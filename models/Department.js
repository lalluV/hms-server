const mongoose = require("mongoose");

const departmentSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Department", departmentSchema);
