const mongoose = require("mongoose");

const DiagnosticsUserSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("DiagnosticsUser", DiagnosticsUserSchema);
