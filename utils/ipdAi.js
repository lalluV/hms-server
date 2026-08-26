/**
 * IPD AI Follow-up & Clinical Note Management Engine
 * Dedicated helper for Inpatient (Ward / IPD) clinical notes, ward orders,
 * medicine stops, and restarts.
 */

const NOTE_SECTION_ORDER = [
  ["complaints", "Complaints"],
  ["history", "History"],
  ["examination", "Examination"],
  ["diagnosis", "Diagnosis"],
  ["advice", "Doctor's Advice"],
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
  plan: "advice",
  treatmentplan: "advice",
  assessment: "advice",
  assessmentandplan: "advice",
};

const NOTE_LABEL_TO_KEY = Object.fromEntries(
  NOTE_SECTION_ORDER.map(([key, label]) => [label.toLowerCase(), key]),
);

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
  return String(
    typeof item === "string" ? item : item?.name || item?.correctedName || "",
  )
    .trim()
    .toLowerCase();
}

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

const IPD_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM = `

IPD WARD FOLLOW-UP MODE — PATCH ONLY (CRITICAL — KEEP OUTPUT TINY)
- CURRENT CHART below contains the patient's ongoing ward chart and the doctor's current round note.
- Items are tagged origin: "review" (new orders added this round) or "visit" (ongoing ward medications / tests).
- INSTRUCTION is the one new change requested for this ward round.
- Output ONLY ops for items the INSTRUCTION explicitly touches.
- IPD DURATION OVERRIDE: Do NOT default medicine duration to "5 days". Leave duration "" unless explicitly specified. Ward medications continue until stopped.
- DIRECTIONS (IPD): Plain English schedule without course length; do not invent slot quantities unless stated.
- DELETE / REMOVE / STOP (IPD WARD):
  * origin "review": use op "remove" (drops from today's draft).
  * origin "visit": use op "stop" (marks ongoing ward medication to be stopped).
- RESTART (IPD WARD):
  * When doctor asks to restart / resume a previously stopped ward medicine → medicineOps op "restart" with match = chart name.
- assistantReply is required: one short spoken sentence confirming the action.
`;

function buildIpdReviewFollowUpUserPrompt(
  instruction,
  currentChart,
  context,
  existingContext,
) {
  return `SETTING: IPD (Ward progress note).
"stop" discontinues an ongoing ward medicine. "restart" reactivates a previously stopped ward medicine. DURATION: do NOT default to 5 days; ward medicines continue until stopped.
${context ? `PATIENT: ${context}` : ""}
${existingContext ? `EXISTING CONTEXT:\n${JSON.stringify(existingContext)}` : ""}

CURRENT CHART (ground truth — patch only what instruction changes):
${JSON.stringify(currentChart)}

INSTRUCTION:
${instruction}

REMINDER: Output minimal JSON patch for IPD ward orders only.`;
}

/**
 * Applies an IPD model PATCH onto the inpatient chart.
 * Enforces IPD ward logic: review-origin -> drop; visit-origin -> stop (discontinue).
 */
function mergeIpdChartDelta(currentChart, delta) {
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

  let addedMedIndex = 0;
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

    if ((kind === "stop" || kind === "remove") && activeIdx >= 0) {
      kind = itemOrigin(medicines[activeIdx]) === "visit" ? "stop" : "remove";
    } else if (kind === "stop" || kind === "remove") {
      const anyIdx = medicines.findIndex((m) => nameKey(m) === matchName);
      if (anyIdx >= 0) {
        kind = itemOrigin(medicines[anyIdx]) === "visit" ? "stop" : "remove";
      }
    }

    if (kind === "add" && op.medicine) {
      medicines.splice(addedMedIndex++, 0, {
        ...op.medicine,
        generic_name: "",
        action: "add",
        origin: "review",
      });
    } else if (kind === "edit" && op.medicine) {
      const stepsToInsert =
        Array.isArray(op.steps) && op.steps.length > 0
          ? op.steps
          : [op.medicine];
      const formattedSteps = stepsToInsert.map((step) => ({
        ...step,
        generic_name: "",
        action: "add",
        origin: "review",
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
        if (activeIdx < addedMedIndex) addedMedIndex = Math.max(0, addedMedIndex - 1);
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
    } else if (kind === "restart") {
      medicines = medicines.filter(
        (m) =>
          !(
            nameKey(m) === matchName &&
            ["stop", "restart"].includes(String(m?.action || "").toLowerCase())
          ),
      );
      medicines.splice(addedMedIndex++, 0, {
        ...(op.medicine || { name: op.match }),
        name:
          String(op?.medicine?.name || op?.match || "").trim() ||
          String(op?.match || "").trim(),
        action: "restart",
        origin: "visit",
        directions: "Restart this medicine",
      });
    } else if (kind === "remove") {
      medicines = medicines.filter((m) => nameKey(m) !== matchName);
    }
  }

  let addedLabIndex = 0;
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
      const alreadyReviewAdd = labTests.some(
        (t) =>
          nameKey(t) === String(op.name).toLowerCase() &&
          itemOrigin(t) === "review" &&
          String(t?.action || "add").toLowerCase() === "add",
      );
      if (!alreadyReviewAdd) {
        labTests.splice(addedLabIndex++, 0, { name: op.name, action: "add", origin: "review" });
      }
    } else if (kind === "remove" && target) {
      labTests = labTests.filter((t) => nameKey(t) !== target);
    } else if (kind === "stop" && target) {
      if (idx >= 0) {
        const [existing] = labTests.splice(idx, 1);
        if (idx < addedLabIndex) addedLabIndex = Math.max(0, addedLabIndex - 1);
        if (itemOrigin(existing) !== "review") {
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

  let addedProcIndex = 0;
  for (const op of Array.isArray(d.procedureOps) ? d.procedureOps : []) {
    let kind = String(op?.op || "").toLowerCase();
    const target = String(op?.match || op?.name || "")
      .trim()
      .toLowerCase();
    const idx = procedures.findIndex((p) => nameKey(p) === target);

    if (kind === "add" && op.name) {
      procedures.splice(addedProcIndex++, 0, { name: op.name, action: "add", origin: "review" });
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

  return { medicines, labTests, procedures, vitals, doctorNotes };
}

module.exports = {
  NOTE_SECTION_ORDER,
  NOTE_SECTION_ALIASES,
  NOTE_LABEL_TO_KEY,
  parseComposedNoteSections,
  composeNoteFromSections,
  mergeNoteWithOps,
  IPD_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM,
  buildIpdReviewFollowUpUserPrompt,
  mergeIpdChartDelta,
};
