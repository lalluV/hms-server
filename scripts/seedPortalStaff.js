/**
 * Seed demo portal staff with login credentials for each role.
 *
 * Usage:
 *   node scripts/seedPortalStaff.js                    # all active hospitals
 *   node scripts/seedPortalStaff.js --code=demo          # one hospital by code
 *   node scripts/seedPortalStaff.js --hospital-id=...    # one hospital by id
 *   node scripts/seedPortalStaff.js --force              # reset passwords on existing
 *   node scripts/seedPortalStaff.js --include-superadmin   # add demo superadmin if missing
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Hospital = require("../models/Hospital");
const { initializeMasterDatabase } = require("../utils/tenantDb");
const { seedPortalStaffForHospital } = require("../services/portalStaffSeeder");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    hospitalCode: null,
    hospitalId: null,
    force: false,
    includeSuperAdmin: false,
  };

  for (const arg of args) {
    if (arg === "--force") options.force = true;
    else if (arg === "--include-superadmin") options.includeSuperAdmin = true;
    else if (arg.startsWith("--code=")) options.hospitalCode = arg.split("=")[1];
    else if (arg.startsWith("--hospital-id=")) {
      options.hospitalId = arg.split("=")[1];
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  console.log("\n" + "=".repeat(70));
  console.log("HMS Portal Staff Seeder");
  console.log("=".repeat(70) + "\n");

  await initializeMasterDatabase();

  let hospitals;
  if (options.hospitalId) {
    const hospital = await Hospital.findById(options.hospitalId);
    hospitals = hospital ? [hospital] : [];
  } else if (options.hospitalCode) {
    const hospital = await Hospital.findOne({
      code: options.hospitalCode.toLowerCase(),
    });
    hospitals = hospital ? [hospital] : [];
  } else {
    hospitals = await Hospital.find({ active: true, databaseStatus: "active" });
  }

  if (!hospitals.length) {
    console.error("❌ No matching active hospitals found.");
    process.exit(1);
  }

  const allResults = [];

  for (const hospital of hospitals) {
    if (hospital.databaseStatus !== "active") {
      console.warn(
        `⚠️  Skipping ${hospital.name} (${hospital.code}) — database status: ${hospital.databaseStatus}`,
      );
      continue;
    }

    console.log(`🏥 Seeding portal staff for: ${hospital.name} (${hospital.code})`);
    const results = await seedPortalStaffForHospital(hospital._id.toString(), {
      force: options.force,
      includeSuperAdmin: options.includeSuperAdmin,
    });

    for (const row of results) {
      allResults.push({
        ...row,
        hospitalCode: hospital.code,
        hospitalName: hospital.name,
      });
      const icon =
        row.action === "created" ? "✅" : row.action === "updated" ? "🔄" : "⏭️";
      console.log(
        `  ${icon} ${row.type.padEnd(14)} userId=${row.userId.padEnd(14)} [${row.action}]`,
      );
    }
    console.log("");
  }

  console.log("=".repeat(70));
  console.log("LOGIN CREDENTIALS (HMS App — use hospital subdomain)");
  console.log("=".repeat(70));
  console.log("\n| Hospital | Role | User ID | Password | Portal |");
  console.log("|----------|------|---------|----------|--------|");

  for (const row of allResults.filter((r) => r.action !== "skipped")) {
    console.log(
      `| ${row.hospitalCode} | ${row.type} | ${row.userId} | ${row.password} | ${row.portal} |`,
    );
  }

  const skipped = allResults.filter((r) => r.action === "skipped");
  if (skipped.length) {
    console.log("\nSkipped (already exist — use --force to reset passwords):");
    for (const row of skipped) {
      console.log(`  - ${row.hospitalCode}: ${row.type} (${row.userId})`);
    }
  }

  console.log("\nPortal types:");
  console.log("  mobile-doctor / mobile-nurse  → Bottom-tab mobile portal");
  console.log("  sidebar-*                   → Desktop sidebar portal");
  console.log("\nLogin URL pattern: http://{hospital-code}.localhost:5173");
  console.log("=".repeat(70) + "\n");

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
