#!/usr/bin/env node

/**
 * initSharedDb.js
 *
 * One-time script to initialize the hms_shared database:
 *   - Creates the shared connection
 *   - Registers all tenant model schemas
 *   - Creates compound indexes with hospitalId prefix for tenant isolation
 *   - Initializes the UMR counter
 *
 * Usage:
 *   node scripts/initSharedDb.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { getSharedConnection, initializeMasterDatabase } = require("../utils/tenantDb");
const { registerTenantModels, TENANT_MODELS } = require("../utils/tenantModels");

async function main() {
  console.log("🚀 Initializing hms_shared database...\n");

  // 1. Connect to master DB (needed for mongoose default connection)
  await initializeMasterDatabase();

  // 2. Get the shared connection (creates hms_shared if it doesn't exist)
  const conn = await getSharedConnection();
  console.log(`✅ Connected to: ${conn.name}\n`);

  // 3. Register all tenant models
  registerTenantModels(conn);
  console.log(`✅ Registered ${Object.keys(conn.models).length} models\n`);

  // 4. Create collections
  for (const modelName of TENANT_MODELS) {
    if (conn.models[modelName]) {
      try {
        await conn.models[modelName].createCollection();
        console.log(`   📦 Created collection: ${modelName}`);
      } catch (err) {
        // Collection may already exist
        if (err.codeName !== "NamespaceExists") {
          console.warn(`   ⚠️  ${modelName}: ${err.message}`);
        } else {
          console.log(`   ✅ Collection already exists: ${modelName}`);
        }
      }
    }
  }

  // 5. Create compound indexes with hospitalId prefix (critical for shared tenancy)
  console.log("\n🔧 Creating compound indexes with hospitalId prefix...\n");

  const indexDefinitions = [
    // Patient indexes
    { model: "Patient", index: { hospitalId: 1, UMRNo: 1 }, options: { unique: true, sparse: true } },
    { model: "Patient", index: { hospitalId: 1, phone: 1 } },
    { model: "Patient", index: { hospitalId: 1, active: 1 } },
    { model: "Patient", index: { hospitalId: 1, patient_type: 1, active: 1 } },
    { model: "Patient", index: { hospitalId: 1, createdAt: -1 } },
    { model: "Patient", index: { hospitalId: 1, publicRegistrationKey: 1 }, options: { unique: true, sparse: true } },

    // Staff indexes
    { model: "Staff", index: { hospitalId: 1, userId: 1 }, options: { unique: true } },
    { model: "Staff", index: { hospitalId: 1, id: 1 }, options: { unique: true } },
    { model: "Staff", index: { hospitalId: 1, type: 1 } },
    { model: "Staff", index: { hospitalId: 1, active: 1 } },

    // Appointment indexes
    { model: "Appointment", index: { hospitalId: 1, appointmentDate: 1 } },
    { model: "Appointment", index: { hospitalId: 1, doctorId: 1, appointmentDate: 1 } },

    // Consultation indexes
    { model: "Consultation", index: { hospitalId: 1, createdAt: -1 } },
    { model: "Consultation", index: { hospitalId: 1, patientId: 1 } },

    // Receipt indexes (for dashboard aggregation)
    { model: "DiagnosticsReceipt", index: { hospitalId: 1, createdAt: -1 } },
    { model: "PharmacyReceipt", index: { hospitalId: 1, createdAt: -1 } },
    { model: "AdvanceReceipt", index: { hospitalId: 1, createdAt: -1 } },

    // Diagnostic indexes
    { model: "Diagnostic", index: { hospitalId: 1, patientId: 1 } },
    { model: "Diagnostic", index: { hospitalId: 1, createdAt: -1 } },

    // Pharmacy indexes
    { model: "PharmacyInventory", index: { hospitalId: 1, name: 1 } },
    { model: "LabInventory", index: { hospitalId: 1, name: 1 } },

    // Action indexes
    { model: "Action", index: { hospitalId: 1, patientId: 1 } },

    // Expense indexes
    { model: "Expense", index: { hospitalId: 1, createdAt: -1 } },

    // Prescription indexes
    { model: "Prescription", index: { hospitalId: 1, patientId: 1, createdAt: -1 } },
    { model: "Prescription", index: { hospitalId: 1, pharmacyStatus: 1, createdAt: -1 } },
    { model: "Prescription", index: { hospitalId: 1, doctorId: 1, date: -1 } },
    { model: "Prescription", index: { prescriptionId: 1 } },

    // IPAdmission indexes
    { model: "IPAdmission", index: { hospitalId: 1, patientId: 1, admissionDate: -1 } },
    { model: "IPAdmission", index: { hospitalId: 1, patient_status: 1, wardId: 1 } },
    { model: "IPAdmission", index: { hospitalId: 1, ipNumber: 1 } },
  ];

  for (const { model, index, options } of indexDefinitions) {
    if (conn.models[model]) {
      try {
        await conn.models[model].collection.createIndex(index, options || {});
        console.log(`   ✅ ${model}: ${JSON.stringify(index)}`);
      } catch (err) {
        console.warn(`   ⚠️  ${model}: ${err.message}`);
      }
    }
  }

  // 6. Initialize UMR counter
  if (conn.models.Counter) {
    const Counter = conn.model("Counter");
    const existing = await Counter.findById("UMRNo");
    if (!existing) {
      await Counter.create({ _id: "UMRNo", seq: 0 });
      console.log("\n✅ UMR counter initialized");
    } else {
      console.log(`\n✅ UMR counter already exists (seq: ${existing.seq})`);
    }
  }

  // 7. Print summary
  const collections = await conn.db.listCollections().toArray();
  const stats = await conn.db.stats();
  console.log("\n📊 hms_shared Summary:");
  console.log(`   Collections: ${collections.length}`);
  console.log(`   Data size: ${(stats.dataSize / 1024).toFixed(1)} KB`);
  console.log(`   Storage size: ${(stats.storageSize / 1024).toFixed(1)} KB`);

  console.log("\n✅ hms_shared initialization complete!");

  await conn.close();
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Initialization failed:", err);
  process.exit(1);
});
