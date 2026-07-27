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
// Note parsing is the most instruction-sensitive call; override without a deploy if needed.
const PARSE_NOTE_MODEL = process.env.OPENAI_PARSE_MODEL || OPENAI_MODEL;

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

const PARSE_CLINICAL_NOTE_SYSTEM_PROMPT = `You are a medical scribe for an Indian hospital EMR. Convert the CURRENT doctor dictation or consult transcript into the requested JSON. Return valid JSON only.

COMPLETENESS (highest priority — style-agnostic)
- Doctors write in many styles: full sentences, CAPS shorthand, abbreviations, Telugu/English mix, bullets, or one long line. Accept all styles.
- Every clinical fact in the current input MUST appear in the output. Never drop a line because the wording is unusual, abbreviated, or names a procedure/drug/test.
- Prefer keeping a fact in noteSections over discarding it. If unsure whether something is an order vs narrative, keep the polished narrative in noteSections AND only add an order when the doctor is clearly ordering it for THIS visit.
- Before answering, mentally scan the input clause-by-clause (split on newlines, semicolons, or distinct clinical phrases). Each clause must map to noteSections and/or an order/vital. Zero silent drops.

CORE RULES
- Extract only facts stated in the current input. Existing chart context is reference only; never copy it as new content.
- Translate Telugu/Hindi/mixed speech into concise professional English. Ignore greetings, filler and repetition.
- Never infer a diagnosis, medicine, test, procedure or vital from another clinical fact. A diagnosis alone produces no orders.
- Route each current fact once by meaning (not by keyword matching):
  narrative / assessment / plan language → noteSections
  drugs being prescribed/stopped/continued now → medicines[]
  lab/imaging being ordered now → labTests[]
  services/procedures being done or ordered for THIS visit → procedures[]
  measured BP/pulse/temp/SpO2/RR/weight/height → vitals

TEMPORAL ROUTING (global — any wording)
- Past / prior / already done / status-post / known case / history of / "on <drug>" as background → history (noteSections). Do NOT create a today's procedure/lab/medicine order for background alone.
- Presenting symptoms / complaints → complaints.
- Exam findings observed now → examination.
- Impression / diagnosis → diagnosis.
- Counsel, precautions, follow-up timing, review dates, and planned future care (including future procedure/removal dates) → advice.
- Only actions intended for THIS visit go into medicines[] / labTests[] / procedures[] with action "add".

LISTEN / AMBIENT TRANSCRIPTS
- Input may be a messy doctor–patient consult transcript (overlaps, ASR errors, Indic code-mix). Still extract every clinical fact.
- Never drop patient-stated complaints, durations, severity or negatives (e.g. "no vomiting") even if soft, fragmented, in Telugu/Hindi, or spoken by the patient rather than the doctor — put them in complaints/history in English.
- Extract every explicitly named drug with dosage/frequency/duration even when embedded mid-sentence ("start Dolo six fifty BD three days", "give pantop 40 od").
- Correct common Indian ASR near-misses when clinical context is clear: "dollar/dolo/dollo 650"→Dolo 650; "pantop/pan top/pan 40"→Pantop or PAN; "azithro"→Azithromycin; "see bee see/CBC"→CBC; "L F T"→LFT; "0d"→OD.
- Prefer the spoken brand for name/description; put strength only in dosage (650 mg), frequency in frequency (BD), duration in duration (3 days).

NOTE SECTIONS
- Default noteFormat is "labeled". Put short, single-line facts in complaints, history, examination, diagnosis or advice.
- Preserve symptom durations, severity, qualifiers, dates and negative findings.
- Expand abbreviations into clear English when meaning is clear (any local shorthand is fine — do not require a specific format). Fix obvious date typos like 19/726 → 19/7/26.
- Mirror the same facts into symptoms / pastMedicalHistory / provisionalDiagnosis when those fields apply (server may use them as backup).
- Drugs being prescribed now, lab/imaging orders for now, and vital numbers never belong in noteSections.
- "Advise/send/do/get/order/repeat/check" + a lab/imaging test ordered now → labTests[], not advice.
- Planned future procedures, removals, surgery dates, review/follow-up → advice, not procedures[].
- Past procedures/surgeries/results mentioned as background → history, not procedures[]/labTests[].
- Return doctorNotes "" for labeled notes; the server renders headings and bullets.
- Only when existingContext.noteFormat is "soap": set noteFormat "soap", leave noteSections empty and use doctorNotes with S:/O:/A:/P: bullet sections. Orders still stay outside doctorNotes.

NOTE RECONCILIATION
- existingContext.noteSections contains compact existing bullets. Keep current facts in noteSections as usual.
- noteOperations may remove an exact existing bullet only when the current input clearly contradicts, corrects or refines the same clinical concept.
- Each removal must copy section and target exactly from existingContext.noteSections. Remove every superseded variant separately.
- Never remove unrelated complaints/diagnoses or anything when the relationship is uncertain. Never target medicines, labs, procedures or vitals.
- Example: existing complaints ["Fever","Fever for 3 days"], current "no fever" → current complaints ["No fever"] plus two remove operations targeting both old fever bullets.
- Example: existing diagnoses ["Spine pain","Spinecord pain"], current "diagnosis spine disc problem" → current diagnosis ["Spine disc problem"] plus two remove operations.

ORDERS AND ACTIONS
- Extract every explicitly spoken order for THIS visit, including orders embedded in conversation.
- action "add": new/restarted/changed order now.
- action "continue": doctor explicitly says continue/same/ongoing, or repeats an existingContext medicine name without stating a change.
- action "note_only": historical or discussed only — and STILL put the polished narrative into the matching noteSections (history/advice/examination). Never use note_only as a way to hide content from the chart note.
- medicine action "stop": explicitly stop/remove/hold that named drug.
- Never return action "stop" merely because an existing medicine was repeated or omitted from the current input.
- Empty arrays and empty vitals are correct when nothing was ordered or measured.

MEDICINES
- Keep the spoken brand as name/description; do not replace Dolo, Crocin, Telma, T-Bact, Pantop or other brands with generics.
- name and description contain ONLY the corrected medicine/brand name. Never include "Tab", "Cap", "Inj", strength, dose, frequency, duration or instructions in either field; those belong in type/dosage/frequency/duration/instructions.
- Correct obvious medicine spelling, capitalization and punctuation while preserving brand identity: faropenam→Faropenem, limvit→Limvit, pan→PAN, mvi→MVI, pregaba m→Pregaba-M.
- Expand generic shorthand only when no brand was spoken: PCM/Para → Paracetamol; Azithro → Azithromycin; Amox → Amoxicillin; Pantop → Pantoprazole.
- type: Tablet, Capsules, Injection, Syrup, Ointment, Gel, Sachet, Syringe or Other. The explicit spoken form is absolute: tab/tablet→Tablet, cap→Capsules, inj→Injection, syrup/syp→Syrup. Never change a spoken tablet to Injection based on drug knowledge. Default Tablet only when no form was spoken.
- Normalize the common transcription error "0d" (zero-d) to frequency "OD".
- For action "add", return dosage, frequency and duration. Infer a common adult value only for a drug the doctor explicitly named and only when the omitted value is well established.
- Background "patient is on X" / "known case on X" → history note + medicines action "note_only" or "continue" if clearly ongoing; do not invent a new prescription schedule.
- Keep instructions such as before/after food. Never invent item_code, manufacturer or pack.

LABS AND PROCEDURES
- CBP, CUE, CBC, ESR, CRP, LFT, KFT/RFT, HbA1c, TSH, FBS/PPBS/RBS, lipid profile, Widal, MP smear, NS1, ECG, USG and X-ray are labTests when ordered now; never medicines or advice.
- Normalize obvious speech variants: hemogram/cb c→CBC; complete blood picture→CBP; complete urine examination→CUE; liver function→LFT; renal function→KFT; cxr→X-Ray Chest; sonography→USG; ekg→ECG.
- Past/reported results ("USG showed stone", "CBP normal last week") → history or examination narrative; do not create a new lab order unless the doctor orders a repeat now.
- procedures[] only for services being ordered or performed for THIS visit.
- Deduplicate orders.
- In vitals, return values without labels or units: temperature as its spoken numeric value ("98.6"), SpO2 ("98"), pulse ("80"), RR ("18"), and BP as systolic/diastolic ("120/80").

HIGH-VALUE EXAMPLES (different doctor styles — same completeness rule)
- "azithro 3d tid, pantop 3d bd, dolo 650 3d bd" → medicines only; noteSections empty; doctorNotes "".
- "tab faropenam 200mg bd; tab limvit bd; tab pan 40mg od; tab mvi od; tab pregaba m 75mg od" → five medicines, all type Tablet; name/description values are only Faropenem, Limvit, PAN, MVI, Pregaba-M.
- "fever 4 days, cold, cough, advise cbp and lft" → complaints for the three symptoms; CBP and LFT in labTests; advice empty.
- "diagnosis spine pain" → diagnosis only; order arrays empty.
- "chest clear, plenty of fluids, review after 3 days" → examination ["Chest clear"]; advice ["Plenty of fluids","Review after 3 days"].
- Caps shorthand: "POST URSL PLUS DJ STENTING ON 19/726 / ADV STENT REMOVAL ON 2/8/26 / MILD PAIN N BURNING MICTURITION PRESENT" → history ["Post URSL plus DJ stenting on 19/7/26"]; advice ["Advise stent removal on 2/8/26"]; complaints ["Mild pain and burning micturition present"]; procedures[] empty.
- Sentence style: "Patient underwent appendectomy 2 years ago. Advise follow-up in 1 week. Complains of mild abdominal pain." → history, advice, complaints accordingly; no procedure order.
- Mixed: "k/c/o DM on metformin, c/o fever 2 days, plan review SOS, adv CBP" → history ["Known case of DM on metformin"]; complaints ["Fever for 2 days"]; advice ["Review SOS"]; labTests ["CBP"]; no metformin add unless newly prescribed now.

FINAL CHECK
- Completeness: every clinical clause from the input is present in noteSections and/or the correct order/vital field.
- Remove only today's drug/lab/imaging/vital numbers that were accidentally left inside noteSections; never strip history, advice, exam, diagnosis, or past-procedure narrative.
- Remove every order or vital not explicitly supported by the current input.
- Do not drop a stated symptom, history line, advice/follow-up, duration, or explicitly spoken order.`;

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
  "cbp",
  "complete blood picture",
  "blood picture",
  "cue",
  "complete urine examination",
  "urine routine",
  "lipid profile",
  "mp smear",
  "sputum",
  "culture",
  "biopsy",
  "psa",
  "ferritin",
  "amylase",
  "lipase",
  "vdrl",
  "blood group",
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

const ADVICE_ORDER_VERB =
  /^(advise|advice|advised|send|sent|do|get|order|ordered|repeat|check)\s+(.+)$/i;

/** Home-monitoring / conditional counsel must stay counsel even if it names a test. */
const ADVICE_COUNSEL_HINT =
  /\b(daily|weekly|monthly|regularly|home|monitor|monitoring|watch|if|when|avoid|continue|review|follow[- ]?up|removal|on\s+\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?)\b/i;

/**
 * Advice must be counsel only. When the model still writes "Advise CBP" there,
 * move the investigation into labTests instead of dropping the fact.
 */
function reclassifyAdviceOrders(sections, labTests) {
  if (!sections?.advice?.length) return { sections, labTests };
  const keptAdvice = [];
  const nextLabs = [...labTests];

  for (const item of sections.advice) {
    const match = item.match(ADVICE_ORDER_VERB);
    const candidate = match ? match[2].replace(/[.,;]+$/, "").trim() : "";
    const isOrderPhrase =
      candidate &&
      candidate.length <= 40 &&
      candidate.split(/\s+/).length <= 5 &&
      !ADVICE_COUNSEL_HINT.test(candidate);
    if (isOrderPhrase && looksLikeLabTestName(candidate)) {
      const already = nextLabs.some(
        (test) =>
          normalizeLabHint(test?.name || test) === normalizeLabHint(candidate),
      );
      if (!already) nextLabs.push({ name: candidate, action: "add" });
      continue;
    }
    keptAdvice.push(item);
  }

  const nextSections = { ...sections };
  if (keptAdvice.length) nextSections.advice = keptAdvice;
  else delete nextSections.advice;

  return { sections: nextSections, labTests: nextLabs };
}

function sectionHasSimilarBullet(items, text) {
  const compact = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!compact) return false;
  return (items || []).some((item) => {
    const other = String(item || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (!other) return false;
    return other.includes(compact) || compact.includes(other);
  });
}

function sectionBucketHasSimilar(sections, text) {
  if (!sections || !text) return false;
  return NOTE_SECTION_ORDER.some(([key]) =>
    sectionHasSimilarBullet(sections[key], text),
  );
}

/**
 * Merge legacy string fields into noteSections so content is not lost when the
 * model fills symptoms/pastMedicalHistory/provisionalDiagnosis but omits
 * noteSections (or the reverse).
 */
function mergeLegacyFieldsIntoSections(sections, parsed = {}) {
  const next = { ...(sections || {}) };
  const merge = (key, value) => {
    const items = noteSectionItems(value);
    if (!items.length) return;
    next[key] = noteSectionItems([...(next[key] || []), ...items]);
  };
  merge("complaints", parsed.symptoms);
  merge("history", parsed.pastMedicalHistory || parsed.pastHistory);
  merge("diagnosis", parsed.provisionalDiagnosis || parsed.diagnosis);
  return Object.keys(next).length ? next : null;
}

/**
 * Style-agnostic safety net: anything the model marked note_only is narrative
 * for the chart, not a visit order. Fold into history when missing from notes.
 */
function foldNoteOnlyOrdersIntoHistory(
  sections,
  medicines,
  procedures,
  labTests,
) {
  const nextSections = { ...(sections || {}) };
  const history = [...(nextSections.history || [])];

  const fold = (bullet) => {
    const text = String(bullet || "").trim();
    if (!text) return;
    if (sectionBucketHasSimilar(nextSections, text)) return;
    if (sectionHasSimilarBullet(history, text)) return;
    history.push(text);
  };

  for (const proc of procedures || []) {
    if (String(proc?.action || "").toLowerCase() !== "note_only") continue;
    const name = String(proc.correctedName || proc.name || "").trim();
    if (!name) continue;
    fold(/^post\b/i.test(name) ? name : `History of ${name}`);
  }
  for (const med of medicines || []) {
    if (String(med?.action || "").toLowerCase() !== "note_only") continue;
    const name = String(
      med.description || med.correctedName || med.name || "",
    ).trim();
    if (!name) continue;
    fold(`On ${name}`);
  }
  for (const lab of labTests || []) {
    if (String(lab?.action || "").toLowerCase() !== "note_only") continue;
    const name = String(lab.name || "").trim();
    if (!name) continue;
    fold(`Prior ${name}`);
  }

  if (history.length) nextSections.history = noteSectionItems(history);
  else delete nextSections.history;

  return {
    sections: Object.keys(nextSections).length ? nextSections : null,
    medicines: (medicines || []).filter(
      (item) => String(item?.action || "").toLowerCase() !== "note_only",
    ),
    procedures: (procedures || []).filter(
      (item) => String(item?.action || "").toLowerCase() !== "note_only",
    ),
    labTests: (labTests || []).filter(
      (item) => String(item?.action || "").toLowerCase() !== "note_only",
    ),
  };
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

function normalizeNoteAction(action) {
  const normalized = String(action || "add")
    .trim()
    .toLowerCase();
  if (normalized === "stop") return "stop";
  return VALID_NOTE_ACTIONS.has(normalized) ? normalized : "add";
}

const SPOKEN_MEDICINE_FORM =
  /\b(tab(?:let)?s?|cap(?:sule)?s?|inj(?:ection)?s?|syp|syrup|suspension|ointment|cream|gel|sachet)\b/gi;

function normalizeSpokenMedicineForm(value) {
  const token = String(value || "").toLowerCase();
  if (/^tab/.test(token)) return "Tablet";
  if (/^cap/.test(token)) return "Capsules";
  if (/^inj/.test(token)) return "Injection";
  if (/^(syp|syrup|suspension)$/.test(token)) return "Syrup";
  if (/^(ointment|cream)$/.test(token)) return "Ointment";
  if (token === "gel") return "Gel";
  if (token === "sachet") return "Sachet";
  return "";
}

/**
 * Conservatively align explicit spoken forms by order. We override the model
 * only when the number of form words equals the number of extracted medicines.
 */
function extractSpokenMedicineForms(clinicalNote, medicineCount) {
  const forms = [...String(clinicalNote || "").matchAll(SPOKEN_MEDICINE_FORM)]
    .map((match) => normalizeSpokenMedicineForm(match[1]))
    .filter(Boolean);
  if (forms.length === medicineCount) return forms;
  if (
    medicineCount > 0 &&
    medicineCount <= forms.length &&
    new Set(forms).size === 1
  ) {
    return Array(medicineCount).fill(forms[0]);
  }
  return [];
}

const MEDICINE_NAME_CORRECTIONS = new Map([
  ["faropenam", "Faropenem"],
  ["faropenem", "Faropenem"],
  ["limvit", "Limvit"],
  ["pan", "PAN"],
  ["mvi", "MVI"],
  ["pregaba m", "Pregaba-M"],
  ["pregaba-m", "Pregaba-M"],
]);

function extractMedicineNameOnly(value) {
  return String(value || "")
    .trim()
    .replace(
      /^(?:tab(?:let)?s?|cap(?:sule)?s?|inj(?:ection)?s?|syp|syrup|suspension|ointment|cream|gel|sachet)\.?\s+/i,
      "",
    )
    .replace(
      /\s+(?:(?:\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|gm|ml|iu|units?))|(?:od|0d|bd|bid|tds|tid|qid|hs|sos|stat|prn)\b|(?:for\s+)?\d+\s*(?:d|day|days|wk|wks|week|weeks|month|months)\b).*$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMedicineDisplayName(value) {
  const trimmed = extractMedicineNameOnly(value);
  if (!trimmed) return "";
  const key = trimmed
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (MEDICINE_NAME_CORRECTIONS.has(key)) {
    return MEDICINE_NAME_CORRECTIONS.get(key);
  }
  if (trimmed === trimmed.toLowerCase()) {
    return trimmed.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  }
  return trimmed;
}

function normalizeMedicineFrequency(value) {
  const frequency = String(value || "").trim();
  if (/^0\s*d$/i.test(frequency)) return "OD";
  return frequency;
}

function normalizeParsedMedicine(med, spokenType = "", allowStop = false) {
  const name = String(med.name || med.medicine || "").trim();
  const correctedName = String(
    med.correctedName || med.corrected_name || med.description || name,
  ).trim();
  const displayName = normalizeMedicineDisplayName(correctedName || name);
  const description = displayName;
  const rawGenericName = String(
    med.generic_name || med.genericName || displayName,
  ).trim();
  const genericName =
    rawGenericName.toLowerCase() === (correctedName || name).toLowerCase()
      ? displayName
      : normalizeMedicineDisplayName(rawGenericName);
  const type = String(med.type || med.form || med.medicineType || "").trim();
  const parsedAction = normalizeNoteAction(med.action);

  return {
    // Same field names as master medicines / PrescriptionForm manual add
    name: displayName,
    description,
    generic_name: genericName,
    generic_name2: String(med.generic_name2 || "").trim() || undefined,
    type: spokenType || type || undefined,
    form: spokenType || type || undefined,
    manufacturer: String(med.manufacturer || "").trim() || undefined,
    pack: String(med.pack || "").trim() || undefined,
    hsn_code: String(med.hsn_code || med.hsnCode || "").trim() || undefined,
    item_code: String(med.item_code || "").trim() || undefined,
    correctedName: displayName,
    inventoryMatch: displayName,
    dosage: String(med.dosage || med.dose || "").trim(),
    frequency: normalizeMedicineFrequency(med.frequency || med.freq),
    duration: String(med.duration || "").trim(),
    instructions: String(med.instructions || med.instruction || "").trim(),
    action: parsedAction === "stop" && !allowStop ? "add" : parsedAction,
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

const EXPLICIT_MEDICINE_STOP =
  /\b(stop|stopped|discontinue|discontinued|hold|remove|delete|omit)\b/i;

function medicineNameMatchKey(value) {
  return extractMedicineNameOnly(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractExplicitMedicineStopNames(clinicalNote, existingContext) {
  const existingNames =
    compactExistingClinicalContext(existingContext)?.medicineNames || [];
  const targets = new Map();
  const segments = String(clinicalNote || "")
    .split(/[\n;,.]+/)
    .map((segment) => segment.trim())
    .filter((segment) => EXPLICIT_MEDICINE_STOP.test(segment));

  for (const segment of segments) {
    const segmentKey = ` ${medicineNameMatchKey(segment)} `;
    let foundExisting = false;
    for (const existingName of existingNames) {
      const name = normalizeMedicineDisplayName(existingName);
      const key = medicineNameMatchKey(name);
      if (key && segmentKey.includes(` ${key} `)) {
        targets.set(key, name);
        foundExisting = true;
      }
    }

    if (!foundExisting) {
      const rawTarget = segment
        .replace(EXPLICIT_MEDICINE_STOP, "")
        .replace(
          /\s+(?:from|in)\s+(?:this\s+)?(?:prescription|rx|medicines?).*$/i,
          "",
        )
        .trim();
      const name = normalizeMedicineDisplayName(rawTarget);
      const key = medicineNameMatchKey(name);
      if (key && !/^(all|all medicines?|medicines?|treatment)$/.test(key)) {
        targets.set(key, name);
      }
    }
  }

  return [...targets.values()];
}

function applyExplicitMedicineStops(medicines, clinicalNote, existingContext) {
  const stopNames = extractExplicitMedicineStopNames(
    clinicalNote,
    existingContext,
  );
  if (!stopNames.length) return medicines;

  const stopKeys = new Set(stopNames.map(medicineNameMatchKey));
  const result = medicines.map((medicine) =>
    stopKeys.has(medicineNameMatchKey(medicine.name))
      ? { ...medicine, action: "stop" }
      : medicine,
  );

  for (const name of stopNames) {
    const key = medicineNameMatchKey(name);
    if (
      result.some((medicine) => medicineNameMatchKey(medicine.name) === key)
    ) {
      continue;
    }
    result.push({
      name,
      description: name,
      generic_name: name,
      correctedName: name,
      inventoryMatch: name,
      action: "stop",
    });
  }

  return result;
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

COMPLETENESS: Keep every clinical fact from CURRENT INPUT. Writing style may vary — expand shorthand into clear English and place each fact by meaning (past→history, symptoms→complaints, exam→examination, impression→diagnosis, plan/follow-up→advice, today's orders→arrays). Do not drop clauses.

Return exactly this JSON shape:
{
  "noteFormat": "labeled or soap",
  "symptoms": "",
  "pastMedicalHistory": "",
  "provisionalDiagnosis": "",
  "medicines": [{
    "name": "", "description": "", "generic_name": "",
    "type": "Tablet|Capsules|Injection|Syrup|Ointment|Gel|Sachet|Syringe|Other",
    "dosage": "", "frequency": "", "duration": "", "instructions": "",
    "action": "add|continue|note_only|stop"
  }],
  "labTests": [{"name": "", "action": "add|continue|note_only"}],
  "procedures": [{"name": "", "correctedName": "", "inventoryMatch": "", "action": "add|continue|note_only"}],
  "vitals": {
    "weight": "", "height": "", "temperature": "", "spo2": "",
    "heartRate": "", "respiratoryRate": "", "bloodPressure": ""
  },
  "noteSections": {
    "complaints": [], "history": [], "examination": [],
    "diagnosis": [], "advice": []
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
      labCatalog,
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
          model: PARSE_NOTE_MODEL,
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
                existingContext,
                mode,
                clinicalSetting,
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

      const rawMedicines = Array.isArray(parsed.medicines)
        ? parsed.medicines
        : [];
      const spokenMedicineForms = extractSpokenMedicineForms(
        clinicalNote,
        rawMedicines.length,
      );
      const allowMedicineStop =
        /\b(stop|stopped|discontinue|discontinued|hold|remove|delete|omit)\b/i.test(
          clinicalNote,
        );
      const parsedMedicines = rawMedicines
        .map((med, index) =>
          normalizeParsedMedicine(
            med,
            spokenMedicineForms[index],
            allowMedicineStop,
          ),
        )
        .filter((med) => med.name);
      const normalizedMedicines = applyExplicitMedicineStops(
        parsedMedicines,
        clinicalNote,
        existingContext,
      );

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

      const reclassified = reclassifyMisplacedLabs(
        matchedMedicines,
        matchedLabTests,
      );
      const { sections: adviceSections, labTests: adviceLabTests } =
        reclassifyAdviceOrders(
          normalizeNoteSections(
            parsed.noteSections || parsed.note_sections || parsed.sections,
          ),
          reclassified.labTests,
        );
      const mergedSections = mergeLegacyFieldsIntoSections(
        adviceSections,
        parsed,
      );
      const reconciled = foldNoteOnlyOrdersIntoHistory(
        mergedSections,
        reclassified.medicines,
        matchedProcedures,
        adviceLabTests,
      );
      const noteSections = reconciled.sections;
      const medicines = reconciled.medicines;
      const procedures = reconciled.procedures;
      const labTests = reconciled.labTests;

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
      const noteOperations = normalizeParsedNoteOperations(
        parsed.noteOperations || parsed.note_operations,
        existingContext,
      );

      const freeTextNote = compactSoapLabels(
        String(
          parsed.doctorNotes || parsed.doctorNote || parsed.notes || "",
        ).trim(),
      );
      const sectionNote = composeNoteFromSections(noteSections);
      // SOAP continuation still arrives as free text; everything else is composed here.
      const isSoapNote = /^\s*[SOAP]\s*:/m.test(freeTextNote);

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
        noteOperations,
        doctorNotes: isSoapNote && freeTextNote ? freeTextNote : sectionNote,
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
