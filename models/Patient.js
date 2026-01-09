const mongoose = require("mongoose");

// Create a counter schema for UMR numbers
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model("Counter", counterSchema);

const patientSchema = new mongoose.Schema(
  {
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
    name: { type: String, required: true },
    gender: { type: String, required: true },
    age: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String },
    street_address: { type: String },
    city: { type: String },
    state: { type: String, default: "Telangana" },
    postal_code: { type: String, default: "506002" },
    country: { type: String, default: "India" },
    emergency_contact_name: { type: String },
    emergency_contact_relationship: { type: String },
    emergency_phone: { type: String },
    emergency_signature: { type: String },
    patient_type: { type: String, default: "OP" },
    patient_status: { type: String },
    paymentMethod: { type: String, default: "Personal" },
    insurance_provider: { type: String },
    insurance_providerId: { type: String },
    policy_number: { type: String },
    coPayPercentage: { type: Number, default: 0 },
    coPayLimit: { type: Number, default: 0 },
    coPayType: { type: String, default: "percentage" },
    coverage: { type: String },
    expiry_date: { type: String },
    active: { type: Boolean, default: true },
    registered_by: { type: String },
    registration_date: { type: String },
    appointment_date: { type: String },
    admissionDate: { type: String },
    admissionTime: { type: String },
    mlcNo: { type: String },
    consultantDoctor: { type: String },
    doctorId: { type: String },
    medicalOfficerName: { type: String },
    medicalOfficerId: { type: String },
    consultantHistory: [
      {
        consultantId: String,
        consultantName: String,
        role: String,
        startDate: String,
        endDate: String,
        reason: String,
      },
    ],
    patientRepresentiveOfficer: { type: String },
    wardName: { type: String },
    wardId: { type: String },
    selectedBed: { type: String },
    dischargeTo: { type: String },
    transfers: [
      {
        price: Number,
        transferDate: String,
        wardId: String,
        wardName: String,
      },
    ],
    commissionEarnerType: { type: String },
    commissionEarnerId: { type: String },
    commissionEarnerName: { type: String },
    commissionRates: {
      consultation: { type: Number },
      surgery: { type: Number },
      pharmacy: { type: Number },
      lab: { type: Number },
    },
    vitals: [
      {
        time: String,
        temperature: String,
        heartRate: String,
        bloodPressure: String,
        respiratoryRate: String,
        spo2: String,
        grbs: String,
        urineOutput: String,
        modifiedBy: [
          {
            user: String,
            type: { type: String },
            modifiedTime: String,
          },
        ],
      },
    ],
    chiefComplaintsPresentIllnessHistory: { type: String },
    pastMedicalHistory: { type: String },
    pastMedications: { type: String },
    consciousness: { type: String },
    gcs: { type: String },
    pupils: { type: String },
    height: { type: String },
    weight: { type: String },
    doctorNotes: [mongoose.Schema.Types.Mixed],
    nurseNotes: [mongoose.Schema.Types.Mixed],
    systemicExamination: { type: String },
    personalHistory: {
      alcohol: { type: Boolean, default: false },
      smoking: { type: Boolean, default: false },
      illicitDrugs: { type: Boolean, default: false },
      other: { type: String },
    },
    provisionalDiagnosis: { type: String },
    allergiesHistory: { type: String },
    investigations: [mongoose.Schema.Types.Mixed],
    treatment: [mongoose.Schema.Types.Mixed],
    casualtyTreatment: [mongoose.Schema.Types.Mixed],
    insulinChart: [mongoose.Schema.Types.Mixed],
    dischargeOrders: { type: String },
    counselling: { type: String },
    symptoms: [String],
    prescriptions: [mongoose.Schema.Types.Mixed],
    modifiedBy: [
      {
        user: String,
        type: { type: String },
        modifiedTime: String,
      },
    ],
  },
  { strict: true, timestamps: true }
);

// Fix for 'type' field in modifiedBy if needed, but since strict: false, it might pass.
// However, to be correct in Schema definition:
patientSchema.path("modifiedBy").schema.path("type").options.type = String;
// Or better definition above:
// modifiedBy: [{ user: String, type: { type: String }, modifiedTime: String }]

// Pre-save middleware to generate UMR number
patientSchema.pre("save", async function (next) {
  if (this.isNew) {
    try {
      const counter = await Counter.findByIdAndUpdate(
        { _id: "UMRNo" },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      this.UMRNo = `UMR${String(counter.seq).padStart(8, "0")}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

module.exports = mongoose.model("Patient", patientSchema);
