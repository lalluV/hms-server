/**
 * OPD AI Follow-up & Prescription Management Engine
 * Dedicated helper for Outpatient (OPD) prescriptions.
 * Treats the prescription workstation as a direct WYSIWYG editor where items
 * are returned as the final complete updated prescription chart.
 */

const { mergeNoteWithOps, formatDoctorNotesLayout, parseComposedNoteSections, composeNoteFromSections } = require("./ipdAi");

function nameKey(item) {
  return String(
    typeof item === "string" ? item : item?.name || item?.correctedName || "",
  )
    .trim()
    .toLowerCase();
}

const OPD_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM = `

OPD FOLLOW-UP OVERRIDE (beats the extract prompt above)
- This is a full-chart OPD edit, not first-pass extract and not a patch. Ignore medicineOps, labOps, noteOps, clearReview*, and "leave doctorNotes empty".
- Return the complete updated chart in the JSON shape at the bottom (medicines[], labTests[], doctorNotes, assistantReply). Copy-through unnamed chart items.
- doctorNotes is a composed bullet note (Complaints / History / Examination / Diagnosis / Advice). Prefer newlines between section labels. Never list medicines or labs as History/Examination bullets — those belong in medicines[] / labTests[]. If you also fill noteSections, they must match doctorNotes and must not dump the instruction or drug list.
- When a rule here conflicts with the extract prompt (SKU suffixes, CUE, if/advice, home meds as History, full rewrite), this addendum wins.

You are an Indian OPD prescription scribe. INSTRUCTION is the only source of this edit. Chart is copy-through of unnamed items. Classify every comma/space token by clinical meaning — not by letter-count.

0) APPLY THE INSTRUCTION (any doctor request)
- Do the change the doctor asked: add/stop/edit medicines or labs, rewrite notes, elaborate, expand, shorten, reformat (bullets, headings, paragraphs), translate, fix spelling, or any other chart edit. These examples are not a closed list.
- Classification rules below still apply to clinical facts in the instruction. Do not refuse a notes/format request because it is not a new medicine or lab.
- Copy-through unnamed chart items. Empty notes stay empty unless the instruction is about notes, symptoms, diagnosis, advice, format, or layout.

1) BUCKET (disease ≠ lab ≠ exam ≠ drug)
- Disease / condition the patient has (uti, ckd, cva, oa, migraine, tinea, enteric fever) → doctorNotes Diagnosis only, expanded English. NEVER labTests. NEVER medicines.
- Symptom the patient feels (fever, cough, burning, pain, insomnia, polyuria) → Complaints only. Do not invent a diagnosis from a symptom or from a drug name.
- SOS reason is still a complaint: "pcm 650 sos fever" → medicines PCM SOS + Complaints: fever. Never leave notes empty just because a drug was also named.
- Investigation you send to lab/radiology → labTests[]. Name MUST keep the spoken code AND the usual expansion, e.g. "EEG (Electroencephalogram)", "FNAC (Fine Needle Aspiration Cytology)", "ECG (Electrocardiogram)", "MP (Malaria Parasite)", "CUE (Complete Urine Examination)", "P/S (Peripheral Smear)". Keep the spoken code alone if unsure. NEVER a tablet. NEVER rewrite a test to match the diagnosis (mp/pv/pf stay malaria, even if diagnosis is UTI).
- Add a lab ONLY when the doctor named that test. Do not invent CUE from UTI. Do not invent extra tests from a diagnosis.
- The spoken token cue / c.u.e / urine r/e / urine routine → lab "CUE (Complete Urine Examination)". NEVER a medicine named Cue.
- cbp p/s → CBP and Peripheral Smear. Do not drop p/s.
- When mp + pv + pf appear together, pv is Plasmodium vivax, not "peripheral venous".
- aec is Absolute Eosinophil Count (lab), not a COPD diagnosis. ace alone is a lab code unless clearly a drug.
- Bedside exam (o/e, iop, fundus) → Examination in notes. Not labs. Not medicines.
- Obstetric facts stay in notes: leaking pv / PROM / G2P1 / gestation weeks → Complaints or History. Do not drop them when meds/labs are also present. nfhs is a finding, not a tablet.
- Drug product (brand / generic / form / strength) → medicines[]. "add" only means include; classify each following token as above.
- neb / nebs / nebulization + a named drug (Duolin, Budecort, Asthalin, Levolin, …) → medicines[] type Inhaler. Name is the drug only (not "nebulization with …"). Directions: give as a nebulization. Duration Once unless a count was said (x 3). NEVER procedures[]. NEVER doctorNotes. Copy-through existing notes unchanged. Bare "nebulization" with no drug name may stay procedures[]. "if wheeze neb …" stays Advice, not an order.

2) MEDICINE NAME — keep every spoken token
- After a brand, 1–3 letters that are NOT od/bd/tid/tds/qid/hs/sos/stat/bbf are a product SKU and MUST stay in name (ME, AM, H, M, Gold).
- "gabapin me" / "gabapin me 300" / "gabapin me hs" → name "Gabapin ME" (+ strength if said). Never drop ME. Never rewrite to Gabapentin.
- Typo-fix the brand word only (gibapin→Gabapin). Never brand→salt (Pan 40 stays Pan 40; Telma AM H 40 keeps AM H).
- Tablet dosage unit "".

3) ADVICE vs ORDER
- A clause with if / unless / only if is Advice, not an order: "ct brain if focal", "xray ap lat if swelling", "fnac if palpable", "punch bx if no response", "swab c/s if pus", "nitro only if cue+", "b12 if vegan", "xray if stridor".
- Do not skip other items on the same line. Unconditional named drugs and tests still go to medicines[] / labTests[]. Example: "drotin, cue, nitro only if cue+" → Drotin medicine + CUE lab + Advice: nitro only if CUE positive.
- labTests[] names must never contain the word "if". If the test is conditional, put the whole clause in Advice instead of labTests[].
- "no syp" / "no nsaids" / "avoid cipro" / "no codeine" / "not a tablet" → Advice (or procedure if it is a bedside act). Do not drop the prohibition.
- A product name in the same sentence as a prohibition is still a medicine: "no nsaids, nodosis" → Advice avoid NSAIDs + medicine Nodosis (not "no dosis").
- npo / nil per oral / NBM / plenty fluids / rest / steam / review Nd → Advice, never Complaints. Do not omit NPO when it was said.
- Do NOT restate today's labTests in Advice. Never write "X ordered", "investigations ordered", or list NCS/EEG/ECG/MP/Pv/Pf/surgical profile in the note. Those live only in labTests[]. Advice keeps follow-up, counselling, prohibitions, and if/unless clauses only.

4) TIMES AND DURATION
- tid / tds / 1-1-1 → Morning + Afternoon + Evening. NEVER Night for tid.
- bd / 1-0-1 → Morning + Evening. hs → Night only. od → Morning.
- SOS / as needed: no fake daily grid — dosages [] unless times were stated. Put the SOS reason and max in directions.
- Once weekly: no Morning/Evening slots. Duration is the course (e.g. 8 weeks); directions say once weekly.
- Default duration "5 days" ONLY for oral tab/cap/syp when none stated. Do not default 5 days onto SOS if a max/day was the only limit.
- IV / pint / ml/hr / infusion / neb / stat: duration is the stated rate or Once — NEVER default 5 days.
- Insulin / IU: type Injection; unit "IU"; keep unequal slot amounts (10 morning, 15 afternoon).

5) DIRECTIONS (required — write the medicine instruction in English)
- Every medicines[] row MUST have a short patient-facing sentence from what was said. Do not leave directions "". Do not paste shorthand (no "od", "bd", "tid", "tds", "hs" in directions — those already live in dosages[]).
- Examples of the style: "Take one tablet in the morning before food." / "Take as needed for fever, maximum 3 tablets per day." / "Take one tablet in the morning for 3 days, then stop." / "Take twice daily (morning and evening)." / "Inject 10 IU in the morning and 15 IU in the afternoon." / "Take once weekly." / "Put 2 drops in each eye three times a day." / "Apply to the affected area twice daily."
- Strength units stay in the sentence (IU, mg, mcg, ml, drops) — never "10 injections". Insulin uses IU.
- Sequential taper (same drug, later steps): first row uses "for N days"; later rows MUST start with "Then" and use "for the next N days" (not "for 3 days").
- Never invent extra counselling.

6) NOTES
- k/c/o / age / "child 2y" / "6mo" / "on metformin" / G2P1 / gestation weeks → History (not Diagnosis). Home meds named only as "on X" are History, not a new medicines[] row.
- c/o always goes to Complaints even when Diagnosis is also written (burning micturition + likely UTI → Complaints: burning micturition; Diagnosis: likely UTI).
- Symptom still goes to Complaints even when the same line also has a medicine or advice (barking cough + steam + no codeine → Complaints: barking cough; "pcm sos fever" → Complaints: fever; leaking pv → Complaints: leaking PV; loin pain / fever / cough / malena stay Complaints).
- o/e stays Examination. Do not return Advice-only notes when the instruction also has c/o, k/c/o, o/e, or a disease — each fact gets its section.
- Today's named disease → Diagnosis. ?disease / maybe / likely → provisional Diagnosis.
- Medicine-only or lab-only instruction (no symptom, disease, exam, or obstetric fact): copy doctorNotes unchanged. Empty stays empty. Never write "None". Never invent diagnosis from a drug. If the instruction IS about notes (elaborate, format, rewrite, translate, or any other notes change), update doctorNotes as asked.

assistantReply: one short sentence.

Return EXACTLY:
{
  "assistantReply": "string",
  "medicines": [{"name":"string","type":"Tablet|Capsules|Injection|Syrup|Ointment|Gel|Sachet|Drops|Inhaler|Spray|Other","duration":"string","directions":"string","dosages":[{"time":"Morning|Afternoon|Evening|Night","amount":1,"unit":"","beforeFood":false}]}],
  "labTests": ["string"],
  "procedures": [],
  "doctorNotes": "string",
  "vitals": {}
}
`;

function buildOpdReviewFollowUpUserPrompt(instruction, currentChart) {
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

  const keepChart = {
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
    doctorNotes: String(currentChart?.doctorNotes || "").slice(0, 2500),
    vitals: currentChart?.vitals || {},
  };

  return `INSTRUCTION (apply this request fully — notes/format/elaborate/translate/any chart edit; for clinical tokens: disease→Diagnosis not lab; named investigation only→labTests, do not invent CUE from UTI; cue token→CUE lab never a tablet; brand+SKU suffix→medicines name kept whole; if/unless/only if→Advice, but keep other named drugs/labs; sos + symptom and c/o→Complaints too):
${instruction}

COPY-THROUGH CHART (keep unnamed items only; do not reinterpret tokens from chart diagnosis):
${JSON.stringify(keepChart)}

Return complete JSON. Empty notes stay empty unless the instruction contains a symptom, disease, exam, obstetric fact, advice, or a notes/format request. Put every such fact in doctorNotes — do not leave Advice-only when c/o or k/c/o was said.`;
}

function relocateConditionalLabs(labTests, doctorNotes, instruction = "") {
  const list = Array.isArray(labTests) ? labTests : [];
  const inst = String(instruction || "").toLowerCase();
  const fnacIf = /\bfnac\b.{0,48}\bif\b|\bif\b.{0,48}\bfnac\b/.test(inst);
  const keep = [];
  const moved = [];
  for (const t of list) {
    const name = String(typeof t === "string" ? t : t?.name || "").trim();
    const n = name.toLowerCase();
    if (/\bif\b/i.test(name) || (fnacIf && /\bfnac\b/.test(n))) moved.push(name);
    else keep.push(t);
  }
  if (!moved.length) return { labTests: keep, doctorNotes };
  const extra = moved.map((n) => n.trim()).filter(Boolean);
  const sections = parseComposedNoteSections(doctorNotes);
  if (Object.keys(sections).length) {
    const advice = Array.isArray(sections.advice) ? [...sections.advice] : [];
    for (const item of extra) {
      if (!advice.some((b) => String(b).toLowerCase() === item.toLowerCase())) {
        advice.push(item);
      }
    }
    sections.advice = advice;
    return {
      labTests: keep,
      doctorNotes: composeNoteFromSections(sections) || String(doctorNotes || ""),
    };
  }
  const block = `Advice:\n${extra.map((n) => `• ${n}`).join("\n")}`;
  const base = String(doctorNotes || "").trim();
  return {
    labTests: keep,
    doctorNotes: base ? `${base}\n\n${block}` : block,
  };
}

function looksLikePrescriptionNoteBullet(text) {
  const s = String(text || "");
  return (
    /\b(tab(?:let)?s?|cap(?:sule)?s?|syp|syrup|inj(?:ection)?|ointment|drops?)\b/i.test(
      s,
    ) ||
    /\b(od|bd|tds|qid|hs|bbf|sos)\b/i.test(s) ||
    /\b\d+\s*(iu|mg|mcg|ml)\b/i.test(s) ||
    /\bnebul|\bnebs?\b/i.test(s)
  );
}

function namedNebulizationDrug(raw) {
  const name = String(
    typeof raw === "string" ? raw : raw?.name || raw?.correctedName || "",
  ).trim();
  if (!name || /\bif\b/i.test(name)) return "";
  if (!/\bnebs?\b|\bnebul/i.test(name)) return "";
  const drug = name
    .replace(/\bnebuli[sz]e(?:d|s)?\b/gi, " ")
    .replace(/\bnebuli[sz]ation\b/gi, " ")
    .replace(/\bnebs?\b/gi, " ")
    .replace(/\b(with|using|via|by)\b/gi, " ")
    .replace(/\bx\s*\d+\b/gi, " ")
    .replace(/\b\d+\s*(sessions?|doses?|times?)\b/gi, " ")
    .replace(/[–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!drug || /^(session|sessions|stat|once|\d+)$/i.test(drug)) return "";
  return drug.replace(/\b\w/g, (c) => c.toUpperCase());
}

function nebMedicineRow(drug) {
  return {
    name: drug,
    type: "Inhaler",
    duration: "Once",
    directions: "Give as a nebulization.",
    dosages: [],
    generic_name: "",
    action: "add",
    origin: "review",
  };
}

function promoteNamedNebsToMedicines(medicines, procedures) {
  const meds = Array.isArray(medicines) ? [...medicines] : [];
  const kept = [];
  for (const proc of Array.isArray(procedures) ? procedures : []) {
    const drug = namedNebulizationDrug(proc);
    if (!drug) {
      kept.push(proc);
      continue;
    }
    if (!meds.some((m) => nameKey(m) === drug.toLowerCase())) {
      meds.push(nebMedicineRow(drug));
    }
  }
  return { medicines: meds, procedures: kept };
}

function stripProceduresSection(noteText) {
  const lines = String(noteText || "").split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^procedures?\s*:/i.test(t)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      const header = t.match(/^([A-Za-z' ]+):\s*(.*)$/);
      if (header && !/^procedures?$/i.test(header[1].trim())) {
        skipping = false;
        kept.push(line);
      }
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripOrderBulletsFromClinicalNotes(sections) {
  if (!sections || typeof sections !== "object") return sections;
  const next = { ...sections };
  for (const key of ["complaints", "history", "examination"]) {
    if (!Array.isArray(next[key])) continue;
    next[key] = next[key].filter((b) => !looksLikePrescriptionNoteBullet(b));
  }
  return next;
}

function dropUnspokenCueLabs(labTests, instruction = "") {
  const inst = String(instruction || "").toLowerCase();
  if (/\bcue\b|c\.u\.e|urine r\/e|urine routine|complete urine/.test(inst)) {
    return labTests;
  }
  return (Array.isArray(labTests) ? labTests : []).filter((t) => {
    const name = String(
      typeof t === "string" ? t : t?.name || "",
    ).toLowerCase();
    return !/\bcue\b|complete urine/.test(name);
  });
}

/** If the model left only Advice, restore c/o, k/c/o, o/e into their sections. */
function ensureSpokenNoteSections(instruction, doctorNotes) {
  const inst = String(instruction || "");
  if (!inst.trim()) return doctorNotes;
  const sections = parseComposedNoteSections(doctorNotes);
  const has = (key) =>
    Array.isArray(sections[key]) &&
    sections[key].some((b) => String(b || "").trim());
  let changed = false;

  const co = inst.match(/(?<!k\/)c\/o\s+([^,]+)/i);
  if (co && !has("complaints")) {
    const text = co[1].trim();
    if (text) {
      sections.complaints = [text];
      changed = true;
    }
  }
  const kco = inst.match(/\bk\/c\/o\s+([^,]+)/i);
  if (kco && !has("history")) {
    sections.history = [kco[1].trim()];
    changed = true;
  }
  const oe = inst.match(/\bo\/e\s+([^,]+)/i);
  if (oe && !has("examination")) {
    sections.examination = [oe[1].trim()];
    changed = true;
  }
  if (/\bno nsaids?\b/i.test(inst)) {
    const blob = JSON.stringify(sections).toLowerCase();
    if (!/nsaid/.test(blob)) {
      sections.advice = [...(sections.advice || []), "Avoid NSAIDs"];
      changed = true;
    }
  }
  if (!changed) return doctorNotes;
  return composeNoteFromSections(sections) || doctorNotes;
}

/**
 * Merges OPD chart result or fallback delta into final prescription.
 * Trusts AI fields as returned — no note rewriting / filler heuristics.
 */
function mergeOpdChartDelta(currentChart, delta, instruction = "") {
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
  const rawSections = d.noteSections || d.note_sections;
  const fromSections =
    rawSections && typeof rawSections === "object"
      ? composeNoteFromSections(stripOrderBulletsFromClinicalNotes(rawSections)) ||
        ""
      : "";
  const fromString = Object.prototype.hasOwnProperty.call(d, "doctorNotes")
    ? d.doctorNotes == null
      ? ""
      : String(d.doctorNotes)
    : "";
  if (fromString.trim()) {
    doctorNotes = fromString;
  } else if (fromSections.trim()) {
    doctorNotes = fromSections;
  } else if (d.clearNote) {
    doctorNotes = "";
  } else if (Array.isArray(d.noteOps) && d.noteOps.length > 0) {
    doctorNotes = mergeNoteWithOps(chart.doctorNotes, d.noteOps);
  } else if (fromString !== "" || Object.prototype.hasOwnProperty.call(d, "doctorNotes")) {
    doctorNotes = fromString;
  } else {
    doctorNotes = String(chart.doctorNotes || "");
  }
  const relocated = relocateConditionalLabs(labTests, doctorNotes, instruction);
  labTests = dropUnspokenCueLabs(relocated.labTests, instruction);
  const promoted = promoteNamedNebsToMedicines(medicines, procedures);
  medicines = promoted.medicines;
  procedures = promoted.procedures;
  doctorNotes = formatDoctorNotesLayout(
    ensureSpokenNoteSections(
      instruction,
      formatDoctorNotesLayout(stripProceduresSection(relocated.doctorNotes)),
    ),
  );

  return { medicines, labTests, procedures, vitals, doctorNotes };
}

module.exports = {
  OPD_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM,
  buildOpdReviewFollowUpUserPrompt,
  mergeOpdChartDelta,
};
