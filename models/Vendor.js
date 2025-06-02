const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema({}, { strict: false });

// Update the updatedAt timestamp before saving
vendorSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("Vendor", vendorSchema);
