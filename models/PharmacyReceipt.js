const mongoose = require("mongoose");

const pharmacyReceiptSchema = new mongoose.Schema({}, { strict: false });

const PharmacyReceipt = mongoose.model(
  "PharmacyReceipt",
  pharmacyReceiptSchema
);

module.exports = PharmacyReceipt;
