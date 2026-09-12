/**
 * IPD & ERA AI Clinical Engine & Routes
 * Self-contained module for In-Hospital Care: Inpatient Ward Rounds (IPD)
 * and Emergency Response & Casualty Admission (ERA).
 * 
 * Rules:
 * - In-hospital care: NO default durations (duration: "" / continuous hospital administration).
 * - IPD: Ward round progress notes, tracking ongoing ward treatment (origin: "visit"),
 *   explicit stop (discontinue) and restart actions, delta patches to update active treatment.
 * - ERA: Casualty admission, splitting medications into given_in_er vs continue_on_ward,
 *   triage examination (GCS, consciousness, pupils), and emergency vitals (GRBS, urine output).
 */

const express = require("express");
const router = express.Router();
const axios = require("axios");
const { aiCompletionWithFallback } = require("../utils/aiCompletionWithFallback");

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
/* Clinical Note Section Layout & Helper Functions                           */
/* ========================================================================== */

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
  history: "history",
  pasthistory: "history",
  medicalhistory: "history",
  examination: "examination",
  physicalexamination: "examination",
  systemicexamination: "examination",
  diagnosis: "diagnosis",
  provisionaldiagnosis: "diagnosis",
  finaldiagnosis: "diagnosis",
  advice: "advice",
  doctorsadvice: "advice",
  plan: "advice",
  treatmentplan: "advice",
  assessment: "advice",
  assessmentandplan: "advice",
};

const NOTE_LABEL_TO_KEY = {
  ...Object.fromEntries(
    NOTE_SECTION_ORDER.map(([key, label]) => [label.toLowerCase(), key]),
  ),
  advice: "advice",
  "doctor's advice": "advice",
  "doctors advice": "advice",
};

function itemOrigin(item) {
  const raw = String(item?.origin || "").toLowerCase();
  if (raw === "visit") return "visit";
  if (raw === "review") return "review";
  const action = String(item?.action || "add").toLowerCase();
  if (
    action === "stop" ||
    action === "continue" ||
    action === "on_visit" ||
    action === "restart"
  ) {
    return "visit";
  }
  return "review";
}

function nameKey(item) {
  if (!item) return "";
  if (typeof item === "string") return item.trim().toLowerCase();
  return String(
    item.name ||
      item.description ||
      item.correctedName ||
      item.medicineName ||
      item.match ||
      "",
  )
    .trim()
    .toLowerCase();
}

function cleanMedName(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(
      /^(?:tab(?:let)?s?|cap(?:sule)?s?|inj(?:ection)?s?|syp|syrup|suspension|ointment|cream|gel|sachet|iv\s+fluids?|iv|im)\.?\s+/i,
      "",
    )
    .replace(
      /\s+(?:(?:\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|gm|ml|iu|units?))|(?:od|0d|bd|bid|tds|tid|qid|hs|sos|stat|prn)\b|(?:for\s+)?\d+\s*(?:d|day|days|wk|wks|week|weeks|month|months)\b).*$/i,
      "",
    )
    .replace(/\s+\d+(?:\.\d+)?\s*$/i, "")
    .trim();
}

function matchesMedicine(med, query) {
  if (!med || !query) return false;
  const rawA = nameKey(med);
  const rawB = nameKey(query);
  if (!rawA || !rawB) return false;
  if (rawA === rawB) return true;

  const cleanA = cleanMedName(rawA);
  const cleanB = cleanMedName(rawB);
  if (!cleanA || !cleanB) return false;
  if (cleanA === cleanB) return true;

  if (cleanA.length >= 3 && cleanB.length >= 3) {
    if (cleanA.startsWith(cleanB) || cleanB.startsWith(cleanA)) return true;
    if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;
  }
  return false;
}

function cleanLabName(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/^(?:routine|serum|blood|urine|test for|investigation)\s+/i, "")
    .trim();
}

function matchesLab(test, query) {
  if (!test || !query) return false;
  const rawA = nameKey(test);
  const rawB = nameKey(query);
  if (!rawA || !rawB) return false;
  if (rawA === rawB) return true;

  const cleanA = cleanLabName(rawA);
  const cleanB = cleanLabName(rawB);
  if (!cleanA || !cleanB) return false;
  if (cleanA === cleanB) return true;

  if (cleanA.length >= 3 && cleanB.length >= 3) {
    if (cleanA.startsWith(cleanB) || cleanB.startsWith(cleanA)) return true;
    if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;
  }
  return false;
}

function parseComposedNoteSections(noteText) {
  const text = String(noteText || "").trim();
  if (!text) return {};
  const sections = {};
  let currentKey = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    const headerMatch = line.match(/^([A-Za-z' ]+):\s*(.*)$/);
    if (headerMatch) {
      const label = headerMatch[1].trim().toLowerCase();
      const key =
        NOTE_LABEL_TO_KEY[label] ||
        NOTE_SECTION_ALIASES[label.replace(/[^a-z]/g, "")];
      if (key) {
        currentKey = key;
        if (!sections[currentKey]) sections[currentKey] = [];
        const inline = headerMatch[2]?.trim();
        if (inline) {
          sections[currentKey].push(inline.replace(/^[•\-*]\s*/, "").trim());
        }
        continue;
      }
    }
    if (!currentKey) continue;
    const item = line.replace(/^[•\-*]\s*/, "").trim();
    if (item) sections[currentKey].push(item);
  }
  return sections;
}

function composeNoteFromSections(sections) {
  if (!sections || typeof sections !== "object") return "";
  const blocks = [];
  for (const [key, label] of NOTE_SECTION_ORDER) {
    const raw = sections[key];
    const items = Array.isArray(raw)
      ? raw
      : typeof raw === "string" && raw.trim()
        ? [raw.trim()]
        : [];
    const cleanItems = items.filter(Boolean);
    if (cleanItems.length > 0) {
      blocks.push(`${label}:\n${cleanItems.map((i) => `• ${i}`).join("\n")}`);
    }
  }
  return blocks.join("\n\n");
}

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

/* ========================================================================== */
/* Inpatient Delta Merging Logic                                              */
/* ========================================================================== */

function mergeInpatientChartDelta(
  currentChart,
  delta,
  { isEra = false, instruction = "" } = {},
) {
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

  // Fallback: If doctor said "stop med" or "stop medicine" or "stop all meds",
  // ensure medicineOps is populated even if LLM omitted it.
  const instrText = String(instruction || "").trim();
  const isGenericStopMed =
    /\b(?:stop|discontinue|hold|cancel|omit)\s+(?:the\s+|current\s+|this\s+)?(?:med|meds|medicine|medicines|medication|medications)\b/i.test(
      instrText,
    );
  const isStopAllMeds =
    /\b(?:stop|discontinue|hold|cancel|omit)\s+(?:all\s+)(?:med|meds|medicine|medicines|medication|medications)\b/i.test(
      instrText,
    );

  if (isStopAllMeds) {
    medicines = medicines.map((m) => ({
      ...m,
      action: "stop",
      origin: "visit",
      directions: m.directions || "Stop this medicine",
    }));
  } else if (
    isGenericStopMed &&
    (!Array.isArray(d.medicineOps) || d.medicineOps.length === 0)
  ) {
    const activeMeds = medicines.filter(
      (m) => String(m?.action || "add").toLowerCase() !== "stop",
    );
    if (activeMeds.length === 1) {
      d.medicineOps = [
        {
          op: "stop",
          match: activeMeds[0].name || "Medicine",
          medicine: { name: activeMeds[0].name || "Medicine" },
        },
      ];
    }
  }

  let addedMedIndex = 0;
  for (const op of Array.isArray(d.medicineOps) ? d.medicineOps : []) {
    const target = String(
      op?.match || op?.medicine?.name || op?.name || "",
    ).trim();
    const matchName = target.toLowerCase();

    let activeIdx = medicines.findIndex(
      (m) =>
        matchesMedicine(m, target) &&
        String(m?.action || "add").toLowerCase() !== "stop",
    );

    if (
      activeIdx === -1 &&
      /^(?:med|meds|medicine|medicines|medication|medications|current med|this med)$/i.test(
        matchName,
      )
    ) {
      const activeMeds = medicines.filter(
        (m) => String(m?.action || "add").toLowerCase() !== "stop",
      );
      if (activeMeds.length === 1) {
        activeIdx = medicines.indexOf(activeMeds[0]);
      }
    }

    let kind = String(op?.op || "").toLowerCase();

    if ((kind === "stop" || kind === "remove") && activeIdx >= 0) {
      kind = itemOrigin(medicines[activeIdx]) === "visit" ? "stop" : "remove";
    } else if (kind === "stop" || kind === "remove") {
      const anyIdx = medicines.findIndex((m) => matchesMedicine(m, target));
      if (anyIdx >= 0) {
        kind = itemOrigin(medicines[anyIdx]) === "visit" ? "stop" : "remove";
      } else if (
        kind === "remove" &&
        (op?.op === "stop" ||
          /\b(stop|discontinue|hold|cancel|omit)\b/i.test(instrText))
      ) {
        kind = "stop";
      }
    }

    // Determine ERA route tag (given_in_er vs continue_on_ward)
    const eraRoute =
      op.eraRoute ||
      op.medicine?.eraRoute ||
      (isEra
        ? /\b(stat|now|casualty|er\b|emergency|iv bolus)\b/i.test(
            `${op.medicine?.name || ""} ${op.medicine?.directions || ""}`,
          )
          ? "given_in_er"
          : "continue_on_ward"
        : undefined);

    if (kind === "add" && op.medicine) {
      medicines.splice(addedMedIndex++, 0, {
        ...op.medicine,
        duration: op.medicine.duration || "", // Strictly no default 5-day course
        generic_name: "",
        action: "add",
        origin: "review",
        ...(isEra ? { eraRoute: eraRoute || "continue_on_ward" } : {}),
      });
    } else if (kind === "edit" && op.medicine) {
      const stepsToInsert =
        Array.isArray(op.steps) && op.steps.length > 0
          ? op.steps
          : [op.medicine];
      const formattedSteps = stepsToInsert.map((step) => ({
        ...step,
        duration: step.duration || "",
        generic_name: "",
        action: "add",
        origin: "review",
        ...(isEra ? { eraRoute: eraRoute || "continue_on_ward" } : {}),
      }));

      if (activeIdx >= 0) {
        const prev = medicines[activeIdx];
        if (itemOrigin(prev) === "visit") {
          medicines.splice(addedMedIndex, 0, ...formattedSteps);
          addedMedIndex += formattedSteps.length;
        } else {
          medicines.splice(activeIdx, 1, ...formattedSteps);
        }
      } else {
        medicines.splice(addedMedIndex, 0, ...formattedSteps);
        addedMedIndex += formattedSteps.length;
      }
    } else if (kind === "stop") {
      if (activeIdx >= 0) {
        const [existing] = medicines.splice(activeIdx, 1);
        if (activeIdx < addedMedIndex)
          addedMedIndex = Math.max(0, addedMedIndex - 1);
        const medName =
          existing?.name ||
          op?.medicine?.name ||
          target ||
          "Medicine";
        medicines.push({
          ...existing,
          name: medName,
          action: "stop",
          origin: "visit",
          directions: existing?.directions || "Stop this medicine",
        });
      } else if (target) {
        medicines.push({
          ...(op.medicine && typeof op.medicine === "object" ? op.medicine : {}),
          name: String(op?.medicine?.name || target).trim(),
          action: "stop",
          origin: "visit",
          directions: "Stop this medicine",
        });
      }
    } else if (kind === "restart") {
      medicines = medicines.filter(
        (m) =>
          !(
            matchesMedicine(m, target) &&
            ["stop", "restart"].includes(String(m?.action || "").toLowerCase())
          ),
      );
      medicines.splice(addedMedIndex++, 0, {
        ...(op.medicine && typeof op.medicine === "object" ? op.medicine : {}),
        name:
          String(op?.medicine?.name || target).trim() ||
          target,
        duration: "",
        action: "restart",
        origin: "visit",
        directions: "Restart this medicine",
      });
    } else if (kind === "remove") {
      medicines = medicines.filter((m) => !matchesMedicine(m, target));
    }
  }

  let addedLabIndex = 0;
  for (const op of Array.isArray(d.labOps) ? d.labOps : []) {
    let kind = String(op?.op || "").toLowerCase();
    const target = String(op?.match || op?.name || "").trim();
    const idx = labTests.findIndex((t) => matchesLab(t, target));
    if ((kind === "stop" || kind === "remove") && idx >= 0) {
      kind = itemOrigin(labTests[idx]) === "visit" ? "stop" : "remove";
    }

    if (kind === "add" && (op.name || target)) {
      const testName = op.name || target;
      const alreadyReviewAdd = labTests.some(
        (t) =>
          matchesLab(t, testName) &&
          itemOrigin(t) === "review" &&
          String(t?.action || "add").toLowerCase() === "add",
      );
      if (!alreadyReviewAdd) {
        labTests.splice(addedLabIndex++, 0, {
          name: testName,
          action: "add",
          origin: "review",
        });
      }
    } else if (kind === "remove" && target) {
      labTests = labTests.filter((t) => !matchesLab(t, target));
    } else if (kind === "stop" && target) {
      if (idx >= 0) {
        const [existing] = labTests.splice(idx, 1);
        if (idx < addedLabIndex) addedLabIndex = Math.max(0, addedLabIndex - 1);
        labTests.push({
          ...(typeof existing === "string" ? { name: existing } : existing),
          name:
            (typeof existing === "string" ? existing : existing?.name) ||
            target,
          action: "stop",
          origin: "visit",
        });
      } else {
        labTests.push({
          name: target,
          action: "stop",
          origin: "visit",
        });
      }
    }
  }

  let addedProcIndex = 0;
  for (const op of Array.isArray(d.procedureOps) ? d.procedureOps : []) {
    let kind = String(op?.op || "").toLowerCase();
    const target = String(op?.match || op?.name || "").trim();
    const idx = procedures.findIndex((p) => {
      const raw = nameKey(p);
      const q = target.toLowerCase();
      return raw === q || raw.includes(q) || q.includes(raw);
    });

    if (kind === "add" && (op.name || target)) {
      procedures.splice(addedProcIndex++, 0, {
        name: op.name || target,
        action: "add",
        origin: "review",
      });
    } else if (kind === "remove" && target) {
      procedures = procedures.filter((p) => {
        const raw = nameKey(p);
        const q = target.toLowerCase();
        return !(raw === q || raw.includes(q) || q.includes(raw));
      });
    } else if (kind === "stop" && target) {
      if (idx >= 0) {
        const [existing] = procedures.splice(idx, 1);
        procedures.push({
          ...(typeof existing === "string" ? { name: existing } : existing),
          name:
            (typeof existing === "string" ? existing : existing?.name) ||
            target,
          action: "stop",
          origin: "visit",
        });
      } else {
        procedures.push({
          name: target,
          action: "stop",
          origin: "visit",
        });
      }
    }
  }

  const vitals = { ...(chart.vitals || {}), ...(d.vitalsPatch || {}) };
  let doctorNotes = d.clearNote
    ? ""
    : mergeNoteWithOps(chart.doctorNotes, d.noteOps);

  medicines = medicines.filter((m) => {
    const action = String(m?.action || "add").toLowerCase();
    return action === "add" || action === "stop" || action === "restart";
  });
  labTests = labTests.filter((t) => {
    const action = String(
      typeof t === "string" ? "add" : t?.action || "add",
    ).toLowerCase();
    return action === "add" || action === "stop";
  });

  const eraManualExam = isEra
    ? { ...(chart.eraManualExam || {}), ...(d.eraManualExamPatch || {}) }
    : undefined;

  return {
    medicines,
    labTests,
    procedures,
    vitals,
    doctorNotes,
    ...(isEra ? { eraManualExam } : {}),
  };
}

/* ========================================================================== */
/* Prompts                                                                    */
/* ========================================================================== */

const INPATIENT_CLINICAL_NOTE_SYSTEM_PROMPT = `You are a senior inpatient clinician-scribe for an Indian hospital EMR, managing acute admissions and ward care across all specialties. Return valid JSON only. You are the clinical authority for this output. Structure everything the way a senior consultant would chart.`;

const IPD_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM = `

IPD WARD ROUND FOLLOW-UP MODE — PATCH ONLY (CRITICAL — KEEP OUTPUT TINY)
1. GROUND TRUTH & MINIMAL PATCHING:
- CURRENT CHART contains the patient's ongoing ward chart and the doctor's current round note.
- Items are tagged origin: "review" (orders added in today's round) or "visit" (ongoing ward medications / tests).
- INSTRUCTION is the single new update requested right now for this ward round.
- Output ONLY operations for items INSTRUCTION explicitly changes. Unmentioned items remain untouched.
- If instruction does not name or refer to a medicine, medicineOps MUST be []. Same for labs/procedures/vitals.
- Match existing items using their exact "name" from CURRENT CHART.

2. IN-HOSPITAL DURATION RULE (CRITICAL):
- DO NOT default medicine duration to "5 days". Leave duration "" unless explicitly specified.
- Ward medications continue day-to-day on the ward until stopped.
- IV fluids: specify rate in ml/hr or hours when stated, else leave duration "".

3. WARD DELETIONS, STOPS & RESTARTS:
- Standalone stop command on an ongoing ward medicine (origin: "visit") -> op: "stop" (discontinues on ward chart).
- When doctor says "stop med", "stop medicine", "discontinue med", "stop this medication", etc.:
  * If CURRENT CHART has an ongoing medicine or draft medicine, target that medicine with op: "stop", match: exact name from CURRENT CHART, and populate medicine: { "name": "<name>" }.
  * Never return empty medicineOps when the doctor instructs to stop or discontinue a medication.
- Standalone remove command on a draft order added this round (origin: "review") -> op: "remove".
- When doctor asks to restart / resume a previously stopped ward medicine -> op: "restart", match: exact name.

4. WARD NOTES (SOAP):
- Keep clinical facts cleanly placed by meaning:
  - Symptoms/fever/pain -> noteOps section: "complaints"
  - Past history -> noteOps section: "history"
  - Physical exam / vitals findings -> noteOps section: "examination"
  - Provisional / confirmed diagnosis -> noteOps section: "diagnosis"
  - Ward advice, diet, nursing care -> noteOps section: "advice"

5. ASSISTANT REPLY:
- assistantReply is required: ONE short, natural spoken sentence confirming ONLY what was changed on the ward chart.

Return exactly this JSON shape:
{
  "assistantReply": "one short natural spoken sentence",
  "clearReviewMedicines": false,
  "clearReviewLabs": false,
  "clearReviewProcedures": false,
  "stopAllVisitMedicines": false,
  "stopAllVisitLabs": false,
  "clearNote": false,
  "medicineOps": [
    {
      "op": "add" | "edit" | "stop" | "restart" | "remove",
      "match": "existing medicine name when editing, stopping or restarting",
      "medicine": {
        "name": "Exact Brand or Generic Name (strip Tab/Inj/Cap)",
        "type": "Tablet" | "Capsules" | "Injection" | "Syrup" | "IV Fluids" | "Ointment" | "Drops",
        "duration": "",
        "directions": "Schedule in plain English",
        "dosages": [ { "time": "Morning" | "Afternoon" | "Evening" | "Night", "amount": 1, "beforeFood": false } ]
      }
    }
  ],
  "labOps": [
    {
      "op": "add" | "remove" | "stop",
      "match": "test name",
      "name": "Standard Lab/Imaging Test Name"
    }
  ],
  "procedureOps": [
    {
      "op": "add" | "remove" | "stop",
      "match": "procedure name",
      "name": "Procedure Name"
    }
  ],
  "vitalsPatch": {
    "temperature": "",
    "pulse": "",
    "bloodPressure": "",
    "spo2": "",
    "respiratoryRate": "",
    "bloodSugar": ""
  },
  "noteOps": [
    {
      "section": "complaints" | "history" | "examination" | "diagnosis" | "advice",
      "action": "add" | "remove",
      "text": "Specific clinical note bullet"
    }
  ]
}`;

const ERA_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM = `

ERA (EMERGENCY CASUALTY & ADMISSION) FOLLOW-UP MODE — PATCH ONLY
1. IN-HOSPITAL EMERGENCY CARE (NO 5-DAY DURATIONS):
- Patient is in Emergency / Casualty undergoing acute assessment and admission.
- Duration is "" (NOT "5 days"). STAT doses or continuous hospital medications.

2. CASUALTY vs. WARD MEDICATION SPLITTING (CRITICAL):
- Distinguish between medicines administered in Casualty right now vs continued on the ward:
  * STAT doses, IV push, emergency nebulizations, IV bolus, "given now", "in casualty" -> eraRoute: "given_in_er".
  * Regular admissions orders to continue on the ward -> eraRoute: "continue_on_ward".
  * Default continue_on_ward if unclear.
- When doctor asks to stop or discontinue an ongoing medicine -> op: "stop", match: exact medicine name from CURRENT CHART, and populate medicine: { "name": "<name>" }.

3. EMERGENCY VITALS & TRIAGE EXAMINATION:
- Emergency Vitals: Include blood sugar ("bloodSugar" or "grbs") and "urineOutput" (in ml) when mentioned alongside BP, PR, Temp, SpO2.
- Triage Examination (populate under eraManualExamPatch when mentioned):
  * "gcs": Glasgow Coma Scale formatted strictly as "E#V#M#" (e.g. "E3V4M5").
  * "consciousness": One of "Alert", "Oriented", "Drowsy", "Confused", "Stuporous", "Unconscious".
  * "pupils": Pupil reaction text (e.g. "Equal and reactive to light").
  * "personalHistory": { "alcohol": true/false, "smoking": true/false, "illicitDrugs": true/false }.

4. ASSISTANT REPLY:
- assistantReply is required: ONE short, natural spoken sentence confirming the casualty orders or triage findings.

Return exactly this JSON shape:
{
  "assistantReply": "one short natural spoken sentence",
  "clearReviewMedicines": false,
  "clearReviewLabs": false,
  "clearReviewProcedures": false,
  "clearNote": false,
  "medicineOps": [
    {
      "op": "add" | "edit" | "stop" | "remove",
      "match": "existing medicine name when editing, stopping, or removing",
      "eraRoute": "given_in_er" | "continue_on_ward",
      "medicine": {
        "name": "Exact Brand or Generic Name (strip Tab/Inj/Cap)",
        "type": "Injection" | "Tablet" | "IV Fluids" | "Syrup" | "Inhaler",
        "duration": "",
        "directions": "Schedule in plain English",
        "eraRoute": "given_in_er" | "continue_on_ward",
        "dosages": [ { "time": "Morning" | "Afternoon" | "Evening" | "Night", "amount": 1, "beforeFood": false } ]
      }
    }
  ],
  "labOps": [
    {
      "op": "add" | "remove",
      "name": "Standard Lab/Imaging Test Name"
    }
  ],
  "procedureOps": [
    {
      "op": "add" | "remove",
      "name": "Procedure Name"
    }
  ],
  "vitalsPatch": {
    "temperature": "",
    "pulse": "",
    "bloodPressure": "",
    "spo2": "",
    "respiratoryRate": "",
    "bloodSugar": "",
    "grbs": "",
    "urineOutput": ""
  },
  "eraManualExamPatch": {
    "gcs": "E#V#M#",
    "consciousness": "Alert" | "Oriented" | "Drowsy" | "Confused" | "Stuporous" | "Unconscious",
    "pupils": "Equal and reactive",
    "personalHistory": {
      "alcohol": false,
      "smoking": false,
      "illicitDrugs": false
    }
  },
  "noteOps": [
    {
      "section": "complaints" | "history" | "examination" | "diagnosis" | "advice",
      "action": "add" | "remove",
      "text": "Specific clinical note bullet"
    }
  ]
}`;

function buildInpatientReviewFollowUpUserPrompt(instruction, currentChart, isEra = false) {
  const chart = currentChart && typeof currentChart === "object" ? currentChart : {};
  return `SETTING: ${isEra ? "ERA (Emergency Casualty & Admission)" : "IPD (Ward progress note)"}.
IN-HOSPITAL CARE: DURATION is "" (do NOT default to 5 days; continuous hospital orders).
${isEra ? 'SPLIT MEDICINES: "eraRoute": "given_in_er" for casualty stat/now, vs "continue_on_ward" for ward.' : '"stop" discontinues an ongoing ward medicine. "restart" reactivates a previously stopped medicine.'}

CURRENT CHART (ground truth — patch only what instruction changes):
${JSON.stringify(chart)}

INSTRUCTION:
${instruction}

REMINDER: Output minimal JSON patch for ${isEra ? "ERA emergency orders" : "IPD ward orders"} only.`;
}

function parseFollowUpDeltaJson(content) {
  let raw = String(content || "").trim();
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (jsonMatch) raw = jsonMatch[1].trim();

  const startIdx = raw.indexOf("{");
  const endIdx = raw.lastIndexOf("}");
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    raw = raw.substring(startIdx, endIdx + 1);
  }

  return JSON.parse(raw);
}

function isGreetingOnly(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!.,?…]+$/g, "")
    .trim();
  if (!t || t.length > 48) return false;
  if (
    /\b(fever|cough|pain|advise|tab|inj|mg|bd|od|tds|cbc|cbp|lft|dolo|pantop|stop|restart|add|remove|delete|gcs|vitals|bp|pulse)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  return /^(hi|hello|hey|hola|namaste|good\s*(morning|afternoon|evening)|thanks|thank\s*you)(\s+(there|doc|doctor))?$/.test(
    t,
  );
}

/* ========================================================================== */
/* Routes                                                                     */
/* ========================================================================== */

/**
 * POST /api/ipd-ai/review-followup
 * Handles Inpatient (IPD Ward) & Emergency (ERA) chart updates.
 */
router.post("/review-followup", async (req, res) => {
  try {
    const {
      instruction,
      currentChart,
      clinicalSetting = "ipd",
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
    const isEra = clinicalSetting === "era";

    // Direct greeting handler
    if (isGreetingOnly(instruction)) {
      return res.json({
        medicines: chart.medicines || [],
        labTests: chart.labTests || [],
        procedures: chart.procedures || [],
        vitals: chart.vitals || {},
        doctorNotes: chart.doctorNotes || "",
        eraManualExam: chart.eraManualExam || null,
        medicinesToApply: chart.medicines || [],
        labTestsToApply: chart.labTests || [],
        proceduresToApply: chart.procedures || [],
        medicinesToStop: [],
        medicinesToRestart: [],
        labTestsToStop: [],
        assistantReply: isEra
          ? "Hello Doctor. What are the emergency casualty findings or orders?"
          : "Good morning Doctor. Ready for today's ward round.",
      });
    }

    const systemAddendum = isEra
      ? ERA_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM
      : IPD_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM;
    const userPrompt = buildInpatientReviewFollowUpUserPrompt(
      instruction,
      chart,
      isEra,
    );
    const systemContent = `${INPATIENT_CLINICAL_NOTE_SYSTEM_PROMPT}\n${systemAddendum}`;

    const followUpMessages = [
      { role: "system", content: systemContent },
      { role: "user", content: userPrompt },
    ];

    console.log(`=== [${isEra ? "ERA" : "IPD"} AI FOLLOW-UP INPUT] ===`);
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
        `${isEra ? "ERA" : "IPD"} AI Follow-up error:`,
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
      return res
        .status(500)
        .json({ error: `Invalid response from ${isEra ? "ERA" : "IPD"} AI` });
    }

    let content = response.data.choices[0].message.content.trim();
    let delta;
    try {
      delta = parseFollowUpDeltaJson(content);
    } catch (parseErr) {
      console.warn(
        `Failed to parse ${isEra ? "ERA" : "IPD"} AI delta JSON, retrying:`,
        parseErr.message,
      );
      try {
        const retry = await aiCompletionWithFallback(
          [
            ...followUpMessages,
            { role: "assistant", content },
            {
              role: "user",
              content: `Your previous JSON was invalid or truncated. Return a MINIMAL valid JSON patch only for what INSTRUCTION changes.`,
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
        console.error(`${isEra ? "ERA" : "IPD"} AI retry failed:`, retryErr.message);
        return res.status(500).json({ error: "Failed to parse AI response" });
      }
    }

    const merged = mergeInpatientChartDelta(chart, delta, {
      isEra,
      instruction,
    });

    console.log(`=== [${isEra ? "ERA" : "IPD"} AI FINAL RESULT] ===`);
    console.log("Medicines:", merged.medicines.map((m) => m.name));
    console.log(
      "Labs:",
      merged.labTests.map((t) => (typeof t === "string" ? t : t?.name)),
    );

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
      eraManualExam: merged.eraManualExam || null,
      medicinesToApply: merged.medicines,
      labTestsToApply: merged.labTests
        .map((t) => (typeof t === "string" ? t : t?.name || ""))
        .filter(Boolean),
      proceduresToApply: merged.procedures
        .map((p) => (typeof p === "string" ? p : p?.name || ""))
        .filter(Boolean),
      medicinesToStop: merged.medicines.filter(
        (m) => String(m?.action || "").toLowerCase() === "stop",
      ),
      medicinesToRestart: merged.medicines.filter(
        (m) => String(m?.action || "").toLowerCase() === "restart",
      ),
      labTestsToStop: merged.labTests.filter(
        (t) => String(t?.action || "").toLowerCase() === "stop",
      ),
      assistantReply:
        String(delta.assistantReply || "").trim() ||
        (isEra
          ? "Updated emergency casualty chart."
          : "Updated ward progress chart."),
    };

    return res.json(result);
  } catch (error) {
    console.error("Unexpected error in IPD/ERA AI:", error);
    return res.status(500).json({
      error: error?.message || "Internal server error in IPD/ERA AI",
    });
  }
});

/**
 * POST /api/ipd-ai/review-followup/reply-stream
 * Live plain-text token stream confirming doctor's instruction in real-time.
 */
router.post("/review-followup/reply-stream", async (req, res) => {
  const { instruction, currentChart, clinicalSetting = "ipd" } = req.body || {};

  if (!instruction || typeof instruction !== "string" || !instruction.trim()) {
    res.status(400).end("instruction is required");
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  const isEra = clinicalSetting === "era";

  if (isGreetingOnly(instruction)) {
    res.write(
      isEra
        ? "Hello Doctor. What are the emergency casualty orders?"
        : "Good morning Doctor. Ready for today's ward round.",
    );
    res.end();
    return;
  }

  try {
    const upstream = await openaiApi.post(
      "/chat/completions",
      {
        model: OPENAI_MODEL,
        stream: true,
        temperature: 0.2,
        max_tokens: REVIEW_FOLLOWUP_REPLY_MAX_TOKENS,
        messages: [
          {
            role: "system",
            content: `You are a concise medical voice assistant for an Indian hospital ${isEra ? "Emergency Room / Casualty" : "Inpatient Ward"}. Reply in ONE short, natural spoken sentence confirming the clinical order or change. Plain English, warm, professional.`,
          },
          {
            role: "user",
            content: `INSTRUCTION:\n${instruction}\n\nReply with ONE short spoken sentence confirming the action.`,
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
    console.warn("Inpatient AI reply stream upstream error:", err?.message || err);
    res.write(
      isEra
        ? "Got it — updating casualty chart."
        : "Got it — updating ward chart.",
    );
    res.end();
  }
});

module.exports = router;
