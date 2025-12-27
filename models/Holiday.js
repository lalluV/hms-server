const mongoose = require("mongoose");

const holidaySchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    occasion: { type: String, required: true },
    holidayDate: { type: String, required: true }, // Format: YYYY-MM-DD
    description: { type: String },
    day: { type: String }, // e.g., "Monday"
    typeOfHoliday: { type: String },
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

module.exports = mongoose.model("Holiday", holidaySchema);
