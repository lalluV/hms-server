const mongoose = require("mongoose");

const diagnosticSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      index: true,
    },
    diagnosticId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MasterDiagnostic",
      index: true,
      // Optional - for diagnostics created from master
    },
    code: { type: String },
    name: { type: String, required: true },
    deptname: { type: String },
    subdeptname: { type: String },
    description: { type: String },
    mrp: { type: Number },
    price: { type: Number },
    fasting: { type: String },
    reportsIn: { type: String },
    type: { type: String },
    visitType: { type: String },
    /** For type === "Package": catalog tests included in this package */
    includedTests: [mongoose.Schema.Types.Mixed],
    parameters: [mongoose.Schema.Types.Mixed],
    testInstructions: [String],
    active: { type: Boolean, default: true },
    isCustom: {
      type: Boolean,
      default: false,
      // true if diagnostic was created without master reference
    },
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

// Compound index for faster queries
diagnosticSchema.index({ hospitalId: 1, diagnosticId: 1 });
diagnosticSchema.index({ hospitalId: 1, active: 1 });

module.exports = mongoose.model("Diagnostic", diagnosticSchema);
