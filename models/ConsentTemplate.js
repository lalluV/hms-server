const mongoose = require("mongoose");

const consentTemplateSchema = new mongoose.Schema(
  {},
  { strict: false, timestamps: true }
);

module.exports = mongoose.model("ConsentTemplate", consentTemplateSchema);
