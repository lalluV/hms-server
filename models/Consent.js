const mongoose = require("mongoose");

const consentSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    patientId: { type: String, required: true },
    patientName: { type: String },
    consentType: { type: String, required: true },
    consentId: { type: String },
    fileUrl: { type: String, required: true },
    fileName: { type: String },
    fileSize: { type: Number },
    uploadedAt: { type: String },
    status: { type: String, default: "uploaded" },
    uploadedBy: { type: String },
    notes: { type: String },
  },
  { strict: true, timestamps: true }
);

module.exports = mongoose.model("Consent", consentSchema);
