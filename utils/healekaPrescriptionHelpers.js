/**
 * Shared helpers for Healeka AI prescription create / update / reuse.
 */

const MEDICINE_ALIASES = {
  pcm: "paracetamol",
  para: "paracetamol",
  dolo: "paracetamol",
  crocin: "paracetamol",
  azithro: "azithromycin",
  amox: "amoxicillin",
  pantop: "pantoprazole",
  cetrizine: "cetirizine",
  cetirizin: "cetirizine",
  atorva: "atorvastatin",
  telma: "telmisartan",
  montair: "montelukast",
  emeset: "ondansetron",
  brufen: "ibuprofen",
  asthalin: "salbutamol",
  metform: "metformin",
};

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s/+.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveAlias(query) {
  const normalized = normalizeSearchText(query);
  if (MEDICINE_ALIASES[normalized]) return MEDICINE_ALIASES[normalized];
  for (const [alias, canonical] of Object.entries(MEDICINE_ALIASES)) {
    if (normalized.includes(alias)) return canonical;
  }
  return normalized;
}

function similarityScore(a, b) {
  const left = normalizeSearchText(a);
  const right = normalizeSearchText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.92;
  return 0;
}

function isSameCalendarDay(dateLike, now = new Date()) {
  if (!dateLike) return false;
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function medicineLabel(m) {
  if (!m) return "";
  if (typeof m === "string") return m;
  return (
    m.name ||
    m.description ||
    m.generic_name ||
    m.medicineName ||
    m.correctedName ||
    ""
  );
}

function summarizeVisit(rx) {
  if (!rx) return null;
  const meds = Array.isArray(rx.medicineData) ? rx.medicineData : [];
  const activeMeds = meds.filter((m) => m?.isActive !== false);
  const tests = Array.isArray(rx.diagnosticData) ? rx.diagnosticData : [];
  return {
    prescriptionId: rx.prescriptionId,
    date: rx.date || rx.createdAt,
    consultantDoctor: rx.consultantDoctor || "",
    doctorId: rx.doctorId || "",
    medicineCount: activeMeds.length,
    medicines: activeMeds.slice(0, 12).map((m) => medicineLabel(m)).filter(Boolean),
    labCount: tests.length,
    labs: tests
      .slice(0, 8)
      .map((t) => t?.name || t?.description || t?.test_name)
      .filter(Boolean),
    provisionalDiagnosis: rx.provisionalDiagnosis || "",
    symptoms: rx.symptoms || "",
    isToday: isSameCalendarDay(rx.date || rx.createdAt),
    openPath: rx.UMRNo
      ? `/consultation/${rx.UMRNo}/prescription/${rx.prescriptionId}`
      : undefined,
  };
}

function sortVisitsNewestFirst(prescriptions = []) {
  return [...(prescriptions || [])].sort(
    (a, b) =>
      new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0),
  );
}

/**
 * Find a visit the doctor should reuse instead of creating another.
 * Prefer same-consultant same-day; then same-day any consultant; then explicit id.
 */
function findReusableVisit(prescriptions, { doctorId, consultantDoctor, prescriptionId } = {}) {
  const list = sortVisitsNewestFirst(prescriptions);
  if (!list.length) return null;

  if (prescriptionId) {
    const exact = list.find(
      (rx) => String(rx.prescriptionId) === String(prescriptionId),
    );
    if (exact) return exact;
  }

  const sameDoctorToday = list.find((rx) => {
    if (!isSameCalendarDay(rx.date || rx.createdAt)) return false;
    if (doctorId && String(rx.doctorId) === String(doctorId)) return true;
    if (
      consultantDoctor &&
      normalizeSearchText(rx.consultantDoctor) ===
        normalizeSearchText(consultantDoctor)
    ) {
      return true;
    }
    return false;
  });
  if (sameDoctorToday) return sameDoctorToday;

  return list.find((rx) => isSameCalendarDay(rx.date || rx.createdAt)) || null;
}

function findTargetVisit(
  prescriptions,
  { prescriptionId, doctorId, consultantDoctor, pagePrescriptionId } = {},
) {
  const list = sortVisitsNewestFirst(prescriptions);
  if (!list.length) return { visit: null, reason: "none" };

  const wantedId = prescriptionId || pagePrescriptionId;
  if (wantedId) {
    const exact = list.find(
      (rx) => String(rx.prescriptionId) === String(wantedId),
    );
    if (exact) return { visit: exact, reason: "explicit" };
    return { visit: null, reason: "not_found", wantedId };
  }

  const reusable = findReusableVisit(list, { doctorId, consultantDoctor });
  if (reusable) return { visit: reusable, reason: "today" };

  const sameDoctor = list.find((rx) => {
    if (doctorId && String(rx.doctorId) === String(doctorId)) return true;
    if (
      consultantDoctor &&
      normalizeSearchText(rx.consultantDoctor) ===
        normalizeSearchText(consultantDoctor)
    ) {
      return true;
    }
    return false;
  });
  if (sameDoctor) return { visit: sameDoctor, reason: "latest_same_doctor" };

  return { visit: list[0], reason: "latest_any" };
}

function parseFrequency(freq) {
  const freqLower = String(freq || "BD").toLowerCase();
  if (
    freqLower.includes("bd") ||
    freqLower.includes("twice") ||
    freqLower.includes("2 times") ||
    freqLower.includes("2x")
  ) {
    return { value: 2, unit: "/Day" };
  }
  if (
    freqLower.includes("tds") ||
    freqLower.includes("three times") ||
    freqLower.includes("3 times") ||
    freqLower.includes("3x")
  ) {
    return { value: 3, unit: "/Day" };
  }
  if (
    freqLower.includes("qid") ||
    freqLower.includes("four times") ||
    freqLower.includes("4 times") ||
    freqLower.includes("4x")
  ) {
    return { value: 4, unit: "/Day" };
  }
  if (freqLower.includes("hs") || freqLower.includes("at night")) {
    return { value: 1, unit: "/Day" };
  }
  if (
    freqLower.includes("od") ||
    freqLower.includes("once") ||
    freqLower.includes("daily")
  ) {
    return { value: 1, unit: "/Day" };
  }
  if (freqLower.includes("sos")) {
    return { value: 1, unit: "/Day" };
  }
  return { value: 2, unit: "/Day" };
}

function parseDuration(duration) {
  const durationLower = String(duration || "5 days").toLowerCase();
  if (/^(?:once|stat)\b/.test(durationLower)) {
    return { value: 1, unit: "Days" };
  }
  const hoursMatch = durationLower.match(
    /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|hr)\b/,
  );
  if (hoursMatch) {
    // Quantity helper uses days — treat short infusions as 1 day bag
    return { value: 1, unit: "Days" };
  }
  const daysMatch = durationLower.match(/(\d+)\s*days?/);
  if (daysMatch) {
    return { value: parseInt(daysMatch[1], 10), unit: "Days" };
  }
  const weeksMatch = durationLower.match(/(\d+)\s*weeks?/);
  if (weeksMatch) {
    return { value: parseInt(weeksMatch[1], 10) * 7, unit: "Days" };
  }
  return { value: 5, unit: "Days" };
}

function getMedicineIdentity(med) {
  const code = String(med?.item_code || "").trim();
  if (code && !code.startsWith("manual_")) {
    return { type: "code", value: code.toLowerCase() };
  }
  const generic = resolveAlias(med?.generic_name || "");
  if (generic) return { type: "generic", value: generic };
  const name = resolveAlias(med?.name || med?.description || "");
  return { type: "name", value: name };
}

function isSameMedicine(a, b) {
  if (!a || !b) return false;
  const idA = getMedicineIdentity(a);
  const idB = getMedicineIdentity(b);
  if (idA.type === "code" && idB.type === "code" && idA.value === idB.value) {
    return true;
  }
  const keysA = [
    idA.value,
    resolveAlias(a.generic_name),
    resolveAlias(a.name),
    resolveAlias(a.description),
  ].filter(Boolean);
  const keysB = [
    idB.value,
    resolveAlias(b.generic_name),
    resolveAlias(b.name),
    resolveAlias(b.description),
  ].filter(Boolean);
  for (const keyA of keysA) {
    for (const keyB of keysB) {
      if (!keyA || !keyB) continue;
      if (keyA === keyB) return true;
      if (keyA.includes(keyB) || keyB.includes(keyA)) return true;
      if (similarityScore(keyA, keyB) >= 0.88) return true;
    }
  }
  return false;
}

function isSameMedicineStep(a, b) {
  if (!a || !b) return false;
  if (a.lineId && b.lineId && a.lineId === b.lineId) return true;
  if (!isSameMedicine(a, b)) return false;

  const isSeq = (med) =>
    Boolean(
      med?.sequenceGroup ||
        Number(med?.sequenceIndex) > 1 ||
        String(med?.sequenceLabel || "").trim().toLowerCase() === "then" ||
        String(med?.scheduleKind || "").trim().toLowerCase() === "sequential",
    );

  const aSeq = isSeq(a);
  const bSeq = isSeq(b);

  if (!aSeq && !bSeq) return true;

  if (aSeq && bSeq) {
    const aIdx = Number(
      a.sequenceIndex ||
        (String(a.sequenceLabel || "").trim().toLowerCase() === "then" ? 2 : 1),
    );
    const bIdx = Number(
      b.sequenceIndex ||
        (String(b.sequenceLabel || "").trim().toLowerCase() === "then" ? 2 : 1),
    );
    return aIdx === bIdx;
  }

  const seqIdx = aSeq
    ? Number(
        a.sequenceIndex ||
          (String(a.sequenceLabel || "").trim().toLowerCase() === "then" ? 2 : 1),
      )
    : Number(
        b.sequenceIndex ||
          (String(b.sequenceLabel || "").trim().toLowerCase() === "then" ? 2 : 1),
      );

  return seqIdx <= 1;
}

function dedupeMedicineList(medicines = []) {
  const result = [];
  for (const med of medicines || []) {
    const idx = result.findIndex(
      (item) => isSameMedicineStep(item, med) && isSameMedicine(item, med),
    );
    if (idx >= 0) {
      result[idx] = {
        ...result[idx],
        ...med,
        item_code:
          result[idx].item_code?.startsWith("manual_") &&
          med.item_code &&
          !String(med.item_code).startsWith("manual_")
            ? med.item_code
            : result[idx].item_code || med.item_code,
        pharmacyBilled: result[idx].pharmacyBilled ?? med.pharmacyBilled,
        indentSent: result[idx].indentSent ?? med.indentSent,
        isActive: med.isActive !== false,
      };
    } else {
      result.push(med);
    }
  }
  return result;
}

function dedupeTestList(tests = []) {
  const result = [];
  for (const test of tests || []) {
    const name = normalizeSearchText(
      test?.name || test?.description || test?.test_name,
    );
    if (!name) continue;
    const idx = result.findIndex(
      (t) =>
        normalizeSearchText(t.name || t.description || t.test_name) === name,
    );
    if (idx >= 0) {
      result[idx] = { ...result[idx], ...test };
    } else {
      result.push(test);
    }
  }
  return result;
}

function findBestPharmacyMatch(query, pharmacyData = [], minScore = 0.55) {
  if (!query || !pharmacyData.length) return null;
  const aliasResolved = resolveAlias(query);
  let best = null;
  let bestScore = 0;
  for (const item of pharmacyData) {
    for (const field of [
      item.description,
      item.generic_name,
      item.name,
    ]) {
      if (!field) continue;
      const score = Math.max(
        similarityScore(query, field),
        similarityScore(aliasResolved, field),
      );
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
  }
  return bestScore >= minScore ? best : null;
}

function findBestLabMatch(query, labData = [], minScore = 0.55) {
  if (!query || !labData.length) return null;
  const q = normalizeSearchText(query);
  let best = null;
  let bestScore = 0;
  for (const item of labData) {
    for (const field of [
      item.name,
      item.description,
      item.test_name,
      item.code,
    ]) {
      if (!field) continue;
      const score = similarityScore(q, field);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
  }
  return bestScore >= minScore ? best : null;
}

function normalizeIncomingMedicine(raw = {}) {
  const name = String(
    raw.name || raw.medicine || raw.correctedName || "",
  ).trim();
  if (!name) return null;
  const action = String(raw.action || "add")
    .trim()
    .toLowerCase();
  return {
    name,
    correctedName: String(raw.correctedName || raw.corrected_name || name).trim(),
    inventoryMatch: String(
      raw.inventoryMatch || raw.inventory_match || name,
    ).trim(),
    dosage: String(raw.dosage || raw.dose || "").trim(),
    frequency: String(raw.frequency || raw.freq || "BD").trim(),
    duration: String(raw.duration || "5 days").trim(),
    instructions: String(raw.instructions || raw.instruction || "").trim(),
    action: ["add", "continue", "note_only", "stop"].includes(action)
      ? action
      : "add",
  };
}

function normalizeIncomingLab(raw) {
  if (typeof raw === "string") {
    const name = raw.trim();
    return name ? { name, action: "add" } : null;
  }
  const name = String(raw?.name || raw?.test || "").trim();
  if (!name) return null;
  const action = String(raw.action || "add")
    .trim()
    .toLowerCase();
  return {
    name,
    action: ["add", "continue", "note_only"].includes(action) ? action : "add",
  };
}

function buildOpMedicine(med, pharmacyData, actorName) {
  const searchName = med.inventoryMatch || med.correctedName || med.name;
  const matched = findBestPharmacyMatch(searchName, pharmacyData);
  const frequency = parseFrequency(med.frequency || "BD");
  const duration = parseDuration(med.duration || "5 days");
  const quantity = frequency.value * duration.value;
  const displayName = matched?.description || searchName;
  const instructionParts = [med.instructions || ""];
  if (med.dosage) instructionParts.unshift(med.dosage);

  return {
    name: displayName,
    type: matched?.type || "Tablets",
    instructions: instructionParts.filter(Boolean).join(" · "),
    duration,
    frequency,
    quantity: String(quantity),
    dosages: (() => {
      const slotTimes =
        frequency.value === 2
          ? ["Morning", "Evening"]
          : frequency.value === 3
            ? ["Morning", "Afternoon", "Evening"]
            : frequency.value === 4
              ? ["Morning", "Afternoon", "Evening", "Night"]
              : ["Morning"];
      return Array.from({ length: frequency.value }, (_, index) => ({
        id: index,
        time: slotTimes[index] || "Morning",
        beforeFood: false,
      }));
    })(),
    description: matched?.description || displayName,
    generic_name: matched?.generic_name || med.correctedName || med.name,
    item_code:
      matched?.item_code || `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    pharmacyBilled: false,
    indentSent: false,
    isActive: true,
    prescribedBy: actorName || "",
    time: new Date().toISOString(),
    history: [
      {
        action: "Added",
        user: actorName || "Healeka AI",
        timestamp: new Date().toISOString(),
        details: "Added via Healeka AI",
      },
    ],
  };
}

function buildOpTest(test, labData) {
  const matched = findBestLabMatch(test.name, labData);
  if (matched) {
    return {
      ...matched,
      name: matched.name || matched.description || test.name,
      labBilled: false,
      indentSent: false,
    };
  }
  return {
    name: test.name,
    description: test.name,
    test_name: test.name,
    labBilled: false,
    indentSent: false,
  };
}

function processMedicinesForRx(rawList = [], pharmacyData, actorName) {
  const addList = [];
  const stopList = [];
  for (const raw of rawList || []) {
    const med = normalizeIncomingMedicine(raw);
    if (!med) continue;
    if (med.action === "stop") {
      stopList.push(med);
      continue;
    }
    if (med.action === "continue" || med.action === "note_only") continue;
    addList.push(buildOpMedicine(med, pharmacyData, actorName));
  }
  return {
    toAdd: dedupeMedicineList(addList),
    toStop: stopList,
  };
}

function processLabsForRx(rawList = [], labData) {
  const out = [];
  for (const raw of rawList || []) {
    const test = normalizeIncomingLab(raw);
    if (!test || test.action !== "add") continue;
    out.push(buildOpTest(test, labData));
  }
  return dedupeTestList(out);
}

function applyStopMedicines(existing = [], stopList = [], actorName) {
  if (!stopList?.length) return existing || [];
  const now = new Date().toISOString();
  return (existing || []).map((med) => {
    const shouldStop =
      med.isActive !== false &&
      stopList.some((stopMed) =>
        isSameMedicine(med, {
          name: stopMed.inventoryMatch || stopMed.correctedName || stopMed.name,
          generic_name: stopMed.correctedName || stopMed.name,
        }),
      );
    if (!shouldStop) return med;
    return {
      ...med,
      isActive: false,
      history: [
        ...(med.history || []),
        {
          action: "Stopped",
          user: actorName || "Healeka AI",
          timestamp: now,
          details: "Stopped via Healeka AI",
          changes: { isActive: false },
        },
      ],
    };
  });
}

function mergeMedicines(existing, incoming, applyMode = "add") {
  const current = existing || [];
  if (applyMode === "replace") {
    return dedupeMedicineList(incoming.length ? incoming : current);
  }
  return dedupeMedicineList([...current, ...incoming]);
}

function mergeTests(existing, incoming, applyMode = "add") {
  const current = existing || [];
  if (applyMode === "replace") {
    return dedupeTestList(incoming.length ? incoming : current);
  }
  return dedupeTestList([...current, ...incoming]);
}

function mergeNoteText(existing, incoming, applyMode = "add") {
  if (!incoming?.trim()) return existing || "";
  if (applyMode === "replace") return incoming.trim();
  if (!existing?.trim()) return incoming.trim();
  return `${existing.trim()}\n${incoming.trim()}`;
}

function formatMedicinePreview(meds = []) {
  return (meds || [])
    .slice(0, 10)
    .map((m) => {
      const freq = m.frequency
        ? `${m.frequency.value || ""}${m.frequency.unit || ""}`
        : "";
      const dur = m.duration
        ? `${m.duration.value || ""} ${m.duration.unit || ""}`.trim()
        : "";
      return [m.name, freq, dur].filter(Boolean).join(" · ");
    });
}

function hasText(value) {
  return String(value || "").trim() !== "";
}

function getLatestVitals(vitals = []) {
  if (!Array.isArray(vitals) || !vitals.length) return null;
  return [...vitals].sort(
    (a, b) => new Date(b.time || b.date || 0) - new Date(a.time || a.date || 0),
  )[0];
}

/**
 * Build a compose draft the doctor finishes in the chat input (not auto-sent).
 * Must name the field clearly so the agent maps it to the right Rx update.
 */
function buildGapComposeDraft(gap, { UMRNo, prescriptionId, patientName } = {}) {
  const who = [
    UMRNo && `UMR ${UMRNo}`,
    patientName && `(${patientName})`,
    prescriptionId && `visit ${prescriptionId}`,
  ]
    .filter(Boolean)
    .join(" ");
  const prefix = who
    ? `Update prescription for ${who}: `
    : "Update this visit prescription: ";

  switch (gap.key) {
    case "weight":
      return `${prefix}set weight to `;
    case "height":
      return `${prefix}set height to `;
    case "vitals":
      return `${prefix}record vitals — BP `;
    case "vitals_partial":
      return `${prefix}complete vitals (${gap.missingKeys?.join(", ") || "remaining"}) — `;
    case "medicines":
      return `${prefix}add medicines `;
    case "provisionalDiagnosis":
      return `${prefix}set provisionalDiagnosis to `;
    case "doctorNote":
      return `${prefix}add doctor note `;
    default:
      return `${prefix}${gap.label || gap.key} `;
  }
}

/**
 * After create/update, list what's still missing so Healeka can nudge the doctor.
 * Returns prioritized gaps with chip labels (compose drafts built by caller).
 */
function analyzePrescriptionGaps(rx = {}) {
  const gaps = [];
  const latestVitals = getLatestVitals(rx.vitals);
  const meds = (rx.medicineData || []).filter((m) => m?.isActive !== false);
  const notes = rx.doctorNotes || [];
  const hasDoctorNote = notes.some((n) => hasText(n?.content || n?.note));

  if (!hasText(rx.weight)) {
    gaps.push({
      key: "weight",
      label: "Weight",
      priority: 1,
      chip: "Add weight",
      compose: true,
    });
  }
  if (!hasText(rx.height)) {
    gaps.push({
      key: "height",
      label: "Height",
      priority: 1,
      chip: "Add height",
      compose: true,
    });
  }

  const vitalChecks = [
    { key: "bloodPressure", label: "Blood pressure", short: "BP" },
    { key: "heartRate", label: "Heart rate / pulse", short: "pulse" },
    { key: "temperature", label: "Temperature", short: "temp" },
    { key: "spo2", label: "SpO2", short: "SpO2" },
    { key: "respiratoryRate", label: "Respiratory rate", short: "RR" },
  ];
  const missingVitalParts = vitalChecks.filter(
    (v) => !hasText(latestVitals?.[v.key]),
  );
  if (!latestVitals || missingVitalParts.length === vitalChecks.length) {
    gaps.push({
      key: "vitals",
      label: "Vitals (BP, pulse, temp, SpO2)",
      priority: 1,
      chip: "Record vitals",
      compose: true,
    });
  } else if (missingVitalParts.length > 0) {
    const labels = missingVitalParts.map((v) => v.short).join(", ");
    gaps.push({
      key: "vitals_partial",
      label: `Complete vitals (${labels})`,
      priority: 2,
      chip: `Add ${labels}`,
      missingKeys: missingVitalParts.map((v) => v.key),
      compose: true,
    });
  }

  if (!meds.length) {
    gaps.push({
      key: "medicines",
      label: "Medicines",
      priority: 1,
      chip: "Add medicines",
      compose: true,
    });
  }

  if (!hasText(rx.provisionalDiagnosis)) {
    gaps.push({
      key: "provisionalDiagnosis",
      label: "Provisional diagnosis",
      priority: 3,
      chip: "Add diagnosis",
      compose: true,
    });
  }

  if (!hasDoctorNote) {
    gaps.push({
      key: "doctorNote",
      label: "Doctor note",
      priority: 3,
      chip: "Add note",
      compose: true,
    });
  }

  gaps.sort((a, b) => a.priority - b.priority);
  return gaps;
}

function formatCompletionNudge(gaps, { maxItems = 5 } = {}) {
  if (!gaps?.length) {
    return {
      text: "",
      stillMissing: [],
      complete: true,
    };
  }
  const top = gaps.slice(0, maxItems);
  const lines = top.map((g) => `- ${g.label}`);
  const text = `\n\n**Still to complete on this visit:**\n${lines.join("\n")}\n\nTell me the values (e.g. "weight 68 kg, height 165 cm, BP 120/80, pulse 78") and I'll update the Rx.`;
  return {
    text,
    stillMissing: top,
    complete: false,
  };
}

function buildVitalsEntry(vitalsInput = {}, actorName) {
  if (!vitalsInput || typeof vitalsInput !== "object") return null;
  const entry = {
    temperature: String(vitalsInput.temperature || "").trim(),
    spo2: String(vitalsInput.spo2 || vitalsInput.SpO2 || "").trim(),
    heartRate: String(
      vitalsInput.heartRate || vitalsInput.pulse || "",
    ).trim(),
    respiratoryRate: String(
      vitalsInput.respiratoryRate || vitalsInput.rr || "",
    ).trim(),
    bloodPressure: String(
      vitalsInput.bloodPressure || vitalsInput.bp || "",
    ).trim(),
    weight: String(vitalsInput.weight || "").trim(),
    height: String(vitalsInput.height || "").trim(),
    time: new Date().toISOString(),
    modifiedBy: [
      {
        user: actorName || "Healeka AI",
        type: "Healeka AI",
        modifiedTime: new Date().toISOString(),
      },
    ],
  };
  const hasAny = [
    entry.temperature,
    entry.spo2,
    entry.heartRate,
    entry.respiratoryRate,
    entry.bloodPressure,
    entry.weight,
    entry.height,
  ].some(Boolean);
  return hasAny ? entry : null;
}

module.exports = {
  isSameCalendarDay,
  summarizeVisit,
  sortVisitsNewestFirst,
  findReusableVisit,
  findTargetVisit,
  parseFrequency,
  parseDuration,
  isSameMedicine,
  dedupeMedicineList,
  dedupeTestList,
  processMedicinesForRx,
  processLabsForRx,
  applyStopMedicines,
  mergeMedicines,
  mergeTests,
  mergeNoteText,
  formatMedicinePreview,
  normalizeIncomingMedicine,
  medicineLabel,
  analyzePrescriptionGaps,
  buildGapComposeDraft,
  formatCompletionNudge,
  buildVitalsEntry,
  getLatestVitals,
  hasText,
};
