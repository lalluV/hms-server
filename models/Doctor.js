const mongoose = require("mongoose");

const doctorSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Doctor", doctorSchema);
