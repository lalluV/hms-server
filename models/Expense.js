const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    category: { type: String, required: true },
    amount: { type: Number, required: true },
    remarks: { type: String },
    createdAtOriginal: { type: String },
    description: { type: String },
    modifiedBy: [
      {
        user: String,
        type: { type: String },
        modifiedTime: String,
      },
    ],
  },
  { strict: true, timestamps: true }
);

module.exports = mongoose.model("Expense", expenseSchema);
