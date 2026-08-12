const mongoose = require("mongoose");

const prescriptionSchema = new mongoose.Schema(
  {
    prescriptionId: { type: String, required: true },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: true,
    },
    UMRNo: { type: String, required: true },

    // Doctor Details
    doctorId: { type: String, required: true },
    doctorName: { type: String },
    /** Frontend display name (synced with doctorName) */
    consultantDoctor: { type: String },
    department: { type: String },
    date: { type: String, required: true },

    // OP Clinical Snapshot (this visit only)
    // allergies / pastMedicalHistory live on master Patient — not stored here
    symptoms: { type: mongoose.Schema.Types.Mixed, default: "" },
    provisionalDiagnosis: { type: String },
    weight: { type: String },
    height: { type: String },
    vitals: [mongoose.Schema.Types.Mixed],
    doctorNotes: [mongoose.Schema.Types.Mixed],
    nurseNotes: [mongoose.Schema.Types.Mixed],
    diagnosticData: [mongoose.Schema.Types.Mixed],

    // Prescribed Medicines (includes pharmacyBilled / indentSent flags)
    medicineData: [mongoose.Schema.Types.Mixed],

    // Insurance for THIS OP Visit
    paymentMethod: { type: String, default: "Personal" },
    insurance_provider: { type: String },
    insurance_providerId: { type: String },
    policy_number: { type: String },
    coPayPercentage: { type: Number, default: 0 },
    coPayLimit: { type: Number, default: 0 },
    coPayType: { type: String, default: "percentage" },
    coverage: { type: String },
    expiry_date: { type: String },

    // Commission / Referral for THIS OP Visit
    commissionEarnerType: { type: String },
    commissionEarnerId: { type: String },
    commissionEarnerName: { type: String },
    commissionRates: {
      consultation: { type: Number },
      surgery: { type: Number },
      pharmacy: { type: Number },
      lab: { type: Number },
    },

    // Pharmacy & Dispensing Lifecycle
    pharmacyStatus: {
      type: String,
      enum: ["pending", "dispensed", "partially_dispensed", "cancelled"],
      default: "pending",
    },
    receiptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PharmacyReceipt",
    },
    dispensedAt: { type: Date },
    dispensedBy: { type: String },
  },
  { strict: true, timestamps: true },
);

prescriptionSchema.index({ hospitalId: 1, patientId: 1, createdAt: -1 });
prescriptionSchema.index({ hospitalId: 1, pharmacyStatus: 1, createdAt: -1 });
prescriptionSchema.index({ hospitalId: 1, doctorId: 1, date: -1 });
prescriptionSchema.index({ hospitalId: 1, prescriptionId: 1 }, { unique: true });

module.exports = mongoose.model("Prescription", prescriptionSchema);
