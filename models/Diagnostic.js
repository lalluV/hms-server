const mongoose = require("mongoose");

const diagnosticSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Diagnostic", diagnosticSchema);
