#!/usr/bin/env node

/**
 * purgeLoginPasswords.js
 *
 * One-time migration: remove all plaintext loginPassword fields from Staff
 * documents across ALL tenant databases (both isolated and shared).
 *
 * Usage:
 *   node scripts/purgeLoginPasswords.js              # dry-run (default)
 *   node scripts/purgeLoginPasswords.js --execute     # apply changes
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Hospital = require("../models/Hospital");
const { getTenantConnection, getSharedConnection } = require("../utils/tenantDb");
const { registerTenantModels } = require("../utils/tenantModels");

const dryRun = !process.argv.includes("--execute");

async function purgeFromConnection(conn, label) {
  registerTenantModels(conn);
  const Staff = conn.model("Staff");

  const count = await Staff.countDocuments({
    loginPassword: { $exists: true },
  });

  if (count === 0) {
    console.log(`   ${label}: no loginPassword fields found`);
    return 0;
  }

  if (dryRun) {
    console.log(`   ${label}: would purge ${count} staff doc(s)`);
    return count;
  }

  const result = await Staff.updateMany(
    { loginPassword: { $exists: true } },
    { $unset: { loginPassword: 1 } }
  );
  console.log(`   ${label}: purged ${result.modifiedCount} staff doc(s)`);
  return result.modifiedCount;
}

async function main() {
  console.log("🔒 Purging plaintext loginPassword fields from all Staff docs...");
  console.log(`   Mode: ${dryRun ? "DRY RUN (pass --execute to apply)" : "EXECUTING"}\n`);

  // 1. Connect to master DB
  await mongoose.connect(process.env.MONGO_URI_SHARED || process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ Connected to master DB\n");

  let totalPurged = 0;

  // 2. Purge from shared DB
  try {
    const sharedConn = await getSharedConnection();
    totalPurged += await purgeFromConnection(sharedConn, "hms_shared");
  } catch (err) {
    console.warn("   ⚠️  hms_shared: could not connect (may not exist yet)");
  }

  // 3. Purge from all isolated tenant DBs
  const hospitals = await Hospital.find({
    $or: [
      { tenancyMode: "isolated" },
      { tenancyMode: { $exists: false } },
    ],
  }).select("_id name code");

  console.log(`\n   Found ${hospitals.length} isolated hospital(s)\n`);

  for (const h of hospitals) {
    try {
      const conn = await getTenantConnection(h._id.toString());
      totalPurged += await purgeFromConnection(
        conn,
        `hms_hospital_${h._id} (${h.code})`
      );
    } catch (err) {
      console.warn(`   ⚠️  ${h.code}: ${err.message}`);
    }
  }

  console.log(`\n📊 Total: ${totalPurged} staff doc(s) ${dryRun ? "would be" : ""} purged`);

  if (dryRun) {
    console.log("\n⚠️  DRY RUN complete. Run with --execute to apply changes.");
  } else {
    console.log("\n✅ Purge complete. All plaintext passwords removed.");
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Purge failed:", err);
  process.exit(1);
});
