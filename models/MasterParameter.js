const mongoose = require("mongoose");

const masterParameterSchema = new mongoose.Schema(
  {
    parameter_code: {
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
    units: {
      type: String,
      required: true,
    },
    default_normal_range: {
      adult_male: { type: String },
      adult_female: { type: String },
      child: { type: String },
    },
    default_critical_values: {
      low: { type: String },
      high: { type: String },
    },
    category: {
      type: String,
      index: true,
    },
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
    collection: "masterparameters",
  }
);

// Compound index for faster searches
masterParameterSchema.index({ name: 1, category: 1 });
masterParameterSchema.index({ active: 1, name: 1 });

module.exports = mongoose.model("MasterParameter", masterParameterSchema);

