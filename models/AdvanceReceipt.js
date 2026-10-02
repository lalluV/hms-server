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
    receiptType: { type: String },
    discount: { type: Number, default: 0 },
    insurance: { type: Number, default: 0 },
    totalBill: { type: Number, default: 0 },
    totalBillAfterDiscount: { type: Number, default: 0 },
    totalPaid: { type: Number, default: 0 },
    wardCharges: { type: Number, default: 0 },
    consultationCharges: { type: Number, default: 0 },
    investigationCharges: { type: Number, default: 0 },
    procedureCharges: { type: Number, default: 0 },
    serviceCharges: { type: Number, default: 0 },
    pharmacyCharges: { type: Number, default: 0 },
    dischargeDate: { type: String },

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
