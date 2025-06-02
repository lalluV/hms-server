const mongoose = require("mongoose");

const parameterSchema = new mongoose.Schema({}, { strict: false });

// Update the updatedAt timestamp before saving
parameterSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("Parameter", parameterSchema);
