const mongoose = require("mongoose");

const ipAdmissionSchema = new mongoose.Schema(
  {
    ipNumber: { type: String, required: true },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: true,
    },
    UMRNo: { type: String, required: true },
    patientName: { type: String, required: true },

    // Admission & Staff Incharge
    admissionDate: { type: String, required: true },
    admissionTime: { type: String },
    mlcNo: { type: String },
    patient_status: {
      type: String,
      enum: [
        "Admitted",
        "Refused Admission",
        "Discharged",
        "Transferred",
        "Expired",
        "LAMA",
      ],
      default: "Admitted",
    },
    consultantDoctor: { type: String },
    doctorId: { type: String },
    medicalOfficerName: { type: String },
    medicalOfficerId: { type: String },
    patientRepresentiveOfficer: { type: String },

    // Consultant Cross-Practice History
    consultantHistory: [
      {
        consultantId: String,
        consultantName: String,
        role: String,
        startDate: String,
        endDate: String,
        reason: String,
      },
    ],

    // Current Bed & Ward
    wardName: { type: String },
    wardId: { type: String },
    selectedBed: { type: String },

    // Bed Transfers History (for ward billing)
    transfers: [
      {
        wardId: String,
        wardName: String,
        price: Number,
        transferDate: String,
      },
    ],

    // Inpatient Clinical Charts
    chiefComplaintsPresentIllnessHistory: { type: String },
    pastMedicalHistory: { type: String },
    pastMedications: { type: String },
    allergiesHistory: { type: String },
    consciousness: { type: String },
    gcs: { type: String },
    pupils: { type: String },
    height: { type: String },
    weight: { type: String },
    personalHistory: {
      alcohol: { type: Boolean, default: false },
      smoking: { type: Boolean, default: false },
      illicitDrugs: { type: Boolean, default: false },
      habitsNil: { type: Boolean, default: false },
      other: { type: String },
      maritalStatus: { type: String },
      familyHistory: { type: String },
    },
    systemicExamination: { type: String },
    provisionalDiagnosis: { type: String },
    vitals: [mongoose.Schema.Types.Mixed],
    /** Vitals entered on the ER form. Ward readings stay on vitals. */
    eraVitalEntry: { type: mongoose.Schema.Types.Mixed },
    doctorNotes: [mongoose.Schema.Types.Mixed],
    nurseNotes: [mongoose.Schema.Types.Mixed],
    insulinChart: [mongoose.Schema.Types.Mixed],
    investigations: [mongoose.Schema.Types.Mixed],
    procedures: [mongoose.Schema.Types.Mixed],
    treatment: [mongoose.Schema.Types.Mixed],
    /** Frozen copy of the treatment list from the first ERA save. */
    casualtyTreatment: [mongoose.Schema.Types.Mixed],
    /** Frozen copy of the investigation list from the first ERA save. */
    casualtyInvestigations: [mongoose.Schema.Types.Mixed],
    otNotes: { type: String },
    surgeryNotes: { type: String },

    // Discharge Summary & Medical Orders
    dischargeDate: { type: String },
    dischargedAt: { type: String },
    dischargeCondition: { type: String },
    dischargeTo: { type: String },
    dischargeDestination: { type: String },
    finalDiagnosis: { type: String },
    dischargeInstructions: { type: String },
    followUpPlan: { type: String },
    dischargeTime: { type: String },
    lengthOfStay: { type: Number },
    dangerSigns: { type: String },
    hospitalCourse: { type: String },
    dischargeOrders: { type: String },

    // Insurance for THIS Hospital Stay
    paymentMethod: { type: String, default: "Personal" },
    insurance_provider: { type: String },
    insurance_providerId: { type: String },
    policy_number: { type: String },
    coPayPercentage: { type: Number, default: 0 },
    coPayLimit: { type: Number, default: 0 },
    coPayType: { type: String, default: "percentage" },
    coverage: { type: String },
    expiry_date: { type: String },
    claimNumber: { type: String },
    preAuthAmount: { type: Number, default: 0 },
    approvedAmount: { type: Number, default: 0 },

    // Commission / Referral for THIS Hospital Stay
    commissionEarnerType: { type: String },
    commissionEarnerId: { type: String },
    commissionEarnerName: { type: String },
    commissionRates: {
      consultation: { type: Number },
      surgery: { type: Number },
      pharmacy: { type: Number },
      lab: { type: Number },
    },

    // IP Billing Financial Summary
    finalBillAmount: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    insurance: { type: Number, default: 0 },
    paymentStatus: { type: String, default: "pending" },
  },
  { strict: true, timestamps: true }
);

ipAdmissionSchema.index({ hospitalId: 1, patientId: 1, admissionDate: -1 });
ipAdmissionSchema.index({ hospitalId: 1, patient_status: 1, wardId: 1 });
ipAdmissionSchema.index({ hospitalId: 1, ipNumber: 1 });

module.exports = mongoose.model("IPAdmission", ipAdmissionSchema);
