const mongoose = require("mongoose");

const certificateSchema = new mongoose.Schema(
  {
    certificateNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      index: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      index: true,
    },
    patientName: { type: String, required: true },
    UMRNo: { type: String, required: true, index: true },
    phone: { type: String },
    age: { type: String },
    gender: { type: String },
    address: { type: String },

    type: {
      type: String,
      enum: [
        "essentiality_a", // OPD Essentiality Certificate
        "essentiality_b", // IPD Hospitalized Essentiality Certificate
        "medical_sick_leave", // Sick Leave Medical Certificate
        "fitness", // Physical Fitness Certificate
        "referral", // Referral Letter / Certificate
        "custom",
      ],
      required: true,
      index: true,
    },
    title: { type: String, required: true },

    // Doctor & Department
    doctorId: { type: String },
    doctorName: { type: String, required: true },
    doctorRegNo: { type: String },
    department: { type: String },

    // Specific Payloads
    diagnosis: { type: String },
    
    // For Essentiality Certificates (Form A & B)
    admissionId: { type: String },
    admissionDate: { type: String },
    dischargeDate: { type: String },
    reimbursementRule: {
      type: String,
      default: "CS(MA) / CGHS / State Govt Rules",
    },
    medicines: [
      {
        name: { type: String },
        batchNo: { type: String },
        quantity: { type: Number },
        price: { type: Number },
        nonAvailabilityCertified: { type: Boolean, default: true },
      },
    ],
    labTests: [
      {
        testName: { type: String },
        price: { type: Number },
        date: { type: String },
      },
    ],
    procedures: [
      {
        name: { type: String },
        price: { type: Number },
      },
    ],
    totalClaimAmount: { type: Number, default: 0 },

    // For Medical / Sick Leave
    leaveFrom: { type: String },
    leaveTo: { type: String },
    totalDays: { type: Number },
    expectedFitDate: { type: String },
    identificationMarks: { type: String },

    // For Fitness Certificate
    fitFrom: { type: String },
    purpose: { type: String },
    physicalFindings: { type: String },

    // Custom text / General
    bodyText: { type: String },
    remarks: { type: String },

    // Lifecycle
    status: {
      type: String,
      enum: ["issued", "draft", "cancelled"],
      default: "issued",
    },
    issuedDate: {
      type: String,
      required: true,
    },
    issuedBy: { type: String },
    whatsappSent: { type: Boolean, default: false },
    whatsappSentAt: { type: Date },
  },
  { timestamps: true }
);

certificateSchema.index({ hospitalId: 1, type: 1, issuedDate: -1 });
certificateSchema.index({ hospitalId: 1, UMRNo: 1 });

module.exports = mongoose.model("Certificate", certificateSchema);
