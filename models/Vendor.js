const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    vendorName: { type: String, required: true },
    mobile: { type: String, required: true },
    GST: { type: String, required: true },
    DLNo: { type: String },
    address: { type: String, required: true },
    openingHours: { type: String },
    paymentTerms: { type: String },
    vendorCode: { type: String, required: true },
    bankName: { type: String },
    accountNumber: { type: String },
    ifscCode: { type: String },
    branch: { type: String },
    accountType: { type: String },
    accountHolderName: { type: String },
    status: { type: String, default: "active" },
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

module.exports = mongoose.model("Vendor", vendorSchema);
