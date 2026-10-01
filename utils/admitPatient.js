const mongoose = require("mongoose");
const {
  pickPerson,
  assignPersonEdits,
  presentPatient,
  normalizeName,
} = require("./patientFields");

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function itemKey(item) {
  if (typeof item === "string") return item.trim().toLowerCase();
  return String(
    item?.name || item?.medicineName || item?.test_name || item?.description || "",
  )
    .trim()
    .toLowerCase();
}

/** First ERA list, plus any casualty-only rows that are not already in it. */
function eraReferenceList(eraList, casualtyList) {
  const first = asList(eraList);
  const prior = asList(casualtyList);
  if (!first.length) return prior;
  const seen = new Set(first.map(itemKey).filter(Boolean));
  const merged = [...first];
  for (const item of prior) {
    const key = itemKey(item);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(item);
  }
  return merged;
}

function generateIpNumber() {
  const year = new Date().getFullYear();
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `IP-${year}-${rand}`;
}

async function nextIpNumber(IPAdmission, hospitalId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ipNumber = generateIpNumber();
    const exists = await IPAdmission.exists({ hospitalId, ipNumber });
    if (!exists) return ipNumber;
  }
  return `IP-${Date.now()}`;
}

function eraVitalFromBody(body) {
  const list = Array.isArray(body?.vitals) ? body.vitals : [];
  const entry = list.find((row) => row?.source === "era") || list[0];
  if (!entry || typeof entry !== "object") return null;
  const hasReading = [
    "temperature",
    "spo2",
    "heartRate",
    "respiratoryRate",
    "bloodPressure",
    "grbs",
    "urineOutput",
    "outputUrine",
  ].some((key) => String(entry[key] || "").trim());
  if (!hasReading) return null;
  return { ...entry, source: "era" };
}

function mergeEraVital(existing, entry) {
  if (!entry) return Array.isArray(existing) ? existing : [];
  const list = Array.isArray(existing) ? [...existing] : [];
  const index = list.findIndex((row) => row?.source === "era");
  if (index >= 0) list[index] = { ...list[index], ...entry, source: "era" };
  else list.unshift(entry);
  return list;
}

function stayPayload(body, patient, hospitalId, ipNumber) {
  const admissionDate =
    body.admissionDate || new Date().toISOString().split("T")[0];
  const admissionTime =
    body.admissionTime || new Date().toTimeString().slice(0, 5);
  const status = body.patient_status || "Admitted";
  const wardId = body.wardId || "";
  const wardName = body.wardName || "";
  const transfers = Array.isArray(body.transfers)
    ? body.transfers
    : wardId || wardName
      ? [
          {
            wardId,
            wardName,
            price: Number(body.bedPrice || 0),
            transferDate: admissionDate,
          },
        ]
      : [];

  const doc = {
    ipNumber,
    hospitalId,
    patientId: patient._id,
    UMRNo: patient.UMRNo,
    patientName: patient.name,
    admissionDate,
    admissionTime,
    mlcNo: body.mlcNo || "",
    patient_status: status,
    consultantDoctor: String(body.consultantDoctor || "").trim(),
    doctorId: String(body.doctorId || "").trim(),
    medicalOfficerName: body.medicalOfficerName || "",
    medicalOfficerId: body.medicalOfficerId || "",
    patientRepresentiveOfficer: body.patientRepresentiveOfficer || "",
    consultantHistory: Array.isArray(body.consultantHistory)
      ? body.consultantHistory
      : [],
    wardName,
    wardId,
    selectedBed: body.selectedBed || "",
    transfers,
    chiefComplaintsPresentIllnessHistory:
      body.chiefComplaintsPresentIllnessHistory || "",
    consciousness: body.consciousness || "",
    gcs: body.gcs || "",
    pupils: body.pupils || "",
    height: body.height || "",
    weight: body.weight || "",
    systemicExamination: body.systemicExamination || "",
    provisionalDiagnosis: body.provisionalDiagnosis || "",
    vitals: Array.isArray(body.vitals) ? body.vitals : [],
    eraVitalEntry: eraVitalFromBody(body),
    doctorNotes: Array.isArray(body.doctorNotes) ? body.doctorNotes : [],
    nurseNotes: Array.isArray(body.nurseNotes) ? body.nurseNotes : [],
    insulinChart: Array.isArray(body.insulinChart) ? body.insulinChart : [],
    investigations: Array.isArray(body.investigations) ? body.investigations : [],
    procedures: Array.isArray(body.procedures) ? body.procedures : [],
    treatment: Array.isArray(body.treatment) ? body.treatment : [],
    casualtyTreatment: eraReferenceList(body.treatment, body.casualtyTreatment),
    casualtyInvestigations: Array.isArray(body.investigations)
      ? body.investigations
      : [],
    paymentMethod: body.paymentMethod || patient.paymentMethod || "Personal",
    insurance_provider: body.insurance_provider || patient.insurance_provider || "",
    insurance_providerId:
      body.insurance_providerId || patient.insurance_providerId || "",
    policy_number: body.policy_number || patient.policy_number || "",
    coPayPercentage: body.coPayPercentage ?? patient.coPayPercentage ?? 0,
    coPayLimit: body.coPayLimit ?? patient.coPayLimit ?? 0,
    coPayType: body.coPayType || patient.coPayType || "percentage",
    coverage: body.coverage || patient.coverage || "",
    expiry_date: body.expiry_date || patient.expiry_date || "",
    claimNumber: body.claimNumber || "",
    preAuthAmount: body.preAuthAmount || 0,
    commissionEarnerType: body.commissionEarnerType,
    commissionEarnerId: body.commissionEarnerId,
    commissionEarnerName: body.commissionEarnerName,
    commissionRates: body.commissionRates,
  };

  if (status === "Refused Admission") {
    doc.dischargeTo = body.dischargeTo || "";
  }
  return doc;
}

async function findPatient(Patient, hospitalId, body) {
  const patientId = body.patientId;
  if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
    const byId = await Patient.findOne({ _id: patientId, hospitalId });
    if (byId) return byId;
  }
  const umr = String(body.UMRNo || body.sourceUmr || "").trim();
  if (umr) {
    return Patient.findOne({ UMRNo: umr, hospitalId });
  }
  return null;
}

async function findNamePhoneMatches(Patient, hospitalId, body) {
  const phone = String(body.phone || "").replace(/\D/g, "");
  const name = normalizeName(body.name);
  if (!phone || !name) return [];
  const rows = await Patient.find({ hospitalId, phone }).limit(25);
  return rows.filter((row) => normalizeName(row.name) === name);
}

/**
 * Admit an existing person, or create the person and the stay together.
 * A second patient is never created for someone already on file.
 * An open stay is returned instead of inserting another admission.
 */
async function admitPatient({ tenantDb, hospitalId, body }) {
  const Patient = tenantDb.model("Patient");
  const IPAdmission = tenantDb.model("IPAdmission");
  const payload = body || {};

  const doctorId = String(payload.doctorId || "").trim();
  const consultantDoctor = String(payload.consultantDoctor || "").trim();
  if (!doctorId || !consultantDoctor) {
    return {
      httpStatus: 400,
      payload: { message: "Consultant doctor is required" },
    };
  }

  let patient = await findPatient(Patient, hospitalId, payload);
  let createdPatient = false;

  if (!patient) {
    const matches = await findNamePhoneMatches(Patient, hospitalId, payload);
    if (matches.length && payload.confirmNew !== true) {
      return {
        httpStatus: 409,
        payload: {
          code: "MATCHING_PATIENT",
          message: "A patient with this name and phone is already on file",
          matches: matches.map((row) => ({
            _id: row._id,
            UMRNo: row.UMRNo,
            name: row.name,
            age: row.age,
            gender: row.gender,
            phone: row.phone,
          })),
        },
      };
    }
    patient = new Patient(
      pickPerson(payload, {
        hospitalId,
        registration_date:
          payload.registration_date || new Date().toISOString(),
      }),
    );
    await patient.save();
    createdPatient = true;
  } else {
    assignPersonEdits(patient, payload);
    patient.hospitalId = patient.hospitalId || hospitalId;
    await patient.save();
  }

  const open = await IPAdmission.findOne({
    hospitalId,
    patientId: patient._id,
    patient_status: "Admitted",
  });

  if (open) {
    if (patient.name && open.patientName !== patient.name) {
      open.patientName = patient.name;
      await open.save();
    }
    return {
      httpStatus: 200,
      payload: {
        message: "Patient already has an open admission",
        existingAdmission: true,
        createdPatient: false,
        admission: open,
        patient: presentPatient(patient, { admission: open }),
      },
    };
  }

  try {
    const ipNumber = await nextIpNumber(IPAdmission, hospitalId);
    const admission = await IPAdmission.create(
      stayPayload(payload, patient, hospitalId, ipNumber),
    );
    const presented = presentPatient(patient, {
      admission:
        admission.patient_status === "Admitted" ? admission : null,
    });
    return {
      httpStatus: 201,
      payload: {
        message: "Patient admitted",
        existingAdmission: false,
        createdPatient,
        admission,
        patient: presented,
        UMRNo: patient.UMRNo,
      },
    };
  } catch (error) {
    if (createdPatient) {
      await Patient.deleteOne({ _id: patient._id, hospitalId });
    }
    throw error;
  }
}

const ERA_UPDATE_KEYS = [
  "mlcNo",
  "consultantDoctor",
  "doctorId",
  "medicalOfficerName",
  "medicalOfficerId",
  "chiefComplaintsPresentIllnessHistory",
  "consciousness",
  "gcs",
  "pupils",
  "height",
  "weight",
  "systemicExamination",
  "provisionalDiagnosis",
  "wardName",
  "wardId",
  "selectedBed",
  "patient_status",
  "dischargeTo",
  "counselling",
  "dischargeOrders",
];

/**
 * Update the ER chart on an existing stay. Person fields go to the patient.
 * The live ward treatment and investigation lists are left in place.
 */
async function updateEraChart({ tenantDb, hospitalId, admissionId, body }) {
  const Patient = tenantDb.model("Patient");
  const IPAdmission = tenantDb.model("IPAdmission");
  const payload = body || {};
  const query = mongoose.Types.ObjectId.isValid(admissionId)
    ? { _id: admissionId, hospitalId }
    : { ipNumber: admissionId, hospitalId };
  const admission = await IPAdmission.findOne(query);
  if (!admission) {
    return { httpStatus: 404, payload: { message: "Admission record not found" } };
  }

  const patient = await Patient.findOne({
    _id: admission.patientId,
    hospitalId,
  });
  if (patient) {
    assignPersonEdits(patient, payload);
    await patient.save();
    if (patient.name) admission.patientName = patient.name;
  }

  for (const key of ERA_UPDATE_KEYS) {
    if (payload[key] !== undefined) admission[key] = payload[key];
  }
  if (Array.isArray(payload.casualtyTreatment)) {
    admission.casualtyTreatment = payload.casualtyTreatment;
    admission.markModified("casualtyTreatment");
  }
  if (Array.isArray(payload.investigations)) {
    admission.casualtyInvestigations = payload.investigations;
    admission.markModified("casualtyInvestigations");
  }

  const eraVitalEntry = eraVitalFromBody(payload);
  if (eraVitalEntry) {
    admission.eraVitalEntry = eraVitalEntry;
    admission.vitals = mergeEraVital(admission.vitals, eraVitalEntry);
    admission.markModified("eraVitalEntry");
    admission.markModified("vitals");
  }

  await admission.save();
  const presented = patient
    ? presentPatient(patient, {
        admission:
          admission.patient_status === "Admitted" ? admission : null,
      })
    : null;
  return {
    httpStatus: 200,
    payload: {
      message: "ER assessment updated",
      admission,
      patient: presented,
    },
  };
}

module.exports = { admitPatient, updateEraChart };
