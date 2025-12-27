const mongoose = require("mongoose");

const shiftSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    shiftName: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    employees: [mongoose.Schema.Types.Mixed],
  },
  { strict: true, timestamps: true }
);

// Update the updatedAt field before saving
shiftSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("Shift", shiftSchema);
