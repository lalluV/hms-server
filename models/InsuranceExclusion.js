const mongoose = require("mongoose");

const InsuranceExclusionSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("InsuranceExclusion", InsuranceExclusionSchema);
