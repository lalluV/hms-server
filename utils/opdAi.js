/**
 * OPD AI Follow-up & Prescription Management Engine
 * Dedicated helper for Outpatient (OPD) prescriptions.
 * Treats the prescription workstation as a direct WYSIWYG editor where items
 * are returned as the final complete updated prescription chart.
 */

const { mergeNoteWithOps, formatDoctorNotesLayout } = require("./ipdAi");

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
1. REPLACE: replace the named medicine in medicines[] in-place.
2. DELETE / REMOVE / STOP: omit the named medicine or lab from its array.
3. ADD: add the named medicine or lab to its array (prefer near the start).
4. TAPERS / SEQUENTIAL DOSES:
   - Never pack a taper into one medicine row.
   - Each taper step is its own medicines[] object with its own strength, duration, directions, dosages.
   - Chronological order: starting dose first, then next steps, lowest last.
5. UNTOUCHED ITEMS: keep all unchanged medicines and lab tests in the returned arrays.
6. doctorNotes:
   - If INSTRUCTION does not change notes → copy doctorNotes from CURRENT PRESCRIPTION exactly. Do not invent or fill notes.
   - If INSTRUCTION changes notes → return the updated doctorNotes with labeled bullet sections (Complaints, History, Examination, Diagnosis, Advice). Never put med/lab orders in doctorNotes.
   - Symptom-only instructions without naming a drug or saying to prescribe/add a medicine → put that in doctorNotes Complaints only. Do NOT invent a medicine for a symptom.
   - Add/change medicines[] only when the doctor names a medicine/product or clearly orders treatment.
7. assistantReply: one short natural spoken confirmation sentence.

Return EXACTLY this JSON shape:
{
  "assistantReply": "string",
  "medicines": [
    {
      "name": "string",
      "type": "Tablet|Capsules|Injection|Syrup|Ointment|Gel|Sachet|Drops|Inhaler|Spray|Other",
      "duration": "string",
      "directions": "string",
      "dosages": [{ "time": "Morning|Afternoon|Evening|Night", "amount": 1, "unit": "", "beforeFood": false }]
    }
  ],
  "labTests": ["string"],
  "procedures": [],
  "doctorNotes": "string",
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

REMINDER: Return complete medicines, labTests, doctorNotes, and assistantReply. Copy doctorNotes unchanged unless INSTRUCTION changes notes. Symptom-only words without a named drug go into Complaints notes — never invent medicines for them.`;
}

/**
 * Merges OPD chart result or fallback delta into final prescription.
 * Trusts AI fields as returned — no note rewriting / filler heuristics.
 */
function mergeOpdChartDelta(currentChart, delta) {
  const chart =
    currentChart && typeof currentChart === "object" ? currentChart : {};
  const d = delta && typeof delta === "object" ? delta : {};

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

  if (Array.isArray(d.medicineOps) && d.medicineOps.length > 0) {
    for (const op of d.medicineOps) {
      const matchName = String(op?.match || "")
        .trim()
        .toLowerCase();
      const kind = String(op?.op || "").toLowerCase();

      const activeIdx = medicines.findIndex(
        (m) =>
          nameKey(m) === matchName ||
          (op?.medicine && nameKey(m) === nameKey(op.medicine)),
      );

      if (kind === "add" && op.medicine) {
        medicines.unshift({
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
          medicines.unshift(...formatted);
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
        if (
          !labTests.some((t) => nameKey(t) === String(op.name).toLowerCase())
        ) {
          labTests.unshift({ name: op.name, action: "add", origin: "review" });
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

  let doctorNotes;
  if (Object.prototype.hasOwnProperty.call(d, "doctorNotes")) {
    doctorNotes = d.doctorNotes == null ? "" : String(d.doctorNotes);
  } else if (d.clearNote) {
    doctorNotes = "";
  } else if (Array.isArray(d.noteOps) && d.noteOps.length > 0) {
    doctorNotes = mergeNoteWithOps(chart.doctorNotes, d.noteOps);
  } else {
    doctorNotes = String(chart.doctorNotes || "");
  }
  doctorNotes = formatDoctorNotesLayout(doctorNotes);

  return { medicines, labTests, procedures, vitals, doctorNotes };
}

module.exports = {
  OPD_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM,
  buildOpdReviewFollowUpUserPrompt,
  mergeOpdChartDelta,
};
