const mongoose = require("mongoose");

const wardSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    wardName: { type: String, required: true },
    wardId: { type: String, required: true },
    price: { type: Number, required: true },
    status: { type: String, default: "active" },
    beds: [
      {
        bed: String,
        status: { type: String, default: "Empty" },
        UMRNo: String,
        age: String,
        gender: String,
      },
    ],
    updatedAt: { type: String },
    createdAt: { type: String },
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

module.exports = mongoose.model("Ward", wardSchema);
