const mongoose = require("mongoose");

const nurseDescSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("NurseDesc", nurseDescSchema);
