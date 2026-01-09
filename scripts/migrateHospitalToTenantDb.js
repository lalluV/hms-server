const mongoose = require("mongoose");
require("dotenv").config();
const {
  getTenantConnection,
  getTenantDatabaseName,
} = require("../utils/tenantDb");
const { provisionTenantDatabase } = require("../services/databaseProvisioner");
const { TENANT_MODELS } = require("../utils/tenantModels");

// Models to migrate (from shared DB)
const Hospital = require("../models/Hospital");
const Patient = require("../models/Patient");
const Staff = require("../models/Staff");
// Add other models as needed

/**
 * Migrate a single hospital's data to its own tenant database
 * @param {string} hospitalId - Hospital ObjectId
 * @param {Object} options - Migration options
 */
async function migrateHospitalToTenantDb(hospitalId, options = {}) {
  const {
    dryRun = false,
    verbose = true,
    verifyOnly = false,
  } = options;

  try {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🚀 Starting migration for hospital: ${hospitalId}`);
    console.log(`${"=".repeat(60)}\n`);

    if (dryRun) {
      console.log("⚠️  DRY RUN MODE - No data will be written");
    }

    // Step 1: Verify hospital exists
    console.log("📋 Step 1: Verifying hospital...");
    const hospital = await Hospital.findById(hospitalId);
    if (!hospital) {
      throw new Error(`Hospital with ID ${hospitalId} not found`);
    }
    console.log(`✅ Hospital found: ${hospital.name} (${hospital.code})`);

    // Step 2: Provision tenant database if not already done
    if (!verifyOnly && hospital.databaseStatus !== "active") {
      console.log("\n📦 Step 2: Provisioning tenant database...");
      const provisionResult = await provisionTenantDatabase(hospitalId);
      
      if (!provisionResult.success) {
        throw new Error(`Failed to provision database: ${provisionResult.error}`);
      }
      console.log("✅ Tenant database provisioned successfully");

      // Update hospital record
      if (!dryRun) {
        hospital.databaseStatus = "active";
        hospital.databaseName = getTenantDatabaseName(hospitalId);
        hospital.databaseProvisionedAt = new Date();
        await hospital.save();
      }
    } else {
      console.log("\n📦 Step 2: Tenant database already provisioned, skipping...");
    }

    // Step 3: Get tenant connection
    console.log("\n📡 Step 3: Connecting to tenant database...");
    const tenantConnection = await getTenantConnection(hospitalId);
    console.log(`✅ Connected to ${getTenantDatabaseName(hospitalId)}`);

    // Step 4: Count records in shared database
    console.log("\n📊 Step 4: Counting records in shared database...");
    const counts = await countRecordsInSharedDb(hospitalId);
    
    console.log("\nRecords to migrate:");
    Object.entries(counts).forEach(([model, count]) => {
      console.log(`  - ${model}: ${count}`);
    });

    const totalRecords = Object.values(counts).reduce((sum, count) => sum + count, 0);
    console.log(`  TOTAL: ${totalRecords} records`);

    if (totalRecords === 0) {
      console.log("\n⚠️  No records to migrate");
      return {
        success: true,
        hospitalId,
        message: "No records to migrate",
        counts,
      };
    }

    if (verifyOnly) {
      console.log("\n✅ Verification complete (verify-only mode)");
      return {
        success: true,
        hospitalId,
        message: "Verification complete",
        counts,
      };
    }

    // Step 5: Migrate data
    console.log("\n📤 Step 5: Migrating data...");
    
    if (!dryRun) {
      hospital.databaseStatus = "migrating";
      await hospital.save();
    }

    const migrationResults = await migrateData(
      hospitalId,
      tenantConnection,
      counts,
      { dryRun, verbose }
    );

    // Step 6: Verify migration
    console.log("\n✅ Step 6: Verifying migration...");
    const verification = await verifyMigration(
      hospitalId,
      tenantConnection,
      counts
    );

    if (verification.success) {
      console.log("✅ Migration verification passed");
      
      if (!dryRun) {
        hospital.databaseStatus = "active";
        await hospital.save();
      }
    } else {
      console.log("❌ Migration verification failed");
      throw new Error("Migration verification failed");
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log("✅ Migration completed successfully!");
    console.log(`${"=".repeat(60)}\n`);

    return {
      success: true,
      hospitalId,
      hospitalName: hospital.name,
      message: "Migration completed successfully",
      counts,
      migrationResults,
      verification,
      dryRun,
    };
  } catch (error) {
    console.error(`\n❌ Migration failed for hospital ${hospitalId}:`, error);
    
    // Update hospital status on error
    try {
      const hospital = await Hospital.findById(hospitalId);
      if (hospital && !dryRun) {
        hospital.databaseStatus = "error";
        await hospital.save();
      }
    } catch (err) {
      console.error("Error updating hospital status:", err);
    }

    return {
      success: false,
      hospitalId,
      error: error.message,
      message: "Migration failed",
    };
  }
}

/**
 * Count records in shared database for a hospital
 */
async function countRecordsInSharedDb(hospitalId) {
  const counts = {};

  try {
    counts.patients = await Patient.countDocuments({ hospitalId });
    counts.staff = await Staff.countDocuments({ hospitalId });
    // Add counts for other models as needed

    return counts;
  } catch (error) {
    console.error("Error counting records:", error);
    throw error;
  }
}

/**
 * Migrate data from shared DB to tenant DB
 */
async function migrateData(hospitalId, tenantConnection, counts, options = {}) {
  const { dryRun, verbose } = options;
  const results = {};

  // Migrate Patients
  if (counts.patients > 0) {
    console.log(`\n  📋 Migrating ${counts.patients} patients...`);
    
    if (!dryRun) {
      const patients = await Patient.find({ hospitalId }).lean();
      const TenantPatient = tenantConnection.model("Patient");
      
      // Use bulkWrite for better performance
      const operations = patients.map((patient) => ({
        insertOne: { document: patient },
      }));

      const result = await TenantPatient.bulkWrite(operations, { ordered: false });
      results.patients = result.insertedCount;
      
      if (verbose) {
        console.log(`    ✅ Migrated ${result.insertedCount} patients`);
      }
    } else {
      results.patients = counts.patients;
      console.log(`    ✅ Would migrate ${counts.patients} patients (dry run)`);
    }
  }

  // Migrate Staff
  if (counts.staff > 0) {
    console.log(`\n  👥 Migrating ${counts.staff} staff members...`);
    
    if (!dryRun) {
      const staff = await Staff.find({ hospitalId }).lean();
      const TenantStaff = tenantConnection.model("Staff");
      
      const operations = staff.map((member) => ({
        insertOne: { document: member },
      }));

      const result = await TenantStaff.bulkWrite(operations, { ordered: false });
      results.staff = result.insertedCount;
      
      if (verbose) {
        console.log(`    ✅ Migrated ${result.insertedCount} staff members`);
      }
    } else {
      results.staff = counts.staff;
      console.log(`    ✅ Would migrate ${counts.staff} staff members (dry run)`);
    }
  }

  // Add migration for other models here...

  return results;
}

/**
 * Verify migration by comparing record counts
 */
async function verifyMigration(hospitalId, tenantConnection, originalCounts) {
  const verification = {
    success: true,
    matches: {},
    mismatches: [],
  };

  try {
    // Verify Patients
    if (originalCounts.patients > 0) {
      const TenantPatient = tenantConnection.model("Patient");
      const tenantCount = await TenantPatient.countDocuments({ hospitalId });
      
      verification.matches.patients = {
        original: originalCounts.patients,
        migrated: tenantCount,
        match: tenantCount === originalCounts.patients,
      };

      if (tenantCount !== originalCounts.patients) {
        verification.success = false;
        verification.mismatches.push("patients");
      }
    }

    // Verify Staff
    if (originalCounts.staff > 0) {
      const TenantStaff = tenantConnection.model("Staff");
      const tenantCount = await TenantStaff.countDocuments({ hospitalId });
      
      verification.matches.staff = {
        original: originalCounts.staff,
        migrated: tenantCount,
        match: tenantCount === originalCounts.staff,
      };

      if (tenantCount !== originalCounts.staff) {
        verification.success = false;
        verification.mismatches.push("staff");
      }
    }

    // Add verification for other models...

    return verification;
  } catch (error) {
    console.error("Error verifying migration:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Migrate all hospitals
 */
async function migrateAllHospitals(options = {}) {
  try {
    console.log("🚀 Starting migration for all hospitals...\n");

    const hospitals = await Hospital.find({ databaseStatus: { $ne: "active" } });
    console.log(`Found ${hospitals.length} hospitals to migrate\n`);

    const results = [];

    for (const hospital of hospitals) {
      const result = await migrateHospitalToTenantDb(
        hospital._id.toString(),
        options
      );
      results.push(result);

      // Add delay between migrations to avoid overwhelming the database
      if (!options.dryRun) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log("\n✅ All migrations completed");
    console.log(`Success: ${results.filter((r) => r.success).length}`);
    console.log(`Failed: ${results.filter((r) => !r.success).length}`);

    return results;
  } catch (error) {
    console.error("Error migrating all hospitals:", error);
    throw error;
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const hospitalId = args[0];
  const dryRun = args.includes("--dry-run");
  const verifyOnly = args.includes("--verify-only");
  const all = args.includes("--all");

  // Connect to MongoDB
  mongoose
    .connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    })
    .then(async () => {
      console.log("✅ Connected to MongoDB");

      if (all) {
        const results = await migrateAllHospitals({ dryRun, verifyOnly });
        console.log("\nResults:", JSON.stringify(results, null, 2));
      } else if (hospitalId) {
        const result = await migrateHospitalToTenantDb(hospitalId, {
          dryRun,
          verifyOnly,
        });
        console.log("\nResult:", JSON.stringify(result, null, 2));
      } else {
        console.log("Usage:");
        console.log("  node migrateHospitalToTenantDb.js <hospitalId> [--dry-run] [--verify-only]");
        console.log("  node migrateHospitalToTenantDb.js --all [--dry-run] [--verify-only]");
      }

      process.exit(0);
    })
    .catch((error) => {
      console.error("MongoDB connection error:", error);
      process.exit(1);
    });
}

module.exports = {
  migrateHospitalToTenantDb,
  migrateAllHospitals,
};

