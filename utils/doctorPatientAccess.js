/**
 * Doctor patient/visit visibility helpers.
 * List: assigned consultant (patient.doctorId) OR a visit under that doctor.
 *
 * Note: JWT `req.user.id` is Staff Mongo `_id`, while patient/visit `doctorId`
 * usually stores Staff's custom string `id`. Always resolve both.
 */

function uniqueIds(values = []) {
  return [
    ...new Set(
      values
        .map((v) => String(v || "").trim())
        .filter(Boolean),
    ),
  ];
}

async function resolveRequestDoctorIds(req) {
  const ids = uniqueIds([req?.user?.id, req?.user?.doctorId, req?.user?.userId]);
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

/** Mongo clause: patients this doctor may see. */
function doctorPatientVisibilityClauseFromIds(doctorIds = []) {
  const ids = uniqueIds(doctorIds);
  if (!ids.length) {
    return { _id: { $exists: false } };
  }
  const or = [];
  for (const id of ids) {
    or.push({ doctorId: id });
    or.push({ "prescriptions.doctorId": id });
  }
  return { $or: or };
}

function patientVisibleToDoctorIds(patient, doctorIds = []) {
  const ids = new Set(uniqueIds(doctorIds));
  if (!ids.size) return false;
  if (ids.has(String(patient?.doctorId || "").trim())) return true;
  const prescriptions = Array.isArray(patient?.prescriptions)
    ? patient.prescriptions
    : [];
  return prescriptions.some((rx) =>
    ids.has(String(rx?.doctorId || "").trim()),
  );
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
