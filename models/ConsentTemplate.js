const mongoose = require("mongoose");

const consentTemplateSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("ConsentTemplate", consentTemplateSchema);
