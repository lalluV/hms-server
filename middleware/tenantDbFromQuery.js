const { getTenantConnection } = require("../utils/tenantDb");

/**
 * Tenant Database Middleware for PUBLIC routes (e.g. diagnostics login/registration)
 * Gets hospitalId from query param or request body (no auth required)
 * Used by: diagnostics-users phone routes, send-otp, verify-otp
 */
async function tenantDbFromQuery(req, res, next) {
  try {
    const hospitalId =
      req.query?.hospitalId || req.body?.hospitalId || req.params?.hospitalId;

    if (!hospitalId) {
      return res.status(400).json({
        message:
          "hospitalId is required. Provide it as query param (?hospitalId=...) or in request body.",
      });
    }

    req.hospitalId = hospitalId;

    const tenantConnection = await getTenantConnection(hospitalId);

    if (!tenantConnection) {
      return res.status(500).json({
        message: "Failed to connect to tenant database",
      });
    }

    req.tenantDb = tenantConnection;

    req.getTenantModel = (modelName) => {
      return req.tenantDb.model(modelName);
    };

    next();
  } catch (error) {
    console.error("❌ Tenant DB (from query) middleware error:", error);
    res.status(500).json({
      message: "Error connecting to tenant database",
      error: error.message,
    });
  }
}

module.exports = tenantDbFromQuery;
