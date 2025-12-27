const mongoose = require("mongoose");

const diagnosticsReceiptSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    receiptId: { type: String, unique: true, required: true },
    patientId: { type: String },
    patientName: { type: String },
    patientPhone: { type: String },
    doctorData: { type: Object },
    items: [mongoose.Schema.Types.Mixed], // Flexible schema to support both lab-sale and lab-purchase items
    totalAmount: { type: Number },
    baseTotalAmount: { type: Number },
    discount: { type: Number },
    paymentStatus: { type: String },
    paymentType: { type: String },
    paymentSplit: { type: Object },
    overallStatus: { type: String },
    totalTests: { type: Number },
    completedTests: { type: Number },
    type: { type: String },

    // Purchase specific
    vendorData: { type: mongoose.Schema.Types.Mixed },
    payment: { type: String },
    paid: { type: String },
    due: { type: String },
    paymentMethod: { type: String },
    paymentReference: { type: String },
    dueDate: { type: String },

    modifiedBy: [
      {
        user: String,
        type: { type: String },
        modifiedTime: String,
      },
    ],
  },
  { strict: true, timestamps: true }
);

const DiagnosticsReceipt = mongoose.model(
  "DiagnosticsReceipt",
  diagnosticsReceiptSchema
);

module.exports = DiagnosticsReceipt;
