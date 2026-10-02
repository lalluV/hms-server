const mongoose = require("mongoose");

/** Stored on Patient. Stay, visit, and discharge fields are not in this list. */
const PERSON_KEYS = [
  "name",
  "gender",
  "age",
  "phone",
  "email",
  "street_address",
  "city",
  "state",
  "postal_code",
  "country",
  "emergency_contact_name",
  "emergency_contact_relationship",
  "emergency_phone",
  "emergency_signature",
  "allergiesHistory",
  "pastMedicalHistory",
  "pastMedications",
  "personalHistory",
  "registered_by",
  "registration_date",
  "publicRegistrationKey",
  "appointment_date",
  "modifiedBy",
];

/** Copied onto an existing patient when ERA edits the person. Insurance defaults stay. */
const PERSON_EDIT_KEYS = [
  "name",
  "gender",
  "age",
  "phone",
  "email",
  "street_address",
  "city",
  "state",
  "postal_code",
  "country",
  "emergency_contact_name",
  "emergency_contact_relationship",
  "emergency_phone",
  "emergency_signature",
  "allergiesHistory",
  "pastMedicalHistory",
  "pastMedications",
  "personalHistory",
];

const LEGACY_PATIENT_KEYS = [
  "patient_type",
  "active",
  "activeAdmissionId",
  "weight",
  "height",
  "admissionDate",
  "admissionTime",
  "wardName",
  "wardId",
  "selectedBed",
  "consultantDoctor",
  "doctorId",
  "patient_status",
  "dischargeDate",
  "dischargeTime",
  "lengthOfStay",
  "dischargeCondition",
  "dischargeDestination",
  "dischargeTo",
  "finalDiagnosis",
  "hospitalCourse",
  "dischargeInstructions",
  "dangerSigns",
  "followUpPlan",
  "counselling",
  "summarySections",
  "dischargeMedications",
  "repeatLabs",
  "procedures",
  "dischargeSummary",
  "dischargeSummaryType",
  "dischargeSummaryTimestamp",
  "dischargeSummaryStatus",
  "dischargeSummaryMeta",
  "dischargedAt",
];

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pick(source, keys) {
  const out = {};
  if (!source || typeof source !== "object") return out;
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function pickPerson(source, extra = {}) {
  return { ...pick(source, PERSON_KEYS), ...extra };
}

function assignPersonEdits(patient, source) {
  if (!patient || !source) return;
  for (const key of PERSON_EDIT_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    if (typeof source[key] === "string" && !String(source[key]).trim()) continue;
    patient[key] = source[key];
  }
  if (Array.isArray(source.modifiedBy) && source.modifiedBy.length) {
    const current = Array.isArray(patient.modifiedBy) ? patient.modifiedBy : [];
    patient.modifiedBy = [...current, ...source.modifiedBy];
  }
}

function toPlain(doc) {
  if (!doc) return null;
  return typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
}

/**
 * API shape for screens. Ward, doctor, and type are read from the open
 * admission. They are not stored on the patient.
 */
function presentPatient(patient, { admission = null, roster = "" } = {}) {
  const obj = toPlain(patient) || {};
  for (const key of LEGACY_PATIENT_KEYS) delete obj[key];

  const open = admission && admission.patient_status === "Admitted" ? admission : null;
  if (roster === "discharged") {
    obj.patient_type = "OP";
    obj.active = false;
    obj.patient_status = "Discharged";
    obj.activeAdmissionId = null;
    return obj;
  }
  if (open) {
    obj.patient_type = "IP";
    obj.active = true;
    obj.activeAdmissionId = open._id;
    obj.patient_status = "Admitted";
    obj.admissionDate = open.admissionDate || "";
    obj.admissionTime = open.admissionTime || "";
    obj.wardName = open.wardName || "";
    obj.wardId = open.wardId || "";
    obj.selectedBed = open.selectedBed || "";
    obj.consultantDoctor = open.consultantDoctor || "";
    obj.doctorId = open.doctorId || "";
    obj.paymentMethod = open.paymentMethod || "Personal";
    obj.insurance_provider = open.insurance_provider || "";
    obj.insurance_providerId = open.insurance_providerId || "";
    obj.policy_number = open.policy_number || "";
    obj.coPayPercentage = open.coPayPercentage ?? 0;
    obj.coPayLimit = open.coPayLimit ?? 0;
    obj.coPayType = open.coPayType || "percentage";
    obj.coverage = open.coverage || "";
    obj.expiry_date = open.expiry_date || "";
    return obj;
  }
  obj.patient_type = "OP";
  obj.active = true;
  obj.patient_status = "";
  obj.activeAdmissionId = null;
  return obj;
}

function objectIds(ids) {
  return [...ids]
    .map((id) => String(id || ""))
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

/**
 * OP = no open stay and not sitting in the discharged list.
 * IP = an admission with status Admitted.
 * Discharged = a discharged stay, no open stay, and no OP prescription on or after that discharge date.
 */
async function loadRosterSets(IPAdmission, Prescription, hospitalId, Patient) {
  const [openRows, dischargedRows] = await Promise.all([
    IPAdmission.find({ hospitalId, patient_status: "Admitted" })
      .select("patientId")
      .lean(),
    IPAdmission.find({ hospitalId, patient_status: "Discharged" })
      .select("patientId dischargeDate dischargedAt")
      .lean(),
  ]);

  const openIds = new Set(
    openRows.map((row) => String(row.patientId || "")).filter(Boolean),
  );

  const staleDischarged = new Set();
  if (Patient && openIds.size) {
    const stale = await Patient.collection
      .find(
        {
          _id: { $in: objectIds(openIds) },
          $or: [{ active: false }, { patient_status: "Discharged" }],
        },
        { projection: { _id: 1 } },
      )
      .toArray();
    for (const row of stale) {
      const id = String(row._id);
      openIds.delete(id);
      staleDischarged.add(id);
    }
  }

  const latestDischarge = new Map();
  for (const row of dischargedRows) {
    const id = String(row.patientId || "");
    if (!id || openIds.has(id)) continue;
    const day = String(row.dischargeDate || row.dischargedAt || "").slice(0, 10);
    const prev = latestDischarge.get(id);
    if (!prev || day > prev) latestDischarge.set(id, day || prev || "");
  }
  for (const id of staleDischarged) {
    if (!openIds.has(id) && !latestDischarge.has(id)) {
      latestDischarge.set(id, "");
    }
  }

  const returned = new Set();
  const dischargedPatientIds = [...latestDischarge.keys()];
  if (dischargedPatientIds.length && Prescription) {
    const rxRows = await Prescription.find({
      hospitalId,
      patientId: { $in: objectIds(dischargedPatientIds) },
    })
      .select("patientId date")
      .lean();
    for (const rx of rxRows) {
      const id = String(rx.patientId || "");
      const cut = latestDischarge.get(id);
      const day = String(rx.date || "").slice(0, 10);
      if (day && (!cut || day >= cut)) returned.add(id);
    }
  }

  const dischargedIds = dischargedPatientIds.filter((id) => !returned.has(id));
  const excludeFromOp = [...openIds, ...dischargedIds];
  return { openIds: [...openIds], dischargedIds, excludeFromOp };
}

/** When there is no open stay, copy billing/discharge fields from the latest IP stay. */
function attachLatestDischargedStay(view, admission) {
  if (!view || !admission) return view;
  view.active = false;
  view.patient_status = "Discharged";
  view.activeAdmissionId = null;
  view.patient_type = view.patient_type || "IP";
  view.admissionDate = admission.admissionDate || view.admissionDate || "";
  view.admissionTime = admission.admissionTime || view.admissionTime || "";
  view.dischargeDate = admission.dischargeDate || view.dischargeDate || "";
  view.dischargeTime = admission.dischargeTime || view.dischargeTime || "";
  view.dischargedAt = admission.dischargedAt || view.dischargedAt || "";
  view.wardName = admission.wardName || view.wardName || "";
  view.wardId = admission.wardId || view.wardId || "";
  view.selectedBed = admission.selectedBed || view.selectedBed || "";
  view.consultantDoctor =
    admission.consultantDoctor || view.consultantDoctor || "";
  view.doctorId = admission.doctorId || view.doctorId || "";
  if (admission.discount !== undefined) view.discount = admission.discount;
  if (admission.insurance !== undefined) view.insurance = admission.insurance;
  if (admission.finalBillAmount !== undefined) {
    view.finalBillAmount = admission.finalBillAmount;
  }
  if (admission.paymentStatus !== undefined) {
    view.paymentStatus = admission.paymentStatus;
  }
  if (Array.isArray(admission.transfers)) {
    view.transfers = admission.transfers;
  }
  return view;
}

async function loadOpenAdmissionMap(IPAdmission, hospitalId, patientIds) {
  const ids = objectIds(patientIds);
  if (!ids.length) return new Map();
  const rows = await IPAdmission.find({
    hospitalId,
    patientId: { $in: ids },
    patient_status: "Admitted",
  }).lean();
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.patientId), row);
  }
  return map;
}

module.exports = {
  PERSON_KEYS,
  LEGACY_PATIENT_KEYS,
  normalizeName,
  pickPerson,
  assignPersonEdits,
  presentPatient,
  attachLatestDischargedStay,
  objectIds,
  loadRosterSets,
  loadOpenAdmissionMap,
};
