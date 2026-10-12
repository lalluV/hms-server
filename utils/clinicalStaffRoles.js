const { normalizeRole } = require("../config/rolePermissions");

const STAFF_TYPE_MO = "MO";

function isMedicalOfficerRole(req) {
  return normalizeRole(req?.user?.type) === STAFF_TYPE_MO;
}

function isIpdClinicalPanelRole(req) {
  const role = normalizeRole(req?.user?.type);
  return role === "Nurse" || role === STAFF_TYPE_MO;
}

function isIpdClinicalPanelWithoutEntitlement(req) {
  return (
    isIpdClinicalPanelRole(req) &&
    req.entitlements?.modules?.ipdNursePanel !== true
  );
}

module.exports = {
  STAFF_TYPE_MO,
  isMedicalOfficerRole,
  isIpdClinicalPanelRole,
  isIpdClinicalPanelWithoutEntitlement,
};
