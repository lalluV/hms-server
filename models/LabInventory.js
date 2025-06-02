const mongoose = require("mongoose");

const labInventorySchema = new mongoose.Schema({}, { strict: false });

// Update the updatedAt timestamp before saving
labInventorySchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Update status based on stock level
labInventorySchema.pre("save", function (next) {
  if (this.stock <= 0) {
    this.status = "Out of Stock";
  } else if (this.stock <= this.minimumStock) {
    this.status = "Low Stock";
  } else {
    this.status = "Available";
  }
  next();
});

module.exports = mongoose.model("LabInventory", labInventorySchema);
