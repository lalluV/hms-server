// const mongoose = require("mongoose");

// const pharmacyInventorySchema = new mongoose.Schema(
//   {
//     item_code: String,
//     name: String,
//     manufacturer: String,
//     description: String,
//     quantity: Number,
//     price: Number,
//     orderingNumber: Number,
//     // add other fields you have
//   },
//   { collection: "pharmacyinventory" }
// );

// module.exports = mongoose.model("PharmacyInventory", pharmacyInventorySchema);

const mongoose = require("mongoose");

const pharmacyInventorySchema = new mongoose.Schema(
  {},
  { strict: false, collection: "pharmacyinventory" }
);

module.exports = mongoose.model("PharmacyInventory", pharmacyInventorySchema);
