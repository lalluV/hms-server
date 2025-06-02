const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model("Expense", expenseSchema);
