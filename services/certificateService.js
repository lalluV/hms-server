const dayjs = require("dayjs");
const Certificate = require("../models/Certificate");
const IPAdmission = require("../models/IPAdmission");
const PharmacyReceipt = require("../models/PharmacyReceipt");
const DiagnosticsReceipt = require("../models/DiagnosticsReceipt");
const Hospital = require("../models/Hospital");
const { sendWhatsAppTextMessage } = require("../utils/whatsappCloud");

/**
 * Generate unique serial certificate number based on year and type
 */
async function generateCertificateNumber(hospitalId, type) {
  const currentYear = dayjs().year();
  const typePrefixMap = {
    essentiality_a: "ESA",
    essentiality_b: "ESB",
    medical_sick_leave: "MED",
    fitness: "FIT",
    referral: "REF",
    custom: "CRT",
  };
  const prefix = typePrefixMap[type] || "CRT";

  const count = await Certificate.countDocuments({
    hospitalId,
    type,
    createdAt: {
      $gte: dayjs().startOf("year").toDate(),
    },
  });

  const serial = String(count + 1).padStart(4, "0");
  return `${prefix}-${currentYear}-${serial}`;
}

/**
 * Auto-populate IP admission data for 1-click Essentiality Certificate Form B
 */
async function prefillIpdEssentialityData(hospitalId, admissionId) {
  const admission = await IPAdmission.findOne({ _id: admissionId, hospitalId })
    .populate("patientId")
    .lean();

  if (!admission) {
    throw new Error("IP Admission record not found");
  }

  const patient = admission.patientId || {};
  const admissionDate = admission.admissionDate
    ? dayjs(admission.admissionDate).format("YYYY-MM-DD")
    : dayjs(admission.createdAt).format("YYYY-MM-DD");
  const dischargeDate = admission.dischargeDate
    ? dayjs(admission.dischargeDate).format("YYYY-MM-DD")
    : dayjs().format("YYYY-MM-DD");

  // Fetch pharmacy receipts billed during this IP stay
  const pharmacyBills = await PharmacyReceipt.find({
    hospitalId,
    $or: [{ admissionId: admission._id }, { UMRNo: admission.UMRNo }],
    createdAt: {
      $gte: dayjs(admissionDate).startOf("day").toDate(),
      $lte: dayjs(dischargeDate).endOf("day").toDate(),
    },
  }).lean();

  const medicines = [];
  let medicineTotal = 0;

  for (const bill of pharmacyBills) {
    const items = Array.isArray(bill.items) ? bill.items : [];
    for (const it of items) {
      const price = Number(it.totalAmount || it.amount || (it.qty * it.rate) || 0);
      medicines.push({
        name: it.itemDesc || it.itemName || it.description || "Medicine",
        batchNo: it.batchNo || "—",
        quantity: Number(it.quantityApproved || it.qty || 1),
        price,
        nonAvailabilityCertified: true,
      });
      medicineTotal += price;
    }
  }

  // Fetch lab diagnostic receipts during this IP stay
  const labBills = await DiagnosticsReceipt.find({
    hospitalId,
    $or: [{ admissionId: admission._id }, { UMRNo: admission.UMRNo }],
    createdAt: {
      $gte: dayjs(admissionDate).startOf("day").toDate(),
      $lte: dayjs(dischargeDate).endOf("day").toDate(),
    },
  }).lean();

  const labTests = [];
  let labTotal = 0;

  for (const bill of labBills) {
    const tests = Array.isArray(bill.tests) ? bill.tests : [];
    for (const t of tests) {
      const price = Number(t.price || t.rate || 0);
      labTests.push({
        testName: t.testName || t.name || "Diagnostic Test",
        price,
        date: dayjs(bill.createdAt).format("YYYY-MM-DD"),
      });
      labTotal += price;
    }
  }

  const totalClaimAmount = Math.round((medicineTotal + labTotal) * 100) / 100;

  return {
    patientId: patient._id,
    patientName: patient.name || admission.patientName,
    UMRNo: admission.UMRNo || patient.UMRNo,
    phone: patient.phone,
    age: patient.age,
    gender: patient.gender,
    address: patient.street_address ? `${patient.street_address}, ${patient.city || ""}` : "",
    admissionId: admission._id.toString(),
    admissionDate,
    dischargeDate,
    doctorId: admission.doctorId,
    doctorName: admission.consultantDoctor || admission.doctorName || "Consultant Physician",
    department: admission.department || "General Medicine",
    diagnosis: admission.provisionalDiagnosis || admission.finalDiagnosis || "Inpatient Care",
    medicines,
    labTests,
    totalClaimAmount,
  };
}

/**
 * Build WhatsApp text message for certificate notification
 */
function buildCertificateWhatsAppMessage({
  hospitalName,
  hospitalPhone,
  certificate,
}) {
  const formattedDate = dayjs(certificate.issuedDate).format("DD MMM YYYY");
  const certTypeTitles = {
    essentiality_a: "Essentiality Certificate (Form A - OPD)",
    essentiality_b: "Essentiality Certificate (Form B - IPD Hospitalized)",
    medical_sick_leave: "Medical Certificate for Leave",
    fitness: "Physical Fitness Certificate",
    referral: "Medical Referral Letter",
    custom: "Hospital Medical Certificate",
  };

  const title = certTypeTitles[certificate.type] || certificate.title || "Medical Certificate";
  const contactText = hospitalPhone ? `\n📞 Helpline: ${hospitalPhone}` : "";

  let specificDetails = "";
  if (certificate.type === "medical_sick_leave") {
    specificDetails =
      `📋 *Leave Period:* ${certificate.leaveFrom} to ${certificate.leaveTo} (${certificate.totalDays || "—"} days)\n` +
      `🩺 *Diagnosis:* ${certificate.diagnosis || "Medical Illness"}\n` +
      `🏃 *Expected Return Date:* ${certificate.expectedFitDate || certificate.leaveTo}\n`;
  } else if (certificate.type === "fitness") {
    specificDetails =
      `💪 *Certified Fit From:* ${certificate.fitFrom || formattedDate}\n` +
      `🎯 *Purpose:* ${certificate.purpose || "Resuming duties / Physical fitness"}\n`;
  } else if (certificate.type.startsWith("essentiality")) {
    specificDetails =
      `💰 *Total Certified Claim:* ₹${Number(certificate.totalClaimAmount || 0).toFixed(2)}\n` +
      `💊 *Medicines Certified:* ${certificate.medicines?.length || 0} items\n` +
      `🧪 *Lab Tests Certified:* ${certificate.labTests?.length || 0} tests\n` +
      `📜 *Rule:* ${certificate.reimbursementRule || "CGHS / CS(MA)"}\n`;
  }

  return (
    `🏥 *${hospitalName || "Hospital"}*\n` +
    `*OFFICIAL MEDICAL CERTIFICATE ISSUED*\n\n` +
    `Dear *${certificate.patientName}* (UMR: ${certificate.UMRNo}),\n\n` +
    `Your *${title}* has been issued.\n\n` +
    `📄 *Certificate No:* ${certificate.certificateNumber}\n` +
    `📅 *Date of Issue:* ${formattedDate}\n` +
    `👨‍⚕️ *Attending Doctor:* Dr. ${certificate.doctorName}${certificate.doctorRegNo ? ` (Reg: ${certificate.doctorRegNo})` : ""}\n` +
    specificDetails +
    `\nA signed copy with hospital seal is available at the reception desk for your official records.${contactText}\n\n` +
    `_Wishing you complete health & wellness!_`
  );
}

/**
 * Dispatch certificate via WhatsApp to patient
 */
async function sendCertificateWhatsApp(certificateId, hospitalId) {
  const certificate = await Certificate.findOne({ _id: certificateId, hospitalId });
  if (!certificate) throw new Error("Certificate not found");

  const phone = certificate.phone;
  if (!phone) throw new Error("No phone number associated with this certificate");

  const hospital = await Hospital.findById(hospitalId).lean();
  const hospitalName = hospital?.name || "Hospital";
  const hospitalPhone =
    hospital?.phone || hospital?.emergencyContact || "";

  const message = buildCertificateWhatsAppMessage({
    hospitalName,
    hospitalPhone,
    certificate,
  });

  const result = await sendWhatsAppTextMessage({ phone, message });

  certificate.whatsappSent = true;
  certificate.whatsappSentAt = new Date();
  await certificate.save();

  return { success: true, result, message };
}

module.exports = {
  generateCertificateNumber,
  prefillIpdEssentialityData,
  buildCertificateWhatsAppMessage,
  sendCertificateWhatsApp,
};
