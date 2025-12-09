const mongoose = require("mongoose");

const patientCommissionLinkSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model(
  "PatientCommissionLink",
  patientCommissionLinkSchema
);
