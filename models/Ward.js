const mongoose = require("mongoose");

const wardSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Ward", wardSchema);
