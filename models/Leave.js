const mongoose = require("mongoose");

const leaveSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Leave", leaveSchema);
