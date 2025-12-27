const mongoose = require("mongoose");

const masterMedicineSchema = new mongoose.Schema(
  {
    item_code: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    generic_name: {
      type: String,
      required: true,
      index: true,
    },
    generic_name2: { type: String },
    pack: { type: String },
    manufacturer: {
      type: String,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "Tablet",
        "Syrup",
        "Injection",
        "Ointment",
        "Capsules",
        "Gel",
        "Sachet",
        "Syringe",
        "Other",
      ],
      default: "Tablet",
    },
    description: { type: String },
    hsn_code: { type: String },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: { type: String }, // Admin user ID
    modifiedBy: [
      {
        user: String,
        type: { type: String },
        modifiedTime: String,
      },
    ],
  },
  {
    strict: true,
    timestamps: true,
    collection: "mastermedicines",
  }
);

// Compound index for faster searches
masterMedicineSchema.index({ generic_name: 1, manufacturer: 1, pack: 1 });
masterMedicineSchema.index({ active: 1, generic_name: 1 });

module.exports = mongoose.model("MasterMedicine", masterMedicineSchema);
