/**
 * Doctor Memory — crawl signed Prescriptions directly and suggest meds/labs/notes from past practice.
 * Direct crawling of the Prescription collection ensures 100% real-time accuracy with zero sync lag.
 */

const SECTION_HEADER =
  /^(Complaints?|Chief\s*Complaints?(?:\s*\/\s*HPI)?|HPI|History|Past\s*Medical\s*History|PMH|Examination|Exam|Systemic\s*Examination|Vitals?|Provisional\s*Diagnosis|Working\s*Diagnosis|Diagnosis|Advice|Procedures?)\s*:\s*(.*)$/i;

const STOP_WORDS = new Set([
  "with",
  "have",
  "days",
  "patient",
  "since",
  "mild",
  "moderate",
  "severe",
  "history",
  "complaints",
  "examination",
  "diagnosis",
  "advice",
  "present",
  "illness",
  "chief",
  "past",
  "medical",
  "provisional",
  "working",
  "the",
  "and",
  "for",
  "from",
  "that",
  "this",
  "been",
  "after",
  "before",
]);

// 2-letter and 3-letter clinical abbreviations that MUST NOT be stripped
const CLINICAL_SHORT_TOKENS = new Set([
  "dm",
  "bp",
  "ht",
  "htn",
  "tb",
  "ra",
  "oa",
  "urti",
  "lrti",
  "uti",
  "gerd",
  "apd",
  "ckd",
  "cad",
  "copd",
  "ba",
  "hiv",
  "lft",
  "kft",
  "rft",
  "cbp",
  "cbc",
  "esr",
  "crp",
  "ns1",
  "ecg",
  "cxr",
  "usg",
  "grbs",
  "rbs",
  "fbs",
  "ppbs",
  "af",
  "hba1c",
  "tsh",
  "t3",
  "t4",
  "pt",
  "inr",
  "pct",
  "aptt",
  "vdrl",
  "hbsag",
  "hcv",
  "ct",
  "mri",
  "2d",
  "echo",
  "pft",
  "eeg",
  "tmt",
]);

const MIN_SIMILAR_CASES = 2;
const MIN_MED_FREQUENCY = 0.08;
const MIN_LAB_FREQUENCY = 0.08;
const MAX_MED_SUGGESTIONS = 40;
const MAX_PER_MED_CATEGORY = 5;
const MAX_LAB_SUGGESTIONS = 20;
const MIN_TEXT_FREQUENCY = 0.08;
const MIN_PROCEDURE_FREQUENCY = 0.1;
const MIN_CASE_SCORE_FOR_ORDERS = 0.1;
const MAX_TEXT_SUGGESTIONS = 5;
const MAX_PROCEDURE_SUGGESTIONS = 5;
const MIN_SIMILARITY_SCORE = 0.16;
const SIMILAR_CASE_LIMIT = 40;

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const tokens = new Set();
  for (const word of normalized.split(" ")) {
    if (!word) continue;
    if (word.length < 3 && !CLINICAL_SHORT_TOKENS.has(word)) continue;
    if (STOP_WORDS.has(word)) continue;
    tokens.add(word);
  }
  return [...tokens];
}

function bulletsFromText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s•\-*]+/, "").trim())
    .filter(Boolean);
}

function parseLabeledSections(noteText = "") {
  const sections = {
    complaints: [],
    history: [],
    examination: [],
    diagnosis: [],
    advice: [],
    procedures: [],
  };

  let current = null;
  for (const rawLine of String(noteText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = line.match(SECTION_HEADER);
    if (header) {
      const key = header[1].toLowerCase();
      if (/complaint|hpi/.test(key)) current = "complaints";
      else if (/history|pmh/.test(key)) current = "history";
      else if (/exam/.test(key)) current = "examination";
      else if (/diagnosis/.test(key)) current = "diagnosis";
      else if (/advice/.test(key)) current = "advice";
      else if (/procedure/.test(key)) current = "procedures";
      else current = null;

      const inline = (header[2] || "").replace(/^[\s•\-*]+/, "").trim();
      if (current && inline) sections[current].push(inline);
      continue;
    }
    if (!current) continue;
    const bullet = line.replace(/^[\s•\-*]+/, "").trim();
    if (bullet) sections[current].push(bullet);
  }
  return sections;
}

function medName(m) {
  if (!m) return "";
  if (typeof m === "string") return m.trim();
  return String(
    m.name ||
      m.medicine_name ||
      m.description ||
      m.correctedName ||
      m.generic_name ||
      "",
  ).trim();
}

function labName(t) {
  if (!t) return "";
  if (typeof t === "string") return t.trim();
  return String(t.name || t.test_name || t.description || "").trim();
}

function procName(proc) {
  if (!proc) return "";
  if (typeof proc === "string") return proc.trim();
  return String(
    proc.name ||
      proc.description ||
      proc.inventoryMatch ||
      proc.correctedName ||
      "",
  ).trim();
}

const MED_BRAND_ALIASES = new Map([
  ["dolo", "paracetamol"],
  ["calpol", "paracetamol"],
  ["crocin", "paracetamol"],
  ["pcm", "paracetamol"],
  ["paracetamol", "paracetamol"],
  ["acetaminophen", "paracetamol"],
  ["pantocid", "pantoprazole"],
  ["pantop", "pantoprazole"],
  ["pantoprazole", "pantoprazole"],
]);

function detectMedForm(name) {
  const s = String(name || "").toLowerCase().trim();
  if (!s) return "";
  if (/\b(inj|injection)\b/.test(s) || s.startsWith("inj ") || s.startsWith("inj.")) {
    return "inj";
  }
  if (/\b(iv|infusion)\b/.test(s) || s.startsWith("iv ")) return "iv";
  if (/\b(syp|syrup|susp|suspension|liquid)\b/.test(s) || s.startsWith("syp")) {
    return "syp";
  }
  if (/\b(drop|drops)\b/.test(s)) return "drops";
  if (/\b(oint|ointment|cream|gel|lotion)\b/.test(s)) return "topical";
  if (/\b(sachet|powder)\b/.test(s)) return "sachet";
  if (/\b(spray|inhaler|rotacap|respule)\b/.test(s)) return "inh";
  if (/\b(tab|tablet|cap|capsule)\b/.test(s) || s.startsWith("tab") || s.startsWith("cap")) {
    return "tab";
  }
  return "";
}

function medicineFormCategory(pill) {
  const type = String(pill?.type || "").toLowerCase();
  const name = String(pill?.name || "").toLowerCase();
  const blob = `${type} ${name}`;
  const form = detectMedForm(blob) || detectMedForm(name);
  if (form === "inj") return "Injections";
  if (form === "iv") return "IV Fluids";
  if (form === "syp") return "Syrups & Liquids";
  if (form === "drops") return "Drops";
  if (form === "topical") return "Ointments & Topicals";
  if (form === "sachet") return "Sachets & Powders";
  if (form === "inh") return "Inhalers & Sprays";
  if (form === "tab") return "Tablets & Capsules";
  return "Other Medicines";
}

/**
 * Canonical Medicine Normalizer — groups brand/form/strength variations together
 * e.g. "Tab Dolo 650", "Dolo 650mg", "PCM 650" -> "tab paracetamol 650"
 * Syrup/injection of the same drug stay in a separate bucket.
 */
function normalizeMedKey(name) {
  if (!name) return "";
  const form = detectMedForm(name) || "tab";
  let s = String(name || "").toLowerCase().trim();

  // Strip dosage form prefixes/suffixes
  s = s.replace(
    /\b(tab|tablet|tablets|cap|capsule|capsules|syp|syrup|inj|injection|injections|oint|ointment|cream|gel|sachet|sachets|drops|respules|spray|rotacap|susp|suspension|mouthwash|gargle|lotion|powder)\b\.?/gi,
    " ",
  );

  // Strip routes and dosing schedules
  s = s.replace(
    /\b(od|0d|bd|bid|tds|tid|qid|hs|sos|stat|prn|ac|pc|po|iv|im|sc|oral|before\s*food|after\s*food|bf|af|once|twice|thrice|daily|night|morning)\b/gi,
    " ",
  );

  // Strip pattern doses: 1-0-1, 1-1-1, 1-0-0, 0-0-1, etc.
  s = s.replace(/\b\d+-\d+-\d+(?:-\d+)?\b/g, " ");

  // Standardize trailing strength numbers (e.g. "650 mg" -> "650", "0.5 mg" -> "0.5")
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:mg|mcg|µg|g|gm|ml|iu|units?|%)\b/gi, "$1");

  // Clean non-alphanumeric and excess whitespace
  s = s.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

  const parts = s.split(" ").filter(Boolean);
  if (parts[0] && MED_BRAND_ALIASES.has(parts[0])) {
    parts[0] = MED_BRAND_ALIASES.get(parts[0]);
    s = parts.join(" ");
  }
  return s ? `${form} ${s}` : form;
}

const LAB_SYNONYMS = new Map([
  ["cbc", "cbp"],
  ["complete blood count", "cbp"],
  ["complete blood picture", "cbp"],
  ["hemogram", "cbp"],
  ["haemogram", "cbp"],
  ["complete hemogram", "cbp"],
  ["complete haemogram", "cbp"],
  ["blood picture", "cbp"],
  ["cbp", "cbp"],

  ["liver function test", "lft"],
  ["liver function tests", "lft"],
  ["liver profile", "lft"],
  ["lft", "lft"],

  ["renal function test", "rft"],
  ["renal function tests", "rft"],
  ["kidney function test", "rft"],
  ["kidney function tests", "rft"],
  ["kft", "rft"],
  ["rft", "rft"],

  ["lipid profile", "lipid profile"],
  ["serum lipid profile", "lipid profile"],
  ["lipid panel", "lipid profile"],

  ["thyroid profile", "thyroid profile"],
  ["thyroid function test", "thyroid profile"],
  ["thyroid function tests", "thyroid profile"],
  ["tft", "thyroid profile"],
  ["t3 t4 tsh", "thyroid profile"],
  ["tsh", "tsh"],

  ["cue", "urine routine"],
  ["complete urine examination", "urine routine"],
  ["urine routine examination", "urine routine"],
  ["urinalysis", "urine routine"],
  ["urine complete", "urine routine"],
  ["urine re", "urine routine"],
  ["urine routine", "urine routine"],

  ["serum creatinine", "serum creatinine"],
  ["s creatinine", "serum creatinine"],
  ["creatinine", "serum creatinine"],

  ["blood urea", "serum urea"],
  ["serum urea", "serum urea"],
  ["urea", "serum urea"],

  ["glycated hemoglobin", "hba1c"],
  ["glycosylated hemoglobin", "hba1c"],
  ["hb a1c", "hba1c"],
  ["hba1c", "hba1c"],

  ["fasting blood sugar", "fbs"],
  ["fasting blood glucose", "fbs"],
  ["fbs", "fbs"],

  ["post prandial blood sugar", "ppbs"],
  ["post prandial blood glucose", "ppbs"],
  ["ppbs", "ppbs"],

  ["random blood sugar", "rbs"],
  ["grbs", "rbs"],
  ["blood sugar random", "rbs"],
  ["rbs", "rbs"],

  ["serum electrolytes", "serum electrolytes"],
  ["electrolytes", "serum electrolytes"],
  ["na k cl", "serum electrolytes"],

  ["dengue ns1", "dengue profile"],
  ["dengue serology", "dengue profile"],
  ["dengue ns1 antigen", "dengue profile"],
  ["dengue profile", "dengue profile"],
  ["dengue test", "dengue profile"],

  ["widal", "widal test"],
  ["widal test", "widal test"],
  ["typhoid test", "widal test"],

  ["ecg", "ecg"],
  ["ekg", "ecg"],
  ["12 lead ecg", "ecg"],

  ["chest x ray", "chest x-ray"],
  ["chest xray", "chest x-ray"],
  ["cxr", "chest x-ray"],
  ["x ray chest pa", "chest x-ray"],
  ["x ray chest", "chest x-ray"],
  ["chest x-ray", "chest x-ray"],

  ["usg abdomen", "usg abdomen"],
  ["usg abdomen and pelvis", "usg abdomen"],
  ["ultrasound abdomen", "usg abdomen"],
  ["usg whole abdomen", "usg abdomen"],
]);

const CANONICAL_LAB_NAMES = {
  cbp: "Complete Blood Picture (CBP)",
  lft: "Liver Function Tests (LFT)",
  rft: "Renal Function Tests (RFT)",
  "lipid profile": "Lipid Profile",
  "thyroid profile": "Thyroid Profile (T3, T4, TSH)",
  tsh: "TSH",
  "urine routine": "Complete Urine Examination (CUE)",
  "serum creatinine": "Serum Creatinine",
  "serum urea": "Serum Urea",
  hba1c: "HbA1c (Glycated Hemoglobin)",
  fbs: "Fasting Blood Sugar (FBS)",
  ppbs: "Post Prandial Blood Sugar (PPBS)",
  rbs: "Random Blood Sugar (RBS)",
  "serum electrolytes": "Serum Electrolytes",
  "dengue profile": "Dengue Serology / NS1 Antigen",
  "widal test": "Widal Test",
  ecg: "ECG (12 Lead)",
  "chest x-ray": "Chest X-Ray (PA View)",
  "usg abdomen": "USG Abdomen & Pelvis",
};

function normalizeLabKey(name) {
  if (!name) return "";
  const s = normalizeText(name);
  if (LAB_SYNONYMS.has(s)) return LAB_SYNONYMS.get(s);
  const clean = s.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (LAB_SYNONYMS.has(clean)) return LAB_SYNONYMS.get(clean);
  return clean;
}

function normalizeBulletKey(text) {
  return normalizeText(text);
}

const NOTE_FILLER =
  /\b(c\/o|h\/o|c o|h o|since|for|with|associated|and|the|of|in|on|to|a|an|days?|weeks?|months?|years?|history|complaints?|mild|moderate|severe|high|grade|low|ago)\b/g;

/**
 * Collapse near-duplicate note lines:
 * "Fever 3 days" / "Fever since 3 days" / "H/o fever 3 days" -> "fever"
 */
function normalizeNoteIdeaKey(text) {
  const filler =
    /\b(c\/o|h\/o|c o|h o|since|for|with|associated|and|the|of|in|on|to|a|an|days?|weeks?|months?|years?|history|complaints?|mild|moderate|severe|high|grade|low|ago)\b/g;
  const s = normalizeText(text)
    .replace(/\b(c|h)\s+o\b/g, " ")
    .replace(filler, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

function tokenSetFromList(list) {
  return new Set(tokenize((list || []).join(" ")));
}

function overlapCount(querySet, caseSet) {
  let n = 0;
  for (const t of querySet) {
    if (caseSet.has(t)) n += 1;
  }
  return n;
}

/**
 * Same-kind-of-case gate: diagnosis overlap when both have a diagnosis,
 * otherwise overlapping chief complaints.
 */
function caseMatchesContext(clinicalCase, context) {
  const qDiag = tokenSetFromList(context?.diagnosis);
  const cDiag = tokenSetFromList(clinicalCase?.diagnosis);
  if (qDiag.size && cDiag.size) {
    return overlapCount(qDiag, cDiag) > 0;
  }

  const qComp = tokenSetFromList(context?.complaints);
  const cComp = tokenSetFromList(clinicalCase?.complaints);
  if (qComp.size && cComp.size) {
    const hits = overlapCount(qComp, cComp);
    if (qComp.size <= 2) return hits >= 1;
    return hits >= Math.min(2, qComp.size);
  }

  const q = new Set(context?.searchTokens || []);
  const c = new Set(clinicalCase?.searchTokens || []);
  if (!q.size || !c.size) return false;
  return overlapCount(q, c) >= 2;
}

function recencyBoost(visitDate) {
  if (!visitDate) return 0;
  const days = (Date.now() - new Date(visitDate).getTime()) / 86400000;
  if (!Number.isFinite(days) || days < 0) return 0;
  if (days <= 60) return 0.1;
  if (days <= 180) return 0.05;
  return 0;
}

function buildSearchContext(extractedClinical = {}) {
  const note = String(
    extractedClinical.clinicalNote || extractedClinical.doctorNotes || "",
  ).trim();
  const parsed = parseLabeledSections(note);

  const symptomBullets = bulletsFromText(extractedClinical.symptoms);
  const historyBullets = bulletsFromText(extractedClinical.pastMedicalHistory);
  const diagnosisBullets = bulletsFromText(
    extractedClinical.provisionalDiagnosis,
  );

  const complaints =
    (Array.isArray(extractedClinical.complaints) &&
    extractedClinical.complaints.length
      ? extractedClinical.complaints
      : null) ||
    (symptomBullets.length ? symptomBullets : null) ||
    parsed.complaints;
  const history =
    (Array.isArray(extractedClinical.history) &&
    extractedClinical.history.length
      ? extractedClinical.history
      : null) ||
    (historyBullets.length ? historyBullets : null) ||
    parsed.history;
  const examination =
    (Array.isArray(extractedClinical.examination) &&
    extractedClinical.examination.length
      ? extractedClinical.examination
      : null) || parsed.examination;
  const diagnosis =
    (Array.isArray(extractedClinical.diagnosis) &&
    extractedClinical.diagnosis.length
      ? extractedClinical.diagnosis
      : null) ||
    (diagnosisBullets.length ? diagnosisBullets : null) ||
    parsed.diagnosis;
  const advice =
    (Array.isArray(extractedClinical.advice) && extractedClinical.advice.length
      ? extractedClinical.advice
      : null) || parsed.advice;
  const procedures =
    (Array.isArray(extractedClinical.procedures) &&
    extractedClinical.procedures.length
      ? extractedClinical.procedures
      : null) || parsed.procedures;

  const blob = [
    ...(Array.isArray(complaints) ? complaints : bulletsFromText(complaints)),
    ...(Array.isArray(history) ? history : bulletsFromText(history)),
    ...(Array.isArray(examination)
      ? examination
      : bulletsFromText(examination)),
    ...(Array.isArray(diagnosis) ? diagnosis : bulletsFromText(diagnosis)),
    ...(Array.isArray(advice) ? advice : bulletsFromText(advice)),
    ...(Array.isArray(procedures) ? procedures : bulletsFromText(procedures)),
    note,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    complaints: Array.isArray(complaints)
      ? complaints
      : bulletsFromText(complaints),
    history: Array.isArray(history) ? history : bulletsFromText(history),
    examination: Array.isArray(examination)
      ? examination
      : bulletsFromText(examination),
    diagnosis: Array.isArray(diagnosis)
      ? diagnosis
      : bulletsFromText(diagnosis),
    advice: Array.isArray(advice) ? advice : bulletsFromText(advice),
    procedures: Array.isArray(procedures)
      ? procedures
      : bulletsFromText(procedures),
    searchText: normalizeText(blob),
    searchTokens: tokenize(blob),
  };
}

function snapshotDosages(med) {
  const source = Array.isArray(med?.dosages) ? med.dosages : [];
  return source
    .map((dose, index) => ({
      id: dose?.id ?? index,
      time: String(dose?.time || "").trim(),
      beforeFood: Boolean(dose?.beforeFood),
      ...(Number(dose?.amount) > 0 ? { amount: Number(dose.amount) } : {}),
      ...(String(dose?.unit || "").trim()
        ? { unit: String(dose.unit).trim() }
        : {}),
    }))
    .filter((dose) => dose.time);
}

function medDosages(sample) {
  if (Array.isArray(sample?.dosages) && sample.dosages.length) {
    return sample.dosages;
  }
  if (Array.isArray(sample?.raw?.dosages) && sample.raw.dosages.length) {
    return snapshotDosages(sample.raw);
  }
  return [];
}

function snapshotMedicine(med) {
  const name = medName(med);
  if (!name) return null;
  return {
    name,
    dosage: String(med?.dosage || "").trim(),
    frequency: med?.frequency || null,
    duration: med?.duration || med?.durationText || null,
    directions: String(
      med?.patientDirections || med?.directions || med?.instructions || "",
    ).trim(),
    type: String(med?.type || med?.form || "").trim(),
    dosages: snapshotDosages(med),
    raw: med,
  };
}

function snapshotLab(lab) {
  const name = labName(lab);
  if (!name) return null;
  return { name };
}

function uniqueBullets(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    const items = Array.isArray(list) ? list : bulletsFromText(list);
    for (const raw of items) {
      const text = String(raw || "").trim();
      if (!text) continue;
      const key = normalizeBulletKey(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
  }
  return out;
}

function buildCaseFromPrescription({
  hospitalId,
  doctorId,
  umr,
  prescription,
  patientAge = "",
  patientGender = "",
}) {
  const prescriptionId = String(
    prescription?.prescriptionId || prescription?._id || "",
  ).trim();
  if (!prescriptionId || !doctorId) return null;

  const noteList = Array.isArray(prescription?.doctorNotes)
    ? prescription.doctorNotes
    : prescription?.doctorNotes
    ? [prescription.doctorNotes]
    : [];

  const note = noteList
    .map((n) => (typeof n === "string" ? n : n?.content || n?.text || ""))
    .filter(Boolean)
    .join("\n");

  const sections = parseLabeledSections(note);
  const complaints = uniqueBullets(
    prescription?.symptoms
      ? Array.isArray(prescription.symptoms)
        ? prescription.symptoms
        : bulletsFromText(prescription.symptoms)
      : [],
    sections.complaints,
  );
  const history = uniqueBullets(
    prescription?.pastMedicalHistory,
    sections.history,
  );
  const diagnosis = uniqueBullets(
    prescription?.provisionalDiagnosis,
    sections.diagnosis,
  );
  const advice = uniqueBullets(sections.advice);
  const proceduresFromRx = [
    ...(Array.isArray(prescription?.procedureData)
      ? prescription.procedureData
      : []),
    ...(Array.isArray(prescription?.procedures) ? prescription.procedures : []),
  ]
    .map(procName)
    .filter(Boolean);
  const procedures = [
    ...new Set([...proceduresFromRx, ...sections.procedures]),
  ];

  const medicines = (
    Array.isArray(prescription?.medicineData) ? prescription.medicineData : []
  )
    .filter((m) => m?.isActive !== false)
    .map(snapshotMedicine)
    .filter(Boolean);

  const labs = (
    Array.isArray(prescription?.diagnosticData)
      ? prescription.diagnosticData
      : []
  )
    .map(snapshotLab)
    .filter(Boolean);

  if (
    !medicines.length &&
    !labs.length &&
    !procedures.length &&
    !note.trim() &&
    !complaints.length &&
    !diagnosis.length
  ) {
    return null;
  }

  const searchBlob = [
    ...complaints,
    ...history,
    ...sections.examination,
    ...diagnosis,
    ...advice,
    ...procedures,
    note,
  ].join(" ");

  const visitDateRaw = prescription?.date || prescription?.createdAt;
  const visitDate = visitDateRaw ? new Date(visitDateRaw) : null;

  return {
    hospitalId: String(hospitalId),
    doctorId: String(doctorId),
    umr: String(umr || prescription?.UMRNo || "").trim(),
    prescriptionId,
    visitDate:
      visitDate && !Number.isNaN(visitDate.getTime()) ? visitDate : null,
    complaints,
    history,
    examination: sections.examination,
    diagnosis,
    advice,
    procedures,
    searchText: normalizeText(searchBlob),
    searchTokens: tokenize(searchBlob),
    medicines,
    labs,
    patientAge: String(patientAge || "").trim(),
    patientGender: String(patientGender || "").trim(),
    source: "prescription",
  };
}

function pickModeValue(items, picker) {
  const counts = new Map();
  for (const item of items) {
    const key = picker(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function buildCaseScoreMap(similarCases = [], scores = []) {
  const map = new Map();
  similarCases.forEach((clinicalCase, index) => {
    map.set(
      clinicalCase.prescriptionId || String(index),
      Number(scores[index]) || 0,
    );
  });
  return map;
}

function casePassesScoreGate(
  clinicalCase,
  caseScores,
  minScore = MIN_CASE_SCORE_FOR_ORDERS,
) {
  if (clinicalCase?.source === "package") return true;
  const score = caseScores.get(clinicalCase?.prescriptionId) || 0;
  return score >= minScore;
}

function pickBestDisplayName(samples = []) {
  if (!samples.length) return "";
  const sorted = [...samples].sort((a, b) => {
    const nameA = String(a.name || "");
    const nameB = String(b.name || "");
    const hasDosageA = nameA.match(/\d+/) ? 1 : 0;
    const hasDosageB = nameB.match(/\d+/) ? 1 : 0;
    if (hasDosageA !== hasDosageB) return hasDosageB - hasDosageA;
    return nameB.length - nameA.length;
  });
  return sorted[0]?.name || "";
}

function aggregateMedicinePills(
  similarCases,
  currentReview = {},
  caseScores = new Map(),
) {
  const currentMeds = new Set(
    (currentReview.medicines || [])
      .map((m) => normalizeMedKey(medName(m)))
      .filter(Boolean),
  );

  const gatedCases = similarCases.filter((clinicalCase) =>
    casePassesScoreGate(clinicalCase, caseScores),
  );
  const buckets = new Map();
  for (const clinicalCase of gatedCases) {
    for (const med of clinicalCase.medicines || []) {
      const key = normalizeMedKey(med.name);
      if (!key) continue;
      if (!buckets.has(key)) {
        buckets.set(key, { key, samples: [] });
      }
      buckets.get(key).samples.push(med);
    }
  }

  const caseCount = gatedCases.length || 1;
  const pills = [];

  for (const bucket of buckets.values()) {
    const frequencyInCases = bucket.samples.length / caseCount;
    const displayName = pickBestDisplayName(bucket.samples);
    const form =
      detectMedForm(displayName) ||
      detectMedForm(bucket.samples[0]?.name) ||
      "tab";
    if (form === "tab") {
      if (frequencyInCases < MIN_MED_FREQUENCY && bucket.samples.length < 2) {
        continue;
      }
    }

    const dosage = pickModeValue(
      bucket.samples.filter((m) => m.dosage),
      (m) => m.dosage,
    );
    const directions = pickModeValue(bucket.samples, (m) => m.directions);
    const type = pickModeValue(bucket.samples, (m) => m.type);
    const inferredType =
      type ||
      ({
        tab: "Tablet",
        syp: "Syrup",
        inj: "Injection",
        iv: "IV Fluid",
        drops: "Drops",
        topical: "Ointment",
        sachet: "Sachet",
        inh: "Inhaler",
      }[form] || "");

    let frequency = null;
    let duration = null;
    const freqSamples = bucket.samples.filter(
      (m) => m.frequency && Number(m.frequency.value) > 0,
    );
    const freqKey = pickModeValue(
      freqSamples.length ? freqSamples : bucket.samples,
      (m) => JSON.stringify(m.frequency || null),
    );
    if (freqKey) {
      try {
        frequency = JSON.parse(freqKey);
      } catch {
        frequency = null;
      }
    }
    const durKey = pickModeValue(bucket.samples, (m) =>
      JSON.stringify(m.duration || null),
    );
    if (durKey) {
      try {
        duration = JSON.parse(durKey);
      } catch {
        duration = null;
      }
    }

    let dosages = [];
    const dosagesKey = pickModeValue(bucket.samples, (m) =>
      JSON.stringify(medDosages(m)),
    );
    if (dosagesKey) {
      try {
        dosages = JSON.parse(dosagesKey);
      } catch {
        dosages = [];
      }
    }

    pills.push({
      name: displayName,
      canonicalKey: bucket.key,
      dosage,
      frequency,
      duration,
      directions,
      type: inferredType,
      dosages,
      frequencyInCases: Math.round(frequencyInCases * 1000) / 1000,
      usedInCases: bucket.samples.length,
      alreadyInReview: currentMeds.has(bucket.key),
      preselected: false,
    });
  }

  pills.sort((a, b) => b.frequencyInCases - a.frequencyInCases);
  const visible = pills.filter((pill) => !pill.alreadyInReview);
  const byCategory = new Map();
  for (const pill of visible) {
    const cat = medicineFormCategory(pill);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    const list = byCategory.get(cat);
    if (list.length < MAX_PER_MED_CATEGORY) list.push(pill);
  }
  const mixed = [];
  for (const list of byCategory.values()) mixed.push(...list);
  return mixed.slice(0, MAX_MED_SUGGESTIONS);
}

function aggregateLabPills(
  similarCases,
  currentReview = {},
  caseScores = new Map(),
) {
  const currentLabs = new Set(
    (currentReview.labTests || [])
      .map((t) =>
        normalizeLabKey(
          typeof t === "string" ? t : t?.name || t?.test_name || "",
        ),
      )
      .filter(Boolean),
  );

  const gatedCases = similarCases.filter((clinicalCase) =>
    casePassesScoreGate(clinicalCase, caseScores),
  );
  const buckets = new Map();
  for (const clinicalCase of gatedCases) {
    for (const lab of clinicalCase.labs || []) {
      const key = normalizeLabKey(lab.name);
      if (!key) continue;
      if (!buckets.has(key)) {
        const canonicalName = CANONICAL_LAB_NAMES[key] || lab.name;
        buckets.set(key, { key, name: canonicalName, count: 0 });
      }
      buckets.get(key).count += 1;
    }
  }

  const caseCount = gatedCases.length || 1;
  const pills = [];
  for (const bucket of buckets.values()) {
    const frequencyInCases = bucket.count / caseCount;
    if (frequencyInCases < MIN_LAB_FREQUENCY && bucket.count < 2) continue;
    pills.push({
      name: bucket.name,
      canonicalKey: bucket.key,
      frequencyInCases: Math.round(frequencyInCases * 1000) / 1000,
      usedInCases: bucket.count,
      alreadyInReview: currentLabs.has(bucket.key),
      preselected: false,
    });
  }

  pills.sort((a, b) => b.frequencyInCases - a.frequencyInCases);
  return pills
    .filter((pill) => !pill.alreadyInReview)
    .slice(0, MAX_LAB_SUGGESTIONS);
}

function aggregateTextPills(
  similarCases,
  field,
  currentBullets = [],
  caseScores = new Map(),
) {
  const currentSet = new Set(
    (currentBullets || [])
      .map((text) => normalizeNoteIdeaKey(text) || normalizeBulletKey(text))
      .filter(Boolean),
  );

  const buckets = new Map();
  let weightSum = 0;
  for (const clinicalCase of similarCases) {
    if (clinicalCase.source === "package") continue;
    if (!casePassesScoreGate(clinicalCase, caseScores)) continue;
    const weight =
      caseScores.get(clinicalCase.prescriptionId) || MIN_CASE_SCORE_FOR_ORDERS;
    weightSum += weight;
    const items = clinicalCase[field] || [];
    for (const raw of items) {
      const text = String(raw || "").trim();
      if (!text || text.length < 3) continue;
      const key = normalizeNoteIdeaKey(text) || normalizeBulletKey(text);
      if (!key) continue;
      if (currentSet.has(key)) continue;
      if (!buckets.has(key)) {
        buckets.set(key, { text, weight: 0 });
      }
      buckets.get(key).weight += weight;
      if (
        text.length < buckets.get(key).text.length &&
        text.length >= 8
      ) {
        buckets.get(key).text = text;
      }
    }
  }

  const denom = weightSum || 1;
  const pills = [];
  for (const bucket of buckets.values()) {
    const frequencyInCases = bucket.weight / denom;
    if (frequencyInCases < MIN_TEXT_FREQUENCY) continue;
    pills.push({
      text: bucket.text,
      frequencyInCases: Math.round(frequencyInCases * 1000) / 1000,
      usedInCases: Math.round(bucket.weight * 10),
      alreadyInNote: false,
      source: "memory",
    });
  }

  pills.sort((a, b) => b.frequencyInCases - a.frequencyInCases);
  return pills.slice(0, MAX_TEXT_SUGGESTIONS);
}

function aggregateProcedurePills(
  similarCases,
  currentReview = {},
  caseScores = new Map(),
) {
  const currentProcs = new Set();
  for (const proc of currentReview.procedures || []) {
    const key = normalizeBulletKey(procName(proc));
    if (key) currentProcs.add(key);
  }
  for (const name of currentReview.procedureNames || []) {
    const key = normalizeBulletKey(name);
    if (key) currentProcs.add(key);
  }

  const gatedCases = similarCases.filter((clinicalCase) =>
    casePassesScoreGate(clinicalCase, caseScores),
  );
  const buckets = new Map();
  for (const clinicalCase of gatedCases) {
    for (const raw of clinicalCase.procedures || []) {
      const name = procName(raw);
      if (!name) continue;
      const key = normalizeBulletKey(name);
      if (!key) continue;
      if (!buckets.has(key)) {
        buckets.set(key, { name, count: 0 });
      }
      buckets.get(key).count += 1;
    }
  }

  const caseCount = gatedCases.length || 1;
  const pills = [];
  for (const bucket of buckets.values()) {
    const frequencyInCases = bucket.count / caseCount;
    if (frequencyInCases < MIN_PROCEDURE_FREQUENCY && bucket.count < 2) {
      continue;
    }
    pills.push({
      name: bucket.name,
      frequencyInCases: Math.round(frequencyInCases * 1000) / 1000,
      usedInCases: bucket.count,
      alreadyInReview: currentProcs.has(normalizeBulletKey(bucket.name)),
    });
  }

  pills.sort((a, b) => b.frequencyInCases - a.frequencyInCases);
  return pills
    .filter((pill) => !pill.alreadyInReview)
    .slice(0, MAX_PROCEDURE_SUGGESTIONS);
}

function buildNotePills(
  similarCases,
  noteContext = {},
  caseScores = new Map(),
) {
  const sections = ["complaints", "examination", "diagnosis", "advice"];
  const used = new Set();
  const result = {};

  for (const section of sections) {
    const pills = aggregateTextPills(
      similarCases,
      section,
      noteContext[section],
      caseScores,
    ).filter((pill) => {
      const key =
        normalizeNoteIdeaKey(pill.text) || normalizeBulletKey(pill.text);
      if (!key || used.has(key)) return false;
      used.add(key);
      return true;
    });
    result[section] = pills;
  }
  return result;
}

function bulletAlreadyInNote(text, noteContext = {}) {
  const key = normalizeNoteIdeaKey(text) || normalizeBulletKey(text);
  if (!key) return true;
  for (const section of ["complaints", "examination", "diagnosis", "advice"]) {
    const items = noteContext[section] || [];
    for (const bullet of items) {
      const bulletKey =
        normalizeNoteIdeaKey(bullet) || normalizeBulletKey(bullet);
      if (bulletKey === key) return true;
    }
  }
  return false;
}

function buildMemoryHints(
  similarCases,
  scores = [],
  packages = [],
  noteContext = {},
) {
  const caseScore = new Map();
  similarCases.forEach((clinicalCase, index) => {
    caseScore.set(
      clinicalCase.prescriptionId || String(index),
      Number(scores[index]) || 0.1,
    );
  });

  const note = {};
  for (const section of ["complaints", "examination", "diagnosis", "advice"]) {
    const bucket = new Map();
    for (const clinicalCase of similarCases) {
      if (clinicalCase.source === "package") continue;
      const weight = caseScore.get(clinicalCase.prescriptionId) || 0.1;
      for (const raw of clinicalCase[section] || []) {
        const text = String(raw || "").trim();
        if (!text || text.length < 3) continue;
        if (bulletAlreadyInNote(text, noteContext)) continue;
        const key = normalizeNoteIdeaKey(text) || normalizeBulletKey(text);
        if (!key) continue;
        if (!bucket.has(key)) bucket.set(key, { text, score: 0 });
        bucket.get(key).score += weight;
        if (text.length < bucket.get(key).text.length && text.length >= 8) {
          bucket.get(key).text = text;
        }
      }
    }
    note[section] = [...bucket.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((row) => row.text);
  }

  const medicineBucket = new Map();
  const labBucket = new Map();
  const procedureBucket = new Map();

  for (const clinicalCase of similarCases) {
    const weight = caseScore.get(clinicalCase.prescriptionId) || 0.1;
    for (const med of clinicalCase.medicines || []) {
      const name = medName(med);
      if (!name) continue;
      const key = normalizeMedKey(name);
      if (!medicineBucket.has(key)) {
        medicineBucket.set(key, { name, score: 0 });
      }
      medicineBucket.get(key).score += weight;
    }
    for (const lab of clinicalCase.labs || []) {
      const name = labName(lab);
      if (!name) continue;
      const key = normalizeLabKey(name);
      const canonicalName = CANONICAL_LAB_NAMES[key] || name;
      if (!labBucket.has(key)) labBucket.set(key, { name: canonicalName, score: 0 });
      labBucket.get(key).score += weight;
    }
    for (const proc of clinicalCase.procedures || []) {
      const name = procName(proc);
      if (!name) continue;
      const key = normalizeBulletKey(name);
      if (!procedureBucket.has(key)) {
        procedureBucket.set(key, { name, score: 0 });
      }
      procedureBucket.get(key).score += weight;
    }
  }

  const packageNames = (packages || [])
    .map((pkg) => String(pkg?.name || "").trim())
    .filter(Boolean);

  return {
    note,
    medicines: [...medicineBucket.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((row) => row.name),
    labs: [...labBucket.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((row) => row.name),
    procedures: [...procedureBucket.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((row) => row.name),
    packageNames,
    hasNoteHints: Object.values(note).some((items) => items.length > 0),
  };
}

function hasUsableOrderMemory(similarCases) {
  return similarCases.some(
    (clinicalCase) =>
      (clinicalCase.medicines || []).length > 0 ||
      (clinicalCase.labs || []).length > 0 ||
      (clinicalCase.procedures || []).length > 0,
  );
}

/**
 * Enhanced Clinical Case Scorer
 * Uses asymmetric containment (so short notes match rich records) + Diagnosis boost + Jaccard
 */
function scoreCase(clinicalCase, context, _umr) {
  if (!caseMatchesContext(clinicalCase, context)) return 0;

  const queryTokens = context.searchTokens || [];
  const caseTokens = clinicalCase.searchTokens || [];
  if (!queryTokens.length || !caseTokens.length) return 0;

  const setCase = new Set(caseTokens);
  let matchCount = 0;
  for (const t of queryTokens) {
    if (setCase.has(t)) matchCount += 1;
  }

  // 1. Asymmetric containment: % of what the doctor typed that is in the historical case
  const containment = matchCount / queryTokens.length;

  // 2. Symmetric Jaccard
  const unionSize = new Set([...queryTokens, ...caseTokens]).size;
  const jaccardScore = unionSize ? matchCount / unionSize : 0;

  let score = containment * 0.65 + jaccardScore * 0.35;

  // 3. Diagnosis Token Priority Boost
  const queryDiagTokens = tokenize((context.diagnosis || []).join(" "));
  if (queryDiagTokens.length) {
    const caseDiagTokens = tokenize((clinicalCase.diagnosis || []).join(" "));
    if (caseDiagTokens.length) {
      const caseDiagSet = new Set(caseDiagTokens);
      let diagMatches = 0;
      for (const dt of queryDiagTokens) {
        if (caseDiagSet.has(dt)) diagMatches += 1;
      }
      const diagContainment = diagMatches / queryDiagTokens.length;
      score += diagContainment * 0.4;
    }
  }

  score += recencyBoost(clinicalCase.visitDate);

  return Math.min(1, score);
}

function packagePseudoCases(packages = []) {
  const out = [];
  for (const pkg of packages) {
    const meds = (pkg?.medicines || []).map(snapshotMedicine).filter(Boolean);
    const labs = (pkg?.labTests || []).map(snapshotLab).filter(Boolean);
    const procedures = (pkg?.procedures || [])
      .map(procName)
      .filter(Boolean)
      .map((name) => ({ name }));
    if (!meds.length && !labs.length) continue;
    const name = String(pkg?.name || "").trim();
    out.push({
      hospitalId: String(pkg.hospitalId || ""),
      doctorId: String(pkg.doctorId || ""),
      umr: "",
      prescriptionId: `pkg:${pkg._id}`,
      visitDate: pkg.updatedAt || pkg.createdAt || null,
      complaints: [],
      history: [],
      examination: [],
      diagnosis: name ? [name.replace(/^advice:\s*/i, "").trim()] : [],
      searchText: normalizeText(name),
      searchTokens: tokenize(name),
      medicines: meds,
      labs,
      procedures: procedures.map((p) => p.name),
      source: "package",
      _packageWeight: 0.35,
    });
  }
  return out;
}

function normalizeDoctorIds(doctorIdOrIds) {
  const raw = Array.isArray(doctorIdOrIds) ? doctorIdOrIds : [doctorIdOrIds];
  return [...new Set(raw.map((id) => String(id || "").trim()).filter(Boolean))];
}

/**
 * Direct crawl of Prescriptions — no intermediate shadow table needed.
 */
async function findSimilarCases({
  Prescription,
  ClinicalOrderPackage,
  doctorIds,
  hospitalId,
  context,
  umr,
  excludePrescriptionId,
  limit = SIMILAR_CASE_LIMIT,
}) {
  const resolvedDoctorIds = normalizeDoctorIds(doctorIds);
  if (!resolvedDoctorIds.length) {
    return { similarCases: [], scores: [], packages: [] };
  }

  // Fetch recent prescriptions directly from Prescription collection
  const allPrescriptions = await Prescription.find({
    hospitalId: String(hospitalId),
    doctorId: { $in: resolvedDoctorIds },
  })
    .sort({ date: -1, createdAt: -1 })
    .limit(300)
    .lean();

  let packages = [];
  if (ClinicalOrderPackage) {
    packages = await ClinicalOrderPackage.find({
      hospitalId,
      doctorId: { $in: resolvedDoctorIds },
      active: { $ne: false },
    })
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();
  }

  const scored = [];
  for (const rx of allPrescriptions) {
    const rxId = String(rx.prescriptionId || rx._id || "").trim();
    if (excludePrescriptionId && rxId === String(excludePrescriptionId).trim()) {
      continue;
    }

    const clinicalCase = buildCaseFromPrescription({
      hospitalId,
      doctorId: rx.doctorId,
      umr: rx.UMRNo,
      prescription: rx,
    });
    if (!clinicalCase) continue;

    const samePatient =
      umr &&
      clinicalCase.umr &&
      String(umr).trim() === String(clinicalCase.umr).trim();
    if (samePatient) continue;

    const score = scoreCase(clinicalCase, context, umr);
    if (score < MIN_SIMILARITY_SCORE) continue;
    scored.push({ clinicalCase, score });
  }

  for (const pseudo of packagePseudoCases(packages)) {
    const score =
      scoreCase(pseudo, context, umr) * (pseudo._packageWeight || 0.35);
    if (score < MIN_SIMILARITY_SCORE * 0.5) continue;
    scored.push({ clinicalCase: pseudo, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return {
    similarCases: scored.slice(0, limit).map((row) => row.clinicalCase),
    scores: scored.slice(0, limit).map((row) => row.score),
    packages,
  };
}

function confidenceFromCount(count) {
  if (count >= 8) return "high";
  if (count >= MIN_SIMILAR_CASES) return "medium";
  if (count >= 1) return "low";
  return "none";
}

const {
  suggestNotePillsWithLlm,
  suggestOrderPillsWithLlm,
  cleanPracticeSuggestionsWithLlm,
  buildNotePillsFromHints,
  mergeNotePills,
  countNotePills,
} = require("./practiceSuggestLlm");

async function suggestFromPractice({
  tenantDb,
  hospitalId,
  doctorId,
  doctorIds,
  umr,
  extractedClinical,
  currentReview = {},
  excludePrescriptionId,
}) {
  const Prescription = tenantDb.model("Prescription");
  const ClinicalOrderPackage = tenantDb.models.ClinicalOrderPackage || null;
  const resolvedDoctorIds = normalizeDoctorIds(doctorIds || doctorId);

  const context = buildSearchContext(extractedClinical);
  const { similarCases, scores, packages } = await findSimilarCases({
    Prescription,
    ClinicalOrderPackage,
    doctorIds: resolvedDoctorIds,
    hospitalId,
    context,
    umr,
    excludePrescriptionId,
  });

  const prescriptionCases = similarCases.filter((c) => c.source !== "package");
  const similarCaseCount = prescriptionCases.length;

  const noteContext = buildSearchContext({
    clinicalNote:
      currentReview.clinicalNote || extractedClinical.clinicalNote || "",
    symptoms: extractedClinical.symptoms,
    pastMedicalHistory: extractedClinical.pastMedicalHistory,
    provisionalDiagnosis: extractedClinical.provisionalDiagnosis,
  });
  const caseScoreMap = buildCaseScoreMap(similarCases, scores);
  const memoryHints = buildMemoryHints(
    similarCases,
    scores,
    packages,
    noteContext,
  );

  const emptyNotePills = {
    complaints: [],
    examination: [],
    diagnosis: [],
    advice: [],
  };

  let notePills = emptyNotePills;
  let medicinePills = [];
  let labPills = [];
  let procedurePills = [];
  let suggestionSource = "memory";

  const orderMemoryAvailable = hasUsableOrderMemory(similarCases);
  if (orderMemoryAvailable) {
    medicinePills = aggregateMedicinePills(
      similarCases,
      currentReview,
      caseScoreMap,
    );
    labPills = aggregateLabPills(similarCases, currentReview, caseScoreMap);
    procedurePills = aggregateProcedurePills(
      similarCases,
      {
        procedures: currentReview.procedures || [],
        procedureNames: noteContext.procedures,
      },
      caseScoreMap,
    );
  }

  if (similarCaseCount >= MIN_SIMILAR_CASES) {
    notePills = buildNotePills(similarCases, noteContext, caseScoreMap);
    suggestionSource = "memory";
  } else if (memoryHints.hasNoteHints) {
    notePills = buildNotePillsFromHints(memoryHints, noteContext);
    suggestionSource = "memory";
  }

  if (countNotePills(notePills) === 0) {
    try {
      const llmNotePills = await suggestNotePillsWithLlm({
        extractedClinical,
        noteContext,
        memoryHints,
      });
      notePills = mergeNotePills(notePills, llmNotePills);
      if (countNotePills(llmNotePills) > 0 && suggestionSource === "memory") {
        suggestionSource = memoryHints.hasNoteHints ? "memory" : "llm";
      } else if (
        countNotePills(notePills) > 0 &&
        suggestionSource !== "memory"
      ) {
        suggestionSource = "llm";
      }
    } catch (error) {
      console.warn("LLM note suggest failed:", error?.message || error);
    }
  }

  const needsLlmOrders =
    !orderMemoryAvailable ||
    (medicinePills.length === 0 &&
      labPills.length === 0 &&
      procedurePills.length === 0);

  if (needsLlmOrders) {
    try {
      const llmOrders = await suggestOrderPillsWithLlm({
        extractedClinical,
        currentReview: {
          ...currentReview,
          procedureNames: noteContext.procedures,
        },
        memoryHints,
      });
      if (medicinePills.length === 0) {
        medicinePills = llmOrders.medicinePills || [];
      }
      if (labPills.length === 0) {
        labPills = llmOrders.labPills || [];
      }
      if (procedurePills.length === 0) {
        procedurePills = llmOrders.procedurePills || [];
      }
      if (
        !orderMemoryAvailable &&
        (medicinePills.length || labPills.length || procedurePills.length)
      ) {
        suggestionSource = suggestionSource === "memory" ? "memory+llm" : "llm";
      }
    } catch (error) {
      console.warn("LLM order suggest failed:", error?.message || error);
    }
  }

  try {
    const cleaned = await cleanPracticeSuggestionsWithLlm({
      extractedClinical,
      noteContext,
      medicinePills,
      labPills,
      procedurePills,
      notePills,
    });
    const hadMemory =
      medicinePills.length ||
      labPills.length ||
      procedurePills.length ||
      countNotePills(notePills) > 0;
    medicinePills = cleaned.medicinePills;
    labPills = cleaned.labPills;
    procedurePills = cleaned.procedurePills;
    notePills = cleaned.notePills;
    if (
      hadMemory &&
      suggestionSource === "memory" &&
      (medicinePills.length > 0 || labPills.length > 0)
    ) {
      suggestionSource = "memory+llm";
    }
  } catch (error) {
    console.warn("LLM suggestion clean failed:", error?.message || error);
  }

  let patientContinue = null;
  if (umr) {
    const lastPatientRx = await Prescription.findOne({
      hospitalId: String(hospitalId),
      doctorId: { $in: resolvedDoctorIds },
      UMRNo: String(umr).trim(),
      ...(excludePrescriptionId
        ? { prescriptionId: { $ne: String(excludePrescriptionId).trim() } }
        : {}),
    })
      .sort({ date: -1, createdAt: -1 })
      .lean();

    if (lastPatientRx) {
      const activeMeds = (
        Array.isArray(lastPatientRx.medicineData)
          ? lastPatientRx.medicineData
          : []
      )
        .filter((m) => m?.isActive !== false)
        .map(medName)
        .filter(Boolean);

      const activeLabs = (
        Array.isArray(lastPatientRx.diagnosticData)
          ? lastPatientRx.diagnosticData
          : []
      )
        .map(labName)
        .filter(Boolean);

      if (activeMeds.length || activeLabs.length) {
        const seenMed = new Set();
        const seenLab = new Set();
        patientContinue = {
          prescriptionId: lastPatientRx.prescriptionId,
          visitDate: lastPatientRx.date || lastPatientRx.createdAt,
          medicines: activeMeds.filter((name) => {
            const key = normalizeMedKey(name);
            if (!key || seenMed.has(key)) return false;
            seenMed.add(key);
            return true;
          }),
          labs: activeLabs.filter((name) => {
            const key = normalizeLabKey(name);
            if (!key || seenLab.has(key)) return false;
            seenLab.add(key);
            return true;
          }),
        };
      }
    }
  }

  const continueMedKeys = new Set(
    (patientContinue?.medicines || []).map((name) => normalizeMedKey(name)),
  );
  const continueLabKeys = new Set(
    (patientContinue?.labs || []).map((name) => normalizeLabKey(name)),
  );
  medicinePills = medicinePills.filter(
    (pill) => !continueMedKeys.has(normalizeMedKey(pill.name)),
  );
  labPills = labPills.filter(
    (pill) => !continueLabKeys.has(normalizeLabKey(pill.name)),
  );

  return {
    similarCaseCount,
    confidence: confidenceFromCount(similarCaseCount),
    suggestionSource,
    notePills,
    medicinePills,
    labPills,
    procedurePills,
    patientContinue,
    contextSummary: {
      complaints: noteContext.complaints.slice(0, 6),
      diagnosis: noteContext.diagnosis.slice(0, 4),
    },
  };
}

// Backwards-compatible stubs for any legacy invocation
async function upsertClinicalCase() {
  return null;
}
async function syncClinicalCasesFromPatient() {
  return { indexed: 0 };
}
async function clearClinicalCasesForTenant() {
  return { deleted: 0 };
}
async function backfillClinicalCasesForTenant() {
  return { ok: true, message: "Direct prescription crawl active" };
}
async function rebuildClinicalCasesForTenant() {
  return { ok: true, message: "Direct prescription crawl active" };
}

module.exports = {
  buildSearchContext,
  buildCaseFromPrescription,
  suggestFromPractice,
  upsertClinicalCase,
  syncClinicalCasesFromPatient,
  clearClinicalCasesForTenant,
  backfillClinicalCasesForTenant,
  rebuildClinicalCasesForTenant,
  normalizeMedKey,
  normalizeLabKey,
  normalizeBulletKey,
  normalizeNoteIdeaKey,
  caseMatchesContext,
  scoreCase,
  MIN_SIMILAR_CASES,
};
