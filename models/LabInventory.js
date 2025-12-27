const mongoose = require("mongoose");

const labInventorySchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      index: true,
    },
    labItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MasterLabItem",
      index: true,
      // Optional - for lab items created from master
    },
    // Legacy fields - kept for backward compatibility, will be populated from MasterLabItem
    name: { type: String, required: true },
    item_code: { type: String, required: true, index: true },
    category: { type: String },
    description: { type: String },
    manufacturer: { type: String },
    type: { type: String },
    unit: { type: String },
    // Hospital-specific inventory data
    active: { type: Boolean, default: true },
    batches: [mongoose.Schema.Types.Mixed], // Batches contain mrp, rate, purchase_price, etc.
    orderingNumber: { type: Number },
  },
  { strict: true, timestamps: true }
);

// Compound index for faster queries
labInventorySchema.index({ hospitalId: 1, labItemId: 1 });
labInventorySchema.index({ hospitalId: 1, active: 1 });

module.exports = mongoose.model("LabInventory", labInventorySchema);
