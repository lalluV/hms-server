const mongoose = require("mongoose");

const appointmentSchema = new mongoose.Schema(
  {
    fullName: { type: String },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    name: { type: String, required: true },
    mobile: { type: String },
    phone: { type: String },
    gender: { type: String },
    email: { type: String },
    address: { type: String },
    doctor: { type: String, required: true },
    doctorName: { type: String },
    doctorId: { type: String },
    appointmentDate: { type: String },
    time: { type: String },
    slotDate: { type: String },
    slotTime: { type: String },
    treatment: { type: String },
    notes: { type: String },
    status: { type: String, default: "scheduled" },
    registered_by: { type: String },
  },
  { strict: true, timestamps: true }
);

module.exports = mongoose.model("Appointment", appointmentSchema);
