const { getPlanConfig, DEFAULT_PLAN } = require("../config/planEntitlements");

const SUBSCRIPTION_STATUS = {
  ACTIVE: "active",
  TRIALING: "trialing",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  EXPIRED: "expired",
};

const BLOCKED_STATUSES = new Set([SUBSCRIPTION_STATUS.EXPIRED, SUBSCRIPTION_STATUS.CANCELED]);

/**
 * @param {import("mongoose").Document|object|null} hospital
 * @returns {boolean}
 */
function isSubscriptionAccessAllowed(hospital) {
  if (!hospital) return false;
  if (hospital.active === false) return false;

  const status = hospital.subscriptionStatus || SUBSCRIPTION_STATUS.ACTIVE;
  if (BLOCKED_STATUSES.has(status)) {
    return false;
  }
  if (hospital.subscriptionExpiry) {
    const end = new Date(hospital.subscriptionExpiry);
    if (!Number.isNaN(end.getTime()) && end.getTime() < Date.now() && status !== SUBSCRIPTION_STATUS.TRIALING) {
      return false;
    }
  }
  return true;
}

/**
 * Merges plan defaults, module overrides, and applies subscription lock (all false if no access)
 * @param {import("mongoose").Document|object|null} hospital
 * @returns {{
 *  modules: Record<string, boolean>,
 *  limits: Record<string, number>,
 *  subscription: {
 *    plan: string,
 *    status: string,
 *    expiry: string | null,
 *  },
 *  isAccessAllowed: boolean,
 * }}
 */
function buildEntitlements(hospital) {
  const isAccessAllowed = isSubscriptionAccessAllowed(hospital);
  const plan = (hospital && hospital.subscriptionPlan) || DEFAULT_PLAN;
  const { modules: planMods, limits } = getPlanConfig(plan);

  const merged = { ...planMods };
  const overrides = hospital && hospital.moduleOverrides;
  if (overrides && typeof overrides === "object") {
    Object.keys(overrides).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(merged, key) && typeof overrides[key] === "boolean") {
        merged[key] = overrides[key];
      }
    });
  }

  if (!isAccessAllowed) {
    Object.keys(merged).forEach((k) => {
      merged[k] = false;
    });
  }

  return {
    modules: merged,
    limits: { ...limits },
    isAccessAllowed,
    subscription: {
      plan: (plan || DEFAULT_PLAN).toLowerCase(),
      status: (hospital && hospital.subscriptionStatus) || SUBSCRIPTION_STATUS.ACTIVE,
      expiry: hospital && hospital.subscriptionExpiry
        ? new Date(hospital.subscriptionExpiry).toISOString()
        : null,
    },
  };
}

/**
 * @param {import("mongoose").Model} HospitalModel
 * @param {string} hospitalId
 * @returns {Promise<object|null>}
 */
async function getEntitlementsByHospitalId(HospitalModel, hospitalId) {
  if (!hospitalId) return null;
  const hospital = await HospitalModel.findById(hospitalId).lean();
  if (!hospital) return null;
  return buildEntitlements(hospital);
}

/**
 * @param {import("mongoose").Document|object} hospital
 * @returns {object}
 */
function toClientPayloadFromHospital(hospital) {
  return buildEntitlements(hospital);
}

module.exports = {
  buildEntitlements,
  getEntitlementsByHospitalId,
  toClientPayloadFromHospital,
  isSubscriptionAccessAllowed,
  SUBSCRIPTION_STATUS,
  BLOCKED_STATUSES,
};
