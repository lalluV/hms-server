const mongoose = require("mongoose");

const actionSchema = new mongoose.Schema(
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
    items: [mongoose.Schema.Types.Mixed],
    totalAmount: { type: Number },
    baseTotalAmount: { type: Number },
    doctorData: { type: mongoose.Schema.Types.Mixed },
    paymentStatus: { type: String },
    type: { type: String, default: "action" },
    discount: { type: Number, default: 0 },
    paymentSplit: {
      UPI: { type: Number, default: 0 },
      cash: { type: Number, default: 0 },
      card: { type: Number, default: 0 },
      bank_transfer: { type: Number, default: 0 },
      cheque: { type: Number, default: 0 },
    },
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

module.exports = mongoose.model("Action", actionSchema);
