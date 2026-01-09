/**
 * Utility script to help update route files to use tenant database
 * This generates the code patterns needed for each route
 */

const routesToUpdate = [
  // Already updated
  { file: "patients.js", models: ["Patient"] },
  { file: "staff.js", models: ["Staff"] },
  { file: "consultations.js", models: ["Consultation"] },
  { file: "appointments.js", models: ["Appointment"] },
  { file: "pharmacy.js", models: ["PharmacyInventory"] },
  { file: "diagnostics.js", models: ["Diagnostic"] },
  { file: "wards.js", models: ["Ward"] },
  { file: "departments.js", models: ["Department"] },
  
  // Need to update
  { file: "shifts.js", models: ["Shift"] },
  { file: "leaves.js", models: ["Leave"] },
  { file: "holidays.js", models: ["Holiday"] },
  { file: "expenses.js", models: ["Expense"] },
  { file: "pharmacyReceipts.js", models: ["PharmacyReceipt"] },
  { file: "diagnosticsReceipts.js", models: ["DiagnosticsReceipt"] },
  { file: "advanceReceipts.js", models: ["AdvanceReceipt"] },
  { file: "consentRoutes.js", models: ["Consent"] },
  { file: "consentTemplateRoutes.js", models: ["ConsentTemplate"] },
  { file: "insuranceRoutes.js", models: ["InsuranceCompany"] },
  { file: "insuranceTariffs.js", models: ["InsuranceTariff"] },
  { file: "insuranceExclusions.js", models: ["InsuranceExclusion"] },
  { file: "vendorRoutes.js", models: ["Vendor"] },
  { file: "stamps.js", models: ["Stamp"] },
  { file: "nurseDesc.js", models: ["NurseDesc"] },
  { file: "actions.js", models: ["Action"] },
  { file: "indentStoreRoutes.js", models: ["IndentStore"] },
  { file: "diagnosticsUsers.js", models: ["DiagnosticsUser"] },
  { file: "parameterRoutes.js", models: ["Parameter"] },
  { file: "labInventoryRoutes.js", models: ["LabInventory"] },
  { file: "commissions.js", models: ["PatientCommissionLink", "Patient", "PharmacyReceipt", "DiagnosticsReceipt"] },
  { file: "dashboard.js", models: ["Patient", "Staff", "Appointment", "PharmacyReceipt", "DiagnosticsReceipt"] },
  { file: "dischargeSummary.js", models: ["Patient"] },
];

console.log("Route Update Guide for Tenant Database");
console.log("=" .repeat(60));
console.log("\nFor each route file, make these changes:\n");

console.log("1. UPDATE IMPORTS:");
console.log("   REMOVE: const Model = require('../models/Model');");
console.log("   ADD: const tenantDb = require('../middleware/tenantDb');\n");

console.log("2. ADD MIDDLEWARE:");
console.log("   AFTER: router.use(auth);");
console.log("   ADD: router.use(tenantDb);\n");

console.log("3. IN EACH ROUTE HANDLER:");
console.log("   AT START OF try block:");
console.log("   ADD: const Model = req.tenantDb.model('Model');\n");

console.log("\n" + "=".repeat(60));
console.log("Routes that need updating:\n");

routesToUpdate.forEach((route, index) => {
  console.log(`${index + 1}. ${route.file}`);
  console.log(`   Models: ${route.models.join(", ")}`);
  console.log(`   Pattern:`);
  route.models.forEach(model => {
    console.log(`   const ${model} = req.tenantDb.model('${model}');`);
  });
  console.log();
});

console.log("\n" + "=".repeat(60));
console.log("Master Data Routes (NO CHANGES NEEDED):");
console.log("- masterMedicines.js");
console.log("- masterParameters.js");
console.log("- masterDiagnostics.js");
console.log("- masterLabItems.js");
console.log("- hospitals.js");
console.log("- adminAuth.js");
console.log("- auth.js");
console.log("- upload.js");
console.log("- migrations.js");

module.exports = { routesToUpdate };

