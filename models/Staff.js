const mongoose = require("mongoose");

const staffSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, required: true },
    userId: { type: String, unique: true },
    password: { type: String },
    /** Last set password (admin reference only; cleared when user changes their own password) */
    loginPassword: { type: String, select: false },
    name: { type: String, required: true },
    email: { type: String },
    phone: { type: String },
    gender: { type: String },
    dateOfBirth: { type: String },
    joinDate: { type: String },
    location: { type: String },
    position: { type: String },
    qualification: { type: String },
    specialization: { type: String },
    active: { type: Boolean, default: true },
    type: { type: String, required: true },
    department: { type: String },
    imgUrl: { type: String },
    signatureUrl: { type: String },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    opCharges: { type: String },
    ipCharges: { type: String },
    licenseNumber: { type: String },
    labCertification: { type: String },
    adminLevel: { type: String },
    receptionistId: { type: String },
    accountantId: { type: String },
    hrManagerId: { type: String },
    itSupportId: { type: String },
    createdAt: { type: String },
    createdAtOriginal: { type: String },
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

module.exports = mongoose.model("Staff", staffSchema);
