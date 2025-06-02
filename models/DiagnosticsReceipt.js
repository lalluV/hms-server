const mongoose = require("mongoose");

const diagnosticsReceiptSchema = new mongoose.Schema({}, { strict: false });

// Add indexes for frequently queried fields
diagnosticsReceiptSchema.index({ patientId: 1 });
diagnosticsReceiptSchema.index({ type: 1 });
diagnosticsReceiptSchema.index({ status: 1 });
diagnosticsReceiptSchema.index({ createdAt: 1 });

const DiagnosticsReceipt = mongoose.model(
  "DiagnosticsReceipt",
  diagnosticsReceiptSchema
);

module.exports = DiagnosticsReceipt;
