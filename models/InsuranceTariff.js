const mongoose = require("mongoose");

const InsuranceTariffSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    companyId: { type: String, required: true },
    companyName: { type: String },
    coveragePercentage: { type: Number },
    coverageLimit: { type: Number },
    deductible: { type: Number },
    wardCoveragePercentage: { type: Number },
    wardCoverageLimit: { type: Number },
    wardDeductible: { type: Number },
    consultationCoveragePercentage: { type: Number },
    consultationCoverageLimit: { type: Number },
    consultationDeductible: { type: Number },
    investigationCoveragePercentage: { type: Number },
    investigationCoverageLimit: { type: Number },
    investigationDeductible: { type: Number },
    procedureCoveragePercentage: { type: Number },
    procedureCoverageLimit: { type: Number },
    procedureDeductible: { type: Number },
    pharmacyCoveragePercentage: { type: Number },
    pharmacyCoverageLimit: { type: Number },
    pharmacyDeductible: { type: Number },
    validityFrom: { type: String },
    validityTo: { type: String },
    description: { type: String },
  },
  { strict: true, timestamps: true }
);

module.exports = mongoose.model("InsuranceTariff", InsuranceTariffSchema);
