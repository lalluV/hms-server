const mongoose = require("mongoose");

const indentStoreSchema = new mongoose.Schema({}, { strict: false });

// Update the updatedAt timestamp before saving
indentStoreSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("IndentStore", indentStoreSchema);
