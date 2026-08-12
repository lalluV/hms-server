const Hospital = require("../models/Hospital");
const { getTenantConnection, getSharedConnection } = require("./tenantDb");

/**
 * Resolve the correct tenant database connection based on hospital tenancyMode.
 *
 * - "shared"   → returns the singleton hms_shared connection pool
 * - "isolated"  → returns (or creates) a dedicated hms_hospital_{id} connection
 *
 * @param {string} hospitalId - The hospital ObjectId as a string
 * @returns {Promise<import("mongoose").Connection>} The tenant database connection
 */
async function resolveTenantConnection(hospitalId) {
  if (!hospitalId) {
    throw new Error("Hospital ID is required for tenant routing");
  }

  // Look up the tenancy mode from master DB
  const hospital = await Hospital.findById(hospitalId)
    .select("tenancyMode")
    .lean();

  if (!hospital) {
    throw new Error(`Hospital ${hospitalId} not found in master DB`);
  }

  if (hospital.tenancyMode === "shared") {
    return getSharedConnection();
  }

  // Default: isolated (also handles undefined/null for existing hospitals)
  return getTenantConnection(hospitalId);
}

module.exports = { resolveTenantConnection };
