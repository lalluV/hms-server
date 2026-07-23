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

const {
  matchMedicineToCatalog,
  matchLabTestToCatalog,
  matchProcedureToCatalog,
} = require("../utils/clinicalNoteMatcher");

const PARSE_CLINICAL_NOTE_SYSTEM_PROMPT = `You are a medical scribe for an Indian hospital EMR (OPD and IPD progress notes). Extract structured data from doctor dictation, typed notes, voice-transcribed notes, or full consult transcripts (which may be noisy or mixed-language).

LANGUAGE (mandatory):
- doctorNotes MUST be clean, professional clinical English ONLY
- Never write Telugu, Hindi, or other non-English prose in doctorNotes
- Translate patient/doctor vernacular into clear English clinical language
- Keep standard medical abbreviations in English/Latin form (c/o, h/o, k/c/o, OD, BD, TDS, PRN, BP, SpO2)
- Medicine brand names may stay as spoken brands (Dolo, Telma) inside an otherwise English note

NOTE QUALITY (mandatory):
- Write a clean, save-ready progress note — not a raw transcript dump
- Remove filler, greetings, small talk, repetitions, and speech artifacts
- Organize findings under clear section LABELS (see FORMAT)
- Prefer concise clinical phrases (not long paragraphs)

FORMAT (critical):
- noteFormat must be one of: "labeled", "soap", "narrative", "bullet", "problem_oriented", "template"
- DEFAULT for unstructured consults / voice transcripts / mixed dictation: noteFormat "labeled"
- Labeled doctorNotes MUST use these English section headers (include a section only if content exists; skip empty ones):
  Complaints:
  History:
  Examination:
  Vitals:
  Diagnosis:
  Advice:
- Do NOT put Medicines, Investigations, or Procedures inside doctorNotes — those belong ONLY in the medicines[], labTests[], and procedures[] arrays (already shown as separate lists in the UI)
- Each label on its own line, ending with a colon
- Under EVERY labeled section, put content as unicode DOT bullets (•) — one clinical fact / advice per line
- Always use "• " (bullet + space), even when the section has only one item — never plain paragraphs or comma-lists under a label
- Do NOT use markdown dashes (-), asterisks (*), or numbered lists
- Vitals: one vital per bullet (e.g. • BP 120/80)
- Example:
  Complaints:
  • Fever for 3 days
  • Dry cough
  Diagnosis:
  • Acute febrile illness
  Advice:
  • Plenty of fluids
  (and medicines/labTests/procedures filled in their arrays — not duplicated in doctorNotes)
- If existing chart notes already use S:/O:/A:/P: SOAP letter labels, keep SOAP (noteFormat "soap") and use ONLY:
  S:
  O:
  A:
  P:
  Never write the words Subjective/Objective/Assessment/Plan as SOAP headers
  Under each SOAP letter, also use • bullets for readability
- If existing notes are clearly dense narrative paragraphs (not labeled), you may match that style; otherwise prefer labeled + • bullets
- NEVER force SOAP when there is no prior SOAP format — prefer labeled sections for new consult notes

RECOGNISE ORDERS (critical — always extract structured arrays):
- medicines[] = every drug/tablet/syrup/ointment/injection the doctor orders, starts, changes, continues, or stops
- labTests[] = every investigation/lab/imaging ordered or advised (CBC, LFT, X-ray, USG, ECG, dengue, etc.)
- procedures[] = every procedure/service ordered (dressing, nebulization, physiotherapy, suturing, etc.)
- Do NOT miss orders buried in conversation ("give him…", "start…", "advise…", "send…", "do…", "order…", "take…")
- Do NOT put labs/imaging in medicines, or medicines in labTests
- Also list ordered Medicines / Investigations / Procedures inside doctorNotes under those labeled sections (or under P: for SOAP)

EMBED ORDERS IN doctorNotes:
- "Continue current medications" → document in note; do NOT re-list every drug name unless doctor named them
- New medicines/tests/procedures → include in the labeled note sections AND in structured arrays with action "add"
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
- Fix misspellings and voice errors, but KEEP the doctor's spoken brand/product name — do NOT rewrite brands to generics for name/correctedName
- Brands stay brands: Dolo → Dolo (not Paracetamol); Crocin → Crocin; T-Bact / tbact → T-Bact; Telma → Telma; Montair → Montair; Asthalin → Asthalin; Augmentin → Augmentin
- Only use a generic as name/correctedName when the doctor spoke the generic (e.g. "paracetamol 650", "azithromycin")
- Abbreviations that are generics/aliases may expand only when no brand was spoken: PCM/Para → Paracetamol; Azithro → Azithromycin; Amox → Amoxicillin; Pantop → Pantoprazole
- Correct lab test spellings: "cb c"/"hemogram" → CBC; "liver function"/"lft" → LFT; "kft"/"rft" → KFT; "urine rm" → Urine R/M; "xray chest"/"cxr" → X-Ray Chest; "usg"/"sonography" → USG; "ecg"/"ekg" → ECG; "hba1c" → HbA1c; "blood sugar"/"rbs" → Random Blood Sugar; "fbs" → Fasting Blood Sugar; "ppbs" → Post Prandial Blood Sugar
- If a hospital catalog is provided, pick the closest matching catalog name for medicines and lab tests
- Never invent medicines or tests not mentioned in the note
- Never list the same medicine or lab test twice in one response

MEDICINE RULES:
- Return each medicine in the SAME shape as hospital master medicines / Rx objects (not a free-form invent)
- name / description: spoken brand OR product name as the doctor said it (e.g. "Dolo", "T-Bact", "Pantop"). Use generic ONLY if doctor said the generic
- generic_name: generic if known, else same as name
- type (REQUIRED when form is stated or clearly implied): one of Tablet | Syrup | Injection | Ointment | Capsules | Gel | Sachet | Syringe | Other
  - tab / tablet / tabs / oral tablet → Tablet
  - cap / capsule → Capsules
  - inj / injection / IV / IM / amp → Injection
  - syrup / syp / suspension → Syrup
  - ointment / cream / apply locally → Ointment (or Gel if gel)
  - If form not stated, default Tablet for typical OPD oral drugs (not Injection)
- dosage: REQUIRED for every medicine with action "add" — strength only (500mg, 650mg, 1 tab, 5ml). Never leave dosage empty for new orders. If the doctor omitted strength, use the standard adult dose for that drug when well-known (e.g. Paracetamol 500mg, Azithromycin 500mg, Pantoprazole 40mg); otherwise keep best inferred dose from context
- frequency: REQUIRED for every medicine with action "add" — OD, BD, TDS, QID, HS, SOS, or descriptive. Default BD if a course is clearly intended but freq omitted
- duration: REQUIRED for every medicine with action "add" — e.g. "5 days", "1 week". Default "5 days" if a course is ordered but days omitted
- instructions: before/after food, SOS only, etc.
- Do NOT invent item_code, manufacturer, or pack — leave those out (pharmacy maps stock later)
- correctedName / inventoryMatch: same as name/description (no catalog rewrite)
- action: "add" | "continue" | "note_only" | "stop"

LAB TEST / INVESTIGATION RULES:
- Return objects: { "name": "standardized test name", "action": "add" | "continue" | "note_only" }
- CRITICAL: Lab investigations must NEVER appear in medicines. Examples that are ALWAYS labTests (not medicines): CRP, CBC, ESR, LFT, KFT, RFT, HbA1c, TSH, T3, T4, FBS, PPBS, RBS, lipid profile, troponin, D-dimer, PT/INR, urine R/M, USG, ECG, X-ray, vitamin D, B12, dengue, widal, malaria smear
- Short orders like "advise CRP", "send CBC", "do LFT", "take x-ray" → labTests only

PROCEDURE RULES:
- Return objects: { "name": "procedure/service name", "action": "add" | "continue" | "note_only" }
- Match hospital procedure catalog when provided (wound care, dressing, nebulization, physiotherapy, etc.)
- Correct spelling of common procedures
- Never invent procedures not mentioned

CLINICAL FIELDS:
- symptoms: short English summary of chief complaints (also reflected under Complaints: in doctorNotes)
- provisionalDiagnosis: English diagnosis / impression when stated or clearly implied (also under Diagnosis: in doctorNotes)
- pastMedicalHistory: relevant PMH if mentioned; else empty string
- Handle Hindi-English / Telugu-English mixed input — but ALWAYS output doctorNotes and these fields in English only
- doctorNotes is the complete clean save-ready English clinical note (never raw transcript)
- Return valid JSON only`;

const VALID_NOTE_ACTIONS = new Set(["add", "continue", "note_only", "stop"]);

const LAB_NAME_HINTS = [
  "crp",
  "cbc",
  "esr",
  "lft",
  "kft",
  "rft",
  "hba1c",
  "tsh",
  "t3",
  "t4",
  "fbs",
  "ppbs",
  "rbs",
  "blood sugar",
  "lipid",
  "troponin",
  "d-dimer",
  "ddimer",
  "procalcitonin",
  "pt/inr",
  "inr",
  "aptt",
  "widal",
  "dengue",
  "ns1",
  "malaria",
  "urine",
  "usg",
  "ultrasound",
  "ecg",
  "ekg",
  "x-ray",
  "xray",
  "cxr",
  "vitamin d",
  "vitamin b12",
  "b12",
  "hiv",
  "hbsag",
  "hemogram",
  "haemogram",
  "thyroid",
  "renal function",
  "liver function",
  "complete blood",
];

function normalizeLabHint(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9/+ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeLabTestName(name) {
  const n = normalizeLabHint(name);
  if (!n) return false;
  if (
    LAB_NAME_HINTS.some(
      (hint) => n === hint || n.includes(hint) || hint.includes(n),
    )
  ) {
    return true;
  }
  return /\b(test|count|panel|profile|assay|titre|titer|function)\b/.test(n);
}

function reclassifyMisplacedLabs(medicines = [], labTests = []) {
  const nextLabs = [...labTests];
  const nextMedicines = [];

  for (const med of medicines) {
    const name = String(
      med.inventoryMatch || med.correctedName || med.name || "",
    ).trim();
    if (looksLikeLabTestName(name)) {
      const already = nextLabs.some(
        (test) =>
          normalizeLabHint(test.name || test) === normalizeLabHint(name),
      );
      if (!already) {
        nextLabs.push({
          name,
          action: med.action === "stop" ? "add" : med.action || "add",
        });
      }
      continue;
    }
    nextMedicines.push(med);
  }

  return { medicines: nextMedicines, labTests: nextLabs };
}

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
    med.correctedName || med.corrected_name || med.description || name,
  ).trim();
  const displayName = correctedName || name;
  const description = String(med.description || displayName).trim();
  const genericName = String(
    med.generic_name || med.genericName || displayName,
  ).trim();
  const type = String(med.type || med.form || med.medicineType || "")
    .trim();

  return {
    // Same field names as master medicines / PrescriptionForm manual add
    name: displayName,
    description,
    generic_name: genericName,
    generic_name2: String(med.generic_name2 || "").trim() || undefined,
    type: type || undefined,
    form: type || undefined,
    manufacturer: String(med.manufacturer || "").trim() || undefined,
    pack: String(med.pack || "").trim() || undefined,
    hsn_code: String(med.hsn_code || med.hsnCode || "").trim() || undefined,
    item_code: String(med.item_code || "").trim() || undefined,
    correctedName: displayName,
    inventoryMatch: displayName,
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
    correctedName: String(
      proc?.correctedName || proc?.corrected_name || name,
    ).trim(),
    inventoryMatch: String(
      proc?.inventoryMatch || proc?.inventory_match || name,
    ).trim(),
    action: normalizeNoteAction(proc.action),
  };
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

  // No local pharmacy / procedure catalogs — client resolves via master APIs.
  // Lab catalog is optional hint only when the client still sends one.

  if (Array.isArray(labCatalog) && labCatalog.length > 0) {
    catalogSection.push(
      `Hospital lab test catalog (use closest match for labTests):\n${JSON.stringify(labCatalog.slice(0, 250))}`,
    );
  }

  const settingLine =
    clinicalSetting === "ipd"
      ? `Clinical setting: IPD inpatient progress note. Match format of recent doctor notes. Newly mentioned labs and procedures in this dictation MUST use action "add" (not continue) unless the doctor explicitly says continue/same/already ordered. Only use continue when the item is already pending on the chart AND the doctor did not place a new order. action "stop" = discontinue medicine on chart. Medicines are NOT catalog-matched — return spoken brand + type (Tablet/Injection/Syrup/…) in master-medicine-shaped objects; pharmacy maps stock later. Extract vitals when mentioned (weight, height, BP, pulse, temp, SpO2, RR); never invent numbers.\n\n`
      : `Clinical setting: OPD outpatient visit. Extract ALL medicines, labs, and vitals (including weight/height) mentioned in the dictation. action "add" = add to this visit Rx. action "stop" = DELETE/remove from this visit prescription (not inpatient discontinue). Medicines are NOT catalog-matched — return spoken brand + type (Tablet/Injection/Syrup/…) with name/description/generic_name like master medicines; do not invent item_code.\n\n`;

  const existingSection = existingContext
    ? `EXISTING CHART & NOTE CONTEXT (use for format detection and continue vs add decisions):
${JSON.stringify(existingContext, null, 2)}

${
  mode === "add"
    ? `MODE "add" — doctor dictated NEW content to append:
- Extract medicines, labs, and clinical facts with the SAME completeness as a full visit parse (do not under-extract)
- doctorNotes = polished clinical fragment for ONLY the new dictation using labeled sections when appropriate. Do NOT copy/repeat the existing note
- ALWAYS extract every newly ordered medicine, investigation (labTests), and procedure — do not under-extract
- Prefer the spoken/written medicine name in "name" and "correctedName" (including brands like T-Bact). Do NOT invent a different catalog medicine for inventoryMatch unless the catalog clearly contains that product
- If unsure about inventoryMatch, set it equal to correctedName — never substitute a random ointment/cream/tablet
- Extract vitals/weight/height when mentioned; leave unmentioned vitals fields empty — never invent numbers
- Every new medicine MUST include dosage, frequency, and duration (days). Infer sensible defaults when omitted (e.g. ointment: Apply locally / BD / 5 days; tablet: 1 tab / BD / 5 days)
- Mark medicines/labs newly mentioned as action "add" unless doctor explicitly says continue/same/ongoing
- Lab abbreviations (CRP, CBC, LFT, etc.) go in labTests, never medicines
- Do NOT return empty medicines/labTests when the dictation clearly orders them
`
    : `MODE "replace" — doctor is revising the note/plan:
- Preserve detected format unless doctor clearly switches style
- action "add" for medicines/tests newly ordered in this dictation — dosage, frequency, and duration REQUIRED on each (infer sensible defaults when omitted)
- Prefer spoken brand/generic in name/correctedName; set inventoryMatch only when catalog clearly matches — never invent a different product
- action "continue" for items already on chart that doctor wants documented but not re-ordered
- action "stop" means remove from this visit Rx in OPD (or discontinue in IPD)
`
}
`
    : mode === "add"
      ? `MODE "add" — extract EVERY medicine, lab, and clinical fact with full visit quality. Every new medicine needs dosage, frequency, and duration (days). doctorNotes = polished fragment of the dictation only.\n\n`
      : "";

  return `${settingLine}${context ? `Patient context: ${context}\n\n` : ""}${existingSection}${catalogSection.length ? `${catalogSection.join("\n\n")}\n\n` : ""}Extract structured clinical data from this note/consult transcript.

Rules reminder:
- Prefer labeled English sections (Complaints, History, Examination, Vitals, Diagnosis, Medicines, Investigations, Procedures, Advice) unless existing notes are already SOAP S:/O:/A:/P:
- Under each labeled (or SOAP letter) section, write content as • unicode dot bullets — one item per line
- ALWAYS extract medicines[], labTests[], and procedures[] when ordered in speech — do not miss them
- doctorNotes must be clean English only (never raw transcript)

JSON schema (return exactly these keys):
{
  "noteFormat": "labeled | soap | narrative | bullet | problem_oriented | template",
  "symptoms": "chief complaints in English (short)",
  "pastMedicalHistory": "string or empty",
  "provisionalDiagnosis": "diagnosis/impression in English or empty",
  "medicines": [
    {
      "name": "spoken brand or product (Dolo, Pantop) — keep brand if spoken",
      "description": "same as name — display label like master medicines",
      "generic_name": "generic if known, else same as name",
      "type": "Tablet | Syrup | Injection | Ointment | Capsules | Gel | Sachet | Syringe | Other",
      "dosage": "e.g. 500mg or 5ml",
      "frequency": "BD | TDS | OD | QID | HS | SOS",
      "duration": "e.g. 5 days",
      "instructions": "e.g. after food or empty string",
      "action": "add | continue | note_only | stop"
    }
  ],
  "labTests": [
    { "name": "spell-corrected standard test/investigation name", "action": "add | continue | note_only" }
  ],
  "procedures": [
    {
      "name": "procedure or service name",
      "correctedName": "spell-corrected name",
      "inventoryMatch": "closest catalog name if available",
      "action": "add | continue | note_only"
    }
  ],
  "vitals": {
    "weight": "kg or empty — never invent",
    "height": "cm or empty — never invent",
    "temperature": "as spoken (C or F) or empty",
    "spo2": "percent or empty",
    "heartRate": "bpm or empty",
    "respiratoryRate": "per min or empty",
    "bloodPressure": "e.g. 120/80 or empty"
  },
  "doctorNotes": "clean ENGLISH-ONLY labeled note with Complaints:/History:/Examination:/Vitals:/Diagnosis:/Advice: (skip empty). Do NOT include Medicines, Investigations, or Procedures in doctorNotes — put those only in medicines/labTests/procedures arrays. Under each section use • bullets (one item per line). SOAP S:/O:/A:/P: only if existing notes already use SOAP (still • under each letter)."
}

Examples:
- "fever 3 days, give dolo 650 bd 5 days, send cbc" → doctorNotes like "Complaints:\\n• Fever for 3 days"; medicines Dolo type:Tablet action:add; labTests CBC action:add (orders NOT repeated in doctorNotes)
- "give tab dolo 650 bd 5 days" → name/description Dolo type:Tablet dosage:650mg frequency:BD duration:5 days action:add (do NOT rewrite to Paracetamol; do NOT pick Injection)
- "inj pantop 40 stat" → name Pantop type:Injection dosage:40mg action:add
- "pantop syrup 5ml bd" → name Pantop type:Syrup dosage:5ml frequency:BD
- "give tab paracetmol 650 bd 5 days" → name Paracetamol type:Tablet dosage:650mg frequency:BD duration:5 days action:add
- "add azithro od 3 days" → name Azithromycin type:Tablet dosage:500mg frequency:OD duration:3 days action:add
- "ex tbact" / "t bact ointment" → name T-Bact type:Ointment; dosage Apply locally frequency BD duration 5 days
- "continue meds, add azithro 500 od, CBC" → Azithromycin medicines action:add dosage:500mg type:Tablet; CBC labTests action:add
- "advise CRP" / "send crp" → labTests CRP action:add; medicines must be empty
- "stop metformin" → metformin action:stop
- "advise cb c and lft" → labTests both action:add
- "order wound dressing" → procedures with action:add
- "BP 130/80, pulse 88, spo2 98, temp 98.6 F, weight 72, height 170" → vitals filled; leave unmentioned vitals empty — never invent

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

      const matchedProcedures = normalizedProcedures;

      // No hospital pharmacy fuzzy catalog — client resolves meds via master search
      const matchedMedicines = normalizedMedicines;

      const matchedLabTests =
        Array.isArray(labCatalog) && labCatalog.length > 0
          ? normalizedLabTests.map((test) => {
              const matched = matchLabTestToCatalog(test.name, labCatalog);
              return {
                name:
                  matched.inventoryMatch || matched.standardized || test.name,
                action: test.action,
              };
            })
          : normalizedLabTests;

      const { medicines, labTests } = reclassifyMisplacedLabs(
        matchedMedicines,
        matchedLabTests,
      );
      const procedures = matchedProcedures;

      const medicinesToApply = medicines.filter((med) => med.action === "add");
      const medicinesToStop = medicines.filter((med) => med.action === "stop");
      const labTestsToApply = labTests
        .filter((test) => test.action === "add")
        .map((test) => test.name);
      const proceduresToApply = procedures.filter(
        (proc) => proc.action === "add",
      );

      const vitals = normalizeParsedVitals(
        parsed.vitals || parsed.vitalSigns || parsed.vital_signs,
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
        vitals,
        medicinesToApply,
        medicinesToStop,
        labTestsToApply,
        proceduresToApply,
        doctorNotes: compactSoapLabels(
          String(
            parsed.doctorNotes || parsed.doctorNote || parsed.notes || "",
          ).trim(),
        ),
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
