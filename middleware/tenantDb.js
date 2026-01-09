const { getTenantConnection } = require("../utils/tenantDb");

/**
 * Tenant Database Middleware
 * Attaches tenant database connection to the request object
 * Requires auth middleware to run first to get hospitalId
 */
async function tenantDbMiddleware(req, res, next) {
  try {
    // Get hospitalId from auth middleware (req.hospitalId)
    // For admin users, it might also come from request body or params
    let hospitalId = req.hospitalId;

    // If not set by auth middleware (e.g., admin user), try body and params
    if (!hospitalId && req.isAdmin) {
      hospitalId = req.body?.hospitalId || req.params?.hospitalId || req.query?.hospitalId;
    }

    if (!hospitalId) {
      return res.status(400).json({
        message: "Hospital ID not found in request. Please provide hospitalId in body, params, or query.",
      });
    }

    // Update req.hospitalId for consistency
    req.hospitalId = hospitalId;

    // Get tenant database connection
    const tenantConnection = await getTenantConnection(hospitalId);

    if (!tenantConnection) {
      return res.status(500).json({
        message: "Failed to connect to tenant database",
      });
    }

    // Attach tenant connection to request
    req.tenantDb = tenantConnection;

    // Also attach a helper to get models from tenant DB
    req.getTenantModel = (modelName) => {
      return req.tenantDb.model(modelName);
    };

    next();
  } catch (error) {
    console.error("❌ Tenant DB middleware error:", error);
    res.status(500).json({
      message: "Error connecting to tenant database",
      error: error.message,
    });
  }
}

module.exports = tenantDbMiddleware;

