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
      habitsNil: { type: Boolean, default: false },
      other: { type: String },
      maritalStatus: { type: String },
      familyHistory: { type: String },
    },

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
patientSchema.index({ hospitalId: 1, name: 1 });
patientSchema.index(
  { hospitalId: 1, publicRegistrationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { publicRegistrationKey: { $type: "string" } },
    name: "hospitalId_publicRegistrationKey_partial_unique",
  },
);

// Pre-save middleware to generate a per-hospital UMR number
patientSchema.pre("save", async function (next) {
  if (!this.isNew || this.UMRNo) return next();
  try {
    const CounterModel = this.db.models.Counter || Counter;
    const counterId = `UMRNo:${this.hospitalId}`;
    const existing = await CounterModel.findById(counterId).lean();
    if (!existing) {
      const latest = await this.constructor
        .findOne({ hospitalId: this.hospitalId, UMRNo: /^UMR\d+$/ })
        .sort({ UMRNo: -1 })
        .select("UMRNo")
        .lean();
      const floor = latest?.UMRNo
        ? parseInt(String(latest.UMRNo).replace(/\D/g, ""), 10) || 0
        : 0;
      await CounterModel.updateOne(
        { _id: counterId },
        { $max: { seq: floor } },
        { upsert: true },
      );
    }
    const counter = await CounterModel.findByIdAndUpdate(
      counterId,
      { $inc: { seq: 1 } },
      { new: true },
    );
    this.UMRNo = `UMR${String(counter.seq).padStart(8, "0")}`;
    next();
  } catch (error) {
    next(error);
  }
});

module.exports =
  mongoose.models.Patient || mongoose.model("Patient", patientSchema);
