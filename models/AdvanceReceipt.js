const mongoose = require("mongoose");

const advanceReceiptSchema = new mongoose.Schema(
  {
    receiptId: { type: String, required: true },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    patientId: { type: String, required: true },
    patientName: { type: String },
    patientPhone: { type: String },
    advanceAmount: { type: Number, required: true },
    totalAmount: { type: Number },
    remarks: { type: String },
    paymentStatus: { type: String },
    type: { type: String, default: "advance" },

    // Visit / stay scope (Phase B) — advances usually attach to IP stay
    visitType: { type: String, default: null },
    prescriptionId: { type: String, default: null },
    admissionId: { type: String, default: null },
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

module.exports = mongoose.model("AdvanceReceipt", advanceReceiptSchema);
