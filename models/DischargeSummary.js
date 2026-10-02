const mongoose = require("mongoose");

const dischargeSummarySchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: false,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: false,
    },
    admissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IPAdmission",
      required: false,
    },
    ipNumber: { type: String },
    UMRNo: { type: String, required: true, index: true },

    // Discharge Dates & Stay Duration
    admissionDate: { type: String },
    dischargeDate: { type: String },
    dischargeTime: { type: String },
    lengthOfStay: { type: Number, default: 1 },

    // Clinical Condition & Destination
    dischargeCondition: { type: String, default: "Stable" },
    dischargeDestination: { type: String, default: "Home" },
    dischargeTo: { type: String },
    finalDiagnosis: { type: String },
    hospitalCourse: { type: String },
    dischargeInstructions: { type: String },
    dangerSigns: { type: String },
    followUpPlan: { type: String },
    counselling: { type: String },

    // Dynamic case-tailored clinical sections
    summarySections: [mongoose.Schema.Types.Mixed],

    // Clinical orders. These are the only medication and lab lists.
    dischargeMedications: [mongoose.Schema.Types.Mixed],
    repeatLabs: [mongoose.Schema.Types.Mixed],
    procedures: [mongoose.Schema.Types.Mixed],

    // Generated summary document state
    summary: { type: String },
    summaryType: { type: String, default: "standard" },
    dischargeSummaryStatus: { type: String, default: "draft" },
    dischargeSummaryMeta: mongoose.Schema.Types.Mixed,

    // Audit
    savedBy: {
      id: String,
      name: String,
      role: String,
    },
    lastSavedAt: { type: Date, default: Date.now },
  },
  { strict: true, timestamps: true }
);

dischargeSummarySchema.index({ hospitalId: 1, UMRNo: 1 });
// One summary per admission; existing duplicates must be merged before this index can build.
dischargeSummarySchema.index(
  { hospitalId: 1, admissionId: 1 },
  {
    unique: true,
    partialFilterExpression: { admissionId: { $type: "objectId" } },
    name: "one_summary_per_admission",
  },
);

module.exports = mongoose.model("DischargeSummary", dischargeSummarySchema);
