/**
 * Doctor patient/visit visibility helpers.
 * List: assigned consultant (patient.doctorId) OR a visit under that doctor.
 *
 * Note: JWT `req.user.id` is Staff Mongo `_id`, while patient/visit `doctorId`
 * usually stores Staff's custom string `id`. Always resolve both.
 *
 * After Prescription decoupling, visit-based visibility uses Prescription
 * collection via findPatientIdsByPrescriptionDoctors (in patients route).
 * patientVisibleToDoctorIds checks assigned consultant only; visit-based
 * visibility is resolved via Prescription collection in the patients list route.
 */

function uniqueIds(values = []) {
  return [
    ...new Set(values.map((v) => String(v || "").trim()).filter(Boolean)),
  ];
}

async function resolveRequestDoctorIds(req) {
  const ids = uniqueIds([
    req?.user?.id,
    req?.user?.doctorId,
    req?.user?.userId,
  ]);
  if (!req?.tenantDb || !req?.user?.id) return ids;

  try {
    const Staff = req.tenantDb.model("Staff");
    const me = await Staff.findById(req.user.id).select("id userId").lean();
    if (me?.id) ids.push(String(me.id));
    if (me?.userId) ids.push(String(me.userId));
  } catch {
    // ignore lookup failures — fall back to JWT ids
  }
  return uniqueIds(ids);
}

/**
 * Mongo clause for Patient fields only (doctorId assignment).
 * prescriptions.doctorId is no longer on Patient — use Prescription lookup.
 */
function doctorPatientVisibilityClauseFromIds(doctorIds = []) {
  const ids = uniqueIds(doctorIds);
  if (!ids.length) {
    return { _id: { $exists: false } };
  }
  return { doctorId: { $in: ids } };
}

function patientVisibleToDoctorIds(patient, doctorIds = []) {
  const ids = new Set(uniqueIds(doctorIds));
  // If doctor identity not resolved from token, allow access by default
  if (!ids.size) return true;

  // 1. Assigned consultant doctor
  if (patient?.doctorId && ids.has(String(patient.doctorId).trim())) return true;

  // 2. Has any prescription / visit under this doctor
  if (Array.isArray(patient?.prescriptions) && patient.prescriptions.length > 0) {
    const hasVisit = patient.prescriptions.some((rx) =>
      rx?.doctorId && ids.has(String(rx.doctorId).trim()),
    );
    if (hasVisit) return true;
  }

  // 3. All Outpatient (OP) or unassigned hospital patients are accessible for consultation/check-in
  if (patient?.patient_type !== "IP" && patient?.patient_type !== "OPtoIP") {
    return true;
  }

  return false;
}

function isDoctorRole(req) {
  return String(req?.user?.type || "") === "Doctor";
}

module.exports = {
  uniqueIds,
  resolveRequestDoctorIds,
  doctorPatientVisibilityClauseFromIds,
  patientVisibleToDoctorIds,
  isDoctorRole,
};
