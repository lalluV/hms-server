const mongoose = require("mongoose");

const parameterSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      index: true,
    },
    parameterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MasterParameter",
      index: true,
      // Optional - for parameters created from master
    },
    name: { type: String, required: true },
    normal_range: {
      adult_male: { type: String },
      adult_female: { type: String },
      child: { type: String },
    },
    units: { type: String, required: true },
    critical_values: {
      low: { type: String },
      high: { type: String },
    },
    category: { type: String },
    isCustom: {
      type: Boolean,
      default: false,
      // true if parameter was created without master reference
    },
    active: { type: Boolean, default: true },
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

// Compound index for faster queries
parameterSchema.index({ hospitalId: 1, parameterId: 1 });
parameterSchema.index({ hospitalId: 1, active: 1 });

module.exports = mongoose.model("Parameter", parameterSchema);
