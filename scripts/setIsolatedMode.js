#!/usr/bin/env node

/**
 * setIsolatedMode.js
 *
 * One-time migration: backfill tenancyMode = "isolated" on all existing
 * hospitals that don't have the field set yet.
 *
 * This ensures existing hospitals continue to use their dedicated
 * hms_hospital_{id} databases after the hybrid tenancy code is deployed.
 *
 * Usage:
 *   node scripts/setIsolatedMode.js              # dry-run (default)
 *   node scripts/setIsolatedMode.js --execute     # apply changes
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Hospital = require("../models/Hospital");

const dryRun = !process.argv.includes("--execute");

async function main() {
  console.log(`🔧 Backfilling tenancyMode on existing hospitals...`);
  console.log(`   Mode: ${dryRun ? "DRY RUN (pass --execute to apply)" : "EXECUTING"}\n`);

  await mongoose.connect(process.env.MONGO_URI_SHARED || process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ Connected to master DB\n");

  // Find hospitals without tenancyMode set
  const filter = {
    $or: [
      { tenancyMode: { $exists: false } },
      { tenancyMode: null },
    ],
  };

  const hospitals = await Hospital.find(filter).select("_id name code databaseStatus tenancyMode");
  console.log(`   Found ${hospitals.length} hospital(s) without tenancyMode\n`);

  if (hospitals.length === 0) {
    console.log("✅ All hospitals already have tenancyMode set. Nothing to do.");
    await mongoose.disconnect();
    process.exit(0);
  }

  for (const h of hospitals) {
    console.log(`   ${h.code} (${h.name}) — databaseStatus: ${h.databaseStatus || "none"}`);
  }

  if (dryRun) {
    console.log(`\n⚠️  DRY RUN: Would set tenancyMode = "isolated" on ${hospitals.length} hospital(s).`);
    console.log(`   Run with --execute to apply.`);
  } else {
    const result = await Hospital.updateMany(filter, {
      $set: { tenancyMode: "isolated" },
    });
    console.log(`\n✅ Updated ${result.modifiedCount} hospital(s) → tenancyMode: "isolated"`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
