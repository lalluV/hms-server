/**
 * Discharge summary AI routes (IPD module).
 * - POST /           — generate printable discharge HTML from patientData
 * - POST /course-chat — hospital stay narrative chat
 *
 * Rx / chart copilot: opdAi.js, ipdAi.js, dischargeAi.js (not this file).
 */

const express = require("express");
const router = express.Router();
const axios = require("axios");
const {
  applyEntitlementsNoTenantDb,
} = require("../utils/applyTenantEntitlements");

applyEntitlementsNoTenantDb(router, { moduleKey: "ipd" });

const {
  aiCompletionWithFallback,
} = require("../utils/aiCompletionWithFallback");

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL =
  process.env.OPENAI_FALLBACK_MODEL || process.env.OPENAI_MODEL || "gpt-6-luna";
// AI Write chart JSON goes through aiCompletionWithFallback (Gemini first).
const PARSE_NOTE_TIMEOUT_MS =
  Number(process.env.GEMINI_PARSE_TIMEOUT_MS) ||
  Number(process.env.OPENAI_PARSE_TIMEOUT_MS) ||
  60000;
const PARSE_NOTE_MAX_TOKENS =
  Number(process.env.GEMINI_PARSE_MAX_TOKENS) ||
  Number(process.env.OPENAI_PARSE_MAX_TOKENS) ||
  4096;

/** Gemini/OpenAI JSON completion for course-chat fallback. */
async function callParseClinicalNoteCompletion(
  messages,
  { timeoutMs = PARSE_NOTE_TIMEOUT_MS, maxTokens = PARSE_NOTE_MAX_TOKENS } = {},
) {
  return aiCompletionWithFallback(messages, {
    timeoutMs,
    maxTokens,
    responseJson: true,
  });
}

const openaiApi = axios.create({
  baseURL: OPENAI_API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  },
});

function stripMarkdownFormatting(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/^```(?:html|json|markdown|text)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
}

function stripHtmlDocumentWrapper(html) {
  if (!html || typeof html !== "string") return html;
  let content = html.trim();
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1].trim();
  return content
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<\/?html[^>]*>/gi, "")
    .replace(/<\/?head[^>]*>[\s\S]*?<\/?head>/gi, "")
    .replace(/<\/?body[^>]*>/gi, "")
    .trim();
}

const DISCHARGE_SUMMARY_SYSTEM_PROMPT = `You are a senior consultant physician at an Indian multispecialty hospital. You write discharge summaries used for clinical handover, insurance claims, and medico-legal records.

STRICT RULES:
1. Use ONLY facts present in the patient data. Never invent diagnoses, medications, dates, vitals, lab values, or events.
2. If a section has no supporting data, omit that section entirely — do not write "Not documented" or "N/A" unless the data explicitly says so.
3. Return ONLY the inner HTML content — no <!DOCTYPE>, <html>, <head>, or <body> tags.
4. Do not wrap output in markdown code fences.
5. Use Indian medical conventions (MLC, GRBS, BD/TDS/OD, casualty, ward, UMR).
6. Summarize trends and clinical significance — never dump raw tables or repetitive vitals rows.
7. Write in formal third-person clinical prose ("The patient was admitted with...").
8. Keep discharge instructions and follow-up plan in clear, actionable language for the patient and caregiver.

HTML REQUIREMENTS:
- Return inner HTML only. Do not include a document title or a patient-demographics header; the print layout already shows UMR, IP number, name, age/gender, doctor, ward/bed, admission, and discharge.
- Each section must be: <section class="prescription-section"><p class="prescription-section-kicker">Title</p><div class="discharge-summary-copy">...</div></section>
- Do not set inline colors, fonts, or borders.
- Use <p> and <ul>/<li> for prose. Use <table class="printable-table"> only for medicines or comparative results that are already tabular in the data.

SECTION ORDER (include a section only when the record has facts for it):
1. Primary consultant
2. Provisional diagnosis
3. Final diagnosis
4. Past medical history
5. Allergies
6. Procedure / Surgery — name and date only
7. History of presenting complaints
8. Emergency evaluation — casualty care, when present
9. Condition on admission — vitals on arrival
10. General / Physical examination
11. Systemic examination
12. Course in hospital
13. OT findings
14. Condition on discharge — status, destination, discharge vitals
15. Discharge medications — name, route, frequency, when, duration, instructions
16. Diet care
17. Discharge advice
18. Review / Follow-up
19. Urgent care — when to return to emergency
20. Emergency contact
Do not include sections titled Treatment during stay, Inpatient Treatment Given, or Investigations during hospitalization.`;

const DISCHARGE_SUMMARY_USER_PROMPT = (
  patientData,
) => `Generate a complete hospital discharge summary in HTML from this patient record.

Before writing:
- Calculate length of stay from admissionDate and dischargeDate if not provided in lengthOfStay
- Synthesize doctorNotes and nurseNotes into Hospital Course — do not copy verbatim
- For vitals: describe trends (e.g. "BP remained 120–140/70–85 mmHg; SpO2 stable at 96–98%")
- For investigations.abnormalFindings: list only clinically significant results with interpretation
- For insulinChart: summarize control status, dose range, and insulin types used
- For Emergency / Casualty: include an "Emergency evaluation" section whenever emergencyAssessment, MLC number, presenting complaints in ER, or casualty treatment are present
- If summarySections exist in patientData, incorporate these case-tailored sections into the clinical summary and hospital course

Patient Data:
${JSON.stringify(patientData, null, 2)}`;

// Middleware to validate request
const validateRequest = (req, res, next) => {
  const { patientData } = req.body;
  if (!patientData) {
    return res.status(400).json({ error: "Patient data is required" });
  }
  next();
};

// Generate discharge summary
router.post("/", validateRequest, async (req, res) => {
  try {
    const { patientData } = req.body;

    const response = await openaiApi.post("/chat/completions", {
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: DISCHARGE_SUMMARY_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: DISCHARGE_SUMMARY_USER_PROMPT(patientData),
        },
      ],
      reasoning_effort: "none",
      max_completion_tokens: 8000,
      temperature: 0.1,
      top_p: 0.9,
    });

    const summary = stripHtmlDocumentWrapper(
      stripMarkdownFormatting(response.data.choices[0].message.content),
    );

    // Log the request for auditing
    console.log(
      `Generated discharge summary for patient at ${new Date().toISOString()}`,
    );

    res.json({
      summary,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error generating discharge summary:", error);
    res.status(500).json({
      error: "Failed to generate discharge summary",
      details: error.message,
    });
  }
});

/**
 * POST /course-chat
 * Body: { patientData, chatHistory, userPrompt, currentCourse }
 * Synthesizes or iteratively edits the "Course in Hospital" clinical narrative
 * using multi-day doctor notes, nurse notes, operative notes, lab trends, and radiology findings.
 */
router.post("/course-chat", async (req, res) => {
  try {
    const {
      patientData = {},
      chatHistory = [],
      userPrompt = "",
      currentCourse = "",
    } = req.body;

    const doctorNotesText = (patientData.doctorNotes || [])
      .map(
        (n) =>
          `[${
            n.timestamp
              ? new Date(n.timestamp).toLocaleDateString("en-GB")
              : "Note"
          }]: ${n.content || n.note || ""}`,
      )
      .join("\n");

    const nurseNotesText = (patientData.nurseNotes || [])
      .map(
        (n) =>
          `[${
            n.timestamp
              ? new Date(n.timestamp).toLocaleDateString("en-GB")
              : "Nurse"
          }]: ${n.content || n.note || ""}`,
      )
      .join("\n");

    const otNotesText =
      patientData.otNotes ||
      patientData.procedureNotes ||
      patientData.operativeNotes ||
      "";
    const procedureName =
      patientData.procedureName || patientData.surgeryName || "";
    const complaints =
      patientData.emergencyAssessment?.ernote || patientData.ernote || "";
    const admissionVitals = patientData.vitals?.admission
      ? `BP: ${patientData.vitals.admission.bloodPressure || "—"}, HR: ${
          patientData.vitals.admission.heartRate || "—"
        }, Temp: ${patientData.vitals.admission.temperature || "—"}`
      : "";
    const dischargeVitals = patientData.vitals?.discharge
      ? `BP: ${patientData.vitals.discharge.bloodPressure || "—"}, HR: ${
          patientData.vitals.discharge.heartRate || "—"
        }, Temp: ${patientData.vitals.discharge.temperature || "—"}`
      : "";

    // Labs and Radiology
    const abnormalLabs = (patientData.investigations?.abnormalFindings || [])
      .map(
        (l) =>
          `${l.testName}: ${l.result} ${l.units || ""} (${l.normalRange || ""})`,
      )
      .join(", ");

    const radiologySummary = (patientData.radiologyReports || [])
      .map(
        (r) =>
          `${r.testName || "Imaging"} (${r.date || ""}): ${
            r.textReport || r.impression || "Report completed"
          }`,
      )
      .join("; ");

    const systemPrompt = `You are an expert clinical documentation assistant for hospital discharge summaries.
Your task is to write and iteratively refine the "Course in Hospital" / Hospital Stay Narrative paragraph(s) for an inpatient being discharged.

STRICT CLINICAL RULES:
1. Synthesize the inpatient stay chronologically:
   - Presenting complaints & pre-operative / admission clinical evaluation.
   - Operative procedure performed & operative findings (if surgical).
   - Post-operative / inpatient recovery trajectory (POD progress, diet step-up, fever/infection control, vitals stability).
   - Status at discharge (afebrile, tolerating diet, stable vitals, wound status healthy).
2. Incorporate relevant laboratory trends and radiology findings naturally when available.
3. Use formal, professional, third-person medical prose ("The patient was admitted with... Underwent... Operative period was uneventful...").
4. Length: 1 to 2 concise, high-impact paragraphs (100–180 words).
5. Output format: You MUST return a JSON object with:
   - "course": The refined clinical course narrative text.
   - "reply": A concise 1-sentence response acknowledging what changes were made.`;

    const userMessageContent = `
PATIENT CLINICAL CONTEXT:
- Patient: ${patientData.name || "Patient"}, ${patientData.age || ""}y / ${
      patientData.gender || ""
    }
- Chief Complaints: ${complaints || "None specified"}
- Procedure / Surgery: ${procedureName || "Medical Management"} ${
      otNotesText ? `(${otNotesText})` : ""
    }
- Admission Vitals: ${admissionVitals || "Stable"}
- Discharge Vitals: ${dischargeVitals || "Afebrile, Stable"}
- Daily Doctor Notes:
${doctorNotesText || "Daily inpatient progress notes indicate uneventful recovery."}
- Nurse Notes:
${nurseNotesText || "Vitals stable, oral intake tolerated."}
- Key Lab Findings: ${abnormalLabs || "Within acceptable limits"}
- Radiology / Imaging: ${radiologySummary || "None reported"}

CURRENT COURSE NARRATIVE:
${currentCourse || "(No narrative generated yet)"}

DOCTOR'S INSTRUCTION / CHAT:
${
  userPrompt ||
  "Synthesize a comprehensive initial Course in Hospital narrative from the inpatient stay data."
}
`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content || m.text || "",
      })),
      { role: "user", content: userMessageContent },
    ];

    try {
      const response = await openaiApi.post("/chat/completions", {
        model: OPENAI_MODEL,
        messages,
        response_format: { type: "json_object" },
        reasoning_effort: "none",
        max_completion_tokens: 1500,
        temperature: 0.2,
      });

      const raw = response.data?.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(raw);

      return res.json({
        course: parsed.course || currentCourse,
        reply: parsed.reply || "Updated the hospital stay course narrative.",
      });
    } catch (openaiErr) {
      console.warn(
        "OpenAI course chat failed, attempting Gemini fallback:",
        openaiErr.message,
      );

      const fallbackResult = await callParseClinicalNoteCompletion(messages, {
        timeoutMs: 30000,
        maxTokens: 2000,
      });

      const raw = fallbackResult?.data?.choices?.[0]?.message?.content || "{}";
      let parsed = {};
      try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        parsed = { course: raw, reply: "Updated course narrative." };
      }

      return res.json({
        course: parsed.course || currentCourse,
        reply: parsed.reply || "Updated the hospital stay course narrative.",
      });
    }
  } catch (error) {
    console.error("Error in course-chat endpoint:", error);
    res.status(500).json({
      error: "Failed to generate course narrative",
      details: error.message,
    });
  }
});

module.exports = router;
