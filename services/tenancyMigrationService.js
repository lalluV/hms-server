const mongoose = require("mongoose");
const Hospital = require("../models/Hospital");
const {
  getTenantConnection,
  getSharedConnection,
  getTenantDatabaseName,
} = require("../utils/tenantDb");
const { registerTenantModels, TENANT_MODELS } = require("../utils/tenantModels");

/**
 * Migrate a hospital between Shared and Isolated tenancy modes.
 *
 * @param {string} hospitalId - Hospital ObjectId
 * @param {"shared" | "isolated"} targetMode - Desired tenancy mode
 * @param {Object} options - Migration options
 * @param {boolean} options.cleanupSource - Remove docs from source DB after migration (default true)
 * @param {boolean} options.dropSourceDb - Drop isolated DB when migrating isolated -> shared (default false)
 * @returns {Promise<Object>} Migration results
 */
async function migrateHospitalTenancy(hospitalId, targetMode, options = {}) {
  const { cleanupSource = true, dropSourceDb = false } = options;

  if (!["shared", "isolated"].includes(targetMode)) {
    throw new Error(`Invalid target tenancyMode: ${targetMode}. Must be "shared" or "isolated".`);
  }

  const hospital = await Hospital.findById(hospitalId);
  if (!hospital) {
    throw new Error(`Hospital not found: ${hospitalId}`);
  }

  const currentMode = hospital.tenancyMode || "isolated";
  if (currentMode === targetMode) {
    return {
      success: true,
      alreadyInTargetMode: true,
      message: `Hospital ${hospital.name} (${hospital.code}) is already in "${targetMode}" tenancy mode.`,
      tenancyMode: targetMode,
    };
  }

  console.log(`🚀 Starting tenancy migration for ${hospital.code}: ${currentMode} -> ${targetMode}`);

  // Mark as migrating in master DB
  hospital.databaseStatus = "migrating";
  await hospital.save();

  const migrationStats = {};
  let totalDocsMigrated = 0;

  try {
    const sharedConn = await getSharedConnection();
    registerTenantModels(sharedConn);

    const isolatedConn = await getTenantConnection(hospitalId);
    registerTenantModels(isolatedConn);

    const hospitalObjId = new mongoose.Types.ObjectId(hospitalId);
    const hospitalMatch = {
      $or: [{ hospitalId: hospitalId }, { hospitalId: hospitalObjId }],
    };

    if (targetMode === "isolated") {
      // ===== MIGRATION: SHARED -> ISOLATED =====
      // Source: hms_shared (filtered by hospitalId)
      // Target: hms_hospital_{hospitalId} (dedicated)

      for (const modelName of TENANT_MODELS) {
        if (!sharedConn.models[modelName] || !isolatedConn.models[modelName]) {
          continue;
        }

        const SourceModel = sharedConn.model(modelName);
        const TargetModel = isolatedConn.model(modelName);

        const docs = await SourceModel.find(hospitalMatch).lean();
        if (docs.length > 0) {
          // Insert into isolated database
          for (const doc of docs) {
            await TargetModel.updateOne(
              { _id: doc._id },
              { $set: doc },
              { upsert: true }
            );
          }

          // Cleanup from shared database if requested
          if (cleanupSource) {
            await SourceModel.deleteMany(hospitalMatch);
          }

          migrationStats[modelName] = docs.length;
          totalDocsMigrated += docs.length;
          console.log(`   📦 Migrated ${docs.length} ${modelName} doc(s) -> isolated DB`);
        }
      }

      // Initialize counter if needed in isolated DB
      if (isolatedConn.models.Counter) {
        const sharedCounter = await sharedConn.model("Counter").findById("UMRNo").lean();
        if (sharedCounter) {
          await isolatedConn.model("Counter").updateOne(
            { _id: "UMRNo" },
            { $set: { seq: sharedCounter.seq } },
            { upsert: true }
          );
        }
      }

      // Update Hospital record
      hospital.tenancyMode = "isolated";
      hospital.databaseName = getTenantDatabaseName(hospitalId);
      hospital.databaseStatus = "active";
      hospital.databaseProvisionedAt = new Date();
      await hospital.save();

    } else {
      // ===== MIGRATION: ISOLATED -> SHARED =====
      // Source: hms_hospital_{hospitalId} (dedicated)
      // Target: hms_shared (co-located with hospitalId)

      for (const modelName of TENANT_MODELS) {
        if (!isolatedConn.models[modelName] || !sharedConn.models[modelName]) {
          continue;
        }

        const SourceModel = isolatedConn.model(modelName);
        const TargetModel = sharedConn.model(modelName);

        const docs = await SourceModel.find({}).lean();
        if (docs.length > 0) {
          for (const doc of docs) {
            // Ensure hospitalId is always attached
            doc.hospitalId = hospitalObjId;
            await TargetModel.updateOne(
              { _id: doc._id },
              { $set: doc },
              { upsert: true }
            );
          }

          migrationStats[modelName] = docs.length;
          totalDocsMigrated += docs.length;
          console.log(`   📦 Migrated ${docs.length} ${modelName} doc(s) -> shared DB`);
        }
      }

      // Drop isolated DB if explicitly requested
      if (dropSourceDb) {
        try {
          await isolatedConn.dropDatabase();
          console.log(`   🗑️ Dropped isolated database for hospital ${hospitalId}`);
        } catch (dropErr) {
          console.warn(`   ⚠️ Could not drop isolated database:`, dropErr.message);
        }
      }

      // Update Hospital record
      hospital.tenancyMode = "shared";
      hospital.databaseName = "hms_shared";
      hospital.databaseStatus = "active";
      await hospital.save();
    }

    console.log(`✅ Tenancy migration completed successfully: ${totalDocsMigrated} total docs`);

    return {
      success: true,
      hospitalId,
      hospitalCode: hospital.code,
      fromMode: currentMode,
      toMode: targetMode,
      databaseName: hospital.databaseName,
      totalDocsMigrated,
      stats: migrationStats,
      message: `Successfully migrated ${hospital.name} to "${targetMode}" tenancy mode.`,
    };
  } catch (error) {
    console.error(`❌ Tenancy migration error for hospital ${hospitalId}:`, error);
    // Mark as error so admin knows intervention is needed
    hospital.databaseStatus = "error";
    await hospital.save();

    throw error;
  }
}

module.exports = { migrateHospitalTenancy };
