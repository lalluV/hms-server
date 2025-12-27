const mongoose = require("mongoose");

const masterLabItemSchema = new mongoose.Schema(
  {
    item_code: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      index: true,
    },
    category: {
      type: String,
      index: true,
    },
    manufacturer: {
      type: String,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "Reagent",
        "Consumable",
        "Equipment",
        "Kit",
        "Strip",
        "Chemical",
        "Other",
      ],
      default: "Reagent",
    },
    unit: { type: String },
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
    collection: "masterlabitems",
  }
);

// Compound index for faster searches
masterLabItemSchema.index({ name: 1, manufacturer: 1, category: 1 });
masterLabItemSchema.index({ active: 1, name: 1 });

module.exports = mongoose.model("MasterLabItem", masterLabItemSchema);

