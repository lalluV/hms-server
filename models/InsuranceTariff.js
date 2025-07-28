const mongoose = require("mongoose");

const InsuranceTariffSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("InsuranceTariff", InsuranceTariffSchema);
