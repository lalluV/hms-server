const mongoose = require("mongoose");

const shiftSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      unique: true,
      required: true,
    },
    shiftName: {
      type: String,
      required: true,
      enum: ["EarlyShifts", "NoonShifts", "NightShifts"],
    },
    startTime: {
      type: String,
      required: true,
    },
    endTime: {
      type: String,
      required: true,
    },
    employees: [
      {
        id: String,
        name: String,
        department: String,
        position: String,
        email: String,
        phone: String,
      },
    ],
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { strict: false }
);

// Update the updatedAt field before saving
shiftSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("Shift", shiftSchema);
