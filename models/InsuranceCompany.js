const mongoose = require("mongoose");

const insuranceCompanySchema = new mongoose.Schema({}, { strict: false });

// Update the updatedAt timestamp before saving
insuranceCompanySchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("InsuranceCompany", insuranceCompanySchema);
