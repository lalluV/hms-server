const mongoose = require("mongoose");

// Create a counter schema for UMR numbers
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model("Counter", counterSchema);

const patientSchema = new mongoose.Schema(
  {
    UMRNo: {
      type: String,
      unique: true,
      required: false,
    },
  },
  { strict: false }
);

// Pre-save middleware to generate UMR number
patientSchema.pre("save", async function (next) {
  if (this.isNew) {
    try {
      const counter = await Counter.findByIdAndUpdate(
        { _id: "UMRNo" },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      this.UMRNo = `UMR${String(counter.seq).padStart(8, "0")}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

module.exports = mongoose.model("Patient", patientSchema);
