const mongoose = require("mongoose");

const inventorySchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Inventory", inventorySchema);
