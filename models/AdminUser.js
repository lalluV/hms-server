const mongoose = require("mongoose");

const adminUserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    role: { type: String, default: "SuperAdmin" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminUser", adminUserSchema);
