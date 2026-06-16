const Hospital = require("../models/Hospital");
const { buildEntitlements } = require("../services/entitlementsService");

/**
 * After `auth` or `flexibleAuth` — requires `req.hospitalId` from JWT.
 * Attaches `req.entitlements` and `req.hospitalRow` (master DB hospital doc).
 */
async function loadEntitlements(req, res, next) {
  try {
    const hospitalId = req.hospitalId;
    if (!hospitalId) {
      return res.status(400).json({
        message: "Hospital context missing. Ensure you are using a valid tenant session.",
      });
    }

    const hospital = await Hospital.findById(hospitalId);
    if (!hospital) {
      return res.status(404).json({ message: "Hospital not found" });
    }

    req.hospitalRow = hospital;
    req.entitlements = buildEntitlements(hospital);
    next();
  } catch (error) {
    console.error("loadEntitlements error:", error);
    return res.status(500).json({ message: "Error loading subscription entitlements" });
  }
}

function requireActiveSubscription(req, res, next) {
  if (!req.entitlements) {
    return res.status(500).json({ message: "Entitlements not loaded" });
  }
  if (!req.entitlements.isAccessAllowed) {
    return res.status(403).json({
      code: "SUBSCRIPTION_INACTIVE",
      message: "Subscription is inactive or expired. Please contact your administrator.",
      subscription: req.entitlements.subscription,
    });
  }
  return next();
}

/**
 * @param {string} moduleKey — key from planEntitlements modules (e.g. `ipd`, `lab`)
 */
function requireModule(moduleKey) {
  return (req, res, next) => {
    if (!req.entitlements) {
      return res.status(500).json({ message: "Entitlements not loaded" });
    }
    if (!req.entitlements.isAccessAllowed) {
      return res.status(403).json({
        code: "SUBSCRIPTION_INACTIVE",
        message: "Subscription is inactive or expired. Please contact your administrator.",
        subscription: req.entitlements.subscription,
      });
    }
    const { modules } = req.entitlements;
    if (!modules || !modules[moduleKey]) {
      return res.status(403).json({
        code: "MODULE_NOT_IN_PLAN",
        message: `This feature is not included in your subscription plan.`,
        module: moduleKey,
        subscription: req.entitlements.subscription,
      });
    }
    return next();
  };
}

module.exports = {
  loadEntitlements,
  requireActiveSubscription,
  requireModule,
};
