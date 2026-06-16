const express = require("express");
const router = express.Router();
const axios = require("axios");
const {
  applyEntitlementsNoTenantDb,
} = require("../utils/applyTenantEntitlements");

applyEntitlementsNoTenantDb(router, { moduleKey: "ipd" });

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-mini";

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
- Wrap everything in a single root <div> with inline styles: font-family Arial, sans-serif; font-size 14px; line-height 1.6; color #222;
- Section headings: <h2 style="color:#002E81;border-bottom:2px solid #002E81;padding-bottom:4px;margin-top:20px;">
- Sub-headings: <h3 style="color:#333;margin-top:12px;">
- Use <p>, <ul>/<li> for lists, <strong> for labels
- Print-friendly: avoid dark backgrounds; use page-break-inside:avoid on major sections

SECTION ORDER (include only when data exists):
1. DISCHARGE SUMMARY (h1 title)
2. Patient Information — age range, gender, UMR, admission/discharge dates, length of stay, ward, consultant
3. Emergency Assessment — MLC, chief complaints, casualty treatment, initial findings
4. Admission Details — reason for admission, bed/ward, consultant history
5. Clinical Summary — presenting illness, relevant history, examination highlights
6. Hospital Course — day-by-day or chronological narrative from doctor/nurse notes
7. Investigations — abnormal findings and completed test summaries only; note clinical significance
8. Treatment Given — key inpatient medications/procedures with purpose
9. Insulin Management — only if insulinChart data exists; summarize GRBS control and regimen
10. Discharge Medications — name, dose, frequency, duration as list
11. Discharge Condition — stable/improved/etc. and destination
12. Discharge Instructions — numbered patient-facing instructions
13. Follow-up Plan — appointments, repeat tests, warning signs
14. Emergency Contact
15. Medical Team`;

const DISCHARGE_SUMMARY_USER_PROMPT = (
  patientData,
) => `Generate a complete hospital discharge summary in HTML from this patient record.

Before writing:
- Calculate length of stay from admissionDate and dischargeDate if not provided in lengthOfStay
- Synthesize doctorNotes and nurseNotes into Hospital Course — do not copy verbatim
- For vitals: describe trends (e.g. "BP remained 120–140/70–85 mmHg; SpO2 stable at 96–98%")
- For investigations.abnormalFindings: list only clinically significant results with interpretation
- For insulinChart: summarize control status, dose range, and insulin types used
- For emergencyAssessment: include MLC, chief complaints, systemic exam, allergies, past history as available

Patient Data:
${JSON.stringify(patientData, null, 2)}`;

const SECTION_REWRITE_GUIDANCE = {
  chief_complaints: {
    label: "Chief Complaints & History of Present Illness",
    format:
      "Write 1–3 concise paragraphs. Start with chief complaint(s), then onset, duration, progression, associated symptoms, and relevant negatives. Use chronological narrative.",
  },
  past_medical_history: {
    label: "Past Medical History",
    format:
      "Bullet list or short paragraph of prior illnesses, surgeries, hospitalizations, and chronic conditions. Include duration/status where mentioned (e.g. 'Type 2 DM × 5 years, on OAD').",
  },
  past_medications: {
    label: "Past Medications",
    format:
      "List each medication with dose and frequency if known. Format: Drug name dose — frequency. One item per line.",
  },
  allergies_history: {
    label: "Allergies",
    format:
      "List known drug/food allergies with reaction type if mentioned. If none stated in input, write 'No known drug allergies' only if input explicitly says so; otherwise preserve what is given.",
  },
  systemic_examination: {
    label: "Systemic Examination",
    format:
      "Organ-system wise findings: CVS, RS, PA, CNS, extremities, etc. Use standard abbreviations. Document normal and abnormal findings separately.",
  },
  provisional_diagnosis: {
    label: "Provisional Diagnosis",
    format:
      "Numbered list of diagnoses in order of clinical priority. Use formal medical terminology.",
  },
  final_diagnosis: {
    label: "Final Diagnosis",
    format:
      "Numbered list of confirmed diagnoses at discharge. Primary diagnosis first, then secondary/comorbid conditions.",
  },
  symptoms: {
    label: "Symptoms",
    format:
      "Concise symptom description suitable for OPD prescription. Include onset, duration, severity, and relieving/aggravating factors if mentioned.",
  },
  doctor_notes: {
    label: "Doctor's Clinical Notes",
    format:
      "Formal clinical note covering assessment, examination findings, diagnosis, and plan. Use complete sentences. Do not include nursing tasks.",
  },
  nurse_notes: {
    label: "Nursing Notes",
    format:
      "Nursing-focused note: observations, vitals monitoring, intake/output, wound care, patient response to treatment, and nursing interventions. No medical diagnosis or prescription changes.",
  },
  discharge_instructions: {
    label: "Discharge Instructions",
    format:
      "Numbered list of clear, patient-friendly instructions: diet, activity, wound care, medication adherence, warning signs requiring ER visit. Action-oriented language.",
  },
  follow_up_plan: {
    label: "Follow-up Plan",
    format:
      "Specify follow-up date/timeframe, department/doctor, repeat investigations, and pending reports. Include 'return immediately if' warning signs.",
  },
  SOAP: {
    label: "SOAP Note",
    format: `Restructure into exactly four labeled sections with blank lines between them:
Subjective:
[Patient-reported symptoms, history, concerns]

Objective:
[Examination findings, vitals, investigation results mentioned in input]

Assessment:
[Clinical impression and differential/working diagnosis]

Plan:
[Treatment, investigations, follow-up, advice]

Use plain text only. No markdown, no headings beyond the four labels above.`,
  },
  "Clinical Note": {
    label: "Clinical Note",
    format:
      "Polish the note for grammar, clarity, and professional medical language. Preserve ALL clinical facts exactly — do not add, remove, or change diagnoses, medications, or findings. Improve sentence structure and organization only.",
  },
};

function getSectionRewritePrompt(sectionType, inputText, context) {
  const normalizedType = sectionType.trim();
  const guidance =
    SECTION_REWRITE_GUIDANCE[normalizedType] ||
    SECTION_REWRITE_GUIDANCE[normalizedType.replace(/\s+/g, "_")] ||
    SECTION_REWRITE_GUIDANCE[normalizedType.toLowerCase()];

  const sectionLabel = guidance
    ? guidance.label
    : normalizedType.replace(/_/g, " ");
  const formatRules = guidance
    ? guidance.format
    : "Rewrite as a clear, formal medical record section. Preserve all clinical facts from the input.";

  const isSoap = normalizedType.toUpperCase() === "SOAP";

  return `${context ? `Clinical context (for understanding only — do NOT include age or gender in output unless they appear in the doctor's notes below): ${context}\n\n` : ""}Rewrite the doctor's raw notes into a "${sectionLabel}" section.

FORMAT RULES:
${formatRules}

OUTPUT RULES:
- Return ONLY the rewritten section content — no section title/heading, no preamble ("Here is..."), no explanations
- Do not use markdown formatting (no **, ##, \`backticks\`, or code fences)
- Do not invent clinical information not present in the input
- Preserve all drug names, doses, dates, and values exactly as stated
- Use standard Indian medical abbreviations (BD, TDS, OD, QID, HS, SOS, GRBS)
${isSoap ? "- Follow the exact Subjective/Objective/Assessment/Plan label format shown above" : ""}

Doctor's notes:
${inputText}`;
}

const REWRITE_SECTION_SYSTEM_PROMPT = `You are an experienced Indian hospital physician editing clinical documentation for an EMR system.

Your job is to rewrite rough doctor dictation or shorthand into polished, structured medical text suitable for permanent medical records.

Critical constraints:
- Never fabricate or assume clinical details
- Never include patient age or gender unless explicitly written in the doctor's notes
- Output plain text only (except discharge summaries handled elsewhere)
- Match the requested section format precisely`;

const {
  matchMedicineToCatalog,
  matchLabTestToCatalog,
  matchProcedureToCatalog,
} = require("../utils/clinicalNoteMatcher");

const PARSE_CLINICAL_NOTE_SYSTEM_PROMPT = `You are a medical scribe for an Indian hospital EMR (OPD and IPD progress notes). Extract structured data from doctor dictation, typed notes, or voice-transcribed clinical notes.

FORMAT DETECTION (critical):
- Detect the note format from: existing doctor notes, imported template, and the doctor's new input
- noteFormat must be one of: "soap", "narrative", "bullet", "problem_oriented", "template"
- doctorNotes MUST be the complete formatted progress note in that detected format
- If existing notes use SOAP (S/O/A/P or Subjective/Objective/Assessment/Plan), output SOAP with the same label style
- If existing notes are narrative paragraphs, stay narrative
- If bullet style, use bullets consistently
- Default to SOAP only when no prior format exists and input is unstructured clinical dictation
- NEVER convert a non-SOAP format to SOAP unless the doctor explicitly used SOAP labels

EMBED ORDERS IN doctorNotes (critical):
- Medicines, lab tests, and procedures mentioned MUST appear inside doctorNotes in the appropriate section (SOAP Plan, closing plan paragraph, or bullet list)
- "Continue current medications" → document in note; do NOT re-list every drug name unless doctor named them
- New medicines/tests → include in note Plan AND in structured arrays with action "add"
- Continuing existing chart items → action "continue" (documented in note only, not re-ordered)
- Mention-only (discussed but not ordered) → action "note_only"

ORDER INTENT — action field (required on every medicine, lab test, and procedure):
- "add" = NEW order to apply to chart (new drug, new test, new procedure, dose change, restart)
- "continue" = already on chart / doctor said continue/same/ongoing — document in note only
- "note_only" = mentioned in discussion but not a new order
- "stop" = discontinue/stop/hold an existing medicine on chart — document in note AND mark for chart stop (medicines only)

Examples:
- "continue all meds, add azithro 500 od 5 days, send CBC" → azithro action:add, CBC action:add; existing meds action:continue (or omit from arrays if only "continue all")
- "stop metformin, continue others" → metformin action:stop
- "plan wound dressing daily" → procedure action:add if new order; action:continue if already pending
- "stable, continue treatment" → no action:add items; doctorNotes documents stability
- "repeat CBC tomorrow" when CBC already pending → action:continue or note_only, NOT add

SPELLING & NORMALIZATION (critical):
- Correct misspellings and voice-transcription errors to standard generic medicine names
- Expand common abbreviations: PCM/Para/Dolo/Crocin → Paracetamol; Azithro → Azithromycin; Amox → Amoxicillin; Pantop → Pantoprazole; Cetrizine → Cetirizine; Atorva → Atorvastatin; Telma → Telmisartan; Montair → Montelukast; Emeset → Ondansetron; Brufen → Ibuprofen; Asthalin → Salbutamol
- Correct lab test spellings: "cb c"/"hemogram" → CBC; "liver function"/"lft" → LFT; "kft"/"rft" → KFT; "urine rm" → Urine R/M; "xray chest"/"cxr" → X-Ray Chest; "usg"/"sonography" → USG; "ecg"/"ekg" → ECG; "hba1c" → HbA1c; "blood sugar"/"rbs" → Random Blood Sugar; "fbs" → Fasting Blood Sugar; "ppbs" → Post Prandial Blood Sugar
- If a hospital catalog is provided, pick the closest matching catalog name for medicines and lab tests
- Never invent medicines or tests not mentioned in the note
- Never list the same medicine or lab test twice in one response

MEDICINE RULES:
- name: generic name without strength (e.g. "Paracetamol", not "Para 650")
- correctedName: standardized generic after spelling correction
- dosage: strength only (500mg, 650mg, 1 tab)
- frequency: OD, BD, TDS, QID, HS, SOS, or descriptive
- duration: "5 days", "1 week" etc. (required when mentioned)
- instructions: before/after food, SOS only, etc.
- action: "add" | "continue" | "note_only" | "stop"

LAB TEST RULES:
- Return objects: { "name": "standardized test name", "action": "add" | "continue" | "note_only" }

PROCEDURE RULES:
- Return objects: { "name": "procedure/service name", "action": "add" | "continue" | "note_only" }
- Match hospital procedure catalog when provided (wound care, dressing, nebulization, physiotherapy, etc.)
- Correct spelling of common procedures
- Never invent procedures not mentioned

OTHER:
- Handle Hindi-English mixed input (c/o, k/c/o, h/o, since 3 days)
- doctorNotes is the ONLY narrative output — complete, save-ready clinical note
- Leave symptoms, pastMedicalHistory, and provisionalDiagnosis empty strings unless the doctor explicitly dictated them as separate labeled sections
- Never repeat the same clinical information across doctorNotes, symptoms, pastMedicalHistory, and provisionalDiagnosis
- Return valid JSON only`;

const VALID_NOTE_ACTIONS = new Set(["add", "continue", "note_only", "stop"]);

function normalizeNoteAction(action) {
  const normalized = String(action || "add")
    .trim()
    .toLowerCase();
  if (normalized === "stop") return "stop";
  return VALID_NOTE_ACTIONS.has(normalized) ? normalized : "add";
}

function normalizeParsedMedicine(med) {
  const name = String(med.name || med.medicine || "").trim();
  const correctedName = String(
    med.correctedName || med.corrected_name || name,
  ).trim();
  const inventoryMatch = String(
    med.inventoryMatch || med.inventory_match || correctedName || name,
  ).trim();

  return {
    name: correctedName || name,
    correctedName: correctedName || name,
    inventoryMatch: inventoryMatch || correctedName || name,
    dosage: String(med.dosage || med.dose || "").trim(),
    frequency: String(med.frequency || med.freq || "").trim(),
    duration: String(med.duration || "").trim(),
    instructions: String(med.instructions || med.instruction || "").trim(),
    action: normalizeNoteAction(med.action),
  };
}

function normalizeParsedLabTest(test) {
  if (typeof test === "string") {
    const name = test.trim();
    return name ? { name, action: "add" } : null;
  }
  const name = String(test?.name || test?.test || "").trim();
  if (!name) return null;
  return {
    name,
    action: normalizeNoteAction(test.action),
  };
}

function normalizeParsedProcedure(proc) {
  if (typeof proc === "string") {
    const name = proc.trim();
    return name ? { name, action: "add" } : null;
  }
  const name = String(
    proc?.name || proc?.procedure || proc?.service_name || "",
  ).trim();
  if (!name) return null;
  return {
    name,
    correctedName: String(proc?.correctedName || proc?.corrected_name || name).trim(),
    inventoryMatch: String(
      proc?.inventoryMatch || proc?.inventory_match || name,
    ).trim(),
    action: normalizeNoteAction(proc.action),
  };
}

const PARSE_CLINICAL_NOTE_USER_PROMPT = (
  clinicalNote,
  context,
  pharmacyCatalog,
  labCatalog,
  existingContext,
  mode = "replace",
  clinicalSetting = "opd",
  procedureCatalog,
) => {
  const catalogSection = [];

  if (Array.isArray(pharmacyCatalog) && pharmacyCatalog.length > 0) {
    catalogSection.push(
      `Hospital pharmacy catalog (use closest match for correctedName and inventoryMatch):\n${JSON.stringify(pharmacyCatalog.slice(0, 250))}`,
    );
  }

  if (Array.isArray(labCatalog) && labCatalog.length > 0) {
    catalogSection.push(
      `Hospital lab test catalog (use closest match for labTests):\n${JSON.stringify(labCatalog.slice(0, 250))}`,
    );
  }

  if (Array.isArray(procedureCatalog) && procedureCatalog.length > 0) {
    catalogSection.push(
      `Hospital procedure/service catalog (use closest match for procedures):\n${JSON.stringify(procedureCatalog.slice(0, 250))}`,
    );
  }

  const settingLine =
    clinicalSetting === "ipd"
      ? `Clinical setting: IPD inpatient progress note. Match format of recent doctor notes. Only action "add" items are new chart orders.\n\n`
      : "";

  const existingSection = existingContext
    ? `EXISTING CHART & NOTE CONTEXT (use for format detection and continue vs add decisions):
${JSON.stringify(existingContext, null, 2)}

${
  mode === "add"
    ? `MODE "add" — append/update today's note:
- Detect note format from recentDoctorNotes or doctorNotes; preserve that format in doctorNotes output
- doctorNotes should be a complete new progress note for this entry (not a diff)
- Mark existing chart medicines/tests as action "continue" when doctor says continue/same/ongoing
- Mark only newly ordered items as action "add"
`
    : `MODE "replace" — doctor is revising the note/plan:
- Preserve detected format unless doctor clearly switches style
- action "add" for medicines/tests newly ordered in this dictation
- action "continue" for items already on chart that doctor wants documented but not re-ordered
`
}
`
    : "";

  return `${settingLine}${context ? `Patient context: ${context}\n\n` : ""}${existingSection}${catalogSection.length ? `${catalogSection.join("\n\n")}\n\n` : ""}Extract structured clinical data from this note.

JSON schema (return exactly these keys):
{
  "noteFormat": "soap | narrative | bullet | problem_oriented | template",
  "symptoms": "string",
  "pastMedicalHistory": "string or empty",
  "provisionalDiagnosis": "string or empty",
  "medicines": [
    {
      "name": "generic medicine name",
      "correctedName": "spell-corrected generic name",
      "inventoryMatch": "closest hospital catalog medicine name if available, else same as correctedName",
      "dosage": "e.g. 500mg",
      "frequency": "BD | TDS | OD | QID | HS | SOS",
      "duration": "e.g. 5 days",
      "instructions": "e.g. after food or empty string",
      "action": "add | continue | note_only | stop"
    }
  ],
  "labTests": [
    { "name": "spell-corrected standard test name", "action": "add | continue | note_only" }
  ],
  "procedures": [
    {
      "name": "procedure or service name",
      "correctedName": "spell-corrected name",
      "inventoryMatch": "closest catalog name if available",
      "action": "add | continue | note_only"
    }
  ],
  "doctorNotes": "complete formatted clinical note with meds/tests/procedures embedded in the appropriate section"
}

Examples:
- "give tab paracetmol 650 bd 5 days" → action:add, doctorNotes includes in Plan
- "continue meds, add azithro 500 od, CBC" → azithro and CBC action:add; existing meds action:continue or omitted
- "stop metformin" → metformin action:stop
- "advise cb c and lft" → labTests both action:add
- "order wound dressing" → procedures with action:add

Clinical note:
${clinicalNote}`;
};

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
      max_tokens: 8000,
      temperature: 0.1,
      top_p: 0.9,
      frequency_penalty: 0.1,
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
 * POST /rewrite-section
 * Body: { sectionType: string, inputText: string, age?: number, gender?: string }
 * Returns: { rewritten: string }
 */
router.post("/rewrite-section", async (req, res) => {
  try {
    const { sectionType, inputText, age, gender } = req.body;
    // Improved input validation
    if (
      !sectionType ||
      typeof sectionType !== "string" ||
      !sectionType.trim()
    ) {
      return res.status(400).json({
        error: "sectionType is required and must be a non-empty string",
      });
    }
    if (!inputText || typeof inputText !== "string" || !inputText.trim()) {
      return res.status(400).json({
        error: "inputText is required and must be a non-empty string",
      });
    }
    if (age && (typeof age !== "number" || age < 0 || age > 130)) {
      return res
        .status(400)
        .json({ error: "age must be a valid number between 0 and 130" });
    }
    if (
      gender &&
      !["male", "female", "other", "Male", "Female", "Other"].includes(gender)
    ) {
      return res
        .status(400)
        .json({ error: "gender must be 'male', 'female', or 'other'" });
    }

    const contextParts = [];
    if (age) contextParts.push(`Age ${age}`);
    if (gender) contextParts.push(`Gender ${gender}`);
    const context = contextParts.join(", ");

    const prompt = getSectionRewritePrompt(sectionType, inputText, context);

    let response;
    try {
      response = await openaiApi.post(
        "/chat/completions",
        {
          model: OPENAI_MODEL,
          messages: [
            {
              role: "system",
              content: REWRITE_SECTION_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          max_tokens: sectionType.toUpperCase() === "SOAP" ? 1200 : 800,
          temperature: 0.2,
          top_p: 0.9,
          frequency_penalty: 0.3,
        },
        { timeout: 15000 },
      );
    } catch (apiError) {
      console.error(
        "OpenAI API error:",
        apiError?.response?.data || apiError.message,
      );
      return res.status(502).json({
        error: "Failed to contact OpenAI API",
        details: apiError?.response?.data || apiError.message,
      });
    }

    if (
      !response?.data?.choices ||
      !response.data.choices[0]?.message?.content
    ) {
      return res
        .status(500)
        .json({ error: "Invalid response from OpenAI API" });
    }
    const rewritten = stripMarkdownFormatting(
      response.data.choices[0].message.content,
    );
    res.json({ rewritten });
  } catch (error) {
    console.error("Error rewriting section:", error);
    res.status(500).json({
      error: "Failed to rewrite section",
      details: error.message,
    });
  }
});

/**
 * POST /parse-clinical-note
 * Body: { clinicalNote: string, age?: number, gender?: string, allergies?: string }
 * Returns: { symptoms, pastMedicalHistory, provisionalDiagnosis, medicines: [], labTests: [], doctorNotes }
 */
router.post("/parse-clinical-note", async (req, res) => {
  try {
    const {
      clinicalNote,
      age,
      gender,
      allergies,
      pharmacyCatalog,
      labCatalog,
      existingContext,
      mode = "replace",
      clinicalSetting = "opd",
      procedureCatalog,
    } = req.body;

    if (
      !clinicalNote ||
      typeof clinicalNote !== "string" ||
      !clinicalNote.trim()
    ) {
      return res.status(400).json({
        error: "clinicalNote is required and must be a non-empty string",
      });
    }

    const contextParts = [];
    if (age) contextParts.push(`age ${age}`);
    if (gender) contextParts.push(`gender ${gender}`);
    if (allergies) contextParts.push(`allergies: ${allergies}`);
    const context = contextParts.join(", ");

    let response;
    try {
      response = await openaiApi.post(
        "/chat/completions",
        {
          model: OPENAI_MODEL,
          messages: [
            {
              role: "system",
              content: PARSE_CLINICAL_NOTE_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: PARSE_CLINICAL_NOTE_USER_PROMPT(
                clinicalNote,
                context,
                pharmacyCatalog,
                labCatalog,
                existingContext,
                mode,
                clinicalSetting,
                procedureCatalog,
              ),
            },
          ],
          max_tokens: 2500,
          temperature: 0.1,
          top_p: 0.9,
          response_format: { type: "json_object" },
        },
        { timeout: 20000 },
      );
    } catch (apiError) {
      console.error(
        "OpenAI API error:",
        apiError?.response?.data || apiError.message,
      );
      return res.status(502).json({
        error: "Failed to contact OpenAI API",
        details: apiError?.response?.data || apiError.message,
      });
    }

    if (
      !response?.data?.choices ||
      !response.data.choices[0]?.message?.content
    ) {
      return res
        .status(500)
        .json({ error: "Invalid response from OpenAI API" });
    }

    const content = response.data.choices[0].message.content.trim();

    let jsonString = content;
    const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (jsonMatch) {
      jsonString = jsonMatch[1];
    }

    try {
      const parsed = JSON.parse(jsonString);

      const normalizedMedicines = Array.isArray(parsed.medicines)
        ? parsed.medicines
            .map(normalizeParsedMedicine)
            .filter((med) => med.name)
        : [];

      const normalizedLabTests = Array.isArray(parsed.labTests)
        ? parsed.labTests.map(normalizeParsedLabTest).filter(Boolean)
        : Array.isArray(parsed.lab_tests)
          ? parsed.lab_tests.map(normalizeParsedLabTest).filter(Boolean)
          : [];

      const normalizedProcedures = Array.isArray(parsed.procedures)
        ? parsed.procedures.map(normalizeParsedProcedure).filter(Boolean)
        : [];

      const medicines = Array.isArray(pharmacyCatalog)
        ? normalizedMedicines.map((med) =>
            matchMedicineToCatalog(med, pharmacyCatalog),
          )
        : normalizedMedicines;

      const labTests = Array.isArray(labCatalog)
        ? normalizedLabTests.map((test) => {
            const matched = matchLabTestToCatalog(test.name, labCatalog);
            return {
              name:
                matched.inventoryMatch || matched.standardized || test.name,
              action: test.action,
            };
          })
        : normalizedLabTests;

      const procedures = Array.isArray(procedureCatalog)
        ? normalizedProcedures.map((proc) =>
            matchProcedureToCatalog(proc, procedureCatalog),
          )
        : normalizedProcedures;

      const medicinesToApply = medicines.filter((med) => med.action === "add");
      const medicinesToStop = medicines.filter((med) => med.action === "stop");
      const labTestsToApply = labTests
        .filter((test) => test.action === "add")
        .map((test) => test.name);
      const proceduresToApply = procedures.filter(
        (proc) => proc.action === "add",
      );

      const result = {
        noteFormat: String(parsed.noteFormat || "narrative").trim(),
        symptoms: String(parsed.symptoms || "").trim(),
        pastMedicalHistory: String(
          parsed.pastMedicalHistory || parsed.pastHistory || "",
        ).trim(),
        provisionalDiagnosis: String(
          parsed.provisionalDiagnosis || parsed.diagnosis || "",
        ).trim(),
        medicines,
        labTests,
        procedures,
        medicinesToApply,
        medicinesToStop,
        labTestsToApply,
        proceduresToApply,
        doctorNotes: String(
          parsed.doctorNotes || parsed.doctorNote || parsed.notes || "",
        ).trim(),
      };

      res.json(result);
    } catch (parseError) {
      console.error("Error parsing AI response:", parseError);
      console.error("AI Response:", content);
      res.status(500).json({
        error: "Failed to parse AI response",
        details: parseError.message,
      });
    }
  } catch (error) {
    console.error("Error parsing clinical note:", error);
    res.status(500).json({
      error: "Failed to parse clinical note",
      details: error.message,
    });
  }
});

module.exports = router;
