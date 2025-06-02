const mongoose = require("mongoose");

const prescriptionSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Prescription", prescriptionSchema);
