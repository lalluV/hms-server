const mongoose = require("mongoose");

const pharmacyInventorySchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      index: true,
    },
    medicineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MasterMedicine",
      index: true,
      // Not required initially for backward compatibility during migration
    },
    // Legacy fields - kept for backward compatibility, will be populated from MasterMedicine
    item_code: { type: String, required: true, index: true },
    generic_name: { type: String },
    generic_name2: { type: String },
    pack: { type: String },
    manufacturer: { type: String },
    type: { type: String },
    description: { type: String },
    // Hospital-specific inventory data
    active: { type: Boolean, default: true },
    batches: [mongoose.Schema.Types.Mixed],
    orderingNumber: { type: Number },
    price_history: [mongoose.Schema.Types.Mixed],
  },
  { strict: true, timestamps: true, collection: "pharmacyinventory" }
);

// Compound index for faster queries
pharmacyInventorySchema.index({ hospitalId: 1, medicineId: 1 });
pharmacyInventorySchema.index({ hospitalId: 1, active: 1 });

module.exports = mongoose.model("PharmacyInventory", pharmacyInventorySchema);
