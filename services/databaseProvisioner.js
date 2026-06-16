const mongoose = require("mongoose");
const {
  getTenantConnection,
  getTenantDatabaseName,
} = require("../utils/tenantDb");
const { registerTenantModels, TENANT_MODELS } = require("../utils/tenantModels");

/**
 * Provision a new tenant database for a hospital
 * @param {string} hospitalId - Hospital ObjectId
 * @returns {Promise<Object>} Provisioning result
 */
async function provisionTenantDatabase(hospitalId) {
  try {
    console.log(`🚀 Starting database provisioning for hospital ${hospitalId}`);

    const dbName = getTenantDatabaseName(hospitalId);
    const startTime = Date.now();

    // Step 1: Create/Get tenant database connection
    console.log(`📡 Step 1: Creating connection to ${dbName}...`);
    const connection = await getTenantConnection(hospitalId);

    if (!connection) {
      throw new Error("Failed to create tenant database connection");
    }

    // Step 2: Register all tenant models
    console.log("📦 Step 2: Registering tenant models...");
    registerTenantModels(connection);

    // Step 3: Create collections and indexes
    console.log("🔧 Step 3: Creating collections and indexes...");
    await createCollections(connection);
    await createIndexes(connection);

    // Step 4: Seed initial data if needed
    console.log("🌱 Step 4: Seeding initial data...");
    await seedInitialData(connection, hospitalId);

    // Step 5: Verify database setup
    console.log("✅ Step 5: Verifying database setup...");
    const verification = await verifyDatabase(connection);

    const duration = Date.now() - startTime;

    console.log(`✅ Database provisioning completed in ${duration}ms`);

    return {
      success: true,
      hospitalId,
      databaseName: dbName,
      duration,
      verification,
      message: "Tenant database provisioned successfully",
    };
  } catch (error) {
    console.error(`❌ Database provisioning failed for hospital ${hospitalId}:`, error);
    return {
      success: false,
      hospitalId,
      error: error.message,
      message: "Failed to provision tenant database",
    };
  }
}

/**
 * Create collections for all tenant models
 * @param {mongoose.Connection} connection - Tenant database connection
 */
async function createCollections(connection) {
  try {
    const models = TENANT_MODELS;
    const promises = [];

    for (const modelName of models) {
      try {
        // Check if model is registered, if not, it will be created when first used
        if (connection.models[modelName]) {
          const model = connection.model(modelName);
          // createCollection will create it if it doesn't exist
          promises.push(model.createCollection().catch(() => {}));
        }
      } catch (error) {
        // Some models might not be registered yet, that's okay
        console.warn(`⚠️  Model ${modelName} not registered yet, will be created on first use`);
      }
    }

    await Promise.all(promises);
    console.log("✅ Collections created");
  } catch (error) {
    console.error("❌ Error creating collections:", error);
    throw error;
  }
}

/**
 * Create indexes for all tenant models
 * @param {mongoose.Connection} connection - Tenant database connection
 */
async function createIndexes(connection) {
  try {
    // Create indexes for Patient model
    if (connection.models.Patient) {
      const Patient = connection.model("Patient");
      await Patient.createIndexes();
      console.log("✅ Patient indexes created");
    }

    // Create indexes for Staff model
    if (connection.models.Staff) {
      const Staff = connection.model("Staff");
      await Staff.createIndexes();
      console.log("✅ Staff indexes created");
    }

    // Additional indexes can be added here for other models
    console.log("✅ All indexes created");
  } catch (error) {
    console.error("❌ Error creating indexes:", error);
    // Don't throw - indexes can be created later
  }
}

/**
 * Seed initial data for a new tenant database
 * @param {mongoose.Connection} connection - Tenant database connection
 * @param {string} hospitalId - Hospital ObjectId
 */
async function seedInitialData(connection, hospitalId) {
  try {
    // Initialize counter for UMR numbers
    if (connection.models.Counter) {
      const Counter = connection.model("Counter");
      const existingCounter = await Counter.findById("UMRNo");

      if (!existingCounter) {
        await Counter.create({
          _id: "UMRNo",
          seq: 0,
        });
        console.log("✅ UMR counter initialized");
      }
    }

    if (process.env.SEED_PORTAL_STAFF !== "false") {
      const { seedPortalStaffForHospital } = require("./portalStaffSeeder");
      const results = await seedPortalStaffForHospital(hospitalId);
      const created = results.filter((r) => r.action === "created").length;
      console.log(`✅ Portal staff seeded (${created} new accounts)`);
    }

    console.log("✅ Initial data seeded");
  } catch (error) {
    console.error("❌ Error seeding initial data:", error);
    // Don't throw - seeding can be done later
  }
}

/**
 * Verify database setup
 * @param {mongoose.Connection} connection - Tenant database connection
 * @returns {Promise<Object>} Verification results
 */
async function verifyDatabase(connection) {
  try {
    const verification = {
      connected: connection.readyState === 1,
      databaseName: connection.name,
      collections: [],
      indexes: {},
      healthy: true,
    };

    // List all collections
    const collections = await connection.db.listCollections().toArray();
    verification.collections = collections.map((c) => c.name);

    // Verify indexes for key models
    if (connection.models.Patient) {
      const Patient = connection.model("Patient");
      const indexes = await Patient.collection.getIndexes();
      verification.indexes.Patient = Object.keys(indexes).length;
    }

    if (connection.models.Staff) {
      const Staff = connection.model("Staff");
      const indexes = await Staff.collection.getIndexes();
      verification.indexes.Staff = Object.keys(indexes).length;
    }

    return verification;
  } catch (error) {
    console.error("❌ Error verifying database:", error);
    return {
      connected: false,
      healthy: false,
      error: error.message,
    };
  }
}

/**
 * Check if a tenant database is provisioned
 * @param {string} hospitalId - Hospital ObjectId
 * @returns {Promise<boolean>} True if provisioned
 */
async function isDatabaseProvisioned(hospitalId) {
  try {
    const connection = await getTenantConnection(hospitalId);
    const collections = await connection.db.listCollections().toArray();
    
    // Check if essential collections exist
    const hasPatients = collections.some((c) => c.name === "patients");
    const hasStaff = collections.some((c) => c.name === "staffs");
    
    return hasPatients || hasStaff || collections.length > 0;
  } catch (error) {
    console.error(`❌ Error checking database provisioning status:`, error);
    return false;
  }
}

/**
 * Get database statistics
 * @param {string} hospitalId - Hospital ObjectId
 * @returns {Promise<Object>} Database statistics
 */
async function getDatabaseStats(hospitalId) {
  try {
    const connection = await getTenantConnection(hospitalId);
    const stats = await connection.db.stats();
    
    return {
      hospitalId,
      databaseName: getTenantDatabaseName(hospitalId),
      collections: stats.collections,
      dataSize: stats.dataSize,
      indexSize: stats.indexSize,
      storageSize: stats.storageSize,
      avgObjSize: stats.avgObjSize,
      objects: stats.objects,
    };
  } catch (error) {
    console.error(`❌ Error getting database stats:`, error);
    throw error;
  }
}

/**
 * Delete a tenant database (USE WITH EXTREME CAUTION)
 * @param {string} hospitalId - Hospital ObjectId
 * @returns {Promise<Object>} Deletion result
 */
async function deleteTenantDatabase(hospitalId) {
  try {
    console.log(`⚠️  WARNING: Deleting database for hospital ${hospitalId}`);
    
    const connection = await getTenantConnection(hospitalId);
    await connection.dropDatabase();
    
    console.log(`✅ Database deleted for hospital ${hospitalId}`);
    
    return {
      success: true,
      hospitalId,
      message: "Tenant database deleted successfully",
    };
  } catch (error) {
    console.error(`❌ Error deleting database:`, error);
    return {
      success: false,
      hospitalId,
      error: error.message,
      message: "Failed to delete tenant database",
    };
  }
}

module.exports = {
  provisionTenantDatabase,
  isDatabaseProvisioned,
  getDatabaseStats,
  deleteTenantDatabase,
  createCollections,
  createIndexes,
  seedInitialData,
  verifyDatabase,
};

