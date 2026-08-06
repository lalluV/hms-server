const express = require("express");
const router = express.Router();
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");
const {
  applyEntitlementsNoTenantDb,
} = require("../utils/applyTenantEntitlements");

applyEntitlementsNoTenantDb(router, { moduleKey: "ipd" });

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-mini";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// AI Write extract / review-followup / taper expand — Gemini 3.1 Flash Lite.
const PARSE_NOTE_MODEL =
  process.env.GEMINI_PARSE_MODEL ||
  process.env.GEMINI_TRANSCRIBE_MODEL ||
  "gemini-3.1-flash-lite";
const PARSE_NOTE_TIMEOUT_MS =
  Number(process.env.GEMINI_PARSE_TIMEOUT_MS) ||
  Number(process.env.OPENAI_PARSE_TIMEOUT_MS) ||
  60000;
// Large consults (many meds/labs) need a high ceiling — 3500 truncates mid-JSON.
const PARSE_NOTE_MAX_TOKENS =
  Number(process.env.GEMINI_PARSE_MAX_TOKENS) ||
  Number(process.env.OPENAI_PARSE_MAX_TOKENS) ||
  16384;
const PARSE_NOTE_RETRY_MAX_TOKENS = Math.max(
  PARSE_NOTE_MAX_TOKENS,
  Number(process.env.GEMINI_PARSE_RETRY_MAX_TOKENS) || 24576,
);
// Review follow-up returns a small PATCH, not the whole chart — keep the cap
// modest so the model can't fall back to re-emitting everything.
const REVIEW_FOLLOWUP_DELTA_MAX_TOKENS =
  Number(process.env.OPENAI_FOLLOWUP_MAX_TOKENS) || 16384;
// Retry budget when the first response is truncated / invalid JSON.
const REVIEW_FOLLOWUP_DELTA_RETRY_MAX_TOKENS =
  Number(process.env.OPENAI_FOLLOWUP_RETRY_MAX_TOKENS) || 24576;
// Live "typing" reply is a separate tiny call — plain text, streamed, no JSON mode.
const REVIEW_FOLLOWUP_REPLY_MAX_TOKENS = 60;

function withTimeout(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`AI request timed out after ${timeoutMs}ms`);
      err.code = "ECONNABORTED";
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** OpenAI-style messages → Gemini systemInstruction + contents. */
function openAiMessagesToGemini(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systemChunks = [];
  const contents = [];
  for (const message of list) {
    const text = String(message?.content || "").trim();
    if (!text) continue;
    if (message.role === "system") {
      systemChunks.push(text);
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) {
      prev.parts[0].text = `${prev.parts[0].text}\n\n${text}`;
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }
  if (!contents.length) {
    contents.push({ role: "user", parts: [{ text: "Return valid JSON." }] });
  }
  // Gemini chats should start with a user turn.
  if (contents[0].role !== "user") {
    contents.unshift({
      role: "user",
      parts: [{ text: "Continue with the JSON response." }],
    });
  }
  return {
    systemInstruction: systemChunks.length
      ? systemChunks.join("\n\n")
      : undefined,
    contents,
  };
}

/**
 * AI Write JSON completion via Gemini (same return shape as OpenAI chat.completions
 * so parse / follow-up / taper callers stay unchanged).
 */
async function callParseClinicalNoteCompletion(
  messages,
  { timeoutMs = PARSE_NOTE_TIMEOUT_MS, maxTokens = PARSE_NOTE_MAX_TOKENS } = {},
) {
  if (!GEMINI_API_KEY) {
    const err = new Error("GEMINI_API_KEY is not configured");
    err.status = 503;
    throw err;
  }

  const { systemInstruction, contents } = openAiMessagesToGemini(messages);
  const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const buildConfig = (outputTokens) => {
    const config = {
      temperature: 0.1,
      topP: 0.9,
      maxOutputTokens: outputTokens,
      responseMimeType: "application/json",
      // Keep thinking minimal so the budget goes to chart JSON, not reasoning.
      thinkingConfig: { thinkingLevel: "minimal" },
    };
    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
    }
    return config;
  };

  const run = (outputTokens) =>
    client.models.generateContent({
      model: PARSE_NOTE_MODEL,
      contents,
      config: buildConfig(outputTokens),
    });

  const toOpenAiShape = (response) => {
    const content = String(response?.text || "").trim();
    if (!content) {
      throw new Error("Empty response from Gemini");
    }
    const finishRaw = String(
      response?.candidates?.[0]?.finishReason || "STOP",
    ).toUpperCase();
    const finish_reason =
      finishRaw === "MAX_TOKENS" || finishRaw === "LENGTH" ? "length" : "stop";
    return {
      data: {
        model: PARSE_NOTE_MODEL,
        choices: [
          {
            message: { role: "assistant", content },
            finish_reason,
          },
        ],
      },
    };
  };

  try {
    const response = await withTimeout(run(maxTokens), timeoutMs);
    return toOpenAiShape(response);
  } catch (firstError) {
    const timedOut =
      firstError?.code === "ECONNABORTED" ||
      /timeout/i.test(String(firstError?.message || ""));
    if (!timedOut) throw firstError;
    console.warn("Parse clinical note timed out; retrying once…");
    const response = await withTimeout(run(maxTokens), timeoutMs);
    return toOpenAiShape(response);
  }
}

const openaiApi = axios.create({
  baseURL: OPENAI_API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  },
});

function medicineTextBlob(med = {}) {
  return [
    med.sourceText,
    med.name,
    med.description,
    med.directions,
    med.patientDirections,
    med.instructions,
    med.duration,
    med.frequency,
    med.dosage,
    med.strength,
  ]
    .map((value) => String(value || ""))
    .join(" ");
}

/** Heuristic only: decide whether to ask the model to re-split medicines. */
function medicineLooksPackedTaper(med = {}) {
  const blob = medicineTextBlob(med);
  if (!/\b(?:then|followed\s+by)\b|→/i.test(blob)) return false;
  const withoutCourseStop = blob.replace(/\bthen\s+stop\b/gi, " ");
  if (
    /\bthen\s+stop\b/i.test(blob) &&
    !/\bthen\s+(?:half\s+)?\d+/i.test(withoutCourseStop)
  ) {
    return false;
  }
  const strengths = withoutCourseStop.match(
    /\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|gm)?\b/gi,
  );
  return (
    /\bthen\s+(?:half\s+)?\d+/i.test(withoutCourseStop) ||
    (strengths && strengths.length >= 2)
  );
}

function medicinesNeedTaperExpandPass(medicines = []) {
  return (Array.isArray(medicines) ? medicines : []).some(
    medicineLooksPackedTaper,
  );
}

const TAPER_EXPAND_SYSTEM_PROMPT = `You fix medicine rows for an Indian hospital EMR. Return valid JSON only: { "medicines": [ ... ] }.

Task: split any PACKED sequential taper into separate medicines[] objects. Leave non-taper medicines unchanged.

Rules:
- Same-day "and"/"also"/"plus" doses stay ONE row.
- "then"/"next"/"followed by"/"→" with changing strength or schedule → SEPARATE rows (one object per step).
- Short course "days then stop" stays ONE add row (not a taper split into stop).
- Keep the spoken name on every step (brand if brand was spoken). Leave generic_name "".
- directions: simple morning/afternoon/evening/night English (no twice/thrice/BD/OD/TDS as patient text).
- dosages: time, amount, beforeFood; unit "" for Tablet/Capsules/Injection unless IU or ml stated.

Shape example (anonymous):
Input packed: BrandX 20 bd 5d then 10 3d then 5 3d
Output length 3: BrandX 20 (5 days), BrandX 10 (next 3 days), BrandX 5 (next 3 days).`;

async function expandPackedTapersWithAi(medicines = [], clinicalNote = "") {
  const list = Array.isArray(medicines) ? medicines : [];
  if (!medicinesNeedTaperExpandPass(list)) return list;

  try {
    const response = await callParseClinicalNoteCompletion(
      [
        { role: "system", content: TAPER_EXPAND_SYSTEM_PROMPT },
        {
          role: "user",
          content: `ORIGINAL NOTE (context only):\n${clinicalNote}\n\nCURRENT medicines[] JSON:\n${JSON.stringify(list)}\n\nReturn the corrected { "medicines": [...] } only.`,
        },
      ],
      { timeoutMs: Math.min(PARSE_NOTE_TIMEOUT_MS, 45000) },
    );
    const content = response?.data?.choices?.[0]?.message?.content?.trim();
    if (!content) return list;
    const parsed = JSON.parse(extractJsonObject(content));
    const next = Array.isArray(parsed.medicines) ? parsed.medicines : null;
    if (!next?.length) return list;
    return next;
  } catch (err) {
    console.warn(
      "Taper expand pass failed; keeping first-pass medicines:",
      err?.message || err,
    );
    return list;
  }
}

async function applyAiOnlyMedicinePasses(parsed, clinicalNote) {
  if (!parsed || typeof parsed !== "object") return parsed;
  const medicines = await expandPackedTapersWithAi(
    parsed.medicines,
    clinicalNote,
  );
  return { ...parsed, medicines };
}

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

/** Normalize SOAP headers to letter labels; leave Complaints:/Diagnosis: etc. untouched. */
function compactSoapLabels(text) {
  if (!text || typeof text !== "string") return text;
  // If note already uses clinical labels, do not coerce into SOAP letters
  if (
    /^(Complaints|History|Examination|Vitals|Diagnosis|Medicines|Investigations|Procedures|Advice)\s*:/im.test(
      text,
    )
  ) {
    return text;
  }
  return text
    .replace(/^S\s+Subjective\s*:\s*/gim, "S: ")
    .replace(/^O\s+Objective\s*:\s*/gim, "O: ")
    .replace(/^A\s+Assessment\s*:\s*/gim, "A: ")
    .replace(/^P\s+Plan\s*:\s*/gim, "P: ")
    .replace(/^Subjective\s*:\s*/gim, "S: ")
    .replace(/^Objective\s*:\s*/gim, "O: ")
    .replace(/^Assessment\s*:\s*/gim, "A: ")
    .replace(/^Plan\s*:\s*/gim, "P: ")
    .replace(/^S\s*:\s*/gim, "S: ")
    .replace(/^O\s*:\s*/gim, "O: ")
    .replace(/^A\s*:\s*/gim, "A: ")
    .replace(/^P\s*:\s*/gim, "P: ");
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
    format: `Restructure into exactly four labeled sections with blank lines between them. Use letter labels only (not full words):
S: [Patient-reported symptoms, history, concerns]

O: [Examination findings, vitals, investigation results mentioned in input]

A: [Clinical impression and differential/working diagnosis]

P: [Treatment, investigations, follow-up, advice]

Use plain text only. No markdown. Labels must be S: O: A: P: — do not write Subjective/Objective/Assessment/Plan.`,
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
${isSoap ? "- Follow the exact S: / O: / A: / P: letter-label format shown above (do not spell out Subjective/Objective/Assessment/Plan)" : ""}

Doctor's notes:
${inputText}`;
}

const REWRITE_SECTION_SYSTEM_PROMPT = `You are an experienced Indian hospital physician editing clinical documentation for an EMR system.

Your job is to rewrite rough doctor dictation or shorthand into polished, structured medical text suitable for permanent medical records.

Critical constraints:
- Never fabricate or assume clinical details
- Never include patient age or gender unless explicitly written in the doctor's notes
- Output plain text only (except discharge summaries handled elsewhere)
- Match the requested section format precisely
- For SOAP notes: use ONLY S: O: A: P: letter labels — never write Subjective, Objective, Assessment, or Plan as headers`;

const PARSE_CLINICAL_NOTE_SYSTEM_PROMPT = `You are a medical scribe for an Indian hospital EMR. Convert the CURRENT doctor dictation or consult transcript into the requested JSON. Return valid JSON only. You are the ONLY clinical authority for this output — structure everything correctly yourself.

COMPLETENESS AND SAFETY
- Preserve every clinical fact from the current input, regardless of writing style, shorthand, language mix, or transcript quality.
- Extract only stated facts. Never invent a diagnosis, order, dose, route, duration, result, or vital.
- When clinical structure is uncertain, preserve the doctor's meaning in clear text instead of guessing.
- Existing chart context is reference only; never copy it as a new current fact.

TEMPORAL AND SEMANTIC ROUTING
- Past conditions, prior events, and background medicines → history (not diagnosis).
- Observed findings → examination.
- Counsel, precautions, follow-up, conditional plans ("if needed", "if not better") → advice.
- Today's drug orders → medicines[]; labs → labTests[]; this-visit clinical acts/services → procedures[] (never medicines[]); measured vitals → vitals.
- A finite medicine course that ends afterward remains action "add". action "stop" only when the doctor explicitly discontinues/holds/removes/omits a medicine.

COMPLAINTS VS DIAGNOSIS (HARD — UNIVERSAL)
- complaints / symptoms: ONLY what the patient presents with now (symptoms, complaints, with or without duration). Symptom language stays here regardless of wording style.
- diagnosis / provisionalDiagnosis: ONLY a disease label, clinical impression, or named condition the doctor stated as diagnosis/impression (e.g. UTI, viral fever, GERD, hypertension, acute gastritis).
- NEVER copy, paraphrase, or mirror a complaints bullet into diagnosis. No overlapping text between the two sections.
- If the note has symptoms but no named diagnosis/impression, leave diagnosis [] and provisionalDiagnosis "".
- Words like fever, pain, cough, cold, burning, itching, vomiting, diarrhea, headache, body ache, weakness belong in complaints — never in diagnosis — unless the doctor explicitly names a disease/impression.

NOTE SECTIONS (BULLETS — REQUIRED)
- Always fill noteSections arrays. Each array item is ONE short bullet in clear English.
- complaints / history / examination / diagnosis / advice: one fact per bullet.
- Mirror into symptoms, pastMedicalHistory, provisionalDiagnosis as newline "• " bullets — same facts as complaints / history / diagnosis respectively (never put complaints facts into provisionalDiagnosis).
- Expand shorthand into readable English. Never put today's drug/lab/imaging orders inside noteSections.

MEDICINE NAMES — ONE FIELD ONLY (HARD)
- Put the spoken medicine in "name" only (+ strength if stated). Leave generic_name ALWAYS "".
- Brand spoken → name is that brand (Pantop/PAN/Dolo/Telma stay as spoken; fix only clear typos like dollo→Dolo). NEVER replace a brand with its salt in name.
- No brand spoken → name is the generic/salt (PCM→Paracetamol, azithro→Azithromycin). That IS the name — do not also invent a brand or fill generic_name.
- Never invent a brand when only a generic was spoken. Never invent a generic_name when a brand was spoken.
- Keep strength in name when it distinguishes products.
- type from spoken form: tab→Tablet, inj→Injection, drops/eye drops/tears→Drops, syp→Syrup, ointment/cream→Ointment, etc.

TAPERS / SEQUENTIAL (MULTI medicines[] ROWS — REQUIRED)
- Same-day concurrent doses ("and"/"also"/"plus" same day) → ONE medicines[] object.
- Sequential/taper "then"/"next"/"followed by"/"→" with changing strength or schedule → SEPARATE medicines[] objects. If 3 steps, medicines[] length MUST be 3. Never pack a taper into one directions paragraph.
- Count strength/schedule steps after each "then". medicines[] length for that drug MUST equal that step count.
- Each step: own name (with that step's strength), frequency, duration, directions (that step only), dosages, action "add".
- Short course "… days then stop" → ONE add row; put "then stop" in directions; action is NOT stop.

TAPER SHAPE (follow this structure — names are anonymous placeholders only):
Doctor: "BrandX 20 bd 5d then 10 3d then 5 3d"
Correct medicines[] (length 3):
1) name "BrandX 20", duration "5 days", directions morning+evening for 5 days, dosages Morning+Evening
2) name "BrandX 10", duration "next 3 days", directions morning+evening for next 3 days, dosages Morning+Evening
3) name "BrandX 5", duration "next 3 days", directions morning+evening for next 3 days, dosages Morning+Evening
Wrong: one medicine whose directions list all three steps.

STOP / DELETE MEDICINES (REQUIRED)
- If the doctor says stop / stopped / discontinue / hold / remove / delete / omit a NAMED medicine → include that medicine in medicines[] with action "stop".
- directions for stop rows: short plain text like "Stop this medicine".
- Prefer the chart name from existingContext.medicineNames when it matches the spoken stop target.
- "3 days then stop" / "od 5d then stop" on a NEW course is NOT a stop action — that is action "add" with "then stop" in directions.
- Do not invent stops for medicines merely omitted from the note.

DURATION
- If duration is stated for a medicine, fill it exactly as stated (keep the mentioned value).
- If several medicines are ordered in the same clause/list and only one shared duration is stated (e.g. "… bd 5d" covering the group), apply that duration to each med in that group.
- If no duration is stated anywhere for a medicine, set duration to "5 days" (default). Do not invent other durations.
- IV fluids / infusions (NS, RL, DNS, Normal Saline, Ringer Lactate, dextrose bags, "IV fluid"): NEVER default to "5 days".
  - If doctor says over X hours / X hrs → duration "X hours".
  - If only a rate is stated (e.g. 100 ml/hr) → put rate in directions; duration "Once" (or hours if also stated).
  - If no duration/rate stated → duration "Once".

DIRECTIONS (LAYMAN ENGLISH — REQUIRED)
- directions: simple Indian patient English. Never use twice, thrice, BD, OD, TDS, QID, HS, SOS, PRN as the only patient text.
- Use morning / afternoon / evening / night. Examples: "Take 1 tablet in the morning and 1 tablet in the evening for 5 days"; "Instill 2 drops in each eye in the morning, afternoon and evening for 7 days"; "Take 1 tablet only if fever".
- Map: OD→morning (or night if HS), BD→morning and evening, TDS→morning afternoon evening, QID→all four, HS→at night, SOS→only when needed / only if [reason].

DOSAGES GRID (M/A/E/N)
- For fixed daily schedules fill dosages[] with Morning/Afternoon/Evening/Night as needed.
- Each dosage object MUST include: time, amount (number), unit, beforeFood (true/false).
- Tablet, Capsules, OR Injection (ampoule/vial count): unit MUST be "" (empty). Never put tablet/tab/capsule/injection/U/unit in unit — grid shows amount only (½, 1, 2…).
- Exception — only when doctor explicitly said insulin units or ml: use "IU" (insulin) or "ml". Never invent "U" for a plain injection (e.g. Lali B inj → amount 1, unit "").
- Syrup/liquid: unit "ml". Drops: "drop". Inhaler: "puff". Topical: "app". Sachet: "sach".
- If doctor says before food / empty stomach → beforeFood true on those slots. After food → beforeFood false and mention after food in directions.
- Unequal same-day amounts (e.g. morning 10 IU and afternoon 15 IU) → one medicine, two dosage slots with correct amounts and unit "IU".
- Do NOT invent a daily grid for SOS / weekly / alternate-day / sliding-scale / conditional schedules; leave dosages [] and put clear text in directions.

LABS
- Current orders → labTests as separate items (split "CBP + LFT" into CBP and LFT).
- Do not duplicate the same lab.
- Phrases like "again if needed", "if required", "repeat if needed" are advice — put them in advice bullets; do NOT create extra labTests from conditional wording alone.
- Past results stay in history/examination narrative.

PROCEDURES VS MEDICINES (HARD)
- medicines[] = drug/product orders the patient takes or is given on a schedule (tablet, capsule, syrup, drops, ointment, inhaler, injection dose with OD/BD/TDS/duration, etc.).
- procedures[] = clinical/bedside/surgical acts or services done or ordered this visit (dressing, suturing, catheterization, ear syringing/wax removal, wound care, debridement, aspiration/tap, nebulization as a procedure session, incision & drainage, foreign-body removal, etc.).
- NEVER put a procedure/act into medicines[]. If there is no drug name + dose/schedule, it is not a medicine.
- This-visit procedure → procedures[] with action "add". Past procedure → history bullet only (not medicines, not procedures). Future/planned procedure → advice bullet only.
- Do not invent a medicine type/dosage/duration for something that is a procedure.

ORDERS AND NOTES
- action: add | continue | note_only | stop. Do not mark omitted existing items as stopped.
- Vitals: values only. Empty arrays/fields when unsupported.
- Labeled notes: use noteSections; leave doctorNotes "". SOAP only when existing format is SOAP.
- noteOperations: remove only an exact existing bullet the current input clearly corrects.

FINAL CHECK
- No complaints/symptoms text in diagnosis; diagnosis empty if no named disease/impression.
- Tapers = multiple medicines[] rows (never one packed taper object).
- Explicit stop/delete of a named drug = action "stop" row; course "then stop" stays action "add".
- name = spoken brand or spoken generic only; generic_name always "".
- directions are morning/afternoon/evening/night English (no twice/thrice).
- Tablet/Capsule/Injection dosages: unit "" unless insulin IU or ml stated; never invent "U" on plain injections.
- IV fluids: duration in hours when stated, else "Once" — never default to 5 days.
- Conditional labs are advice, not duplicate labTests.
- Procedures never appear in medicines[]; medicines never appear in procedures[].
- No invented facts.`;

const NOTE_SECTION_ORDER = [
  ["complaints", "Complaints"],
  ["history", "History"],
  ["examination", "Examination"],
  ["diagnosis", "Diagnosis"],
  ["advice", "Advice"],
];

const NOTE_SECTION_ALIASES = {
  complaints: "complaints",
  complaint: "complaints",
  chiefcomplaints: "complaints",
  symptoms: "complaints",
  history: "history",
  pasthistory: "history",
  pastmedicalhistory: "history",
  examination: "examination",
  exam: "examination",
  findings: "examination",
  diagnosis: "diagnosis",
  impression: "diagnosis",
  provisionaldiagnosis: "diagnosis",
  advice: "advice",
  advise: "advice",
  plan: "advice",
};

function noteSectionItems(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(/\r?\n|;/);
  const seen = new Set();
  const items = [];
  for (const entry of raw) {
    const text = String(entry || "")
      .replace(/^[\s\-*•]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(text);
  }
  return items;
}

/** Bucket model-provided note sections into our fixed section keys. */
function normalizeNoteSections(rawSections) {
  if (!rawSections || typeof rawSections !== "object") return null;
  const buckets = {};
  for (const [rawKey, rawValue] of Object.entries(rawSections)) {
    const key =
      NOTE_SECTION_ALIASES[
        String(rawKey || "")
          .toLowerCase()
          .replace(/[^a-z]/g, "")
      ];
    if (!key) continue;
    const items = noteSectionItems(rawValue);
    if (!items.length) continue;
    buckets[key] = noteSectionItems([...(buckets[key] || []), ...items]);
  }
  return Object.keys(buckets).length ? buckets : null;
}

function composeNoteFromSections(sections) {
  if (!sections) return "";
  const blocks = [];
  for (const [key, label] of NOTE_SECTION_ORDER) {
    const items = sections[key];
    if (!items?.length) continue;
    blocks.push(`${label}:\n${items.map((item) => `• ${item}`).join("\n")}`);
  }
  return blocks.join("\n\n").trim();
}

function pickVitalsField(raw, ...keys) {
  for (const key of keys) {
    const value = raw?.[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function normalizeParsedVitals(raw) {
  if (!raw || typeof raw !== "object") return null;

  const vitals = {
    weight: pickVitalsField(raw, "weight", "wt", "bodyWeight"),
    height: pickVitalsField(raw, "height", "ht", "bodyHeight"),
    temperature: pickVitalsField(raw, "temperature", "temp", "fever"),
    spo2: pickVitalsField(raw, "spo2", "SpO2", "oxygenSaturation", "o2sat"),
    heartRate: pickVitalsField(raw, "heartRate", "pulse", "hr", "PR"),
    respiratoryRate: pickVitalsField(
      raw,
      "respiratoryRate",
      "rr",
      "respRate",
      "respiration",
    ),
    bloodPressure: pickVitalsField(raw, "bloodPressure", "bp", "BP"),
    grbs: pickVitalsField(raw, "grbs", "GRBS", "rbs", "RBS", "bloodSugar"),
    urineOutput: pickVitalsField(
      raw,
      "urineOutput",
      "outputUrine",
      "urine",
      "uo",
    ),
    inputIV: pickVitalsField(raw, "inputIV", "ivInput", "iv"),
    inputOral: pickVitalsField(raw, "inputOral", "oralInput", "oral"),
    inputOthers: pickVitalsField(raw, "inputOthers", "otherInput"),
    outputUrine: pickVitalsField(
      raw,
      "outputUrine",
      "urineOutput",
      "urine",
      "uo",
    ),
    outputDrain: pickVitalsField(raw, "outputDrain", "drainOutput", "drain"),
    outputOthers: pickVitalsField(raw, "outputOthers", "otherOutput"),
  };

  if (!vitals.urineOutput && vitals.outputUrine) {
    vitals.urineOutput = vitals.outputUrine;
  }
  if (!vitals.outputUrine && vitals.urineOutput) {
    vitals.outputUrine = vitals.urineOutput;
  }

  const hasAny = Object.values(vitals).some((value) => Boolean(value));
  return hasAny ? vitals : null;
}

function compactExistingClinicalContext(existingContext) {
  if (!existingContext || typeof existingContext !== "object") return null;

  const uniqueNames = (items, limit) => {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    const names = [];
    for (const item of items) {
      const value =
        typeof item === "string"
          ? item
          : item?.name ||
            item?.description ||
            item?.test_name ||
            item?.correctedName ||
            "";
      const name = String(value).trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
      if (names.length >= limit) break;
    }
    return names;
  };

  const noteText = String(
    existingContext.doctorNotes || existingContext.note || "",
  );
  const noteFormat =
    String(existingContext.noteFormat || "").toLowerCase() === "soap" ||
    /^\s*[SOAP]\s*:/m.test(noteText)
      ? "soap"
      : "labeled";
  const noteSections = {};
  for (const key of [
    "complaints",
    "history",
    "examination",
    "diagnosis",
    "advice",
  ]) {
    const items = uniqueNames(existingContext.noteSections?.[key], 30);
    if (items.length) noteSections[key] = items;
  }

  return {
    noteFormat,
    noteSections,
    medicineNames: uniqueNames(existingContext.medicines, 80),
    labTestNames: uniqueNames(existingContext.labTests, 80),
    procedureNames: uniqueNames(existingContext.procedures, 40),
  };
}

const NOTE_OPERATION_SECTIONS = new Set([
  "complaints",
  "history",
  "examination",
  "diagnosis",
  "advice",
]);

/**
 * Accept only exact existing bullet targets. The model cannot remove a whole
 * section, an order, or text that was not explicitly sent in compact context.
 */
function normalizeParsedNoteOperations(rawOperations, existingContext) {
  if (!Array.isArray(rawOperations)) return [];
  const existingSections =
    compactExistingClinicalContext(existingContext)?.noteSections || {};
  const normalized = [];
  const seen = new Set();

  for (const operation of rawOperations) {
    const section = String(operation?.section || "")
      .trim()
      .toLowerCase();
    if (!NOTE_OPERATION_SECTIONS.has(section)) continue;
    if (String(operation?.action || "").toLowerCase() !== "remove") continue;

    const requestedTarget = String(operation?.target || "").trim();
    if (!requestedTarget) continue;
    const target = (existingSections[section] || []).find(
      (item) => item.toLowerCase() === requestedTarget.toLowerCase(),
    );
    if (!target) continue;

    const key = `${section}|${target.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ section, action: "remove", target });
  }

  return normalized;
}

/** Shared output contract for parse / follow-up — keeps both call sites in sync. */
const CLINICAL_JSON_SHAPE_BLOCK = `Return exactly this JSON shape:
{
  "noteFormat": "labeled or soap",
  "symptoms": "• bullet\\n• bullet",
  "pastMedicalHistory": "• bullet\\n• bullet",
  "provisionalDiagnosis": "• bullet\\n• bullet",
  "medicines": [{
    "sourceText": "",
    "name": "spoken brand or spoken generic (+ strength)",
    "generic_name": "",
    "type": "Tablet|Capsules|Injection|Syrup|Ointment|Gel|Sachet|Syringe|Drops|Inhaler|Spray|Patch|Suppository|Other",
    "strength": "", "dosage": "", "frequency": "", "duration": "",
    "scheduleKind": "fixed_daily|interval|weekly|monthly|alternate_day|prn|sliding_scale|one_time|sequential|device_controlled|free_text",
    "directions": "",
    "dosages": [{ "time": "Morning|Afternoon|Evening|Night", "amount": 1, "unit": "\\"\\" for Tablet/Capsules/Injection else ml|IU|drop|puff|app|sach", "beforeFood": false }],
    "action": "add|continue|note_only|stop"
  }],
  "labTests": [{"name": "", "action": "add|continue|note_only"}],
  "procedures": [{"name": "", "correctedName": "", "inventoryMatch": "", "action": "add|continue|note_only"}],
  "vitals": {
    "weight": "", "height": "", "temperature": "", "spo2": "",
    "heartRate": "", "respiratoryRate": "", "bloodPressure": "",
    "grbs": "", "urineOutput": ""
  },
  "eraManualExam": {
    "gcs": "E4V5M6",
    "consciousness": "Alert",
    "pupils": "",
    "height": "",
    "weight": "",
    "maritalStatus": "",
    "alcohol": false,
    "smoking": false,
    "illicitDrugs": false,
    "familyHistory": ""
  },
  "noteSections": {
    "complaints": ["one symptom bullet"],
    "history": ["one past-history bullet"],
    "examination": ["one exam bullet"],
    "diagnosis": ["one diagnosis bullet"],
    "advice": ["one advice bullet"]
  },
  "noteOperations": [{
    "section": "complaints|history|examination|diagnosis|advice",
    "action": "remove",
    "target": "exact existing bullet"
  }],
  "doctorNotes": "",
  "assistantReply": "one short sentence confirming what changed (follow-up mode only; leave empty otherwise)"
}`;

const PARSE_CLINICAL_NOTE_USER_PROMPT = (
  clinicalNote,
  context,
  existingContext,
  mode = "replace",
  clinicalSetting = "opd",
) => {
  const compactExisting = compactExistingClinicalContext(existingContext);

  const settingLine =
    clinicalSetting === "era"
      ? `SETTING: ERA (emergency admission). Split medicines by route: already given/administered in casualty/ER (stat, IV bolus, "given now") → set "eraRoute": "given_in_er". Medicines to continue on the ward → "eraRoute": "continue_on_ward". Default continue_on_ward if unclear. Labs → labTests only (chart pending). Include allergies in note or allergiesHistory field; use NKDA when stated. Vitals may include grbs (blood sugar) and urineOutput (ml) when mentioned. Fill eraManualExam when mentioned (do not invent): gcs as E#V#M#, consciousness one of Alert|Oriented|Drowsy|Confused|Stuporous|Unconscious, pupils text, height cm, weight kg, maritalStatus, alcohol/smoking/illicitDrugs booleans, familyHistory. Also put the same facts in examination/history note text and vitals.height/weight when stated.`
      : clinicalSetting === "ipd"
        ? `SETTING: IPD. "stop" discontinues a medicine.`
        : `SETTING: OPD. "stop" removes a medicine from this visit prescription.`;
  const modeLine =
    mode === "add"
      ? `MODE: add. Return only facts and actions from the current input; never repeat existing chart items as new.`
      : `MODE: replace. Return the revised content supported by the current input.`;
  const existingLine = compactExisting
    ? `EXISTING CONTEXT (names/style only; reference, never source):\n${JSON.stringify(compactExisting)}`
    : `EXISTING CONTEXT: none`;

  return `${settingLine}
${modeLine}
${context ? `PATIENT: ${context}` : ""}
${existingLine}

COMPLETENESS: Keep every clinical fact from CURRENT INPUT. Writing style may vary — expand shorthand into clear English and place each fact by meaning (past→history, symptoms→complaints only never diagnosis, exam→examination, named impression→diagnosis else leave diagnosis empty, plan/follow-up/if-needed→advice, today's drug orders→medicines[], labs→labTests[], this-visit acts/services→procedures[] never medicines[], measured vitals→vitals). noteSections are bullet lists. Medicine name = spoken brand or spoken generic; leave generic_name "". Tapers = multiple medicines[] rows. Explicit stop/delete of a named drug = action stop. Tablet/Capsule/Injection unit "" (IU/ml only when stated); IV fluids duration hours or Once not 5 days; beforeFood when known. Do not drop clauses.

${CLINICAL_JSON_SHAPE_BLOCK}

CURRENT INPUT:
${clinicalNote}`;
};

/**
 * Addendum for Review follow-up chat. Unlike full extraction, this asks for a
 * small PATCH only — untouched medicines/bullets/labs are never re-emitted, so
 * generation time scales with the size of the edit, not the size of the chart.
 */
const REVIEW_FOLLOWUP_SYSTEM_ADDENDUM = `

REVIEW FOLLOW-UP MODE — PATCH ONLY (CRITICAL — KEEP OUTPUT TINY)
- CURRENT CHART below is the doctor's chart exactly as it stands on screen right now (ground truth, may include hand edits).
- Each medicine/lab/procedure has origin: "review" (added in this Review draft) or "visit" (already on the patient's current Rx/labs).
- INSTRUCTION is the one new change requested right now.
- Output ONLY ops for items the INSTRUCTION explicitly changes. The app keeps every omitted item exactly as-is.
- FORBIDDEN: listing every medicine as "edit" when the instruction only changes a few (or none). That wastes tokens, truncates JSON, and fails.
- If the instruction does not name a medicine, medicineOps MUST be []. Same for labs/procedures/note.
- Prefer ≤ 6 ops total. Prefer clear* flags for bulk clears. Never copy the whole chart.
- Match existing items using their exact "name" as given in CURRENT CHART.
- Apply the normal clinical formatting rules above to any medicine you add or edit.
- ADD EVEN IF ALREADY ON VISIT: if the doctor asks to add a medicine/lab/procedure that is already origin "visit" / action "on_visit", still emit op "add". Do NOT skip, and do NOT use "edit" for that — the app adds a new review row (same as AI Write; UI may show On Rx).
- assistantReply is required: one short spoken sentence to the doctor (like a quick verbal confirm). Confirm only what this patch actually changes — warm, plain English, not robotic. Examples: "Okay — I've stopped Pantop." / "Got it, Dolo is now three times a day." / "Nothing to change on the chart from that."
- Leave arrays/objects empty ({} or []) for anything the instruction did not touch.

DELETE / REMOVE / STOP (HARD)
- origin "review": use op "remove". This drops the item from the Review draft. NEVER use "stop" for review-origin items — they must NOT go to Delete-from-visit.
- origin "visit": use op "stop" for medicines (and for labs/procedures too). This queues Delete-from-this-visit. NEVER use "remove" for visit-origin items.
- If unsure of origin, read the origin field on the matched CURRENT CHART row.

CLEAR / DELETE EVERYTHING
- Prefer clear flags instead of listing every name:
  - clearReviewMedicines / clearReviewLabs / clearReviewProcedures / clearNote — wipe Review-added content only (origin review). Does NOT stop visit Rx items.
  - "delete everything" / "clear all" / "remove all of this" → set all clearReview* + clearNote true. Do NOT set stopAllVisitMedicines unless the doctor clearly asked to remove existing visit Rx/labs too.
  - stopAllVisitMedicines / stopAllVisitLabs — only when the doctor clearly wants existing visit orders removed/stopped.

EXAMPLES (shape only — anonymous)
Doctor: "Make Dolo TDS" (review-origin Dolo 650) →
{"assistantReply":"Got it — Dolo is now three times a day.","medicineOps":[{"op":"edit","match":"Dolo 650","medicine":{"name":"Dolo 650","generic_name":"","type":"Tablet","duration":"5 days","directions":"Take 1 tablet in the morning, afternoon and evening","dosages":[{"time":"Morning","amount":1,"unit":"","beforeFood":false},{"time":"Afternoon","amount":1,"unit":"","beforeFood":false},{"time":"Evening","amount":1,"unit":"","beforeFood":false}]}}]}

Doctor: "Remove Dolo" (Dolo origin review) →
{"assistantReply":"Okay, I've taken Dolo off the draft.","medicineOps":[{"op":"remove","match":"Dolo 650"}]}

Doctor: "Delete Pantop" (Pantop origin visit) →
{"assistantReply":"Okay — Pantop is marked to stop on this visit.","medicineOps":[{"op":"stop","match":"Pantop 40"}]}

Doctor: "Add CBP and remove LFT" (LFT origin review) →
{"assistantReply":"Added CBP and removed LFT.","labOps":[{"op":"add","name":"CBP"},{"op":"remove","match":"LFT"}]}

Doctor: "Add Dolo" (Dolo already origin visit / on_visit) →
{"assistantReply":"Okay — adding Dolo again.","medicineOps":[{"op":"add","medicine":{"name":"Dolo 650","generic_name":"","type":"Tablet","duration":"5 days","directions":"Take 1 tablet in the morning and evening","dosages":[{"time":"Morning","amount":1,"unit":"","beforeFood":false},{"time":"Evening","amount":1,"unit":"","beforeFood":false}]}}]}

Doctor: "Add CBP" (CBP already on visit) →
{"assistantReply":"Sure, adding CBP.","labOps":[{"op":"add","name":"CBP"}]}

Doctor: "Delete everything" →
{"assistantReply":"All cleared from the review draft.","clearReviewMedicines":true,"clearReviewLabs":true,"clearReviewProcedures":true,"clearNote":true}

Doctor: "Add fever with chills to complaints" →
{"assistantReply":"Added fever with chills under complaints.","noteOps":[{"section":"complaints","action":"add","text":"Fever with chills"}]}

ELABORATE / EXPAND / REWRITE NOTE (HARD — NO DUPLICATES)
- When the doctor says elaborate / expand / rewrite / flesh out / make detailed (whole note or a section), do NOT addOps the new wording while leaving the short originals — that duplicates.
- For every bullet you expand: first noteOps remove the exact existing bullet (action "remove", target = exact CURRENT CHART bullet text), then noteOps add the elaborated version (action "add", text = new wording only).
- Same rule for a whole section: remove each existing bullet in that section, then add only the new elaborated bullets. Never keep both short + elaborated side by side.

Doctor: "Elaborate complaints" (CURRENT has • Fever) →
{"assistantReply":"Elaborated the complaints.","noteOps":[{"section":"complaints","action":"remove","target":"Fever"},{"section":"complaints","action":"add","text":"High-grade intermittent fever for 3 days, associated with chills"}]}

Return exactly this JSON shape:
{
  "assistantReply": "one short natural spoken sentence",
  "clearReviewMedicines": false,
  "clearReviewLabs": false,
  "clearReviewProcedures": false,
  "clearNote": false,
  "stopAllVisitMedicines": false,
  "stopAllVisitLabs": false,
  "medicineOps": [{
    "op": "add|edit|stop|remove",
    "match": "exact existing medicine name (edit|stop|remove only)",
    "medicine": {
      "name": "", "generic_name": "",
      "type": "Tablet|Capsules|Injection|Syrup|Ointment|Gel|Sachet|Syringe|Drops|Inhaler|Spray|Patch|Suppository|Other",
      "strength": "", "duration": "", "directions": "",
      "dosages": [{ "time": "Morning|Afternoon|Evening|Night", "amount": 1, "unit": "\\"\\" for Tablet/Capsules/Injection else ml|IU|drop|puff|app|sach", "beforeFood": false }]
    }
  }],
  "labOps": [{ "op": "add|remove|stop", "name": "", "match": "exact existing lab name (remove|stop only)" }],
  "procedureOps": [{ "op": "add|remove|stop", "name": "", "match": "exact existing procedure name (remove|stop only)" }],
  "vitalsPatch": { "only changed vitals keys": "" },
  "noteOps": [{ "section": "complaints|history|examination|diagnosis|advice", "action": "add|remove", "text": "new bullet (add)", "target": "exact existing bullet (remove)" }]
}`;

/** Slim chart for the model — enough to match names/origin, less copy-paste bait. */
function compactChartForFollowUpPrompt(chart) {
  const c = chart && typeof chart === "object" ? chart : {};
  const slimMed = (m) => ({
    name: m?.name || "",
    origin: m?.origin || "review",
    action: m?.action || "add",
    type: m?.type || "",
    duration: m?.duration || "",
    directions: m?.directions || "",
    dosages: Array.isArray(m?.dosages)
      ? m.dosages.map((d) => ({
          time: d?.time || "",
          amount: d?.amount,
          unit: d?.unit || "",
          beforeFood: Boolean(d?.beforeFood),
        }))
      : [],
  });
  const slimNamed = (item, fallbackAction = "add") => {
    if (typeof item === "string") {
      return { name: item, origin: "review", action: fallbackAction };
    }
    return {
      name: item?.name || "",
      origin: item?.origin || "review",
      action: item?.action || fallbackAction,
    };
  };
  return {
    doctorNotes: String(c.doctorNotes || "").slice(0, 2500),
    medicines: (Array.isArray(c.medicines) ? c.medicines : []).map(slimMed),
    labTests: (Array.isArray(c.labTests) ? c.labTests : []).map((t) =>
      slimNamed(t),
    ),
    procedures: (Array.isArray(c.procedures) ? c.procedures : []).map((p) =>
      slimNamed(p),
    ),
    vitals: c.vitals || {},
  };
}

/**
 * Repair truncated model JSON (common when medicineOps was over-emitted and
 * the response cut off mid-string / mid-object).
 */
function repairTruncatedJsonObject(text) {
  let s = String(text || "").trim();
  if (!s) throw new Error("Empty JSON");

  // Drop a trailing incomplete key/value after the last safe comma.
  s = s.replace(
    /,\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*"[^"\\]*(?:\\.[^"\\]*)*$/,
    "",
  );
  s = s.replace(/,\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*[^,}\]]*$/, "");
  s = s.replace(/,\s*"[^"\\]*(?:\\.[^"\\]*)*$/, "");
  s = s.replace(/,\s*$/, "");

  // Close an open string if needed.
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
  }
  if (inString) s += '"';

  // Close open braces / brackets.
  const stack = [];
  inString = false;
  escape = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  while (stack.length) {
    s += stack.pop() === "{" ? "}" : "]";
  }
  return JSON.parse(s);
}

function parseFollowUpDeltaJson(content) {
  const raw = extractJsonObject(content);
  try {
    return JSON.parse(raw);
  } catch (firstError) {
    try {
      return repairTruncatedJsonObject(raw);
    } catch {
      throw firstError;
    }
  }
}

/** Drop no-op medicine edits that just restate the chart (bloat / truncation cause). */
function pruneNoOpMedicineOps(medicineOps, currentChart) {
  const ops = Array.isArray(medicineOps) ? medicineOps : [];
  const chartMeds = Array.isArray(currentChart?.medicines)
    ? currentChart.medicines
    : [];
  return ops.filter((op) => {
    const kind = String(op?.op || "").toLowerCase();
    if (kind !== "edit" || !op.medicine) return true;
    const match = String(op.match || op.medicine.name || "")
      .trim()
      .toLowerCase();
    const existing = chartMeds.find(
      (m) =>
        String(m?.name || "")
          .trim()
          .toLowerCase() === match &&
        String(m?.action || "add").toLowerCase() !== "stop",
    );
    if (!existing) return true;
    const next = op.medicine;
    const sameDirections =
      String(existing.directions || "")
        .trim()
        .toLowerCase() ===
      String(next.directions || "")
        .trim()
        .toLowerCase();
    const sameDuration =
      String(existing.duration || "")
        .trim()
        .toLowerCase() ===
      String(next.duration || "")
        .trim()
        .toLowerCase();
    const sameType =
      String(existing.type || "")
        .trim()
        .toLowerCase() ===
      String(next.type || "")
        .trim()
        .toLowerCase();
    const existingDose = JSON.stringify(existing.dosages || []);
    const nextDose = JSON.stringify(next.dosages || []);
    return !(
      sameDirections &&
      sameDuration &&
      sameType &&
      existingDose === nextDose
    );
  });
}

const REVIEW_FOLLOWUP_USER_PROMPT = (
  instruction,
  currentChart,
  context,
  existingContext,
  clinicalSetting = "opd",
) => {
  const compactExisting = compactExistingClinicalContext(existingContext);
  const settingLine =
    clinicalSetting === "era"
      ? `SETTING: ERA (emergency admission). Split medicines by route: already given/administered in casualty/ER (stat, IV bolus, "given now") → set "eraRoute": "given_in_er". Medicines to continue on the ward → "eraRoute": "continue_on_ward". Default continue_on_ward if unclear. Labs → labTests only (chart pending). Include allergies in note or allergiesHistory field; use NKDA when stated. Vitals may include grbs (blood sugar) and urineOutput (ml) when mentioned. Fill eraManualExam when mentioned (do not invent): gcs as E#V#M#, consciousness one of Alert|Oriented|Drowsy|Confused|Stuporous|Unconscious, pupils text, height cm, weight kg, maritalStatus, alcohol/smoking/illicitDrugs booleans, familyHistory. Also put the same facts in examination/history note text and vitals.height/weight when stated.`
      : clinicalSetting === "ipd"
        ? `SETTING: IPD. "stop" discontinues a medicine.`
        : `SETTING: OPD. "stop" removes a medicine from this visit prescription.`;
  const existingLine = compactExisting
    ? `OTHER VISIT CONTEXT (reference only, never source):\n${JSON.stringify(compactExisting)}`
    : `OTHER VISIT CONTEXT: none`;
  const slimChart = compactChartForFollowUpPrompt(currentChart);

  return `${settingLine}
${context ? `PATIENT: ${context}` : ""}
${existingLine}

CURRENT CHART (ground truth — do NOT repeat these rows back; patch only what the instruction changes):
${JSON.stringify(slimChart)}

INSTRUCTION:
${instruction}

REMINDER: medicineOps/labOps/noteOps only for items named or clearly changed by INSTRUCTION. Unchanged medicines → omit. Empty arrays when unused. Elaborate/expand/rewrite → remove old bullets then add new ones; never leave short originals next to elaborated copies.`;
};

/** Tiny live-typing reply — separate, non-JSON, streamed call so the doctor sees something immediately. */
const REVIEW_FOLLOWUP_REPLY_STREAM_SYSTEM_PROMPT = `You are a helpful clinical scribe chatting with a doctor. Reply with ONE short, natural spoken sentence (like a quick verbal confirm) that restates ONLY what the INSTRUCTION asks for. Warm and plain — not robotic status text. Chart summary is context only — never invent a change for something the instruction did not name. If it is not a chart edit (e.g. hello), say nothing on the chart is changing. Plain text only — no JSON, no markdown, no quotes. Examples: "Okay — stopping Pantop." / "Sure, adding CBP." / "Nothing to change on the chart from that."`;

/** Live typing for AI Write step 1 (Extract) — runs in parallel with full parse. */
const PARSE_NOTE_REPLY_STREAM_SYSTEM_PROMPT = `You are a clinical scribe confirming you are writing a chart from a doctor's dictation. Reply with ONE short, natural, present-tense sentence about what you are extracting (note, medicines, labs). Plain text only — no JSON, no markdown, no quotes. Use only facts clearly present in the note; if the note is sparse, say "Writing the clinical chart from your note." Examples: "Writing the note and adding Dolo 650, Pantop, and CBP." / "Extracting complaints, advice, and two medicines."`;

/** Pipe OpenAI chat.completions SSE into an Express text response. */
function pipeOpenAiChatStreamToResponse(upstream, res) {
  let buffer = "";
  upstream.data.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const token = json?.choices?.[0]?.delta?.content;
        if (token) res.write(token);
      } catch {
        /* ignore partial JSON fragments split across chunks */
      }
    }
  });
  upstream.data.on("end", () => res.end());
  upstream.data.on("error", (err) => {
    console.error("OpenAI chat stream upstream error:", err.message);
    res.end();
  });
}

function summarizeChartForReplyContext(chart) {
  const c = chart && typeof chart === "object" ? chart : {};
  const medNames = (Array.isArray(c.medicines) ? c.medicines : [])
    .map((m) => m?.name)
    .filter(Boolean);
  const labNames = (Array.isArray(c.labTests) ? c.labTests : [])
    .map((t) => (typeof t === "string" ? t : t?.name))
    .filter(Boolean);
  const bits = [];
  if (medNames.length) bits.push(`Medicines: ${medNames.join(", ")}`);
  if (labNames.length) bits.push(`Labs: ${labNames.join(", ")}`);
  return bits.join("\n") || "(empty chart)";
}

/** Reverse of composeNoteFromSections — recovers bucketed bullets from a composed note. */
const NOTE_LABEL_TO_KEY = Object.fromEntries(
  NOTE_SECTION_ORDER.map(([key, label]) => [label.toLowerCase(), key]),
);

function parseComposedNoteSections(noteText) {
  const text = String(noteText || "").trim();
  if (!text) return {};
  const sections = {};
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    const headerMatch = lines[0].match(/^([A-Za-z ]+):\s*(.*)$/);
    if (!headerMatch) continue;
    const key = NOTE_LABEL_TO_KEY[headerMatch[1].trim().toLowerCase()];
    if (!key) continue;
    const rest = lines.slice(1);
    if (headerMatch[2]?.trim()) rest.unshift(headerMatch[2].trim());
    const items = rest
      .map((line) => line.replace(/^[•\-*]\s*/, "").trim())
      .filter(Boolean);
    if (items.length) sections[key] = items;
  }
  return sections;
}

/** Applies add/remove bullet ops onto a composed note without touching untouched text. */
function mergeNoteWithOps(currentNoteText, noteOps) {
  const ops = Array.isArray(noteOps) ? noteOps : [];
  if (!ops.length) return String(currentNoteText || "");

  const existingSections = parseComposedNoteSections(currentNoteText);
  const isStructured = Object.keys(existingSections).length > 0;
  const sections = { ...existingSections };

  for (const op of ops) {
    const key =
      NOTE_SECTION_ALIASES[
        String(op?.section || "")
          .toLowerCase()
          .replace(/[^a-z]/g, "")
      ];
    if (!key) continue;
    const text = String(op?.text || op?.target || "").trim();
    if (!text) continue;
    const list = sections[key] ? [...sections[key]] : [];
    if (String(op.action).toLowerCase() === "remove") {
      const idx = list.findIndex((b) => b.toLowerCase() === text.toLowerCase());
      if (idx >= 0) list.splice(idx, 1);
    } else if (!list.some((b) => b.toLowerCase() === text.toLowerCase())) {
      list.push(text);
    }
    sections[key] = list;
  }

  if (isStructured) {
    return composeNoteFromSections(sections) || String(currentNoteText || "");
  }

  // Freeform/unstructured note (e.g. hand-typed or SOAP): never rewrite it —
  // only append newly requested bullets so nothing existing is ever lost.
  const appended = NOTE_SECTION_ORDER.filter(
    ([key]) => sections[key]?.length,
  ).map(
    ([key, label]) =>
      `${label}:\n${sections[key].map((item) => `• ${item}`).join("\n")}`,
  );
  if (!appended.length) return String(currentNoteText || "");
  const base = String(currentNoteText || "").trim();
  return base ? `${base}\n\n${appended.join("\n\n")}` : appended.join("\n\n");
}

function itemOrigin(item) {
  const raw = String(item?.origin || "").toLowerCase();
  if (raw === "visit") return "visit";
  if (raw === "review") return "review";
  // Fallback: stop rows / continue rows are visit; plain adds are review.
  const action = String(item?.action || "add").toLowerCase();
  if (action === "stop" || action === "continue" || action === "on_visit") {
    return "visit";
  }
  return "review";
}

function nameKey(item) {
  return String(
    typeof item === "string" ? item : item?.name || item?.correctedName || "",
  )
    .trim()
    .toLowerCase();
}

/**
 * Applies a compact model PATCH onto the on-screen chart.
 * Enforces: review-origin → remove (drop); visit-origin → stop (delete-from-visit).
 */
function mergeChartDelta(currentChart, delta) {
  const chart =
    currentChart && typeof currentChart === "object" ? currentChart : {};
  const d = delta && typeof delta === "object" ? delta : {};

  let medicines = Array.isArray(chart.medicines) ? [...chart.medicines] : [];
  let labTests = Array.isArray(chart.labTests) ? [...chart.labTests] : [];
  let procedures = Array.isArray(chart.procedures) ? [...chart.procedures] : [];

  if (d.clearReviewMedicines) {
    medicines = medicines.filter((m) => itemOrigin(m) !== "review");
  }
  if (d.clearReviewLabs) {
    labTests = labTests.filter((t) => itemOrigin(t) !== "review");
  }
  if (d.clearReviewProcedures) {
    procedures = procedures.filter((p) => itemOrigin(p) !== "review");
  }
  if (d.stopAllVisitMedicines) {
    medicines = medicines.map((m) =>
      itemOrigin(m) === "visit"
        ? {
            ...m,
            action: "stop",
            directions: m.directions || "Stop this medicine",
          }
        : m,
    );
  }
  if (d.stopAllVisitLabs) {
    labTests = labTests.map((t) =>
      itemOrigin(t) === "visit"
        ? {
            ...(typeof t === "string" ? { name: t } : t),
            action: "stop",
            origin: "visit",
          }
        : t,
    );
  }

  for (const op of Array.isArray(d.medicineOps) ? d.medicineOps : []) {
    const matchName = String(op?.match || "")
      .trim()
      .toLowerCase();
    const activeIdx = medicines.findIndex(
      (m) =>
        nameKey(m) === matchName &&
        String(m?.action || "add").toLowerCase() !== "stop",
    );
    let kind = String(op?.op || "").toLowerCase();

    // Coerce stop/remove from the matched row's origin (never trust the model alone).
    if ((kind === "stop" || kind === "remove") && activeIdx >= 0) {
      kind = itemOrigin(medicines[activeIdx]) === "visit" ? "stop" : "remove";
    } else if (kind === "stop" || kind === "remove") {
      // Match may already be a stop row, or only exist as visit context.
      const anyIdx = medicines.findIndex((m) => nameKey(m) === matchName);
      if (anyIdx >= 0) {
        kind = itemOrigin(medicines[anyIdx]) === "visit" ? "stop" : "remove";
      }
    }

    if (kind === "add" && op.medicine) {
      // Always add a review draft row — same as AI Write, even if already on visit.
      medicines.push({
        ...op.medicine,
        generic_name: "",
        action: "add",
        origin: "review",
      });
    } else if (kind === "edit" && op.medicine) {
      if (activeIdx >= 0) {
        const prev = medicines[activeIdx];
        if (itemOrigin(prev) === "visit") {
          // Don't overwrite visit context — add a review copy (AI Write style).
          medicines.push({
            ...op.medicine,
            generic_name: "",
            action: "add",
            origin: "review",
          });
        } else {
          medicines[activeIdx] = {
            ...op.medicine,
            generic_name: "",
            action: "add",
            origin: "review",
          };
        }
      } else {
        medicines.push({
          ...op.medicine,
          generic_name: "",
          action: "add",
          origin: "review",
        });
      }
    } else if (kind === "stop") {
      if (activeIdx >= 0) {
        const [existing] = medicines.splice(activeIdx, 1);
        // Review-origin must never become a visit-delete row.
        if (itemOrigin(existing) === "review") continue;
        medicines.push({
          ...existing,
          action: "stop",
          origin: "visit",
          directions: "Stop this medicine",
        });
      } else if (op.medicine || matchName) {
        medicines.push({
          ...(op.medicine || { name: op.match }),
          action: "stop",
          origin: "visit",
          directions: "Stop this medicine",
        });
      }
    } else if (kind === "remove") {
      medicines = medicines.filter((m) => {
        if (nameKey(m) !== matchName) return true;
        // Visit-origin: convert to stop instead of dropping.
        return false;
      });
      // If the matched row was visit and we filtered it out above wrongly —
      // re-check: remove should only drop review rows; visit rows → stop.
      const visitMatch = (
        Array.isArray(chart.medicines) ? chart.medicines : []
      ).find((m) => nameKey(m) === matchName && itemOrigin(m) === "visit");
      if (
        visitMatch &&
        !medicines.some(
          (m) =>
            nameKey(m) === matchName &&
            String(m?.action || "").toLowerCase() === "stop",
        )
      ) {
        medicines.push({
          ...visitMatch,
          action: "stop",
          origin: "visit",
          directions: "Stop this medicine",
        });
      }
    }
  }

  for (const op of Array.isArray(d.labOps) ? d.labOps : []) {
    let kind = String(op?.op || "").toLowerCase();
    const target = String(op?.match || op?.name || "")
      .trim()
      .toLowerCase();
    const idx = labTests.findIndex((t) => nameKey(t) === target);
    if ((kind === "stop" || kind === "remove") && idx >= 0) {
      kind = itemOrigin(labTests[idx]) === "visit" ? "stop" : "remove";
    }

    if (kind === "add" && op.name) {
      // Allow add even when lab is already on the visit (on_visit) — like AI Write.
      // Only skip if this review draft already has the same lab as an add.
      const alreadyReviewAdd = labTests.some(
        (t) =>
          nameKey(t) === String(op.name).toLowerCase() &&
          itemOrigin(t) === "review" &&
          String(t?.action || "add").toLowerCase() === "add",
      );
      if (!alreadyReviewAdd) {
        labTests.push({ name: op.name, action: "add", origin: "review" });
      }
    } else if (kind === "remove" && target) {
      const wasVisit =
        idx >= 0
          ? itemOrigin(labTests[idx]) === "visit"
          : (Array.isArray(chart.labTests) ? chart.labTests : []).some(
              (t) => nameKey(t) === target && itemOrigin(t) === "visit",
            );
      labTests = labTests.filter((t) => nameKey(t) !== target);
      if (wasVisit) {
        labTests.push({
          name: op.match || op.name,
          action: "stop",
          origin: "visit",
        });
      }
    } else if (kind === "stop" && target) {
      if (idx >= 0) {
        const [existing] = labTests.splice(idx, 1);
        if (itemOrigin(existing) === "review") {
          // drop — do not queue visit-delete for review drafts
        } else {
          labTests.push({
            ...(typeof existing === "string" ? { name: existing } : existing),
            action: "stop",
            origin: "visit",
          });
        }
      } else {
        labTests.push({
          name: op.match || op.name,
          action: "stop",
          origin: "visit",
        });
      }
    }
  }

  for (const op of Array.isArray(d.procedureOps) ? d.procedureOps : []) {
    let kind = String(op?.op || "").toLowerCase();
    const target = String(op?.match || op?.name || "")
      .trim()
      .toLowerCase();
    const idx = procedures.findIndex((p) => nameKey(p) === target);
    if ((kind === "stop" || kind === "remove") && idx >= 0) {
      kind = itemOrigin(procedures[idx]) === "visit" ? "stop" : "remove";
    }

    if (kind === "add" && op.name) {
      const alreadyReviewAdd = procedures.some(
        (p) =>
          nameKey(p) === String(op.name).toLowerCase() &&
          itemOrigin(p) === "review" &&
          String(p?.action || "add").toLowerCase() === "add",
      );
      if (!alreadyReviewAdd) {
        procedures.push({ name: op.name, action: "add", origin: "review" });
      }
    } else if (kind === "remove" && target) {
      procedures = procedures.filter((p) => nameKey(p) !== target);
    } else if (kind === "stop" && target) {
      if (idx >= 0) {
        const [existing] = procedures.splice(idx, 1);
        if (itemOrigin(existing) !== "review") {
          procedures.push({
            ...(typeof existing === "string" ? { name: existing } : existing),
            action: "stop",
            origin: "visit",
          });
        }
      }
    }
  }

  const vitals = { ...(chart.vitals || {}), ...(d.vitalsPatch || {}) };
  let doctorNotes = d.clearNote
    ? ""
    : mergeNoteWithOps(chart.doctorNotes, d.noteOps);

  // Strip visit-only "continue/on_visit" rows from the outgoing chart — they are
  // context for matching, not Review draft items. Keep add + stop only.
  medicines = medicines.filter((m) => {
    const action = String(m?.action || "add").toLowerCase();
    return action === "add" || action === "stop";
  });
  labTests = labTests.filter((t) => {
    const action = String(
      typeof t === "string" ? "add" : t?.action || "add",
    ).toLowerCase();
    return action === "add" || action === "stop";
  });
  procedures = procedures.filter((p) => {
    const action = String(
      typeof p === "string" ? "add" : p?.action || "add",
    ).toLowerCase();
    return action === "add" || action === "stop";
  });

  return { medicines, labTests, procedures, vitals, doctorNotes };
}

/** Expands a single new/edited medicine into taper steps only when it looks packed — cheap, targeted. */
async function expandTaperForSingleMedicine(medicine, instruction) {
  if (!medicine) return [medicine];
  const expanded = await expandPackedTapersWithAi([medicine], instruction);
  return Array.isArray(expanded) && expanded.length ? expanded : [medicine];
}

/** Runs taper-expansion only on the medicines the model actually touched this turn. */
async function expandTapersInMedicineOps(medicineOps, instruction) {
  const ops = Array.isArray(medicineOps) ? medicineOps : [];
  const expandedOps = [];
  for (const op of ops) {
    const kind = String(op?.op || "").toLowerCase();
    if ((kind === "add" || kind === "edit") && op.medicine) {
      const steps = await expandTaperForSingleMedicine(
        op.medicine,
        instruction,
      );
      expandedOps.push({ ...op, medicine: steps[0] });
      for (let i = 1; i < steps.length; i += 1) {
        expandedOps.push({ op: "add", medicine: steps[i] });
      }
    } else {
      expandedOps.push(op);
    }
  }
  return expandedOps;
}

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
    const rewritten = compactSoapLabels(
      stripMarkdownFormatting(response.data.choices[0].message.content),
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

function finalizeParsedClinicalNote(parsed, existingContext) {
  // Pass through model medicines/labs/procedures — no clinical rewrite.
  // Drop generic_name: name alone is brand or generic as spoken; salt field causes swaps.
  const medicines = (
    Array.isArray(parsed.medicines) ? parsed.medicines : []
  ).map((med) => {
    if (!med || typeof med !== "object") return med;
    const { generic_name: _g, genericName: _g2, ...rest } = med;
    return { ...rest, generic_name: "" };
  });
  const labTests = Array.isArray(parsed.labTests)
    ? parsed.labTests
    : Array.isArray(parsed.lab_tests)
      ? parsed.lab_tests
      : [];
  const procedures = Array.isArray(parsed.procedures) ? parsed.procedures : [];
  const noteSections = normalizeNoteSections(
    parsed.noteSections || parsed.note_sections || parsed.sections,
  );
  const freeTextNote = compactSoapLabels(
    String(
      parsed.doctorNotes || parsed.doctorNote || parsed.notes || "",
    ).trim(),
  );
  const sectionNote = composeNoteFromSections(noteSections);
  const isSoapNote = /^\s*[SOAP]\s*:/m.test(freeTextNote);

  return {
    noteFormat: String(parsed.noteFormat || "narrative").trim(),
    assistantReply: String(parsed.assistantReply || parsed.reply || "").trim(),
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
    vitals: normalizeParsedVitals(
      parsed.vitals || parsed.vitalSigns || parsed.vital_signs,
    ),
    medicinesToApply: medicines.filter(
      (med) => String(med?.action || "add").toLowerCase() === "add",
    ),
    medicinesToStop: medicines.filter(
      (med) => String(med?.action || "").toLowerCase() === "stop",
    ),
    labTestsToApply: labTests
      .filter(
        (test) =>
          typeof test === "string" ||
          String(test?.action || "add").toLowerCase() === "add",
      )
      .map((test) => (typeof test === "string" ? test : test.name)),
    proceduresToApply: procedures.filter(
      (proc) => String(proc?.action || "add").toLowerCase() === "add",
    ),
    noteOperations: normalizeParsedNoteOperations(
      parsed.noteOperations || parsed.note_operations,
      existingContext,
    ),
    doctorNotes: isSoapNote && freeTextNote ? freeTextNote : sectionNote,
    noteSections,
  };
}

function extractJsonObject(content) {
  const trimmed = String(content || "").trim();
  const jsonMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  return jsonMatch ? jsonMatch[1] : trimmed;
}

/** Parse chart JSON; repair common Gemini truncations on large consults. */
function parseClinicalNoteJson(content) {
  const raw = extractJsonObject(content);
  try {
    return JSON.parse(raw);
  } catch (firstError) {
    try {
      return repairTruncatedJsonObject(raw);
    } catch {
      throw firstError;
    }
  }
}

function buildPatientContextLine({ age, gender, allergies }) {
  const contextParts = [];
  if (age) contextParts.push(`age ${age}`);
  if (gender) contextParts.push(`gender ${gender}`);
  if (allergies) contextParts.push(`allergies: ${allergies}`);
  return contextParts.join(", ");
}

/** Pure questions — do not re-run chart extraction. */
function isChartQuestionOnly(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (
    /\b(fever|cough|pain|advise|adv\b|tab|mg|bd|od|tds|cbc|cbp|lft|post\b|h\/o|k\/c\/o|dolo|remove|add |stop |delete|clear)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  return /^(what|what's|whats|how|show|summarize|summary|recap|list|tell me|do we have|anything else)\b|\?$/.test(
    t,
  );
}

/** Small talk / greetings — reply only, never touch the chart. */
function isGreetingOnly(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!.,?…]+$/g, "")
    .trim();
  if (!t || t.length > 48) return false;
  if (
    /\b(fever|cough|pain|advise|adv\b|tab|mg|bd|od|tds|cbc|cbp|lft|post\b|h\/o|k\/c\/o|dolo|pantop|remove|add |stop |delete|clear|change|update)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  return /^(hi|hello|hey|hola|namaste|yo|sup|hiya|howdy|good\s*(morning|afternoon|evening)|thanks|thank\s*you|thx|ty)(\s+(there|doc|doctor|again))?$/.test(
    t,
  );
}

function greetingAssistantReply(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!.,?…]+$/g, "")
    .trim();
  if (/^good\s*morning/.test(t)) {
    return "Good morning! What would you like to change on the chart?";
  }
  if (/^good\s*afternoon/.test(t)) {
    return "Good afternoon! What would you like to change on the chart?";
  }
  if (/^good\s*evening/.test(t)) {
    return "Good evening! What would you like to change on the chart?";
  }
  if (/^(thanks|thank\s*you|thx|ty)/.test(t)) {
    return "You're welcome — ready when you are.";
  }
  if (/^(hey|hiya|yo|sup|howdy)/.test(t)) {
    return "Hey! Tell me what to update on the chart.";
  }
  return "Hi! What would you like to change on the chart?";
}

function draftResultFromPayload(draftPayload = {}) {
  const medicines = Array.isArray(draftPayload.medicines)
    ? draftPayload.medicines
    : [];
  const labTests = Array.isArray(draftPayload.labTests)
    ? draftPayload.labTests
    : [];
  const procedures = Array.isArray(draftPayload.procedures)
    ? draftPayload.procedures
    : [];
  const doctorNotes = String(draftPayload.doctorNotes || "").trim();
  return {
    noteFormat: "labeled",
    assistantReply: "",
    symptoms: "",
    pastMedicalHistory: "",
    provisionalDiagnosis: "",
    medicines,
    labTests,
    procedures,
    vitals: draftPayload.vitals || {},
    medicinesToApply: medicines.filter(
      (med) => String(med?.action || "add").toLowerCase() === "add",
    ),
    medicinesToStop: Array.isArray(draftPayload.medicinesToStop)
      ? draftPayload.medicinesToStop
      : medicines.filter(
          (med) => String(med?.action || "").toLowerCase() === "stop",
        ),
    labTestsToApply: labTests
      .filter((test) => String(test?.action || "add").toLowerCase() === "add")
      .map((test) => test.name),
    proceduresToApply: procedures.filter(
      (proc) => String(proc?.action || "add").toLowerCase() === "add",
    ),
    noteOperations: [],
    doctorNotes,
  };
}

function summarizeDraftForReply(result) {
  const bits = [];
  if (result.doctorNotes?.trim()) {
    bits.push(`Note:\n${result.doctorNotes.trim()}`);
  }
  const meds = (result.medicinesToApply || result.medicines || [])
    .map((med) => med.description || med.correctedName || med.name)
    .filter(Boolean);
  if (meds.length) bits.push(`Medicines: ${meds.join(", ")}`);
  const labs = result.labTestsToApply?.length
    ? result.labTestsToApply
    : (result.labTests || []).map((lab) => lab.name || lab).filter(Boolean);
  if (labs.length) bits.push(`Labs: ${labs.join(", ")}`);
  if (!bits.length)
    return "Nothing in the working chart yet — send clinical details.";
  return `Here's what we have so far:\n\n${bits.join("\n\n")}`;
}

function buildExtractionReply(result, latestUserText) {
  if (isChartQuestionOnly(latestUserText)) {
    return summarizeDraftForReply(result);
  }
  const parts = [];
  if (result.doctorNotes?.trim()) parts.push("Updated the clinical note");
  const medCount = (result.medicinesToApply || []).length;
  const labCount = (result.labTestsToApply || []).length;
  const stopCount = (result.medicinesToStop || []).length;
  if (medCount) {
    parts.push(
      `${medCount} medicine${medCount === 1 ? "" : "s"}: ${(
        result.medicinesToApply || []
      )
        .map((med) => med.description || med.name)
        .filter(Boolean)
        .join(", ")}`,
    );
  }
  if (labCount) {
    parts.push(`Labs: ${(result.labTestsToApply || []).join(", ")}`);
  }
  if (stopCount) {
    parts.push(
      `Stop: ${(result.medicinesToStop || [])
        .map((med) => med.description || med.name)
        .filter(Boolean)
        .join(", ")}`,
    );
  }
  if (!parts.length) {
    return "Got it. Send more clinical details, meds, or labs whenever you're ready.";
  }
  return `${parts.join(". ")}. Anything else?`;
}

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
      existingContext,
      mode = "replace",
      clinicalSetting = "opd",
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

    const context = buildPatientContextLine({ age, gender, allergies });

    let response;
    try {
      response = await callParseClinicalNoteCompletion([
        {
          role: "system",
          content: PARSE_CLINICAL_NOTE_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: PARSE_CLINICAL_NOTE_USER_PROMPT(
            clinicalNote,
            context,
            existingContext,
            mode,
            clinicalSetting,
          ),
        },
      ]);
    } catch (apiError) {
      console.error(
        "Gemini AI Write parse error:",
        apiError?.response?.data || apiError.message,
      );
      return res.status(apiError?.status === 503 ? 503 : 502).json({
        error: "Failed to contact Gemini for AI Write",
        details: apiError?.response?.data || apiError.message,
      });
    }

    if (
      !response?.data?.choices ||
      !response.data.choices[0]?.message?.content
    ) {
      return res
        .status(500)
        .json({ error: "Invalid response from Gemini AI Write" });
    }

    let content = response.data.choices[0].message.content.trim();
    let finishReason = String(
      response.data.choices[0].finish_reason || "",
    ).toLowerCase();

    let parsed;
    try {
      parsed = parseClinicalNoteJson(content);
    } catch (parseError) {
      // Truncated mid-medicine JSON on big consults — one higher-budget retry.
      if (finishReason === "length" || content.length > 2000) {
        console.warn(
          "AI Write JSON truncated/invalid; retrying with higher output budget…",
          parseError.message,
        );
        try {
          response = await callParseClinicalNoteCompletion(
            [
              {
                role: "system",
                content: PARSE_CLINICAL_NOTE_SYSTEM_PROMPT,
              },
              {
                role: "user",
                content: `${PARSE_CLINICAL_NOTE_USER_PROMPT(
                  clinicalNote,
                  context,
                  existingContext,
                  mode,
                  clinicalSetting,
                )}\n\nIMPORTANT: Previous answer was truncated. Return COMPLETE valid JSON for the full chart. Prefer compact fields; do not omit medicines/labs that were dictated.`,
              },
            ],
            {
              timeoutMs: Math.min(PARSE_NOTE_TIMEOUT_MS + 30000, 120000),
              maxTokens: PARSE_NOTE_RETRY_MAX_TOKENS,
            },
          );
          content = response.data.choices[0].message.content.trim();
          finishReason = String(
            response.data.choices[0].finish_reason || "",
          ).toLowerCase();
          parsed = parseClinicalNoteJson(content);
        } catch (retryError) {
          console.error("Error parsing AI response after retry:", retryError);
          console.error("AI Response:", content?.slice?.(0, 4000) || content);
          return res.status(500).json({
            error:
              "AI Write response was too large / truncated. Try a shorter note, or try Extract again.",
            details: retryError.message || parseError.message,
          });
        }
      } else {
        console.error("Error parsing AI response:", parseError);
        console.error("AI Response:", content?.slice?.(0, 4000) || content);
        return res.status(500).json({
          error: "Failed to parse AI response",
          details: parseError.message,
        });
      }
    }

    try {
      const withMedicinePasses = await applyAiOnlyMedicinePasses(
        parsed,
        clinicalNote,
      );
      res.json(finalizeParsedClinicalNote(withMedicinePasses, existingContext));
    } catch (postError) {
      console.error("Error finalizing clinical note:", postError);
      res.status(500).json({
        error: "Failed to finalize clinical note",
        details: postError.message,
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

/**
 * POST /review-followup
 * AI Write Review, chat-style corrections. Same extraction engine as AI Write,
 * but starts from the doctor's CURRENT on-screen chart (including hand edits)
 * and applies only the new instruction — untouched fields are preserved as-is.
 * Body: { instruction, currentChart, age?, gender?, allergies?, existingContext?, clinicalSetting? }
 */
router.post("/review-followup", async (req, res) => {
  try {
    const {
      instruction,
      currentChart,
      age,
      gender,
      allergies,
      existingContext,
      clinicalSetting = "opd",
    } = req.body;

    if (
      !instruction ||
      typeof instruction !== "string" ||
      !instruction.trim()
    ) {
      return res.status(400).json({
        error: "instruction is required and must be a non-empty string",
      });
    }

    const chart =
      currentChart && typeof currentChart === "object" ? currentChart : {};

    // Greetings / small talk — natural reply only, never rewrite the chart.
    if (isGreetingOnly(instruction)) {
      const kept = draftResultFromPayload(chart);
      kept.assistantReply = greetingAssistantReply(instruction);
      return res.json(kept);
    }

    // Pure questions ("what's on the chart?") — reply only, never rewrite the chart.
    if (isChartQuestionOnly(instruction)) {
      const kept = draftResultFromPayload(chart);
      kept.assistantReply = summarizeDraftForReply(kept);
      return res.json(kept);
    }

    const context = buildPatientContextLine({ age, gender, allergies });
    const followUpMessages = [
      {
        role: "system",
        content: `${PARSE_CLINICAL_NOTE_SYSTEM_PROMPT}${REVIEW_FOLLOWUP_SYSTEM_ADDENDUM}`,
      },
      {
        role: "user",
        content: REVIEW_FOLLOWUP_USER_PROMPT(
          instruction,
          chart,
          context,
          existingContext,
          clinicalSetting,
        ),
      },
    ];

    let response;
    try {
      response = await callParseClinicalNoteCompletion(followUpMessages, {
        timeoutMs: Math.min(PARSE_NOTE_TIMEOUT_MS, 30000),
        maxTokens: REVIEW_FOLLOWUP_DELTA_MAX_TOKENS,
      });
    } catch (apiError) {
      console.error(
        "Gemini review follow-up error:",
        apiError?.response?.data || apiError.message,
      );
      return res.status(apiError?.status === 503 ? 503 : 502).json({
        error: "Failed to contact Gemini for AI Write",
        details: apiError?.response?.data || apiError.message,
      });
    }

    if (
      !response?.data?.choices ||
      !response.data.choices[0]?.message?.content
    ) {
      return res
        .status(500)
        .json({ error: "Invalid response from Gemini AI Write" });
    }

    let content = response.data.choices[0].message.content.trim();
    let finishReason = String(
      response.data.choices[0].finish_reason || "",
    ).toLowerCase();
    // Normalize Gemini finish reasons to the OpenAI-style checks below.
    if (finishReason === "max_tokens" || finishReason === "length") {
      finishReason = "length";
    }
    let delta;

    try {
      delta = parseFollowUpDeltaJson(content);
    } catch (parseError) {
      // Truncation / invalid JSON — one stern retry with a tiny patch budget.
      console.warn(
        "Review follow-up JSON parse failed; retrying compact patch…",
        parseError.message,
      );
      try {
        const retry = await callParseClinicalNoteCompletion(
          [
            ...followUpMessages,
            { role: "assistant", content },
            {
              role: "user",
              content: `Your previous JSON was invalid or truncated (finish_reason=${finishReason || "unknown"}). Return a MINIMAL valid patch only for what INSTRUCTION changes — medicineOps MUST NOT re-list unchanged medicines. Prefer empty medicineOps if the instruction is about note/labs only. Valid complete JSON object only.`,
            },
          ],
          {
            timeoutMs: Math.min(PARSE_NOTE_TIMEOUT_MS, 30000),
            maxTokens: REVIEW_FOLLOWUP_DELTA_RETRY_MAX_TOKENS,
          },
        );
        content = retry?.data?.choices?.[0]?.message?.content?.trim() || "";
        finishReason = retry?.data?.choices?.[0]?.finish_reason;
        delta = parseFollowUpDeltaJson(content);
      } catch (retryError) {
        console.error("Error parsing review follow-up response:", parseError);
        console.error("AI Response:", content);
        return res.status(500).json({
          error: "Failed to parse AI response",
          details: parseError.message,
        });
      }
    }

    // Token-length truncation — retry once with a stern "minimal patch" nudge.
    if (finishReason === "length") {
      try {
        console.warn(
          `Review follow-up truncated (medicineOps=${
            Array.isArray(delta?.medicineOps) ? delta.medicineOps.length : 0
          }); retrying compact patch…`,
        );
        const retry = await callParseClinicalNoteCompletion(
          [
            ...followUpMessages,
            {
              role: "user",
              content: `Previous answer was truncated (finish_reason=length). Re-answer with a MINIMAL complete JSON patch for INSTRUCTION only. Do NOT re-list unchanged medicines as edit. Prefer ≤6 ops. Empty medicineOps if the instruction is not about medicines.`,
            },
          ],
          {
            timeoutMs: Math.min(PARSE_NOTE_TIMEOUT_MS, 30000),
            maxTokens: REVIEW_FOLLOWUP_DELTA_RETRY_MAX_TOKENS,
          },
        );
        const retryContent =
          retry?.data?.choices?.[0]?.message?.content?.trim() || "";
        if (retryContent) {
          content = retryContent;
          finishReason = retry?.data?.choices?.[0]?.finish_reason;
          delta = parseFollowUpDeltaJson(content);
        }
      } catch (retryError) {
        console.warn(
          "Compact retry after length truncation failed; using repaired first delta.",
          retryError.message,
        );
      }
    }

    try {
      delta.medicineOps = pruneNoOpMedicineOps(delta.medicineOps, chart);

      // Taper-expand only the medicine(s) this turn actually touched — cheap,
      // instead of re-running it over the whole chart every time.
      const medicineOps = await expandTapersInMedicineOps(
        delta.medicineOps,
        instruction,
      );

      const merged = mergeChartDelta(chart, { ...delta, medicineOps });

      const result = finalizeParsedClinicalNote(
        {
          medicines: merged.medicines,
          labTests: merged.labTests.filter(
            (t) =>
              typeof t === "string" ||
              String(t?.action || "add").toLowerCase() === "add",
          ),
          procedures: merged.procedures.filter(
            (p) =>
              typeof p === "string" ||
              String(p?.action || "add").toLowerCase() !== "stop",
          ),
          vitals: merged.vitals,
        },
        existingContext,
      );
      // finalize composes doctorNotes from noteSections, which we didn't pass
      // (the note was already merged surgically) — set the real value now.
      result.doctorNotes = merged.doctorNotes;
      // Visit-origin labs queued for Delete-from-this-visit (not in labTestsToApply).
      result.labTestsToStop = merged.labTests
        .filter(
          (t) =>
            typeof t !== "string" &&
            String(t?.action || "").toLowerCase() === "stop",
        )
        .map((t) => ({ name: t.name || "", action: "stop" }))
        .filter((t) => t.name);
      // medicinesToStop already comes from finalize (action "stop").
      // Strip any review-origin stop that slipped through.
      result.medicinesToStop = (result.medicinesToStop || []).filter(
        (m) => String(m?.origin || "visit").toLowerCase() !== "review",
      );
      result.assistantReply =
        String(delta.assistantReply || "").trim() ||
        buildExtractionReply(result, instruction);
      res.json(result);
    } catch (parseError) {
      console.error("Error parsing review follow-up response:", parseError);
      console.error("AI Response:", content);
      res.status(500).json({
        error: "Failed to parse AI response",
        details: parseError.message,
      });
    }
  } catch (error) {
    console.error("Error in review follow-up:", error);
    res.status(500).json({
      error: "Failed to process review follow-up",
      details: error.message,
    });
  }
});

/**
 * POST /review-followup/reply-stream
 * Live "typing" confirmation for the Review follow-up chat. Separate, tiny,
 * plain-text streamed call — runs in parallel with /review-followup so the
 * doctor sees a reply appear immediately while the (now much smaller) chart
 * patch is still being computed.
 * Body: { instruction, currentChart }
 */
router.post("/review-followup/reply-stream", async (req, res) => {
  const { instruction, currentChart } = req.body || {};

  if (!instruction || typeof instruction !== "string" || !instruction.trim()) {
    res.status(400).end("instruction is required");
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  // Greetings / questions — instant reply, no model call.
  if (isGreetingOnly(instruction)) {
    res.write(greetingAssistantReply(instruction));
    res.end();
    return;
  }
  if (isChartQuestionOnly(instruction)) {
    const kept = draftResultFromPayload(
      currentChart && typeof currentChart === "object" ? currentChart : {},
    );
    res.write(summarizeDraftForReply(kept));
    res.end();
    return;
  }

  let upstream;
  try {
    upstream = await openaiApi.post(
      "/chat/completions",
      {
        // Tiny UI stream — keep on OpenAI; chart JSON uses Gemini PARSE_NOTE_MODEL.
        model: OPENAI_MODEL,
        stream: true,
        temperature: 0.2,
        max_tokens: REVIEW_FOLLOWUP_REPLY_MAX_TOKENS,
        messages: [
          {
            role: "system",
            content: REVIEW_FOLLOWUP_REPLY_STREAM_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: `CHART SUMMARY (context only — do not invent edits from this):\n${summarizeChartForReplyContext(
              currentChart,
            )}\n\nINSTRUCTION (confirm ONLY this):\n${instruction}\n\nReply with ONE short sentence confirming the instruction — nothing else.`,
          },
        ],
      },
      { responseType: "stream", timeout: 20000 },
    );
  } catch (apiError) {
    console.error(
      "Review reply stream error:",
      apiError?.response?.data || apiError.message,
    );
    res.write("Updating the chart…");
    res.end();
    return;
  }

  pipeOpenAiChatStreamToResponse(upstream, res);
});

/**
 * POST /parse-clinical-note/reply-stream
 * Live "typing" confirmation while AI Write Extract runs. Parallel with
 * /parse-clinical-note — short plain-text stream only (not the full JSON chart).
 * Body: { clinicalNote }
 */
router.post("/parse-clinical-note/reply-stream", async (req, res) => {
  const { clinicalNote } = req.body || {};

  if (
    !clinicalNote ||
    typeof clinicalNote !== "string" ||
    !clinicalNote.trim()
  ) {
    res.status(400).end("clinicalNote is required");
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  const noteSnippet = clinicalNote.trim().slice(0, 900);

  let upstream;
  try {
    upstream = await openaiApi.post(
      "/chat/completions",
      {
        // Tiny UI stream — keep on OpenAI; chart JSON uses Gemini PARSE_NOTE_MODEL.
        model: OPENAI_MODEL,
        stream: true,
        temperature: 0.2,
        max_tokens: REVIEW_FOLLOWUP_REPLY_MAX_TOKENS,
        messages: [
          {
            role: "system",
            content: PARSE_NOTE_REPLY_STREAM_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: `DOCTOR NOTE:\n${noteSnippet}\n\nReply with ONE short sentence confirming what you are writing/extracting.`,
          },
        ],
      },
      { responseType: "stream", timeout: 20000 },
    );
  } catch (apiError) {
    console.error(
      "Parse reply stream error:",
      apiError?.response?.data || apiError.message,
    );
    res.write("Writing the clinical chart…");
    res.end();
    return;
  }

  pipeOpenAiChatStreamToResponse(upstream, res);
});

module.exports = router;
