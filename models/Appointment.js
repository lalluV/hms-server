const mongoose = require("mongoose");

const appointmentSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Appointment", appointmentSchema);
