const mongoose = require("mongoose");

// Create a counter schema for UMR numbers
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter =
  mongoose.models.Counter || mongoose.model("Counter", counterSchema);

const patientSchema = new mongoose.Schema(
  {
    // Permanent Identifiers
    UMRNo: {
      type: String,
      unique: true,
      required: false,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    /** Deterministic identity for public OP self-registration dedupe */
    publicRegistrationKey: { type: String },

    // Personal Demographics
    name: { type: String, required: true },
    gender: { type: String, required: true },
    age: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String },

    // Address
    street_address: { type: String },
    city: { type: String },
    state: { type: String, default: "Telangana" },
    postal_code: { type: String, default: "506002" },
    country: { type: String, default: "India" },

    // Emergency Contact
    emergency_contact_name: { type: String },
    emergency_contact_relationship: { type: String },
    emergency_phone: { type: String },
    emergency_signature: { type: String },

    // Permanent Baseline Medical History
    allergiesHistory: { type: String },
    pastMedicalHistory: { type: String },
    pastMedications: { type: String },
    personalHistory: {
      alcohol: { type: Boolean, default: false },
      smoking: { type: Boolean, default: false },
      illicitDrugs: { type: Boolean, default: false },
      other: { type: String },
      maritalStatus: { type: String },
      familyHistory: { type: String },
    },

    // Saved Default Insurance Profile (Autofills on OP / IP visits)
    paymentMethod: { type: String, default: "Personal" },
    insurance_provider: { type: String },
    insurance_providerId: { type: String },
    policy_number: { type: String },
    coPayPercentage: { type: Number, default: 0 },
    coPayLimit: { type: Number, default: 0 },
    coPayType: { type: String, default: "percentage" },
    coverage: { type: String },
    expiry_date: { type: String },

    // Current State & Pointers
    patient_type: {
      type: String,
      enum: ["OP", "IP", "OPtoIP"],
      default: "OP",
    },
    active: { type: Boolean, default: true },
    activeAdmissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IPAdmission",
      default: null,
    },

    // Optional vitals snapshot (also on visit/admission)
    weight: { type: String },
    height: { type: String },

    // Registration & Audit
    registered_by: { type: String },
    registration_date: { type: String },
    appointment_date: { type: String },
    modifiedBy: [
      {
        user: String,
        type: { type: String },
        modifiedTime: String,
      },
    ],
  },
  { strict: true, timestamps: true },
);

patientSchema.index({ hospitalId: 1, phone: 1 });
patientSchema.index({ hospitalId: 1, UMRNo: 1 }, { unique: true });
patientSchema.index({ hospitalId: 1, active: 1, patient_type: 1 });
patientSchema.index(
  { hospitalId: 1, publicRegistrationKey: 1 },
  {
    unique: true,
    sparse: true,
    name: "hospitalId_publicRegistrationKey_unique",
  },
);

// Pre-save middleware to generate UMR number
patientSchema.pre("save", async function (next) {
  if (this.isNew && !this.UMRNo) {
    try {
      const counter = await Counter.findByIdAndUpdate(
        { _id: "UMRNo" },
        { $inc: { seq: 1 } },
        { new: true, upsert: true },
      );
      this.UMRNo = `UMR${String(counter.seq).padStart(8, "0")}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

module.exports =
  mongoose.models.Patient || mongoose.model("Patient", patientSchema);
