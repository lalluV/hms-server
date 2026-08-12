#!/usr/bin/env node

/**
 * migrateHospitalTenancy.js
 *
 * CLI tool to migrate a hospital between "shared" and "isolated" tenancy modes.
 *
 * Usage:
 *   node scripts/migrateHospitalTenancy.js --code hs-1234567890 --to isolated
 *   node scripts/migrateHospitalTenancy.js --id <hospitalId> --to shared
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Hospital = require("../models/Hospital");
const { migrateHospitalTenancy } = require("../services/tenancyMigrationService");

async function main() {
  const args = process.argv.slice(2);
  const codeIdx = args.indexOf("--code");
  const idIdx = args.indexOf("--id");
  const toIdx = args.indexOf("--to");
  const dropSource = args.includes("--drop-source");

  const targetMode = toIdx !== -1 ? args[toIdx + 1] : null;
  const hospitalCode = codeIdx !== -1 ? args[codeIdx + 1] : null;
  const hospitalId = idIdx !== -1 ? args[idIdx + 1] : null;

  if (!targetMode || (!hospitalCode && !hospitalId)) {
    console.log(`
Usage:
  node scripts/migrateHospitalTenancy.js --code <hospitalCode> --to <shared|isolated>
  node scripts/migrateHospitalTenancy.js --id <hospitalId> --to <shared|isolated>

Options:
  --drop-source    Drop isolated DB when migrating isolated -> shared
`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI_SHARED || process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  const query = hospitalId ? { _id: hospitalId } : { code: hospitalCode.toLowerCase() };
  const hospital = await Hospital.findOne(query);

  if (!hospital) {
    console.error(`❌ Hospital not found for query:`, query);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`\n🏥 Migrating "${hospital.name}" (${hospital.code})...`);
  console.log(`   Current: ${hospital.tenancyMode || "isolated"}`);
  console.log(`   Target:  ${targetMode}\n`);

  try {
    const result = await migrateHospitalTenancy(hospital._id.toString(), targetMode, {
      cleanupSource: true,
      dropSourceDb: dropSource,
    });

    console.log("✅ Result:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main();
