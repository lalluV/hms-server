const mongoose = require("mongoose");

const consultationSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    patientId: {
      type: String,
      ref: "Patient",
      required: true,
    },
    patientName: { type: String },
    patientPhone: { type: String },
    items: [mongoose.Schema.Types.Mixed],
    totalAmount: { type: Number },
    baseTotalAmount: { type: Number },
    doctorData: { type: mongoose.Schema.Types.Mixed },
    receiptId: { type: String },
    paymentStatus: { type: String, default: "pending" },
    paymentType: { type: String },
    type: { type: String },
    discount: { type: Number },
    paymentSplit: { type: mongoose.Schema.Types.Mixed }, // Or specific object structure if consistent
    modifiedBy: [
      {
        user: String,
        type: { type: String },
        modifiedTime: String,
      },
    ],
    createdAt: { type: String },
    updatedAt: { type: String },
  },
  { strict: false, timestamps: true }
);

module.exports = mongoose.model("Consultation", consultationSchema);
