const mongoose = require("mongoose");

const indentStoreSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    indentId: { type: String, required: true },
    patientId: { type: String, required: true },
    patientName: { type: String },
    patientPhone: { type: String },
    items: [mongoose.Schema.Types.Mixed],
    totalAmount: { type: Number },
    doctorData: { type: mongoose.Schema.Types.Mixed },
    active: { type: Boolean, default: true },
    payment: { type: String },
    paymentStatus: { type: String },
    paid: { type: String },
    due: { type: String },
    type: { type: String, default: "pharmacy-Indent" },
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

module.exports = mongoose.model("IndentStore", indentStoreSchema);
