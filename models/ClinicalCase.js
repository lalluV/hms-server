const mongoose = require("mongoose");

const clinicalCaseMedicineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    dosage: { type: String, default: "" },
    frequency: { type: mongoose.Schema.Types.Mixed, default: null },
    duration: { type: mongoose.Schema.Types.Mixed, default: null },
    directions: { type: String, default: "" },
    type: { type: String, default: "" },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const clinicalCaseLabSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
  },
  { _id: false },
);

const clinicalCaseSchema = new mongoose.Schema(
  {
    hospitalId: { type: String, required: true, index: true },
    doctorId: { type: String, required: true, index: true },
    umr: { type: String, default: "", index: true },
    prescriptionId: { type: String, required: true },
    visitDate: { type: Date, default: null },
    complaints: [{ type: String }],
    history: [{ type: String }],
    examination: [{ type: String }],
    diagnosis: [{ type: String }],
    advice: [{ type: String }],
    procedures: [{ type: String }],
    searchText: { type: String, default: "" },
    searchTokens: [{ type: String }],
    medicines: [clinicalCaseMedicineSchema],
    labs: [clinicalCaseLabSchema],
    patientAge: { type: String, default: "" },
    patientGender: { type: String, default: "" },
    source: {
      type: String,
      enum: ["prescription", "package"],
      default: "prescription",
    },
  },
  { timestamps: true },
);

clinicalCaseSchema.index(
  { hospitalId: 1, doctorId: 1, prescriptionId: 1, umr: 1 },
  { unique: true },
);
clinicalCaseSchema.index({ hospitalId: 1, doctorId: 1, visitDate: -1 });

module.exports = mongoose.model("ClinicalCase", clinicalCaseSchema);
