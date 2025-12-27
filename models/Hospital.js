const mongoose = require("mongoose");

const hospitalSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true }, // Unique slug for the hospital
    address: { type: String },
    city: { type: String },
    state: { type: String },
    zipCode: { type: String },
    phone: { type: String },
    email: { type: String },
    website: { type: String },
    logoUrl: { type: String },
    active: { type: Boolean, default: true },
    subscriptionPlan: { type: String, default: "basic" },
    subscriptionExpiry: { type: Date },
    settings: {
      currency: { type: String, default: "INR" },
      timezone: { type: String, default: "Asia/Kolkata" },
      dateFormat: { type: String, default: "DD-MM-YYYY" },
    },
    createdBy: { type: String }, // Super Admin ID
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

module.exports = mongoose.model("Hospital", hospitalSchema);
