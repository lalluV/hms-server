const mongoose = require("mongoose");

/**
 * Master Data Middleware
 * Ensures master database connection is available for routes that need master data
 * Can be combined with tenant database middleware
 */
async function masterDataMiddleware(req, res, next) {
  try {
    // Attach master database connection (default mongoose connection)
    req.masterDb = mongoose.connection;

    // Add helper to get master models
    req.getMasterModel = (modelName) => {
      return mongoose.model(modelName);
    };

    next();
  } catch (error) {
    console.error("❌ Master data middleware error:", error);
    res.status(500).json({
      message: "Error accessing master data",
      error: error.message,
    });
  }
}

module.exports = masterDataMiddleware;

