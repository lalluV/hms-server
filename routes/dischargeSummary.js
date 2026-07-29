const express = require("express");
const router = express.Router();
const axios = require("axios");
const {
  applyEntitlementsNoTenantDb,
} = require("../utils/applyTenantEntitlements");
const { runAiWriteVisitAgent } = require("../utils/aiWriteVisitAgent");

applyEntitlementsNoTenantDb(router, { moduleKey: "ipd" });

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-mini";
// Note parsing is the most instruction-sensitive call; override without a deploy if needed.
const PARSE_NOTE_MODEL = process.env.OPENAI_PARSE_MODEL || OPENAI_MODEL;
const PARSE_NOTE_TIMEOUT_MS =
  Number(process.env.OPENAI_PARSE_TIMEOUT_MS) || 60000;
const PARSE_NOTE_MAX_TOKENS =
  Number(process.env.OPENAI_PARSE_MAX_TOKENS) || 3500;

async function callParseClinicalNoteCompletion(
  messages,
  { timeoutMs = PARSE_NOTE_TIMEOUT_MS } = {},
) {
  const payload = {
    model: PARSE_NOTE_MODEL,
    messages,
    max_tokens: PARSE_NOTE_MAX_TOKENS,
    temperature: 0.1,
    top_p: 0.9,
    response_format: { type: "json_object" },
  };
  try {
    return await openaiApi.post("/chat/completions", payload, {
      timeout: timeoutMs,
    });
  } catch (firstError) {
    const timedOut =
      firstError?.code === "ECONNABORTED" ||
      /timeout/i.test(String(firstError?.message || ""));
    if (!timedOut) throw firstError;
    console.warn("Parse clinical note timed out; retrying once…");
    return openaiApi.post("/chat/completions", payload, {
      timeout: timeoutMs,
    });
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
- Keep brand in name; generic_name always "".
- directions: simple morning/afternoon/evening/night English (no twice/thrice/BD/OD/TDS as patient text).
- dosages: time, amount, beforeFood; unit "" for Tablet/Capsules; "puffs" for inhaler/puff; else short (ml|IU|drop|puffs|app|U|sach).

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
- Medicines, investigations, procedures, and measured vitals ordered or recorded now → structured fields only.
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

MEDICINE NAMES — BRAND ONLY
- name: spoken BRAND when a brand was spoken. Correct obvious misspellings when confident (e.g. dollo→Dolo, faropenam→Faropenem, azi/azithro→Azithromycin only when used as generic antibiotic shorthand). Never replace a brand with its generic chemical name in "name" (Pantop/PAN stays Pantop or PAN, not Pantoprazole; Dolo stays Dolo, not Paracetamol; Telma stays Telma).
- If unsure of spelling, keep EXACTLY as the doctor wrote.
- generic_name: ALWAYS leave "". Do NOT invent or guess salt/generic names (they are often wrong).
- Expand GENERIC-only shorthand when no brand was spoken (PCM→Paracetamol as the name). Keep strength in name when it distinguishes products.
- type from spoken form: tab→Tablet, inj→Injection, drops/eye drops/tears→Drops, syp→Syrup, ointment/cream→Ointment, inhaler/puff→Inhaler, etc.

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
- If duration is stated for a medicine, fill it.
- If several medicines are ordered in the same clause/list and only one shared duration is stated (e.g. "… bd 5d" covering the group), apply that duration to each med in that group.
- If no duration is stated for a NEW fixed daily add (OD/BD/TDS/QID/HS / morning-evening grid), default duration to "5 days".
- Leave duration "" for SOS/PRN, continue, note_only, weekly, alternate-day, sliding-scale, one-time/stat, or when the doctor clearly implies ongoing/chronic use without a course length.

DIRECTIONS (LAYMAN ENGLISH — REQUIRED)
- directions: simple Indian patient English. Never use twice, thrice, BD, OD, TDS, QID, HS, SOS, PRN as the only patient text.
- Use morning / afternoon / evening / night. Examples: "Take 1 tablet in the morning and 1 tablet in the evening for 5 days"; "Instill 2 drops in each eye in the morning, afternoon and evening for 7 days"; "Take 1 tablet only if fever".
- Map: OD→morning (or night if HS), BD→morning and evening, TDS→morning afternoon evening, QID→all four, HS→at night, SOS→only when needed / only if [reason].

DOSAGES GRID (M/A/E/N)
- For fixed daily schedules fill dosages[] with Morning/Afternoon/Evening/Night as needed.
- Each dosage object MUST include: time, amount (number), unit, beforeFood (true/false).
- Tablet or Capsules type: unit MUST be "" (empty). Never put tablet/tab/capsule in unit — grid shows amount only (½, 1, 2…).
- If the doctor says puff / puffs / inhaler: type Inhaler and EVERY dosages[].unit MUST be "puffs" (not empty, not puff singular).
- All other non-tablet types: unit MUST be a short form only — ml | IU | drop | puffs | app | U | sach. Never long words (tablet, millilitre, drops, application, international units).
- If doctor says before food / empty stomach → beforeFood true on those slots. After food → beforeFood false and mention after food in directions.
- Unequal same-day amounts (e.g. morning 10 IU and afternoon 15 IU) → one medicine, two dosage slots with correct amounts and unit "IU".
- Do NOT invent a daily grid for SOS / weekly / alternate-day / sliding-scale / conditional schedules; leave dosages [] and put clear text in directions.

LABS
- Current orders → labTests as separate items (split "CBP + LFT" into CBP and LFT).
- Do not duplicate the same lab.
- Phrases like "again if needed", "if required", "repeat if needed" are advice — put them in advice bullets; do NOT create extra labTests from conditional wording alone.
- Past results stay in history/examination narrative.

ORDERS AND NOTES
- action: add | continue | note_only | stop. Do not mark omitted existing items as stopped.
- Procedures only for this visit; future planned care → advice.
- Vitals: values only. Empty arrays/fields when unsupported.
- Labeled notes: use noteSections; leave doctorNotes "". SOAP only when existing format is SOAP.
- noteOperations: remove only an exact existing bullet the current input clearly corrects.

FINAL CHECK
- No complaints/symptoms text in diagnosis; diagnosis empty if no named disease/impression.
- Tapers = multiple medicines[] rows (never one packed taper object).
- Explicit stop/delete of a named drug = action "stop" row; course "then stop" stays action "add".
- name is brand; generic_name always "".
- directions are morning/afternoon/evening/night English (no twice/thrice).
- Tablet/Capsule dosages: unit ""; puff/inhaler → unit "puffs"; other forms: short unit only; beforeFood when known.
- Missing duration on fixed daily add → "5 days"; SOS/PRN/continue → duration "".
- Conditional labs are advice, not duplicate labTests.
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

const PARSE_CLINICAL_NOTE_USER_PROMPT = (
  clinicalNote,
  context,
  existingContext,
  mode = "replace",
  clinicalSetting = "opd",
) => {
  const compactExisting = compactExistingClinicalContext(existingContext);

  const settingLine =
    clinicalSetting === "ipd"
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

COMPLETENESS: Keep every clinical fact from CURRENT INPUT. Writing style may vary — expand shorthand into clear English and place each fact by meaning (past→history, symptoms→complaints only never diagnosis, exam→examination, named impression→diagnosis else leave diagnosis empty, plan/follow-up/if-needed→advice, today's orders→arrays). noteSections are bullet lists. name=brand; generic_name always "". Tapers = multiple medicines[] rows. Explicit stop/delete of a named drug = action stop. Tablet/Capsule unit ""; puff/inhaler unit "puffs"; other forms short unit only; beforeFood when known. Fixed daily add with no duration → "5 days"; SOS/PRN/continue → duration "". Do not drop clauses.

Return exactly this JSON shape:
{
  "noteFormat": "labeled or soap",
  "symptoms": "• bullet\\n• bullet",
  "pastMedicalHistory": "• bullet\\n• bullet",
  "provisionalDiagnosis": "• bullet\\n• bullet",
  "medicines": [{
    "sourceText": "",
    "name": "", "generic_name": "",
    "type": "Tablet|Capsules|Injection|Syrup|Ointment|Gel|Sachet|Syringe|Drops|Inhaler|Spray|Patch|Suppository|Other",
    "strength": "", "dosage": "", "frequency": "", "duration": "",
    "scheduleKind": "fixed_daily|interval|weekly|monthly|alternate_day|prn|sliding_scale|one_time|sequential|device_controlled|free_text",
    "directions": "",
    "dosages": [{ "time": "Morning|Afternoon|Evening|Night", "amount": 1, "unit": "\"\" for Tablet/Capsules; puffs for inhaler; else ml|IU|drop|puffs|app|U|sach", "beforeFood": false }],
    "action": "add|continue|note_only|stop"
  }],
  "labTests": [{"name": "", "action": "add|continue|note_only"}],
  "procedures": [{"name": "", "correctedName": "", "inventoryMatch": "", "action": "add|continue|note_only"}],
  "vitals": {
    "weight": "", "height": "", "temperature": "", "spo2": "",
    "heartRate": "", "respiratoryRate": "", "bloodPressure": ""
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
  "doctorNotes": ""
}

CURRENT INPUT:
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
  const medicines = Array.isArray(parsed.medicines) ? parsed.medicines : [];
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

function buildPatientContextLine({ age, gender, allergies }) {
  const contextParts = [];
  if (age) contextParts.push(`age ${age}`);
  if (gender) contextParts.push(`gender ${gender}`);
  if (allergies) contextParts.push(`allergies: ${allergies}`);
  return contextParts.join(", ");
}

/**
 * Shared AI Write extract — same rules/prompt/passes as /parse-clinical-note.
 */
async function parseClinicalNoteContent({
  clinicalNote,
  age,
  gender,
  allergies,
  existingContext,
  mode = "replace",
  clinicalSetting = "opd",
}) {
  const note = String(clinicalNote || "").trim();
  if (!note) {
    const err = new Error("clinicalNote is required");
    err.status = 400;
    throw err;
  }

  const context = buildPatientContextLine({ age, gender, allergies });
  const response = await callParseClinicalNoteCompletion([
    {
      role: "system",
      content: PARSE_CLINICAL_NOTE_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: PARSE_CLINICAL_NOTE_USER_PROMPT(
        note,
        context,
        existingContext,
        mode,
        clinicalSetting,
      ),
    },
  ]);

  if (!response?.data?.choices?.[0]?.message?.content) {
    const err = new Error("Invalid response from OpenAI API");
    err.status = 502;
    throw err;
  }

  const content = response.data.choices[0].message.content.trim();
  const parsed = JSON.parse(extractJsonObject(content));
  const withMedicinePasses = await applyAiOnlyMedicinePasses(parsed, note);
  return finalizeParsedClinicalNote(withMedicinePasses, existingContext);
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

    try {
      const result = await parseClinicalNoteContent({
        clinicalNote,
        age,
        gender,
        allergies,
        existingContext,
        mode,
        clinicalSetting,
      });
      return res.json(result);
    } catch (apiError) {
      if (apiError?.status === 400) {
        return res.status(400).json({ error: apiError.message });
      }
      if (
        apiError?.message === "Invalid response from OpenAI API" ||
        apiError?.response
      ) {
        console.error(
          "OpenAI API error:",
          apiError?.response?.data || apiError.message,
        );
        return res.status(502).json({
          error: "Failed to contact OpenAI API",
          details: apiError?.response?.data || apiError.message,
        });
      }
      if (apiError instanceof SyntaxError || /JSON/i.test(apiError.message)) {
        console.error("Error parsing AI response:", apiError);
        return res.status(500).json({
          error: "Failed to parse AI response",
          details: apiError.message,
        });
      }
      throw apiError;
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
 * POST /merge-clinical-draft
 * AI Write chat — conversational agent; clinical structuring uses AI Write extract rules.
 */
router.post("/merge-clinical-draft", async (req, res) => {
  try {
    const {
      deltaText,
      messages: chatMessages,
      currentDraft,
      age,
      gender,
      allergies,
      existingContext,
      clinicalSetting = "opd",
    } = req.body;

    const draftPayload =
      currentDraft && typeof currentDraft === "object" ? currentDraft : {};

    const result = await runAiWriteVisitAgent({
      messages: chatMessages,
      currentDraft: draftPayload,
      age,
      gender,
      allergies,
      existingContext,
      clinicalSetting,
      deltaText,
      parseClinicalNote: parseClinicalNoteContent,
    });

    return res.json(result);
  } catch (error) {
    console.error("Error in clinical chat:", error);
    const status = error.status || 500;
    return res.status(status).json({
      error: error.message || "Failed to process clinical chat",
      details: error.message,
    });
  }
});

module.exports = router;
