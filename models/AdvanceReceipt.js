const mongoose = require("mongoose");

const advanceReceiptSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("AdvanceReceipt", advanceReceiptSchema);
