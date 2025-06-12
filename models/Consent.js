const mongoose = require("mongoose");

const consentSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Consent", consentSchema);
