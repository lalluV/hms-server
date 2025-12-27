const mongoose = require("mongoose");

const InsuranceExclusionSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    companyId: { type: String, required: true },
    companyName: { type: String },
    excludedService: { type: String },
    excludedCondition: { type: String },
    description: { type: String },
    status: { type: String, default: "active" },
  },
  { strict: true, timestamps: true }
);

module.exports = mongoose.model("InsuranceExclusion", InsuranceExclusionSchema);
