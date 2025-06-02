const mongoose = require("mongoose");

const actionSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Action", actionSchema);
