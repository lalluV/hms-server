const mongoose = require("mongoose");

const pharmacyReceiptSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    receiptId: { type: String },
    items: [mongoose.Schema.Types.Mixed],
    totalAmount: { type: Number },
    baseTotalAmount: { type: Number },
    paymentStatus: { type: String },
    paymentType: { type: String },
    type: { type: String },
    pharmacy: { type: String, default: "pharmacy1" },
    discount: { type: Number },
    paymentSplit: { type: mongoose.Schema.Types.Mixed }, // Or specific object structure if consistent
    description: { type: String },

    // Purchase specific
    vendorData: { type: mongoose.Schema.Types.Mixed },
    payment: { type: String },
    paid: { type: String },
    due: { type: String },
    paymentMethod: { type: String },
    paymentReference: { type: String },
    dueDate: { type: String },

    // Sale specific
    patientId: { type: String },
    patientName: { type: String },
    patientPhone: { type: String },
    doctorData: { type: mongoose.Schema.Types.Mixed },

    // Visit / stay scope (Phase B)
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

module.exports = mongoose.model("PharmacyReceipt", pharmacyReceiptSchema);
