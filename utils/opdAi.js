/**
 * OPD AI Follow-up & Prescription Management Engine
 * Dedicated helper for Outpatient (OPD) prescriptions.
 * Treats the prescription workstation as a direct WYSIWYG editor where items
 * are returned as the final complete updated prescription chart.
 */

const {
  mergeNoteWithOps,
  parseComposedNoteSections,
  composeNoteFromSections,
} = require("./ipdAi");

function nameKey(item) {
  return String(
    typeof item === "string" ? item : item?.name || item?.correctedName || "",
  )
    .trim()
    .toLowerCase();
}

const OPD_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM = `

OPD PRESCRIPTION WORKSTATION MODE — COMPLETE PRESCRIPTION OUTPUT
- CURRENT PRESCRIPTION below is the complete current outpatient prescription (doctor notes, prescribed medicines, ordered lab tests, vitals).
- INSTRUCTION is the doctor's change (add, replace, delete/remove, edit dosage, modify notes).

YOUR TASK:
Return the COMPLETE, FINAL updated prescription reflecting all changes requested in INSTRUCTION:
1. REPLACE:
   * When doctor says "replace [Med A] with [Med B]" → Replace [Med A] with [Med B] in the "medicines" array in-place.
2. DELETE / REMOVE / STOP:
   * When doctor says "delete [Med A]" or "remove [Med A]" → Omit [Med A] completely from the "medicines" array.
   * When doctor says "delete [Lab A]" or "remove [Lab A]" → Omit [Lab A] completely from the "labTests" array.
3. ADD:
   * When doctor says "add [Med C]" → Add [Med C] to the "medicines" array.
   * When doctor says "add [Lab B]" → Add [Lab B] to the "labTests" array.
4. UNTOUCHED ITEMS:
   * All other unchanged medicines and lab tests MUST remain in their returned arrays.
5. assistantReply is required:
   * One warm, concise spoken confirmation sentence (e.g. "Replaced Pantop with Rabeprazole 20mg.", "Removed Dolo 650 from the prescription.").

Return EXACTLY this JSON shape:
{
  "assistantReply": "One short natural spoken sentence confirming the change",
  "medicines": [
    {
      "name": "Medicine name with strength",
      "type": "Tablet|Capsules|Injection|Syrup|Ointment|Gel|Sachet|Drops|Inhaler|Spray|Other",
      "duration": "5 days",
      "directions": "Take 1 tablet in the morning before food",
      "dosages": [{ "time": "Morning|Afternoon|Evening|Night", "amount": 1, "unit": "", "beforeFood": false }]
    }
  ],
  "labTests": ["CBC", "RBS"],
  "procedures": [],
  "doctorNotes": "Full updated clinical note text",
  "vitals": {}
}
`;

function buildOpdReviewFollowUpUserPrompt(
  instruction,
  currentChart,
  context,
  existingContext,
) {
  const slimMed = (m) => ({
    name: m?.name || "",
    type: m?.type || "Tablet",
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

  const slimChart = {
    doctorNotes: String(currentChart?.doctorNotes || "").slice(0, 2500),
    medicines: (Array.isArray(currentChart?.medicines)
      ? currentChart.medicines
      : []
    ).map(slimMed),
    labTests: (Array.isArray(currentChart?.labTests)
      ? currentChart.labTests
      : []
    ).map((t) => (typeof t === "string" ? t : t?.name || "")),
    procedures: (Array.isArray(currentChart?.procedures)
      ? currentChart.procedures
      : []
    ).map((p) => (typeof p === "string" ? p : p?.name || "")),
    vitals: currentChart?.vitals || {},
  };

  return `SETTING: OPD (Outpatient Prescription).
Apply INSTRUCTION to CURRENT PRESCRIPTION and return the COMPLETE updated prescription.
${context ? `PATIENT: ${context}` : ""}
${existingContext ? `VISIT CONTEXT:\n${JSON.stringify(existingContext)}` : ""}

CURRENT PRESCRIPTION:
${JSON.stringify(slimChart)}

INSTRUCTION:
${instruction}

REMINDER: Return JSON with complete updated medicines, labTests, doctorNotes, and assistantReply.`;
}

/**
 * Merges OPD chart result or fallback delta into final prescription.
 */
function mergeOpdChartDelta(currentChart, delta) {
  const chart =
    currentChart && typeof currentChart === "object" ? currentChart : {};
  const d = delta && typeof delta === "object" ? delta : {};

  // 1. Direct updated medicines array from model
  let medicines = [];
  if (Array.isArray(d.medicines)) {
    medicines = d.medicines.map((m) => ({
      ...m,
      generic_name: "",
      action: "add",
      origin: "review",
    }));
  } else if (!d.clearReviewMedicines && !d.stopAllVisitMedicines) {
    medicines = Array.isArray(chart.medicines)
      ? chart.medicines.map((m) => ({ ...m, action: "add", origin: "review" }))
      : [];
  }

  // 2. Direct updated labTests array from model
  let labTests = [];
  if (Array.isArray(d.labTests)) {
    labTests = d.labTests.map((t) =>
      typeof t === "string"
        ? { name: t, action: "add", origin: "review" }
        : { ...t, action: "add", origin: "review" },
    );
  } else if (!d.clearReviewLabs && !d.stopAllVisitLabs) {
    labTests = Array.isArray(chart.labTests)
      ? chart.labTests.map((t) =>
          typeof t === "string"
            ? { name: t, action: "add", origin: "review" }
            : { ...t, action: "add", origin: "review" },
        )
      : [];
  }

  let procedures = Array.isArray(d.procedures)
    ? d.procedures.map((p) =>
        typeof p === "string"
          ? { name: p, action: "add", origin: "review" }
          : { ...p, action: "add", origin: "review" },
      )
    : Array.isArray(chart.procedures)
      ? chart.procedures.map((p) =>
          typeof p === "string"
            ? { name: p, action: "add", origin: "review" }
            : { ...p, action: "add", origin: "review" },
        )
      : [];

  // 3. Fallback: If delta returned ops instead of full arrays
  if (Array.isArray(d.medicineOps) && d.medicineOps.length > 0) {
    for (const op of d.medicineOps) {
      const matchName = String(op?.match || "")
        .trim()
        .toLowerCase();
      const kind = String(op?.op || "").toLowerCase();

      const activeIdx = medicines.findIndex(
        (m) => nameKey(m) === matchName || (op?.medicine && nameKey(m) === nameKey(op.medicine)),
      );

      if (kind === "add" && op.medicine) {
        medicines.push({
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
          medicines.push(...formatted);
        }
      } else if (kind === "remove" || kind === "stop" || kind === "delete") {
        if (activeIdx >= 0) {
          medicines.splice(activeIdx, 1);
        } else if (matchName) {
          medicines = medicines.filter((m) => nameKey(m) !== matchName);
        }
      }
    }
  }

  if (Array.isArray(d.labOps) && d.labOps.length > 0) {
    for (const op of d.labOps) {
      const kind = String(op?.op || "").toLowerCase();
      const target = String(op?.match || op?.name || "")
        .trim()
        .toLowerCase();
      const idx = labTests.findIndex((t) => nameKey(t) === target);

      if (kind === "add" && op.name) {
        if (!labTests.some((t) => nameKey(t) === String(op.name).toLowerCase())) {
          labTests.push({ name: op.name, action: "add", origin: "review" });
        }
      } else if (kind === "remove" || kind === "stop" || kind === "delete") {
        if (idx >= 0) {
          labTests.splice(idx, 1);
        } else if (target) {
          labTests = labTests.filter((t) => nameKey(t) !== target);
        }
      }
    }
  }

  const vitals = {
    ...(chart.vitals || {}),
    ...(d.vitalsPatch || {}),
    ...(d.vitals || {}),
  };

  let doctorNotes = d.doctorNotes
    ? d.doctorNotes
    : d.clearNote
      ? ""
      : mergeNoteWithOps(chart.doctorNotes, d.noteOps);

  return { medicines, labTests, procedures, vitals, doctorNotes };
}

module.exports = {
  OPD_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM,
  buildOpdReviewFollowUpUserPrompt,
  mergeOpdChartDelta,
};
