#!/usr/bin/env node

/**
 * migrateEmbeddedToCollections.js
 *
 * Migration script to extract historical embedded data from Patient documents:
 * 1. Extracts patient.prescriptions[] -> Prescription collection
 * 2. Extracts IP stays (admissionDate / transfers / nurseNotes / dischargeSummary) -> IPAdmission collection
 *
 * Usage:
 *   node scripts/migrateEmbeddedToCollections.js            # Dry run (default)
 *   node scripts/migrateEmbeddedToCollections.js --execute  # Apply changes
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Hospital = require("../models/Hospital");
const {
  getTenantConnection,
  getSharedConnection,
} = require("../utils/tenantDb");
const { registerTenantModels } = require("../utils/tenantModels");

const dryRun = !process.argv.includes("--execute");

async function migrateConnection(conn, label) {
  registerTenantModels(conn);
  const Patient = conn.model("Patient");
  const Prescription = conn.model("Prescription");
  const IPAdmission = conn.model("IPAdmission");

  console.log(`\n🏥 Processing: ${label}...`);

  let prescriptionsMigrated = 0;
  let ipAdmissionsMigrated = 0;

  // 1. Migrate Prescriptions
  const patientsWithRx = await Patient.find({
    prescriptions: { $exists: true, $not: { $size: 0 } },
  }).lean();

  console.log(
    `   Found ${patientsWithRx.length} patient(s) with embedded prescriptions.`,
  );

  for (const patient of patientsWithRx) {
    const rxList = patient.prescriptions || [];
    for (const rx of rxList) {
      const rxId =
        rx.prescriptionId ||
        `RX-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      if (!dryRun) {
        await Prescription.updateOne(
          {
            hospitalId: patient.hospitalId,
            prescriptionId: rxId,
          },
          {
            $set: {
              prescriptionId: rxId,
              hospitalId: patient.hospitalId,
              patientId: patient._id,
              UMRNo: patient.UMRNo || "",
              doctorId: rx.doctorId || "DOC-GEN",
              doctorName: rx.doctorName || patient.consultantDoctor,
              department: rx.department,
              date:
                rx.date ||
                patient.registration_date ||
                new Date().toISOString().split("T")[0],
              symptoms: Array.isArray(rx.symptoms)
                ? rx.symptoms
                : rx.symptoms
                  ? [rx.symptoms]
                  : [],
              provisionalDiagnosis: rx.provisionalDiagnosis,
              weight: rx.weight,
              height: rx.height,
              vitals: rx.vitals || [],
              doctorNotes: rx.doctorNotes || [],
              diagnosticData: rx.diagnosticData || [],
              medicineData: rx.medicineData || [],
              pharmacyStatus: rx.pharmacyStatus || "dispensed",
              paymentMethod: patient.paymentMethod || "Personal",
              insurance_provider: patient.insurance_provider,
              insurance_providerId: patient.insurance_providerId,
              policy_number: patient.policy_number,
              coPayPercentage: patient.coPayPercentage || 0,
              coPayLimit: patient.coPayLimit || 0,
              coPayType: patient.coPayType || "percentage",
              coverage: patient.coverage,
              expiry_date: patient.expiry_date,
            },
          },
          { upsert: true },
        );
      }
      prescriptionsMigrated++;
    }
  }

  // 2. Migrate IP Admissions (patients with admissionDate or transfers or nurseNotes)
  const patientsWithIP = await Patient.find({
    $or: [
      { admissionDate: { $exists: true, $ne: "" } },
      { transfers: { $exists: true, $not: { $size: 0 } } },
      { nurseNotes: { $exists: true, $not: { $size: 0 } } },
      { dischargeDate: { $exists: true, $ne: "" } },
      { patient_type: "IP" },
    ],
  }).lean();

  console.log(
    `   Found ${patientsWithIP.length} patient(s) with Inpatient history.`,
  );

  for (const patient of patientsWithIP) {
    const ipNumber = `IP-${patient.UMRNo || patient._id}`;

    if (!dryRun) {
      const admissionDoc = await IPAdmission.findOneAndUpdate(
        {
          hospitalId: patient.hospitalId,
          $or: [{ ipNumber }, { patientId: patient._id }],
        },
        {
          $set: {
            ipNumber,
            hospitalId: patient.hospitalId,
            patientId: patient._id,
            UMRNo: patient.UMRNo || "",
            patientName: patient.name || "",
            admissionDate:
              patient.admissionDate ||
              patient.registration_date ||
              new Date().toISOString().split("T")[0],
            admissionTime: patient.admissionTime,
            mlcNo: patient.mlcNo,
            patient_status:
              patient.active === false || patient.dischargeDate
                ? "Discharged"
                : "Admitted",
            consultantDoctor: patient.consultantDoctor,
            doctorId: patient.doctorId,
            medicalOfficerName: patient.medicalOfficerName,
            medicalOfficerId: patient.medicalOfficerId,
            patientRepresentiveOfficer: patient.patientRepresentiveOfficer,
            wardName: patient.wardName,
            wardId: patient.wardId,
            selectedBed: patient.selectedBed,
            transfers: patient.transfers || [],
            consultantHistory: patient.consultantHistory || [],
            chiefComplaintsPresentIllnessHistory:
              patient.chiefComplaintsPresentIllnessHistory,
            consciousness: patient.consciousness,
            gcs: patient.gcs,
            pupils: patient.pupils,
            systemicExamination: patient.systemicExamination,
            provisionalDiagnosis: patient.provisionalDiagnosis,
            vitals: patient.vitals || [],
            doctorNotes: patient.doctorNotes || [],
            nurseNotes: patient.nurseNotes || [],
            insulinChart: patient.insulinChart || [],
            investigations: patient.investigations || [],
            procedures: patient.procedures || [],
            treatment: patient.treatment || [],
            casualtyTreatment: patient.casualtyTreatment || [],
            dischargeDate: patient.dischargeDate,
            dischargedAt: patient.dischargedAt,
            dischargeCondition: patient.dischargeCondition,
            dischargeTo: patient.dischargeTo,
            dischargeDestination: patient.dischargeDestination,
            finalDiagnosis: patient.finalDiagnosis,
            dischargeInstructions: patient.dischargeInstructions,
            followUpPlan: patient.followUpPlan,
            dischargeMedications: patient.dischargeMedications || [],
            dischargeSummary: patient.dischargeSummary,
            dischargeSummaryType: patient.dischargeSummaryType,
            dischargeSummaryTimestamp: patient.dischargeSummaryTimestamp,
            dischargeOrders: patient.dischargeOrders,
            counselling: patient.counselling,
            paymentMethod: patient.paymentMethod || "Personal",
            insurance_provider: patient.insurance_provider,
            insurance_providerId: patient.insurance_providerId,
            policy_number: patient.policy_number,
            coPayPercentage: patient.coPayPercentage || 0,
            coPayLimit: patient.coPayLimit || 0,
            coPayType: patient.coPayType || "percentage",
            coverage: patient.coverage,
            expiry_date: patient.expiry_date,
            commissionEarnerType: patient.commissionEarnerType,
            commissionEarnerId: patient.commissionEarnerId,
            commissionEarnerName: patient.commissionEarnerName,
            commissionRates: patient.commissionRates,
            finalBillAmount: patient.finalBillAmount,
            discount: patient.discount || 0,
            insurance: patient.insurance || 0,
            paymentStatus:
              patient.paymentStatus ||
              (patient.active === false ? "settled" : "pending"),
          },
        },
        { upsert: true, new: true },
      );

      // Link active admission pointer to patient if currently admitted
      if (patient.patient_type === "IP" && patient.active !== false) {
        await Patient.updateOne(
          { _id: patient._id },
          { $set: { activeAdmissionId: admissionDoc._id } },
        );
      }
    }
    ipAdmissionsMigrated++;
  }

  console.log(
    `   📊 Summary for ${label}: ${prescriptionsMigrated} prescriptions, ${ipAdmissionsMigrated} IP admissions ${
      dryRun ? "would be" : "were"
    } migrated.`,
  );

  return { prescriptionsMigrated, ipAdmissionsMigrated };
}

async function main() {
  console.log(
    "🚀 Starting Backfill: Extract Embedded Data -> Dedicated Collections",
  );
  console.log(
    `   Mode: ${dryRun ? "DRY RUN (pass --execute to apply)" : "EXECUTING CHANGES"}\n`,
  );

  await mongoose.connect(
    process.env.MONGO_URI_SHARED || process.env.MONGO_URI,
    {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  );
  console.log("✅ Connected to Master Database\n");

  let totalRx = 0;
  let totalIP = 0;

  // 1. Migrate Shared Database
  try {
    const sharedConn = await getSharedConnection();
    const res = await migrateConnection(sharedConn, "hms_shared");
    totalRx += res.prescriptionsMigrated;
    totalIP += res.ipAdmissionsMigrated;
  } catch (err) {
    console.warn("   ⚠️ hms_shared migration error:", err.message);
  }

  // 2. Migrate all Isolated Tenant Databases
  const hospitals = await Hospital.find({
    $or: [{ tenancyMode: "isolated" }, { tenancyMode: { $exists: false } }],
  }).select("_id name code");

  for (const h of hospitals) {
    try {
      const conn = await getTenantConnection(h._id.toString());
      const res = await migrateConnection(
        conn,
        `hms_hospital_${h._id} (${h.code})`,
      );
      totalRx += res.prescriptionsMigrated;
      totalIP += res.ipAdmissionsMigrated;
    } catch (err) {
      console.warn(`   ⚠️ ${h.code}: ${err.message}`);
    }
  }

  console.log(`\n========================================`);
  console.log(
    `🎉 Total Migrated: ${totalRx} Prescriptions, ${totalIP} IP Admissions`,
  );
  console.log(`========================================\n`);

  if (dryRun) {
    console.log("⚠️ DRY RUN complete. Run with --execute to apply changes.");
  } else {
    console.log(
      "✅ Backfill migration complete! Dedicated collections populated.",
    );
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Migration error:", err);
  process.exit(1);
});
