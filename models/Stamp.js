const mongoose = require("mongoose");

const stampSchema = new mongoose.Schema(
  {
    id: { type: String },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    name: { type: String, required: true },
    description: { type: String },
    department: { type: String, required: true },
    category: { type: String, required: true },
    imageUrl: { type: String, required: true },
    createdBy: { type: String },
    isActive: { type: Boolean, default: true },
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

// Create sparse unique index on id field to allow multiple nulls but enforce uniqueness for non-null values
stampSchema.index({ id: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Stamp", stampSchema);
