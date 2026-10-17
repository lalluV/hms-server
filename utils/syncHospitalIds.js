/**
 * Cascade hospital identifier changes so linked clinical docs stay consistent.
 * Patient/admission _id never changes — only the display/compliance numbers.
 */

const mongoose = require("mongoose");

function normalizeId(value) {
  return String(value || "").trim();
}

function sameId(a, b) {
  return normalizeId(a) === normalizeId(b);
}

/** Match hospitalId whether stored as ObjectId or string. */
function hospitalFilter(hospitalId) {
  const raw = hospitalId;
  const asString = String(hospitalId || "");
  if (mongoose.Types.ObjectId.isValid(asString)) {
    const asOid = new mongoose.Types.ObjectId(asString);
    return { $or: [{ hospitalId: asOid }, { hospitalId: asString }, { hospitalId: raw }] };
  }
  return { hospitalId: raw };
}

function withHospital(hospitalId, filter) {
  return { $and: [hospitalFilter(hospitalId), filter] };
}

/** Return a tenant model if registered; otherwise null (skip cascade for that collection). */
function getModel(tenantDb, name) {
  try {
    if (tenantDb.models?.[name]) return tenantDb.model(name);
    return null;
  } catch {
    return null;
  }
}

async function updateManySafe(Model, filter, update, options) {
  if (!Model) return { modifiedCount: 0 };
  return options
    ? Model.updateMany(filter, update, options)
    : Model.updateMany(filter, update);
}

/**
 * Ensure UMR is free for this hospital (excluding one patient).
 * @returns {Promise<string|null>} error message or null
 */
async function assertUmrAvailable(
  tenantDb,
  hospitalId,
  umrNo,
  excludePatientId,
) {
  const umr = normalizeId(umrNo);
  if (!umr) return "UMR number is required.";
  const Patient = tenantDb.model("Patient");
  const query = { ...hospitalFilter(hospitalId), UMRNo: umr };
  if (excludePatientId) query._id = { $ne: excludePatientId };
  const clash = await Patient.findOne(query).select("_id UMRNo").lean();
  if (clash) return `UMR ${umr} is already used by another patient.`;
  return null;
}

/**
 * Ensure IP number is free for this hospital (excluding one admission).
 * @returns {Promise<string|null>} error message or null
 */
async function assertIpAvailable(
  tenantDb,
  hospitalId,
  ipNumber,
  excludeAdmissionId,
) {
  const ip = normalizeId(ipNumber);
  if (!ip) return "IP number is required.";
  const IPAdmission = tenantDb.model("IPAdmission");
  const query = { ...hospitalFilter(hospitalId), ipNumber: ip };
  if (excludeAdmissionId) query._id = { $ne: excludeAdmissionId };
  const clash = await IPAdmission.findOne(query).select("_id ipNumber").lean();
  if (clash) return `IP number ${ip} is already used by another admission.`;
  return null;
}

/**
 * Ensure prescription / OP number is free for this hospital.
 * @returns {Promise<string|null>} error message or null
 */
async function assertPrescriptionIdAvailable(
  tenantDb,
  hospitalId,
  prescriptionId,
  excludePrescriptionMongoId,
) {
  const id = normalizeId(prescriptionId);
  if (!id) return "OP number is required.";
  const Prescription = tenantDb.model("Prescription");
  const query = { ...hospitalFilter(hospitalId), prescriptionId: id };
  if (excludePrescriptionMongoId) {
    query._id = { $ne: excludePrescriptionMongoId };
  }
  const clash = await Prescription.findOne(query)
    .select("_id prescriptionId")
    .lean();
  if (clash) return `OP number ${id} is already used by another visit.`;
  return null;
}

/**
 * Rewrite UMR copies on every collection that denormalizes the number.
 * Prefer patientId (_id) for matching; also rewrite string keys that stored old UMR.
 */
async function syncPatientUmr(
  tenantDb,
  hospitalId,
  { patientId, oldUmr, newUmr },
) {
  const next = normalizeId(newUmr);
  const prev = normalizeId(oldUmr);
  if (!patientId || !next) {
    throw new Error("patientId and newUmr are required to sync UMR.");
  }
  if (sameId(prev, next)) {
    return { skipped: true, updated: {} };
  }

  const Prescription = getModel(tenantDb, "Prescription");
  const IPAdmission = getModel(tenantDb, "IPAdmission");
  const DischargeSummary = getModel(tenantDb, "DischargeSummary");
  const Certificate = getModel(tenantDb, "Certificate");
  const DiagnosticsReceipt = getModel(tenantDb, "DiagnosticsReceipt");
  const PharmacyReceipt = getModel(tenantDb, "PharmacyReceipt");
  const AdvanceReceipt = getModel(tenantDb, "AdvanceReceipt");
  const Consent = getModel(tenantDb, "Consent");
  const Action = getModel(tenantDb, "Action");
  const Appointment = getModel(tenantDb, "Appointment");
  const IndentStore = getModel(tenantDb, "IndentStore");
  const Ward = getModel(tenantDb, "Ward");
  const ClinicalCase = getModel(tenantDb, "ClinicalCase");

  const patientOrUmrFilter = withHospital(hospitalId, {
    $or: [{ patientId }, ...(prev ? [{ UMRNo: prev }] : [])],
  });
  const byPatientId = withHospital(hospitalId, { patientId });
  const byOldUmr = prev
    ? withHospital(hospitalId, { UMRNo: prev })
    : null;
  // Collections that store hospital UMR as string patientId
  const byOldUmrAsPatientId = prev
    ? withHospital(hospitalId, { patientId: prev })
    : null;

  const [
    prescriptions,
    admissions,
    dischargesByPatient,
    dischargesByUmr,
    certificatesByPatient,
    certificatesByUmr,
    receipts,
    pharmacy,
    advances,
    consents,
    actions,
    appointments,
    indents,
    clinicalCases,
  ] = await Promise.all([
    updateManySafe(Prescription, patientOrUmrFilter, { $set: { UMRNo: next } }),
    updateManySafe(IPAdmission, patientOrUmrFilter, { $set: { UMRNo: next } }),
    updateManySafe(DischargeSummary, byPatientId, { $set: { UMRNo: next } }),
    byOldUmr
      ? updateManySafe(DischargeSummary, byOldUmr, { $set: { UMRNo: next } })
      : Promise.resolve({ modifiedCount: 0 }),
    updateManySafe(Certificate, byPatientId, { $set: { UMRNo: next } }),
    byOldUmr
      ? updateManySafe(Certificate, byOldUmr, { $set: { UMRNo: next } })
      : Promise.resolve({ modifiedCount: 0 }),
    // Lab/radiology: patientId is UMR string; also clear any denormalized UMRNo.
    prev
      ? updateManySafe(
          DiagnosticsReceipt,
          withHospital(hospitalId, {
            $or: [{ patientId: prev }, { UMRNo: prev }],
          }),
          {
            $set: {
              patientId: next,
              UMRNo: next,
              "patientData.UMRNo": next,
            },
          },
        )
      : Promise.resolve({ modifiedCount: 0 }),
    byOldUmrAsPatientId
      ? updateManySafe(PharmacyReceipt, byOldUmrAsPatientId, {
          $set: { patientId: next },
        })
      : Promise.resolve({ modifiedCount: 0 }),
    byOldUmrAsPatientId
      ? updateManySafe(AdvanceReceipt, byOldUmrAsPatientId, {
          $set: { patientId: next },
        })
      : Promise.resolve({ modifiedCount: 0 }),
    byOldUmrAsPatientId
      ? updateManySafe(Consent, byOldUmrAsPatientId, {
          $set: { patientId: next },
        })
      : Promise.resolve({ modifiedCount: 0 }),
    byOldUmrAsPatientId
      ? updateManySafe(Action, byOldUmrAsPatientId, {
          $set: { patientId: next },
        })
      : Promise.resolve({ modifiedCount: 0 }),
    byOldUmrAsPatientId
      ? updateManySafe(Appointment, byOldUmrAsPatientId, {
          $set: { patientId: next },
        })
      : Promise.resolve({ modifiedCount: 0 }),
    byOldUmrAsPatientId
      ? updateManySafe(IndentStore, byOldUmrAsPatientId, {
          $set: { patientId: next },
        })
      : Promise.resolve({ modifiedCount: 0 }),
    prev
      ? updateManySafe(
          ClinicalCase,
          withHospital(hospitalId, { umr: prev }),
          { $set: { umr: next } },
        )
      : Promise.resolve({ modifiedCount: 0 }),
  ]);

  // Ward beds store UMR on the occupied bed slot.
  let beds = { modifiedCount: 0 };
  if (prev) {
    beds = await updateManySafe(
      Ward,
      withHospital(hospitalId, { "beds.UMRNo": prev }),
      { $set: { "beds.$[slot].UMRNo": next } },
      { arrayFilters: [{ "slot.UMRNo": prev }] },
    );
  }

  return {
    skipped: false,
    updated: {
      prescriptions: prescriptions.modifiedCount || 0,
      admissions: admissions.modifiedCount || 0,
      dischargeSummaries:
        (dischargesByPatient.modifiedCount || 0) +
        (dischargesByUmr.modifiedCount || 0),
      certificates:
        (certificatesByPatient.modifiedCount || 0) +
        (certificatesByUmr.modifiedCount || 0),
      diagnosticsReceipts: receipts.modifiedCount || 0,
      pharmacyReceipts: pharmacy.modifiedCount || 0,
      advanceReceipts: advances.modifiedCount || 0,
      consents: consents.modifiedCount || 0,
      actions: actions.modifiedCount || 0,
      appointments: appointments.modifiedCount || 0,
      indents: indents.modifiedCount || 0,
      clinicalCases: clinicalCases.modifiedCount || 0,
      wardBeds: beds.modifiedCount || 0,
    },
  };
}

/**
 * Rewrite IP number on the admission and linked discharge / lab receipts.
 */
async function syncIpNumber(
  tenantDb,
  hospitalId,
  { admissionId, oldIp, newIp },
) {
  const next = normalizeId(newIp);
  const prev = normalizeId(oldIp);
  if (!admissionId || !next) {
    throw new Error("admissionId and newIp are required to sync IP number.");
  }
  if (sameId(prev, next)) {
    return { skipped: true, updated: {} };
  }

  const IPAdmission = getModel(tenantDb, "IPAdmission");
  const DischargeSummary = getModel(tenantDb, "DischargeSummary");
  if (!IPAdmission) {
    throw new Error("IPAdmission model is not available.");
  }

  const admissionOid = mongoose.Types.ObjectId.isValid(String(admissionId))
    ? new mongoose.Types.ObjectId(String(admissionId))
    : null;

  const admission = await IPAdmission.findOneAndUpdate(
    withHospital(hospitalId, {
      $or: [
        { _id: admissionId },
        ...(admissionOid ? [{ _id: admissionOid }] : []),
      ],
    }),
    { $set: { ipNumber: next } },
    { new: true },
  );
  if (!admission) {
    throw Object.assign(new Error("Admission record not found"), {
      status: 404,
    });
  }

  const admissionIdMatchers = [
    { admissionId: String(admissionId) },
    { admissionId },
    ...(admissionOid ? [{ admissionId: admissionOid }] : []),
  ];

  const dischargeFilter = withHospital(hospitalId, {
    $or: [
      ...admissionIdMatchers,
      ...(prev
        ? [{ ipNumber: prev, UMRNo: admission.UMRNo }]
        : []),
    ],
  });

  const discharges = await updateManySafe(DischargeSummary, dischargeFilter, {
    $set: { ipNumber: next },
  });

  const DiagnosticsReceipt = getModel(tenantDb, "DiagnosticsReceipt");
  const receiptFilter = withHospital(hospitalId, {
    $or: [
      ...admissionIdMatchers,
      ...(prev
        ? [{ ipNumber: prev, patientId: admission.UMRNo }]
        : []),
    ],
  });

  const receipts = await updateManySafe(DiagnosticsReceipt, receiptFilter, {
    $set: { ipNumber: next },
  });

  return {
    skipped: false,
    admission,
    updated: {
      dischargeSummaries: discharges.modifiedCount || 0,
      diagnosticsReceipts: receipts.modifiedCount || 0,
    },
  };
}

module.exports = {
  normalizeId,
  assertUmrAvailable,
  assertIpAvailable,
  assertPrescriptionIdAvailable,
  syncPatientUmr,
  syncIpNumber,
};
