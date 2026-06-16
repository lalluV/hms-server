/**
 * Plan → default module entitlements. Per-hospital `moduleOverrides` in Hospital
 * can flip individual modules for support. Unknown plans fall back to `pro`.
 *
 * Product tiers:
 * - basic: OP Clinic (doctor panel for OP only)
 * - pro: IPD Operations (wards/IPD billing, no doctor or nurse IPD panel)
 * - enterprise: Full Clinical (includes doctor IPD record and nurse IPD panel)
 */
const BASE_MODULES = {
  core: true,
  opd: true,
  clinical: true,
  pharmacy: true,
  lab: true,
  expenses: true,
  staff: true,
  vendors: false,
  commission: false,
  indent: true,
  ipd: false,
  ipdNursePanel: false,
  ipdDoctorRecord: false,
  insurance: false,
  hr: true,
  consents: false,
  stamps: true,
};

/** OP clinics: OP registration, appointments, OP billing, doctor OP panel, lab/pharmacy. */
const basicModules = {
  ...BASE_MODULES,
  ipd: false,
  ipdNursePanel: false,
  ipdDoctorRecord: false,
  insurance: false,
};

/** IPD operations without the doctor record or nurse IPD panel products. */
const proModules = {
  ...BASE_MODULES,
  vendors: true,
  ipd: true,
  ipdNursePanel: false,
  ipdDoctorRecord: false,
  insurance: true,
  consents: true,
};

/** Full inpatient clinical record on top of IPD operations. */
const enterpriseModules = {
  ...proModules,
  ipdNursePanel: true,
  ipdDoctorRecord: true,
  commission: true,
};

const planEntitlements = {
  basic: { modules: { ...basicModules }, limits: {} },
  pro: { modules: { ...proModules }, limits: {} },
  enterprise: { modules: { ...enterpriseModules }, limits: {} },
};

const MODULE_KEYS = Object.keys(planEntitlements.basic.modules);

/**
 * @param {string} plan
 * @returns {{ modules: Record<string, boolean>, limits: Record<string, number> }}
 */
function getPlanConfig(plan) {
  const key = (plan || "pro").toLowerCase();
  if (planEntitlements[key]) {
    return {
      modules: { ...planEntitlements[key].modules },
      limits: { ...(planEntitlements[key].limits || {}) },
    };
  }
  // Unknown plan → pro-equivalent (IPD operations without doctor IPD record).
  return {
    modules: { ...planEntitlements.pro.modules },
    limits: { ...planEntitlements.pro.limits },
  };
}

module.exports = {
  planEntitlements,
  getPlanConfig,
  MODULE_KEYS,
  DEFAULT_PLAN: "pro",
};
