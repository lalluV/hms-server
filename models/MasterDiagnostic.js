const mongoose = require("mongoose");

const masterDiagnosticSchema = new mongoose.Schema(
  {
    test_code: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      index: true,
    },
    deptname: {
      type: String,
      index: true,
    },
    subdeptname: { type: String },
    description: { type: String },
    default_fasting: { type: String },
    default_reportsIn: { type: String },
    default_testInstructions: [String],
    suggested_parameters: [
      {
        parameterId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "MasterParameter",
        },
        order: { type: Number, default: 0 }, // Order in which parameters should appear
      },
    ],
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: { type: String }, // Admin user ID
    modifiedBy: [
      {
        user: String,
        type: { type: String },
        modifiedTime: String,
      },
    ],
  },
  {
    strict: true,
    timestamps: true,
    collection: "masterdiagnostics",
  }
);

// Compound index for faster searches
masterDiagnosticSchema.index({ name: 1, deptname: 1 });
masterDiagnosticSchema.index({ active: 1, name: 1 });

module.exports = mongoose.model("MasterDiagnostic", masterDiagnosticSchema);

