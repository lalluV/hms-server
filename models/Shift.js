const mongoose = require("mongoose");

const shiftSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    id: { type: String, required: true },
    shiftName: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    employees: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { strict: true, timestamps: true }
);

shiftSchema.index({ hospitalId: 1, id: 1 }, { unique: true });
shiftSchema.index({ hospitalId: 1, shiftName: 1 });

// Update the updatedAt field before saving
shiftSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("Shift", shiftSchema);
