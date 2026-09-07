/**
 * OPD AI Prescription Engine & Route
 * Single self-contained module for Outpatient (OPD) prescription AI copilot.
 * Handles interactive review follow-ups, prompt engineering, delta merge, and streaming replies.
 */

const express = require("express");
const router = express.Router();
const axios = require("axios");
const { aiCompletionWithFallback } = require("../utils/aiCompletionWithFallback");
const {
  mergeNoteWithOps,
  formatDoctorNotesLayout,
  parseComposedNoteSections,
  composeNoteFromSections,
} = require("../utils/ipdAi");

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL =
  process.env.OPENAI_FALLBACK_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4.1-mini";
const PARSE_NOTE_MODEL =
  process.env.GEMINI_PARSE_MODEL ||
  process.env.GEMINI_TRANSCRIBE_MODEL ||
  "gemini-3.1-flash-lite";
const PARSE_NOTE_TIMEOUT_MS =
  Number(process.env.GEMINI_PARSE_TIMEOUT_MS) ||
  Number(process.env.OPENAI_PARSE_TIMEOUT_MS) ||
  30000;
const REVIEW_FOLLOWUP_DELTA_MAX_TOKENS =
  Number(process.env.OPENAI_FOLLOWUP_MAX_TOKENS) || 4096;
const REVIEW_FOLLOWUP_DELTA_RETRY_MAX_TOKENS =
  Number(process.env.OPENAI_FOLLOWUP_RETRY_MAX_TOKENS) || 8192;
const REVIEW_FOLLOWUP_REPLY_MAX_TOKENS = 60;

const openaiApi = axios.create({
  baseURL: OPENAI_API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  },
});

/* ========================================================================== */
/* Prompts                                                                    */
/* ========================================================================== */

const PARSE_CLINICAL_NOTE_SYSTEM_PROMPT = `You are a senior, highly experienced clinician-scribe for an Indian hospital EMR, equally fluent across all departments and specializations (medicine, surgery, paediatrics, obstetrics & gynaecology, orthopaedics, ENT, ophthalmology, dermatology, psychiatry, pulmonology, cardiology, nephrology, neurology, gastroenterology, urology, oncology, emergency, ICU, and every other specialty). Convert the CURRENT doctor dictation or consult transcript into the requested JSON. Return valid JSON only. You are the ONLY clinical authority for this output — structure everything correctly yourself, the way a senior consultant would chart.`;

const OPD_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM = `

REVIEW FOLLOW-UP MODE — UNIVERSAL CLINICAL RULES (PATCH ONLY)

1. GROUND TRUTH & MINIMAL PATCHING:
- CURRENT CHART is the doctor's prescription chart exactly as it stands on screen right now (ground truth).
- INSTRUCTION is the single new update requested right now.
- Output ONLY operations for items that INSTRUCTION explicitly changes. The app preserves every omitted item as-is.
- FORBIDDEN: Re-listing unchanged medicines, labs, or notes. Output minimal ops only.
- If the instruction does not name a medicine, medicineOps MUST be []. Same for labs/procedures. But if the instruction names or implies ANY clinical symptom (e.g. fever, pain, cough), you MUST emit noteOps under Complaints.
- Match existing items using their exact "name" from CURRENT CHART.

2. CONDITIONAL & CONTINGENT ORDERS vs IMMEDIATE ORDERS (CRITICAL):
- Distinguish between IMMEDIATE orders (to perform or dispense right now) vs CONTINGENT recommendations (actions conditioned on future symptoms, thresholds, or test results).
- Any order with conditional or contingency phrasing (e.g. "if", "only if", "in case of", "unless", "when", "if persists", "if positive/negative", "if palpable", "if focal", "if wheeze", "if stridor") MUST NEVER be placed into labOps, medicineOps, or procedureOps.
- Instead, record all conditional instructions under "Advice" (preferably via noteOps: {"section": "advice", "action": "add", "text": "..."}). If returning doctorNotes string, always include both Diagnosis and Advice — NEVER emit an Advice-only note that drops or loses the patient's Diagnosis!
- ONLY unconditional orders to be carried out immediately during this visit belong in labOps, medicineOps, or procedureOps.

3. RESTRICTIONS, NEGATIVE ADVICE & CONTRAINDICATIONS:
- Any clinical directive, dietary advice, or restriction (e.g. "NPO / Nil per os", "no [drug/class]", "avoid [item]", "plenty of fluids", "bed rest", "review if...") MUST be recorded under "Advice" in doctorNotes (or via noteOps under "advice").
- If the doctor negates or rules out an existing diagnosis on the chart (e.g. "not malaria", "ruled out malaria"):
  - Update the Diagnosis section so that it explicitly states "Not Malaria" or "Malaria ruled out" (e.g. in doctorNotes: "Diagnosis:\n• Malaria ruled out", or via noteOps: remove "Malaria", add "Malaria ruled out"). NEVER leave or echo the disease as a positive diagnosis!
- FORBIDDEN UNCONFIRMED DIAGNOSES: When the doctor says "no invent [X] dx", "no dx", or orders viral serology/screening (e.g. HBsAg, HCV, HIV), completely OMIT the Diagnosis section! Do NOT output "Diagnosis:" heading at all, do NOT emit noteOps for diagnosis, and NEVER write "No [X] diagnosis" or "[X] ruled out" or mention [X] under Diagnosis.

4. CLINICAL TERMINOLOGY & SPELLING CORRECTION (CRITICAL):
- SPELLING & PHONETIC CORRECTION:
  - Correct all spelling mistakes, speech-to-text typos, phonetics, and transcription slips into standard medical spelling across all fields (medicines, tests, complaints, diagnosis).
  - BRAND NAMES vs GENERIC MOLECULES (STRICT FIDELITY):
    - PRESERVE SPOKEN IDENTITY EXACTLY:
      - If spoken as a BRAND NAME: Keep the exact brand name spoken (e.g. "Pan 40" must be kept as "Pan 40", NOT "Pantop 40"; "Pantop 40" must be kept as "Pantop 40"; "Dolo 650" must be kept as "Dolo 650", NOT "Paracetamol"; "Levipil 500" must be kept as "Levipil 500", NOT "Levetiracetam"; "Drotin", "Gabapin ME", "Nodosis", "Primolut N", "Montair LC", "Telma AM H", "Ecosprin Gold", "Ascoril", "Betnovate"). Correct typos/spelling in the brand name, but NEVER replace a brand name with a generic chemical name, and NEVER change one brand name into a different brand name.
      - If spoken as a GENERIC MOLECULE OR SHORTHAND: Keep it as generic, correcting typos to the proper generic name (e.g. "asprin" -> "Aspirin", "azithro" -> "Azithromycin", "pcm" -> "PCM", "itra" -> "Itraconazole", "doxy" -> "Doxycycline", "nitro" -> "Nitrofurantoin", "mtx" -> "Methotrexate", "folic" -> "Folic Acid"). NEVER substitute a generic molecule with an arbitrary commercial brand (e.g. if doctor says "pcm", KEEP IT as "PCM" or "Paracetamol", NEVER replace with brand "Dolo").
    - BRAND SUFFIXES: Keep every spoken letter/number suffix intact (e.g. ME, Plus, D, AM, H, LS, LC, OZ). Never strip or drop suffixes.

- DISTINCT MEDICATIONS IN SEQUENTIAL / UNPUNCTUATED DICTATIONS:
  - In clinical dictations, doctors often dictate multiple medicines sequentially without commas (e.g. "dolo650 bd5d pcm sos", "nitrofurantoin 100 bd 5d pcm 650 tds sos pantop 40 od bbf"):
    - Every drug name, brand, or molecule (e.g. "dolo", "pcm", "pantop", "nitrofurantoin", "gabapin") represents an independent medication prescription.
    - You MUST emit EACH drug as a separate, distinct object in medicineOps!
    - NEVER merge a second drug (e.g. "pcm sos") into the directions, duration, or notes of another drug!

- CLINICAL DOMAIN SEPARATION IN COMPOUND DICTATIONS:
  - Clinical prefixes:
    - "c/o" = Complaints.
    - "k/c/o" = History (e.g. "k/c/o epilepsy on levipil" -> record under History: "Known epilepsy on Levipil").
    - "o/e" and clinical examination findings (e.g. chest clear, vitals, IOP, fundus, tenderness) -> place under Examination in doctorNotes, NEVER in labOps or medicineOps (even if "o/e" is not explicitly spoken).
    - "dd" or "d/d" = Differential Diagnosis (e.g. "dd viral vs strep" -> record under Diagnosis: "Differential Diagnosis: Viral vs Streptococcal pharyngitis", NEVER as lab tests).
  - Shorthand conjunctions: In dictations, "n", "+", and "&" mean "and" (e.g. "azithro n cbp" = Azithromycin and CBP test).
  - In multi-item or comma-separated dictations, parse EVERY single spoken token into its true clinical domain:
  - DIAGNOSIS & COMPLAINTS (MANDATORY):
    - UTI (Urinary tract infection) is ALWAYS a clinical medical Diagnosis, NEVER an investigation or lab test. Even with question marks before or after (e.g. "uti??", "?uti", "maybe uti"), ALWAYS emit a noteOp for UTI under Diagnosis! If returning doctorNotes string, always include "Diagnosis:\n• Urinary tract infection".
    - When the instruction mentions any disease, migraine, infection, or pathology (e.g. "migraine", "uti", "?uti", "?malaria", "tinea", "stone", "anemia", "menorrhagia")—without forbidding diagnosis—you MUST emit a noteOp under Diagnosis: {"section": "diagnosis", "action": "add", "text": "exact condition name"}.
    - When the instruction mentions any symptom or indication alongside medicines (e.g. "fever", "pain", "cough", "pcm sos fever"), you MUST emit a noteOp under Complaints: {"section": "complaints", "action": "add", "text": "exact symptom name"} (e.g. "Fever").
  - INVESTIGATIONS: Extract EVERY single diagnostic test, scan, imaging acronym, swab, culture, and abbreviation into labOps without skipping shorthand items (e.g. KFT, LFT, CBP):
    - Tests preceded by "advise [test]" or "advised [test]" (e.g. "advise cbp lft") ARE diagnostic lab test orders: add each to labOps!
    - MP (Malaria parasite / Smear for MP), PV, and PF are laboratory blood investigations, NEVER medicines.
    - AEC (Absolute Eosinophil Count) and ACE (Angiotensin Converting Enzyme level) are laboratory blood investigations.
    - Diagnostic imaging (KUB, USG, CXR, CT, MRI, ECG) and tests (CBC, CBP, P/S, LFT, KFT, CUE, CRP, RBS, ASO, RA Factor, ANA, KOH mount, throat swab, EEG) belong in labOps.
  - PROCEDURES: Minor clinical procedures, ear syringing, wound dressings, and interventions belong in procedureOps (op: "add"), NEVER as medicines or lab tests.
  - MEDICATIONS & REHYDRATION: All prescribed medications, antispasmodics (e.g. Drotin), anticonvulsants (e.g. Levipil), analgesics/antipyretics, oral rehydration salts (ORS), nutritional sachets, and topicals belong in medicineOps.
    - NO FORMULATION TYPE IN MEDICINE NAME:
      - The formulation type belongs strictly in the "type" field ("Tablet", "Capsules", "Injection", "Syrup", "Ointment", "Gel", "Sachet", "Drops", "Inhaler", "Spray").
      - You MUST strip any formulation prefix or word (such as "Tab", "Tablet", "Cap", "Capsule", "Syp", "Syrup", "Inj", "Injection", "Oint", "Ointment", "Drops") from medicine.name (e.g. "tab. dolo 650" -> name: "Dolo 650", type: "Tablet"; "syp. ascoril" -> name: "Ascoril", type: "Syrup"; "inj. betnesol" -> name: "Betnesol", type: "Injection"; "cap. susten 200" -> name: "Susten 200", type: "Capsules"). Never include "Tab" or "Syp" inside the name!
    - When strength is specified after a brand name (e.g. "gabapin me 300", "levipil 500"), keep the strength in the medicine name (e.g. "Gabapin ME 300mg", "Levipil 500mg").
    - Split doses across times (e.g. "10 morning 15 evening", "lantus 10iu m 15iu e 3d"): emit ONE single medicine row (name: "Lantus") with multiple slots in its dosages array (Morning amount: 10, Evening amount: 15).
    - ACCURATE QUANTITY (ALWAYS POPULATE AS AN INTEGER):
      - You MUST calculate and populate "quantity" as an accurate integer for every medicine:
        - Tablets/Capsules/Sachets: quantity = (total daily dose units) × (duration in days). (e.g. 1 capsule BD for 7 days = 14; 1 tablet BD for 5 days = 10; 1 tablet OD for 14 days = 14; 1 sachet weekly for 8 weeks = 8; SOS with no days specified = default 10).
        - Syrups/Ointments/Creams/Gels/Drops/Inhalers/Sprays: quantity = 1 (dispensed as 1 container/bottle/tube).
        - Injections: exact count of ampoules/vials prescribed (e.g. 2 doses = 2; stat = 1; for multi-dose insulin vials/pens such as Lantus, quantity = 1; never multiply insulin IU by days).

5. TAPERS vs SAME-DAY SPLIT DOSES (CRITICAL):
- Tapers are step-down doses across SUCCESSIVE DAYS OR WEEKS (e.g. "for 3 days, then for next 3 days"). For tapers, output separate medicineOps in chronological order (highest dose Step 1 first, with "Then" in later step directions).
- In contrast, split doses across times within the SAME DAY (e.g. "lantus 10iu m 15iu e 3d", "10 morning 15 evening", "10iu m 15iu e", "1 morning 1 night") are NOT tapers! They MUST be emitted as ONE single medicine row (e.g. name: "Lantus"), with separate entries in its dosages array (e.g. Morning amount: 10, Evening amount: 15). Never split same-day timing into multiple medicine rows.

6. STANDARD DOSAGE TIMING SLOTS:
- dosages time must be one of: "Morning", "Afternoon", "Evening", "Night".
- Once daily (OD) -> Morning (or Night if explicitly at bedtime/HS).
- Twice daily (BD) -> Morning and Evening.
- Three times daily (TDS / TID) -> Morning, Afternoon, and Evening.
- Bedtime (HS) -> Night.
- Split dosages (e.g. "10 morning 15 evening"): assign the explicit numeric amount to each respective dosage slot (e.g. Morning amount: 10, Evening amount: 15).
- SOS / PRN -> specify SOS in directions with appropriate slot or max daily limit.

7. FULL NOTE REWRITES & ELABORATIONS:
- If the instruction asks to reformat, elaborate, summarize, or rewrite notes:
  - Retain ALL existing clinical facts from CURRENT CHART.
  - Return the fully rewritten note in "doctorNotes", organized cleanly with section headings (Complaints:, History:, Examination:, Diagnosis:, Advice:) and concise bullet points. Never wipe or empty notes on a formatting request.

8. OPD DELETIONS & CLEAR COMMANDS:
- Standalone stop commands ("stop dolo", "remove pantop", "stop all") remove the targeted item (op: "remove" or "stop"). Whole-chart clearing commands ("clear all", "delete everything") set the corresponding clearReview* flags to true.
- PRESCRIBED COURSE COMPLETION: Phrases like "then stop" or "stop after X days" at the end of a medicine instruction (e.g. "pcm od 5d then stop") mean to prescribe the medicine for that full duration then discontinue: op MUST be "add" with the specified duration (e.g. "5 days") and directions ("Once daily for 5 days then stop"), NEVER a deletion/stop op!

9. ASSISTANT REPLY:
- assistantReply is required: ONE short, natural spoken sentence confirming ONLY what was changed. Plain English, warm, concise.

Return exactly this JSON shape:
{
  "assistantReply": "one short natural spoken sentence",
  "clearReviewMedicines": false,
  "clearReviewLabs": false,
  "clearReviewProcedures": false,
  "clearNote": false,
  "doctorNotes": "full updated clinical note string ONLY when rewriting/formatting/elaborating notes, else omit",
  "medicineOps": [{
    "op": "add|edit|remove|stop",
    "match": "exact existing medicine name (edit|remove|stop only)",
    "medicine": {
      "name": "", "generic_name": "",
      "type": "Tablet|Capsules|Injection|Syrup|Ointment|Gel|Sachet|Drops|Inhaler|Spray|Other",
      "strength": "", "duration": "", "directions": "", "quantity": 10,
      "dosages": [{ "time": "Morning|Afternoon|Evening|Night", "amount": 1, "unit": "", "beforeFood": false }]
    }
  }],
  "labOps": [{ "op": "add|remove|stop", "name": "", "match": "exact existing lab name (remove|stop only)" }],
  "procedureOps": [{ "op": "add|remove|stop", "name": "", "match": "exact existing procedure name (remove|stop only)" }],
  "vitalsPatch": {},
  "noteOps": [{ "section": "complaints|history|examination|diagnosis|advice", "action": "add|remove", "text": "new bullet (add)", "target": "exact existing bullet (remove)" }]
}
`;

const REVIEW_FOLLOWUP_REPLY_STREAM_SYSTEM_PROMPT = `You are a helpful clinical scribe chatting with a doctor. Reply with ONE short, natural spoken sentence (like a quick verbal confirm) that restates ONLY what the INSTRUCTION asks for. Warm and plain — not robotic status text. Chart summary is context only — never invent a change for something the instruction did not name. If it is not a chart edit (e.g. hello), say nothing on the chart is changing. Plain text only — no JSON, no markdown, no quotes. Examples: "Okay — stopping Pantop." / "Sure, adding CBP." / "Nothing to change on the chart from that."`;

/* ========================================================================== */
/* Helper Functions                                                           */
/* ========================================================================== */

function nameKey(item) {
  return String(
    typeof item === "string" ? item : item?.name || item?.correctedName || "",
  )
    .trim()
    .toLowerCase();
}

/** Slim chart for the model — enough to match names/origin, less copy-paste bait. */
function compactChartForFollowUpPrompt(chart) {
  const c = chart && typeof chart === "object" ? chart : {};
  const slimMed = (m) => ({
    name: m?.name || "",
    type: m?.type || "Tablet",
    duration: m?.duration || "",
    directions: m?.directions || "",
    quantity: m?.quantity,
    dosages: Array.isArray(m?.dosages)
      ? m.dosages.map((d) => ({
          time: d?.time || "",
          amount: d?.amount,
          unit: d?.unit || "",
          beforeFood: Boolean(d?.beforeFood),
        }))
      : [],
  });
  const slimNamed = (item) =>
    typeof item === "string" ? item : item?.name || "";

  return {
    medicines: (Array.isArray(c.medicines) ? c.medicines : []).map(slimMed),
    labTests: (Array.isArray(c.labTests) ? c.labTests : []).map(slimNamed),
    procedures: (Array.isArray(c.procedures) ? c.procedures : []).map(slimNamed),
    doctorNotes: String(c.doctorNotes || "").slice(0, 2000),
    vitals: c.vitals || {},
  };
}

function buildOpdReviewFollowUpUserPrompt(instruction, currentChart) {
  const slimChart = compactChartForFollowUpPrompt(currentChart);
  return `CURRENT PRESCRIPTION CHART (ground truth — patch only what INSTRUCTION changes):
${JSON.stringify(slimChart)}

INSTRUCTION:
${instruction}

REMINDER: Emit medicineOps/labOps/noteOps ONLY for items named or changed by INSTRUCTION. Output minimal valid JSON. Strip formulation prefixes (Tab/Syp/Inj) from medicine.name. Include accurate numeric quantity in medicine (daily doses × days for tablets/capsules; 1 for syrups/topicals/inhalers/insulin pens; ampoule count for injections). For tapers: output separate steps in chronological start-to-finish order (highest dose Step 1 first with strength in name, e.g. "Wysolone 20mg"), with "Then" in directions for subsequent steps.`;
}






/**
 * Merges a model delta patch onto the existing prescription chart.
 * Sequential additions use forward chronological insertion (splice with addedMedIndex++).
 */
function mergeOpdChartDelta(currentChart, delta, instruction = "") {
  const chart =
    currentChart && typeof currentChart === "object" ? currentChart : {};
  const d = delta && typeof delta === "object" ? delta : {};

  let medicines = Array.isArray(chart.medicines)
    ? chart.medicines.map((m) => ({ ...m, action: "add", origin: "review" }))
    : [];
  let labTests = Array.isArray(chart.labTests)
    ? chart.labTests.map((t) =>
        typeof t === "string"
          ? { name: t, action: "add", origin: "review" }
          : { ...t, action: "add", origin: "review" },
      )
    : [];
  let procedures = Array.isArray(chart.procedures)
    ? chart.procedures.map((p) =>
        typeof p === "string"
          ? { name: p, action: "add", origin: "review" }
          : { ...p, action: "add", origin: "review" },
      )
    : [];

  if (d.clearReviewMedicines || d.clearMedicines || d.stopAllVisitMedicines) {
    medicines = [];
  }
  if (d.clearReviewLabs || d.clearLabs || d.stopAllVisitLabs) {
    labTests = [];
  }
  if (d.clearReviewProcedures || d.clearProcedures) {
    procedures = [];
  }

  // Process delta.medicineOps
  let addedMedIndex = 0;
  if (Array.isArray(d.medicineOps) && d.medicineOps.length > 0) {
    for (const op of d.medicineOps) {
      const matchName = String(op?.match || "").trim().toLowerCase();
      const kind = String(op?.op || "").toLowerCase();

      const activeIdx = medicines.findIndex(
        (m) =>
          nameKey(m) === matchName ||
          (op?.medicine && nameKey(m) === nameKey(op.medicine)),
      );

      if (kind === "add" && op.medicine) {
        medicines.splice(addedMedIndex++, 0, {
          ...op.medicine,
          generic_name: "",
          action: "add",
          origin: "review",
        });
      } else if ((kind === "edit" || kind === "replace") && op.medicine) {
        const steps =
          Array.isArray(op.steps) && op.steps.length > 0
            ? op.steps
            : [op.medicine];
        const formatted = steps.map((s) => ({
          ...s,
          generic_name: "",
          action: "add",
          origin: "review",
        }));
        if (activeIdx >= 0) {
          medicines.splice(activeIdx, 1, ...formatted);
        } else {
          medicines.splice(addedMedIndex, 0, ...formatted);
          addedMedIndex += formatted.length;
        }
      } else if (kind === "remove" || kind === "stop" || kind === "delete") {
        if (activeIdx >= 0) {
          medicines.splice(activeIdx, 1);
          if (activeIdx < addedMedIndex) {
            addedMedIndex = Math.max(0, addedMedIndex - 1);
          }
        } else if (matchName) {
          medicines = medicines.filter((m) => nameKey(m) !== matchName);
        }
      }
    }
  } else if (Array.isArray(d.medicines) && d.medicines.length > 0) {
    // If the model returned medicines directly
    medicines = d.medicines.map((m) => ({
      ...m,
      generic_name: "",
      action: "add",
      origin: "review",
    }));
  }

  // Process delta.labOps
  let addedLabIndex = 0;
  if (Array.isArray(d.labOps) && d.labOps.length > 0) {
    for (const op of d.labOps) {
      const kind = String(op?.op || "").toLowerCase();
      const target = String(op?.match || op?.name || "")
        .trim()
        .toLowerCase();
      const idx = labTests.findIndex((t) => nameKey(t) === target);

      if (kind === "add" && op.name) {
        if (
          !labTests.some((t) => nameKey(t) === String(op.name).toLowerCase())
        ) {
          labTests.splice(addedLabIndex++, 0, {
            name: op.name,
            action: "add",
            origin: "review",
          });
        }
      } else if (kind === "remove" || kind === "stop" || kind === "delete") {
        if (idx >= 0) {
          labTests.splice(idx, 1);
          if (idx < addedLabIndex) {
            addedLabIndex = Math.max(0, addedLabIndex - 1);
          }
        } else if (target) {
          labTests = labTests.filter((t) => nameKey(t) !== target);
        }
      }
    }
  } else if (Array.isArray(d.labTests) && d.labTests.length > 0) {
    labTests = d.labTests.map((t) =>
      typeof t === "string"
        ? { name: t, action: "add", origin: "review" }
        : { ...t, action: "add", origin: "review" },
    );
  }

  // Process delta.procedureOps
  let addedProcIndex = 0;
  if (Array.isArray(d.procedureOps) && d.procedureOps.length > 0) {
    for (const op of d.procedureOps) {
      const kind = String(op?.op || "").toLowerCase();
      const target = String(op?.match || op?.name || "")
        .trim()
        .toLowerCase();
      const idx = procedures.findIndex((p) => nameKey(p) === target);

      if (kind === "add" && op.name) {
        if (
          !procedures.some((p) => nameKey(p) === String(op.name).toLowerCase())
        ) {
          procedures.splice(addedProcIndex++, 0, {
            name: op.name,
            action: "add",
            origin: "review",
          });
        }
      } else if (kind === "remove" || kind === "stop" || kind === "delete") {
        if (idx >= 0) {
          procedures.splice(idx, 1);
          if (idx < addedProcIndex) {
            addedProcIndex = Math.max(0, addedProcIndex - 1);
          }
        } else if (target) {
          procedures = procedures.filter((p) => nameKey(p) !== target);
        }
      }
    }
  }

  const vitals = {
    ...(chart.vitals || {}),
    ...(d.vitalsPatch || {}),
    ...(d.vitals || {}),
  };

  let doctorNotes;
  const rawSections = d.noteSections || d.note_sections;
  const fromSections =
    rawSections && typeof rawSections === "object"
      ? composeNoteFromSections(rawSections) || ""
      : "";
  const fromString = Object.prototype.hasOwnProperty.call(d, "doctorNotes")
    ? d.doctorNotes == null
      ? ""
      : String(d.doctorNotes)
    : "";

  if (d.clearNote) {
    doctorNotes = "";
  } else if (fromString.trim()) {
    doctorNotes = fromString.trim();
  } else if (fromSections.trim()) {
    doctorNotes = fromSections.trim();
  } else if (Array.isArray(d.noteOps) && d.noteOps.length > 0) {
    doctorNotes = mergeNoteWithOps(chart.doctorNotes, d.noteOps);
  } else {
    doctorNotes = String(chart.doctorNotes || "");
  }

  doctorNotes = formatDoctorNotesLayout(doctorNotes);

  return { medicines, labTests, procedures, vitals, doctorNotes };
}

function extractJsonObject(str) {
  if (!str) return "{}";
  const first = str.indexOf("{");
  const last = str.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return str.slice(first, last + 1);
  }
  return str;
}

function repairTruncatedJsonObject(text) {
  let s = String(text || "").trim();
  if (!s) throw new Error("Empty JSON");

  s = s.replace(
    /,\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*"[^"\\]*(?:\\.[^"\\]*)*$/,
    "",
  );
  s = s.replace(/,\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*[^,}\]]*$/, "");
  s = s.replace(/,\s*"[^"\\]*(?:\\.[^"\\]*)*$/, "");
  s = s.replace(/,\s*$/, "");

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

function isGreetingOnly(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!.,?…]+$/g, "")
    .trim();
  if (!t || t.length > 48) return false;
  if (
    /\b(fever|cough|pain|advise|adv\b|tab|mg|bd|od|tds|cbc|cbp|lft|post\b|h\/o|k\/c\/o|dolo|pantop|remove|add |stop |restart |delete|clear|change|update)\b/i.test(
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
    return "Good morning! What would you like to change on the prescription?";
  }
  if (/^good\s*afternoon/.test(t)) {
    return "Good afternoon! What would you like to change on the prescription?";
  }
  if (/^good\s*evening/.test(t)) {
    return "Good evening! What would you like to change on the prescription?";
  }
  if (/^(thanks|thank\s*you|thx|ty)/.test(t)) {
    return "You're welcome — ready when you are.";
  }
  if (/^(hey|hiya|yo|sup|howdy)/.test(t)) {
    return "Hey! Tell me what to update on the prescription.";
  }
  return "Hi! What would you like to change on the prescription?";
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

function buildExtractionReply(result, latestUserText) {
  const parts = [];
  if (result.doctorNotes?.trim()) parts.push("Updated the clinical note");
  const medCount = (result.medicines || []).length;
  const labCount = (result.labTests || []).length;
  if (medCount) {
    parts.push(
      `${medCount} medicine${medCount === 1 ? "" : "s"}: ${(
        result.medicines || []
      )
        .map((med) => med.description || med.name)
        .filter(Boolean)
        .join(", ")}`,
    );
  }
  if (labCount) {
    parts.push(`Labs: ${(result.labTests || []).join(", ")}`);
  }
  if (!parts.length) {
    return "Updated prescription chart.";
  }
  return `${parts.join(". ")}.`;
}

/* ========================================================================== */
/* Routes                                                                     */
/* ========================================================================== */

/**
 * POST /api/opd-ai/review-followup
 * Handles OPD prescription updates from AI Copilot chat or voice instructions.
 */
router.post("/review-followup", async (req, res) => {
  try {
    const {
      instruction,
      currentChart,
    } = req.body || {};

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

    // Direct greeting handler
    if (isGreetingOnly(instruction)) {
      return res.json({
        medicines: chart.medicines || [],
        labTests: chart.labTests || [],
        procedures: chart.procedures || [],
        vitals: chart.vitals || {},
        doctorNotes: chart.doctorNotes || "",
        medicinesToApply: chart.medicines || [],
        labTestsToApply: chart.labTests || [],
        proceduresToApply: chart.procedures || [],
        medicinesToStop: [],
        medicinesToRestart: [],
        labTestsToStop: [],
        assistantReply: greetingAssistantReply(instruction),
      });
    }

    const userPrompt = buildOpdReviewFollowUpUserPrompt(instruction, chart);
    const systemContent = `${PARSE_CLINICAL_NOTE_SYSTEM_PROMPT}\n${OPD_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM}`;

    const followUpMessages = [
      { role: "system", content: systemContent },
      { role: "user", content: userPrompt },
    ];

    console.log("=== [OPD AI FOLLOW-UP INPUT] ===");
    console.log("Instruction:", instruction);

    let response;
    try {
      response = await aiCompletionWithFallback(followUpMessages, {
        geminiModel: PARSE_NOTE_MODEL,
        openAiModel: OPENAI_MODEL,
        timeoutMs: Math.min(PARSE_NOTE_TIMEOUT_MS, 30000),
        maxTokens: REVIEW_FOLLOWUP_DELTA_MAX_TOKENS,
        responseJson: true,
      });
    } catch (apiError) {
      console.error(
        "OPD AI Follow-up error:",
        apiError?.response?.data || apiError.message,
      );
      return res.status(apiError?.status === 503 ? 503 : 502).json({
        error:
          apiError?.message ||
          "AI assistant is temporarily experiencing high demand. Please try again.",
        details:
          apiError?.response?.data || apiError.details || apiError.message,
      });
    }

    if (
      !response?.data?.choices ||
      !response.data.choices[0]?.message?.content
    ) {
      return res.status(500).json({ error: "Invalid response from OPD AI" });
    }

    let content = response.data.choices[0].message.content.trim();
    let delta;
    try {
      delta = parseFollowUpDeltaJson(content);
    } catch (parseErr) {
      console.warn("Failed to parse OPD AI delta JSON, retrying compact patch:", parseErr.message);
      try {
        const retry = await aiCompletionWithFallback(
          [
            ...followUpMessages,
            { role: "assistant", content },
            {
              role: "user",
              content: `Your previous JSON was invalid or truncated. Return a MINIMAL valid patch only for what INSTRUCTION changes. Return valid complete JSON object only.`,
            },
          ],
          {
            geminiModel: PARSE_NOTE_MODEL,
            openAiModel: OPENAI_MODEL,
            timeoutMs: Math.min(PARSE_NOTE_TIMEOUT_MS, 30000),
            maxTokens: REVIEW_FOLLOWUP_DELTA_RETRY_MAX_TOKENS,
            responseJson: true,
          },
        );
        content = retry?.data?.choices?.[0]?.message?.content?.trim() || "{}";
        delta = parseFollowUpDeltaJson(content);
      } catch (retryErr) {
        console.error("OPD AI retry failed:", retryErr.message);
        return res.status(500).json({ error: "Failed to parse AI response" });
      }
    }

    const merged = mergeOpdChartDelta(chart, delta, instruction);

    console.log("=== [OPD AI FINAL RESULT] ===");
    console.log("Medicines:", merged.medicines.map((m) => m.name));
    console.log("Labs:", merged.labTests.map((t) => (typeof t === "string" ? t : t?.name)));

    const result = {
      medicines: merged.medicines,
      labTests: merged.labTests
        .map((t) => (typeof t === "string" ? t : t?.name || ""))
        .filter(Boolean),
      procedures: merged.procedures
        .map((p) => (typeof p === "string" ? p : p?.name || ""))
        .filter(Boolean),
      vitals: merged.vitals || {},
      doctorNotes: merged.doctorNotes || "",
      medicinesToApply: merged.medicines,
      labTestsToApply: merged.labTests
        .map((t) => (typeof t === "string" ? t : t?.name || ""))
        .filter(Boolean),
      proceduresToApply: merged.procedures
        .map((p) => (typeof p === "string" ? p : p?.name || ""))
        .filter(Boolean),
      medicinesToStop: [],
      medicinesToRestart: [],
      labTestsToStop: [],
      assistantReply:
        String(delta.assistantReply || "").trim() ||
        buildExtractionReply(
          { medicines: merged.medicines, labTests: merged.labTests },
          instruction,
        ),
    };

    return res.json(result);
  } catch (error) {
    console.error("Unexpected error in OPD AI:", error);
    return res.status(500).json({
      error: error?.message || "Internal server error in OPD AI",
    });
  }
});

/**
 * POST /api/opd-ai/review-followup/reply-stream
 * Live plain-text token stream confirming doctor's instruction in real-time.
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

  if (isGreetingOnly(instruction)) {
    res.write(greetingAssistantReply(instruction));
    res.end();
    return;
  }

  let upstream;
  try {
    upstream = await openaiApi.post(
      "/chat/completions",
      {
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
            content: `CHART SUMMARY (context only):\n${summarizeChartForReplyContext(
              currentChart,
            )}\n\nINSTRUCTION:\n${instruction}\n\nReply with ONE short sentence confirming the instruction.`,
          },
        ],
      },
      { responseType: "stream", timeout: 20000 },
    );

    let ended = false;
    const safeEnd = () => {
      if (!ended) {
        ended = true;
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    };

    upstream.data.on("data", (chunk) => {
      const lines = chunk
        .toString("utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (line === "data: [DONE]") {
          safeEnd();
          return;
        }
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          const deltaText = payload.choices?.[0]?.delta?.content;
          if (deltaText) res.write(deltaText);
        } catch {
          /* ignore incomplete chunk parse */
        }
      }
    });

    upstream.data.on("end", safeEnd);
    upstream.data.on("error", () => safeEnd());
    req.on("close", () => {
      try {
        upstream.data.destroy();
      } catch {
        /* ignore */
      }
      safeEnd();
    });
  } catch (err) {
    console.warn("OPD AI reply stream upstream error:", err?.message || err);
    res.write("Got it — updating prescription.");
    res.end();
  }
});

module.exports = router;
