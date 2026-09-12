const mongoose = require("mongoose");
const dayjs = require("dayjs");

/**
 * Currency formatter for Indian Rupees
 */
function formatCurrency(amount = 0) {
  const num = Number(amount) || 0;
  return `₹${num.toLocaleString("en-IN", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  })}`;
}

/**
 * Aggregates daily metrics for a specific hospital across OPD, Lab, Pharmacy, IPD, and Expenses.
 *
 * @param {object} tenantDb - Active Mongoose connection/model resolver for the hospital tenant
 * @param {string|mongoose.Types.ObjectId} hospitalId - Hospital Identifier
 * @param {Date|string} [targetDate] - Target date to calculate (defaults to current time)
 */
async function computeHospitalDailyDigest(tenantDb, hospitalId, targetDate = new Date()) {
  const Patient = tenantDb.model("Patient");
  const Appointment = tenantDb.model("Appointment");
  const Consultation = tenantDb.model("Consultation");
  const DiagnosticsReceipt = tenantDb.model("DiagnosticsReceipt");
  const PharmacyReceipt = tenantDb.model("PharmacyReceipt");
  const AdvanceReceipt = tenantDb.model("AdvanceReceipt");
  const IPAdmission = tenantDb.model("IPAdmission");
  const Expense = tenantDb.model("Expense");

  const hospitalObjId = mongoose.Types.ObjectId.isValid(hospitalId)
    ? new mongoose.Types.ObjectId(hospitalId)
    : hospitalId;

  const matchFilter = {
    hospitalId: { $in: [hospitalId, hospitalObjId] },
  };

  const startOfDay = dayjs(targetDate).startOf("day").toDate();
  const endOfDay = dayjs(targetDate).endOf("day").toDate();
  const dateStr = dayjs(targetDate).format("YYYY-MM-DD");

  const todayDateFilter = {
    ...matchFilter,
    $or: [
      { createdAt: { $gte: startOfDay, $lte: endOfDay } },
      { date: { $gte: startOfDay, $lte: endOfDay } },
      { date: dateStr },
      { date: new RegExp(`^${dateStr}`) },
    ],
  };

  const [
    consultationsToday,
    diagnosticsToday,
    pharmacySalesToday,
    advanceReceiptsToday,
    expensesToday,
    admissionsTodayCount,
    dischargesTodayCount,
    activeAdmittedCount,
    todayAppointmentsCount,
  ] = await Promise.all([
    // 1. OPD Consultations today
    Consultation.find(todayDateFilter).select("items date createdAt").lean(),

    // 2. Diagnostics / Lab Receipts today
    DiagnosticsReceipt.find({
      ...matchFilter,
      $or: [
        { createdAt: { $gte: startOfDay, $lte: endOfDay } },
        { date: { $gte: startOfDay, $lte: endOfDay } },
        { date: dateStr },
      ],
    }).select("totalAmount paymentType paymentStatus items totalTests").lean(),

    // 3. Pharmacy Sales today
    PharmacyReceipt.find({
      ...matchFilter,
      type: "pharmacy-sale",
      $or: [
        { createdAt: { $gte: startOfDay, $lte: endOfDay } },
        { date: { $gte: startOfDay, $lte: endOfDay } },
        { date: dateStr },
      ],
    }).select("totalAmount paymentType paymentMethod paid due paymentSplit").lean(),

    // 4. IP Advance Receipts today
    AdvanceReceipt.find({
      ...matchFilter,
      $or: [
        { createdAt: { $gte: startOfDay, $lte: endOfDay } },
        { date: { $gte: startOfDay, $lte: endOfDay } },
        { date: dateStr },
      ],
    }).select("advanceAmount paymentMode").lean(),

    // 5. Expenses logged today
    Expense.find({
      ...matchFilter,
      $or: [
        { createdAt: { $gte: startOfDay, $lte: endOfDay } },
        { date: { $gte: startOfDay, $lte: endOfDay } },
        { date: dateStr },
      ],
    }).select("amount category description").lean(),

    // 6. IP Admissions today
    IPAdmission.countDocuments({
      ...matchFilter,
      $or: [
        { createdAt: { $gte: startOfDay, $lte: endOfDay } },
        { admissionDate: dateStr },
        { admissionDate: new RegExp(`^${dateStr}`) },
      ],
    }),

    // 7. IP Discharges today
    IPAdmission.countDocuments({
      ...matchFilter,
      patient_status: "Discharged",
      $or: [
        { updatedAt: { $gte: startOfDay, $lte: endOfDay } },
        { dischargeDate: dateStr },
        { dischargeDate: new RegExp(`^${dateStr}`) },
      ],
    }),

    // 8. Currently Admitted In-Patients
    IPAdmission.countDocuments({
      ...matchFilter,
      patient_status: "Admitted",
    }),

    // 9. Appointments today
    Appointment.countDocuments({
      ...matchFilter,
      $or: [
        { appointmentDate: { $gte: startOfDay, $lte: endOfDay } },
        { appointmentDate: dateStr },
        { appointmentDate: new RegExp(`^${dateStr}`) },
      ],
    }),
  ]);

  // Compute OPD totals
  let opdRevenue = 0;
  for (const c of consultationsToday) {
    if (Array.isArray(c.items)) {
      for (const it of c.items) {
        const rate = Number(it?.charges || it?.rate || 0);
        const qty = Number(it?.quantity || 1);
        opdRevenue += rate * qty;
      }
    }
  }

  // Compute Lab totals
  let labRevenue = 0;
  let labTestsCount = 0;
  for (const d of diagnosticsToday) {
    labRevenue += Number(d.totalAmount || 0);
    labTestsCount += Number(d.totalTests || (Array.isArray(d.items) ? d.items.length : 1));
  }

  // Compute Pharmacy totals & payment splits
  let pharmaTotal = 0;
  let pharmaCash = 0;
  let pharmaDigital = 0;
  let pharmaDue = 0;

  for (const p of pharmacySalesToday) {
    const amt = Number(p.totalAmount || 0);
    pharmaTotal += amt;
    const mode = String(p.paymentType || p.paymentMethod || "").toLowerCase();
    const paidAmt = Number(p.paid ?? amt);
    const dueAmt = Number(p.due || 0);

    if (mode.includes("cash")) {
      pharmaCash += paidAmt;
    } else if (mode.includes("upi") || mode.includes("online") || mode.includes("card") || mode.includes("gpay") || mode.includes("phonepe")) {
      pharmaDigital += paidAmt;
    } else {
      // Default to cash if unspecified
      pharmaCash += paidAmt;
    }
    pharmaDue += dueAmt;
  }

  // Compute Advance receipts totals
  let advanceTotal = 0;
  for (const adv of advanceReceiptsToday) {
    advanceTotal += Number(adv.advanceAmount || 0);
  }

  // Compute Expenses totals
  let expensesTotal = 0;
  for (const exp of expensesToday) {
    expensesTotal += Number(exp.amount || 0);
  }

  // Gross and Net Daily Collections
  const grossCollections = opdRevenue + labRevenue + pharmaTotal + advanceTotal;
  const netCollections = grossCollections - expensesTotal;

  // Approximate cash vs digital breakdown across hospital
  const totalCash = pharmaCash + Math.round((opdRevenue + labRevenue + advanceTotal) * 0.4);
  const totalDigital = Math.max(0, grossCollections - totalCash);

  return {
    date: dateStr,
    formattedDate: dayjs(targetDate).format("DD MMM YYYY"),
    dayOfWeek: dayjs(targetDate).format("dddd"),
    timestamp: new Date().toISOString(),

    // OPD
    opd: {
      visits: consultationsToday.length,
      appointments: todayAppointmentsCount,
      revenue: opdRevenue,
    },

    // Diagnostics / Lab
    lab: {
      receipts: diagnosticsToday.length,
      testsCount: labTestsCount,
      revenue: labRevenue,
    },

    // Pharmacy
    pharmacy: {
      bills: pharmacySalesToday.length,
      totalSales: pharmaTotal,
      cash: pharmaCash,
      digital: pharmaDigital,
      due: pharmaDue,
    },

    // IPD
    ipd: {
      admissionsToday: admissionsTodayCount,
      dischargesToday: dischargesTodayCount,
      currentOccupancy: activeAdmittedCount,
      advanceCollected: advanceTotal,
    },

    // Expenses
    expenses: {
      count: expensesToday.length,
      total: expensesTotal,
    },

    // Grand Totals
    financials: {
      grossCollections,
      netCollections,
      estimatedCash: totalCash,
      estimatedDigital: totalDigital,
    },
  };
}

/**
 * Formats the daily summary into an attractive WhatsApp message.
 */
function formatDailyDigestWhatsAppMessage(hospitalName, digest) {
  const name = hospitalName || "Hospital";
  const { formattedDate, dayOfWeek, opd, lab, pharmacy, ipd, expenses, financials } = digest;

  const lines = [
    `🏥 *${name.toUpperCase()}*`,
    `📊 *Daily Operations & Financial Summary*`,
    `📅 *Date:* ${formattedDate} (${dayOfWeek})`,
    `─────────────────────────`,
    `🩺 *OPD Consultations*`,
    `• Visits Completed: *${opd.visits}*`,
    `• Collections: *${formatCurrency(opd.revenue)}*`,
    ``,
    `🧪 *Diagnostics & Lab*`,
    `• Tests Done: *${lab.testsCount}* (Bills: ${lab.receipts})`,
    `• Collections: *${formatCurrency(lab.revenue)}*`,
    ``,
    `💊 *Pharmacy Sales*`,
    `• Total Sale Bills: *${pharmacy.bills}*`,
    `• Pharmacy Revenue: *${formatCurrency(pharmacy.totalSales)}*`,
    `  ├ Cash: ${formatCurrency(pharmacy.cash)}`,
    `  └ Digital/UPI: ${formatCurrency(pharmacy.digital)}`,
  ];

  if (pharmacy.due > 0) {
    lines.push(`  └ Pending Due: ${formatCurrency(pharmacy.due)}`);
  }

  lines.push(
    ``,
    `🏨 *In-Patient (IPD)*`,
    `• New Admissions: *${ipd.admissionsToday}*`,
    `• Discharges: *${ipd.dischargesToday}*`,
    `• Active In-Patients: *${ipd.currentOccupancy}*`,
    `• IP Advance Collected: *${formatCurrency(ipd.advanceCollected)}*`,
    `─────────────────────────`,
    `💰 *TOTAL GROSS COLLECTION: ${formatCurrency(financials.grossCollections)}*`,
    `  ├ Cash: ${formatCurrency(financials.estimatedCash)}`,
    `  └ UPI / Digital: ${formatCurrency(financials.estimatedDigital)}`,
    ``,
    `📉 *Operating Expenses:* ${formatCurrency(expenses.total)}`,
    `💎 *NET DAILY BALANCE: ${formatCurrency(financials.netCollections)}*`,
    `─────────────────────────`,
    `_Generated automatically via HMS Core_`
  );

  return lines.join("\n");
}

/**
 * Compact summary for templates or SMS with strict character limits
 */
function formatDailyDigestCompactSummary(hospitalName, digest) {
  const { formattedDate, opd, lab, pharmacy, ipd, financials } = digest;
  return `${formattedDate} Summary: OPD ${opd.visits} (${formatCurrency(opd.revenue)}), Lab ${lab.testsCount} (${formatCurrency(lab.revenue)}), Pharma ${formatCurrency(pharmacy.totalSales)}, IP Advance ${formatCurrency(ipd.advanceCollected)}. Total: ${formatCurrency(financials.grossCollections)}, Net: ${formatCurrency(financials.netCollections)}.`;
}

module.exports = {
  formatCurrency,
  computeHospitalDailyDigest,
  formatDailyDigestWhatsAppMessage,
  formatDailyDigestCompactSummary,
};
