const auth = require("../middleware/auth");
const flexibleAuth = require("../middleware/flexibleAuth");
const tenantDb = require("../middleware/tenantDb");
const { loadEntitlements, requireActiveSubscription, requireModule } = require("../middleware/entitlements");

/**
 * @param {import("express").Router} router
 * @param {object} options
 * @param {string} options.moduleKey
 * @param {"auth"|"flexible"} [options.useAuth="auth"]
 * @param {boolean} [options.includeTenantDb=true]
 */
function applyTenantEntitlements(router, options) {
  const { moduleKey, useAuth = "auth", includeTenantDb = true } = options;
  const authMiddleware = useAuth === "flexible" ? flexibleAuth : auth;
  router.use(authMiddleware);
  router.use(loadEntitlements);
  router.use(requireActiveSubscription);
  router.use(requireModule(moduleKey));
  if (includeTenantDb) {
    router.use(tenantDb);
  }
}

/**
 * For routes like upload (no tenant DB) but need subscription + module check.
 * @param {import("express").Router} router
 * @param {object} options
 * @param {string} options.moduleKey
 * @param {"auth"|"flexible"} [options.useAuth="flexible"]
 */
function applyEntitlementsNoTenantDb(router, options) {
  applyTenantEntitlements(router, { ...options, includeTenantDb: false });
}

module.exports = { applyTenantEntitlements, applyEntitlementsNoTenantDb };
