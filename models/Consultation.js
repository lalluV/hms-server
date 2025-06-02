const mongoose = require("mongoose");

const consultationSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Consultation", consultationSchema);
