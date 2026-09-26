const {
  HOSPITAL_TZ,
  eventDateExpr,
  dayKeyExpr,
  computeDashboardStatistics,
} = require("./dashboardStats");

const LAB_EXCLUDED_TYPES = [
  "lab-purchase",
  "lab-purchase-return",
  "lab-Indent",
  "lab-indent",
];

const CLOSED_ADMISSION_STATUSES = ["Discharged", "Expired", "LAMA", "Transferred"];

function formatCurrency(amount = 0) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(amount) || 0);
}

function calendarDate(targetDate = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: HOSPITAL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(targetDate instanceof Date ? targetDate : new Date(targetDate));
}

function formatDigestDate(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return {
    formattedDate: new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(utc),
    dayOfWeek: new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      timeZone: "UTC",
    }).format(utc),
  };
}

function hospitalMatch(hospitalId) {
  const mongoose = require("mongoose");
  const hospitalObjId = mongoose.Types.ObjectId.isValid(hospitalId)
    ? new mongoose.Types.ObjectId(hospitalId)
    : hospitalId;
  return { hospitalId: { $in: [hospitalId, hospitalObjId] } };
}

function dayStages(primary, fallback, dateStr) {
  return [
    { $addFields: { eventDate: eventDateExpr(primary, fallback) } },
    { $addFields: { dayKey: dayKeyExpr("$eventDate") } },
    { $match: { dayKey: dateStr } },
  ];
}

async function countOnDay(Model, match, primary, fallback, dateStr) {
  const rows = await Model.aggregate([
    { $match: match },
    ...dayStages(primary, fallback, dateStr),
    { $count: "total" },
  ]);
  return rows[0]?.total || 0;
}

/**
 * Today's operational digest. Money figures use the same calculation as the
 * dashboard "Today" view so WhatsApp and the dashboard stay in agreement.
 */
async function computeHospitalDailyDigest(tenantDb, hospitalId, targetDate = new Date()) {
  const dateStr = calendarDate(targetDate || new Date());
  const stats = await computeDashboardStatistics(
    tenantDb,
    hospitalId,
    "today",
    dateStr,
  );

  const Consultation = tenantDb.model("Consultation");
  const DiagnosticsReceipt = tenantDb.model("DiagnosticsReceipt");
  const PharmacyReceipt = tenantDb.model("PharmacyReceipt");
  const Appointment = tenantDb.model("Appointment");
  const IPAdmission = tenantDb.model("IPAdmission");
  const Patient = tenantDb.model("Patient");
  const match = hospitalMatch(hospitalId);

  const [
    consultations,
    labBills,
    pharmacyBills,
    appointments,
    admissions,
    discharges,
    inpatients,
    registrations,
  ] = await Promise.all([
    countOnDay(Consultation, match, "$createdAt", "$date", dateStr),
    countOnDay(
      DiagnosticsReceipt,
      { ...match, type: { $nin: LAB_EXCLUDED_TYPES } },
      "$createdAt",
      "$date",
      dateStr,
    ),
    countOnDay(
      PharmacyReceipt,
      { ...match, type: { $in: ["pharmacy-sale", "pharmacy"] } },
      "$createdAt",
      "$date",
      dateStr,
    ),
    countOnDay(Appointment, match, "$appointmentDate", "$createdAt", dateStr),
    countOnDay(IPAdmission, match, "$admissionDate", "$createdAt", dateStr),
    countOnDay(
      IPAdmission,
      { ...match, patient_status: { $in: CLOSED_ADMISSION_STATUSES } },
      "$dischargeDate",
      "$dischargedAt",
      dateStr,
    ),
    IPAdmission.countDocuments({ ...match, patient_status: "Admitted" }),
    countOnDay(Patient, match, "$createdAt", "$registration_date", dateStr),
  ]);

  const streams = [
    { id: "consultation", name: "Doctor Consultations", amount: stats.consultationRevenue || 0 },
    { id: "lab", name: "Laboratory & Diagnostics", amount: stats.labRevenue || 0 },
    { id: "procedures", name: "Procedures & Surgeries", amount: stats.procedureRevenue || 0 },
    { id: "services", name: "Clinical Services", amount: stats.serviceRevenue || 0 },
    { id: "pharmacy", name: "Pharmacy", amount: stats.pharmacyRevenue || 0 },
    { id: "ward", name: "IPD Wards & Beds", amount: stats.wardRevenue || 0 },
  ];

  const grossCollections = Number(stats.totalRevenue) || 0;
  const expenses = Number(stats.totalExpenses) || 0;
  const { formattedDate, dayOfWeek } = formatDigestDate(dateStr);

  return {
    date: dateStr,
    formattedDate,
    dayOfWeek,
    timestamp: new Date().toISOString(),
    streams,
    activity: {
      appointments,
      consultations,
      labBills,
      pharmacyBills,
      admissions,
      discharges,
      inpatients,
      registrations,
    },
    financials: {
      grossCollections,
      expenses,
      netCollections: grossCollections - expenses,
    },
  };
}

function moneyLine(label, amount) {
  return `${label} — *${formatCurrency(amount)}*`;
}

function countLine(label, count) {
  return `${label} — *${Number(count) || 0}*`;
}

function formatDailyDigestWhatsAppMessage(hospitalName, digest) {
  const name = hospitalName || "Hospital";
  const { formattedDate, dayOfWeek, streams, activity, financials } = digest;

  const lines = [
    `*${name}*`,
    `Daily digest · ${dayOfWeek}, ${formattedDate}`,
    ``,
    `*Gross collections*`,
    `*${formatCurrency(financials.grossCollections)}*`,
    ``,
    `*Department revenue*`,
    ...streams.map((stream) => moneyLine(stream.name, stream.amount)),
    ``,
    moneyLine("Expenses", financials.expenses),
    moneyLine("Net", financials.netCollections),
    ``,
    `*Today's activity*`,
    countLine("Appointments", activity.appointments),
    countLine("Consultations", activity.consultations),
    countLine("Lab bills", activity.labBills),
    countLine("Pharmacy bills", activity.pharmacyBills),
    countLine("Admissions", activity.admissions),
    countLine("Discharges", activity.discharges),
    countLine("Inpatients", activity.inpatients),
    countLine("Registrations", activity.registrations),
  ];

  return lines.join("\n");
}

function formatDailyDigestCompactSummary(hospitalName, digest) {
  const { formattedDate, streams, financials } = digest;
  const parts = streams.map(
    (stream) => `${stream.name} ${formatCurrency(stream.amount)}`,
  );
  return `${hospitalName || "Hospital"} ${formattedDate}: ${parts.join(", ")}. Gross ${formatCurrency(financials.grossCollections)}, Expenses ${formatCurrency(financials.expenses)}, Net ${formatCurrency(financials.netCollections)}.`;
}

module.exports = {
  formatCurrency,
  computeHospitalDailyDigest,
  formatDailyDigestWhatsAppMessage,
  formatDailyDigestCompactSummary,
};
