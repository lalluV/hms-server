const mongoose = require("mongoose");

/**
 * Define all tenant model schemas
 * These schemas will be registered with tenant connections dynamically
 */

// Patient Schema
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

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

// Pre-save middleware for UMR number generation
patientSchema.pre("save", async function (next) {
  if (this.isNew) {
    try {
      const Counter = this.db.model("Counter");
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

// Staff Schema
const staffSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, required: true },
    userId: { type: String, unique: true },
    password: { type: String },
    name: { type: String, required: true },
    email: { type: String },
    phone: { type: String },
    gender: { type: String },
    dateOfBirth: { type: String },
    joinDate: { type: String },
    location: { type: String },
    position: { type: String },
    qualification: { type: String },
    specialization: { type: String },
    active: { type: Boolean, default: true },
    type: { type: String, required: true },
    department: { type: String },
    imgUrl: { type: String },
    signatureUrl: { type: String },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    opCharges: { type: String },
    ipCharges: { type: String },
    licenseNumber: { type: String },
    labCertification: { type: String },
    adminLevel: { type: String },
    receptionistId: { type: String },
    accountantId: { type: String },
    hrManagerId: { type: String },
    itSupportId: { type: String },
    createdAt: { type: String },
    createdAtOriginal: { type: String },
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

/**
 * Register all tenant models with a given connection
 * @param {mongoose.Connection} connection - Tenant database connection
 */
function registerTenantModels(connection) {
  // Register Counter model (needed for UMR generation)
  if (!connection.models.Counter) {
    connection.model("Counter", counterSchema);
  }

  // Register Patient model
  if (!connection.models.Patient) {
    connection.model("Patient", patientSchema);
  }

  // Register Staff model
  if (!connection.models.Staff) {
    connection.model("Staff", staffSchema);
  }

  // Register all other tenant models from their model files
  // This prevents "Schema hasn't been registered" errors
  const modelFiles = [
    { name: "Consultation", path: "../models/Consultation" },
    { name: "Diagnostic", path: "../models/Diagnostic" },
    { name: "PharmacyInventory", path: "../models/PharmacyInventory" },
    { name: "LabInventory", path: "../models/LabInventory" },
    { name: "Appointment", path: "../models/Appointment" },
    { name: "Department", path: "../models/Department" },
    { name: "Ward", path: "../models/Ward" },
    { name: "Shift", path: "../models/Shift" },
    { name: "Leave", path: "../models/Leave" },
    { name: "Holiday", path: "../models/Holiday" },
    { name: "Expense", path: "../models/Expense" },
    { name: "PharmacyReceipt", path: "../models/PharmacyReceipt" },
    { name: "DiagnosticsReceipt", path: "../models/DiagnosticsReceipt" },
    { name: "AdvanceReceipt", path: "../models/AdvanceReceipt" },
    { name: "Consent", path: "../models/Consent" },
    { name: "ConsentTemplate", path: "../models/ConsentTemplate" },
    { name: "InsuranceCompany", path: "../models/InsuranceCompany" },
    { name: "InsuranceTariff", path: "../models/InsuranceTariff" },
    { name: "InsuranceExclusion", path: "../models/InsuranceExclusion" },
    { name: "Vendor", path: "../models/Vendor" },
    { name: "Stamp", path: "../models/Stamp" },
    { name: "NurseDesc", path: "../models/NurseDesc" },
    { name: "Action", path: "../models/Action" },
    { name: "IndentStore", path: "../models/IndentStore" },
    { name: "DiagnosticsUser", path: "../models/DiagnosticsUser" },
    { name: "PatientCommissionLink", path: "../models/PatientCommissionLink" },
    { name: "Parameter", path: "../models/Parameter" },
    // DischargeSummary model doesn't exist yet - will be added when created
  ];

  // Register each model if not already registered
  for (const { name, path } of modelFiles) {
    if (!connection.models[name]) {
      try {
        // Require the model file (it's a compiled Mongoose model)
        const Model = require(path);

        // Extract the schema from the compiled model
        // Mongoose models have a .schema property that contains the original schema
        if (Model && Model.schema) {
          connection.model(name, Model.schema);
          // console.log(`✅ Registered model: ${name}`);
        } else {
          console.warn(`⚠️  Model ${name} doesn't have a schema property`);
        }
      } catch (error) {
        // Model file doesn't exist or has errors - skip it
        // This is not critical - the app will continue to work
        console.warn(`⚠️  Could not register model ${name}: ${error.message}`);
      }
    }
  }

  return connection;
}

/**
 * Get a list of all tenant model names
 * These are the models that should exist in tenant databases
 */
const TENANT_MODELS = [
  "Patient",
  "Staff",
  "Consultation",
  "Diagnostic",
  "PharmacyInventory",
  "LabInventory",
  "Appointment",
  "Department",
  "Ward",
  "Shift",
  "Leave",
  "Holiday",
  "Expense",
  "PharmacyReceipt",
  "DiagnosticsReceipt",
  "AdvanceReceipt",
  "Consent",
  "ConsentTemplate",
  "InsuranceCompany",
  "InsuranceTariff",
  "InsuranceExclusion",
  "Vendor",
  "Stamp",
  "NurseDesc",
  "Action",
  "IndentStore",
  "DiagnosticsUser",
  "PatientCommissionLink",
  "Parameter",
];

/**
 * Helper function to get a model from a tenant connection
 * @param {mongoose.Connection} connection - Tenant database connection
 * @param {string} modelName - Name of the model to get
 * @returns {mongoose.Model} The model instance
 */
function getTenantModel(connection, modelName) {
  if (!connection) {
    throw new Error("Tenant connection is required");
  }

  if (!connection.models[modelName]) {
    throw new Error(
      `Model ${modelName} is not registered on this connection. Please check registerTenantModels().`
    );
  }

  return connection.models[modelName];
}

module.exports = {
  registerTenantModels,
  getTenantModel,
  TENANT_MODELS,
  // Export schemas for reference
  schemas: {
    counterSchema,
    patientSchema,
    staffSchema,
  },
};
