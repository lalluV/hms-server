const mongoose = require("mongoose");

const nurseDescSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    service_code: { type: String, required: true },
    name: { type: String, required: true },
    category: { type: String, required: true },
    sub_category: { type: String },
    rate: { type: Number, required: true },
    active: { type: Boolean, default: true },
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

module.exports = mongoose.model("NurseDesc", nurseDescSchema);
