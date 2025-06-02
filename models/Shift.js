const mongoose = require("mongoose");

const shiftSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Shift", shiftSchema);
