const mongoose = require("mongoose");

const leaveSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    employeeName: { type: String, required: true },
    employeeId: { type: String },
    leaveType: { type: String, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    numberOfDays: { type: Number },
    remainingLeaves: { type: Number },
    leaveReason: { type: String },
    status: { type: String, default: "Pending" },
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

module.exports = mongoose.model("Leave", leaveSchema);
