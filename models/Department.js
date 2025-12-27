const mongoose = require("mongoose");

const departmentSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    name: { type: String, required: true },
    department_code: { type: String },
    hod_name: { type: String },
    description: { type: String },
    type: { type: String, default: "Department" },
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

module.exports = mongoose.model("Department", departmentSchema);
