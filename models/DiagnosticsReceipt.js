const mongoose = require("mongoose");

const diagnosticsReceiptSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    receiptId: { type: String, unique: true, required: true },
    patientId: { type: String },
    patientName: { type: String },
    patientPhone: { type: String },
    doctorData: { type: Object },
    items: [mongoose.Schema.Types.Mixed], // Flexible schema to support both lab-sale and lab-purchase items
    totalAmount: { type: Number },
    baseTotalAmount: { type: Number },
    discount: { type: Number },
    paymentStatus: { type: String },
    paymentType: { type: String },
    paymentSplit: { type: Object },
    overallStatus: { type: String },
    totalTests: { type: Number },
    completedTests: { type: Number },
    type: { type: String },

    // Patient snapshot (used by both HMS and mobile; mobile sends for display without fetch)
    patientGender: { type: String },
    patientAge: { type: String },
    patientEmail: { type: String },
    accountPhone: { type: String }, // Link to DiagnosticsUser account (mobile)

    // Mobile app booking / appointment
    slotDate: { type: String },
    slotTime: { type: String },
    appointmentDate: { type: String },
    appointmentTime: { type: String },
    bookingType: { type: String },

    // Mobile app address
    address: { type: String },
    area: { type: String },
    city: { type: String },
    flatNo: { type: String },
    addressLabel: { type: String },
    coordinates: { type: mongoose.Schema.Types.Mixed },

    // Mobile app phlebotomist / branch
    phlebotomist: { type: String },
    phlebotomistId: { type: String },
    phlebotomistNumber: { type: String },

    // Purchase specific
    vendorData: { type: mongoose.Schema.Types.Mixed },
    payment: { type: String },
    paid: { type: String },
    due: { type: String },
    paymentMethod: { type: String },
    paymentReference: { type: String },
    dueDate: { type: String },

    modifiedBy: [
      {
        user: String,
        type: { type: String },
        modifiedTime: String,
      },
    ],
  },
  { strict: true, timestamps: true },
);

const DiagnosticsReceipt = mongoose.model(
  "DiagnosticsReceipt",
  diagnosticsReceiptSchema,
);

module.exports = DiagnosticsReceipt;
