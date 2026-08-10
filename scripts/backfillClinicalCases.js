#!/usr/bin/env node
/**
 * Backfill ClinicalCase index from all patient prescriptions for a hospital.
 *
 * Usage:
 *   node scripts/backfillClinicalCases.js <hospitalId>           # upsert only
 *   node scripts/backfillClinicalCases.js <hospitalId> --clear   # delete all + rebuild
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { getTenantConnection } = require("../utils/tenantDb");
const {
  backfillClinicalCasesForTenant,
  rebuildClinicalCasesForTenant,
} = require("../utils/doctorMemory");

async function main() {
  const args = process.argv.slice(2);
  const hospitalId =
    args.find((a) => !a.startsWith("--")) ||
    process.env.BACKFILL_HOSPITAL_ID ||
    "";
  const clearFirst = args.includes("--clear");

  if (!hospitalId) {
    console.error(
      "Usage: node scripts/backfillClinicalCases.js <hospitalId> [--clear]",
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI_SHARED || process.env.MONGO_URI);
  const tenantDb = await getTenantConnection(hospitalId);
  const result = clearFirst
    ? await rebuildClinicalCasesForTenant(tenantDb, hospitalId)
    : await backfillClinicalCasesForTenant(tenantDb, hospitalId);
  console.log(
    JSON.stringify({ hospitalId, clear: clearFirst, ...result }, null, 2),
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
