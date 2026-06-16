const mongoose = require("mongoose");

const insuranceSettingsSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      unique: true,
    },
    defaultCoveragePercentage: { type: Number, default: 80 },
    defaultCoverageLimit: { type: Number, default: 0 },
    defaultProcessingTime: { type: String, default: "7-10 days" },
    autoCalculateInsurance: { type: Boolean, default: true },
    requirePolicyNumber: { type: Boolean, default: true },
    requiredDocuments: { type: [String], default: [] },
    optionalDocuments: { type: [String], default: [] },
  },
  { strict: true, timestamps: true },
);

module.exports = mongoose.model("InsuranceSettings", insuranceSettingsSchema);
