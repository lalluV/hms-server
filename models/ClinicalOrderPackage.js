const mongoose = require("mongoose");

const clinicalOrderPackageSchema = new mongoose.Schema(
  {},
  { strict: false, timestamps: true }
);

module.exports = mongoose.model(
  "ClinicalOrderPackage",
  clinicalOrderPackageSchema
);
