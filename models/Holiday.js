const mongoose = require("mongoose");

const holidaySchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Holiday", holidaySchema);
