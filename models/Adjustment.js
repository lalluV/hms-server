const mongoose = require("mongoose");

const adjustmentSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      index: true,
    },
    reference: { type: String, index: true },
    date: { type: Date, default: Date.now },
    items: [mongoose.Schema.Types.Mixed],
    totalItems: { type: Number, default: 0 },
    reason: { type: String, default: "" },
    status: { type: String, default: "completed" },
    createdBy: { type: String, default: "" },
  },
  { strict: true, timestamps: true, collection: "adjustments" },
);

adjustmentSchema.index({ hospitalId: 1, createdAt: -1 });

module.exports = mongoose.model("Adjustment", adjustmentSchema);
