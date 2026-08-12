const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const dayjs = require("dayjs");
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "core" });

// Helper function to calculate days between dates
const calculateDays = (startDate, endDate) => {
  const start = dayjs(startDate);
  const end = dayjs(endDate || new Date());
  if (!start.isValid() || !end.isValid()) return 0;
  return Math.max(0, end.diff(start, "day") + 1);
};

// Get dashboard statistics with efficient MongoDB aggregations
router.get("/statistics", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    const Appointment = req.tenantDb.model("Appointment");
    const Consultation = req.tenantDb.model("Consultation");
    const Action = req.tenantDb.model("Action");
    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
    const PharmacyReceipt = req.tenantDb.model("PharmacyReceipt");
    const AdvanceReceipt = req.tenantDb.model("AdvanceReceipt");
    const Expense = req.tenantDb.model("Expense");
    const Staff = req.tenantDb.model("Staff");

    const hospitalId = req.hospitalId;
    const hospitalObjId = mongoose.Types.ObjectId.isValid(hospitalId)
      ? new mongoose.Types.ObjectId(hospitalId)
      : hospitalId;

    // Match filter that safely matches either string or ObjectId in Mongo
    const matchFilter = {
      hospitalId: { $in: [hospitalId, hospitalObjId] },
    };

    const now = new Date();
    const currentYear = now.getFullYear();
    const thisMonthStart = new Date(currentYear, now.getMonth(), 1);
    const todayStart = dayjs().startOf("day").toDate();
    const todayEnd = dayjs().endOf("day").toDate();
    const todayStr = dayjs().format("YYYY-MM-DD");

    // Run aggregations and lightweight queries in parallel
    const [
      totalPatients,
      activePatients,
      totalAppointments,
      todayAppointments,
      totalStaff,
      totalExpensesAgg,
      consultationRevenueAgg,
      monthlyConsultationAgg,
      diagnosticsRevenueAgg,
      monthlyDiagnosticsAgg,
      actionRevenueAgg,
      pharmacyRevenueAgg,
      monthlyPharmacyAgg,
      advanceReceiptsAgg,
      departmentStatsAgg,
      recentAppointments,
      recentPharmacySales,
      recentConsultations,
      activePatientsForWard,
    ] = await Promise.all([
      // 1. Patient counts
      Patient.countDocuments(matchFilter),
      Patient.countDocuments({ ...matchFilter, active: true }),

      // 2. Appointment counts
      Appointment.countDocuments(matchFilter),
      Appointment.countDocuments({
        ...matchFilter,
        $or: [
          { appointmentDate: { $gte: todayStart, $lte: todayEnd } },
          { appointmentDate: todayStr },
          { appointmentDate: new RegExp(`^${todayStr}`) },
        ],
      }),

      // 3. Staff count
      Staff.countDocuments(matchFilter),

      // 4. Expenses Aggregation
      Expense.aggregate([
        { $match: matchFilter },
        { $group: { _id: null, total: { $sum: { $toDouble: { $ifNull: ["$amount", 0] } } } } },
      ]),

      // 5. Consultation Total Revenue Aggregation
      Consultation.aggregate([
        { $match: matchFilter },
        { $unwind: { path: "$items", preserveNullAndEmptyArrays: false } },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $multiply: [
                  { $toDouble: { $ifNull: ["$items.charges", 0] } },
                  { $toDouble: { $ifNull: ["$items.quantity", 1] } },
                ],
              },
            },
          },
        },
      ]),

      // 6. Monthly Consultation Revenue (Current Year)
      Consultation.aggregate([
        {
          $match: {
            ...matchFilter,
            $or: [
              { createdAt: { $gte: new Date(currentYear, 0, 1) } },
              { date: { $gte: new Date(currentYear, 0, 1).toISOString() } },
            ],
          },
        },
        { $unwind: "$items" },
        {
          $project: {
            month: {
              $month: {
                $ifNull: ["$createdAt", { $toDate: "$date" }],
              },
            },
            amount: {
              $multiply: [
                { $toDouble: { $ifNull: ["$items.charges", 0] } },
                { $toDouble: { $ifNull: ["$items.quantity", 1] } },
              ],
            },
          },
        },
        { $group: { _id: "$month", total: { $sum: "$amount" } } },
      ]),

      // 7. Diagnostics/Investigation Total Revenue
      DiagnosticsReceipt.aggregate([
        { $match: matchFilter },
        { $unwind: "$items" },
        { $group: { _id: null, total: { $sum: { $toDouble: { $ifNull: ["$items.price", 0] } } } } },
      ]),

      // 8. Monthly Diagnostics Revenue (Current Year)
      DiagnosticsReceipt.aggregate([
        {
          $match: {
            ...matchFilter,
            $or: [
              { createdAt: { $gte: new Date(currentYear, 0, 1) } },
              { date: { $gte: new Date(currentYear, 0, 1).toISOString() } },
            ],
          },
        },
        { $unwind: "$items" },
        {
          $project: {
            month: {
              $month: {
                $ifNull: ["$createdAt", { $toDate: "$date" }],
              },
            },
            price: { $toDouble: { $ifNull: ["$items.price", 0] } },
          },
        },
        { $group: { _id: "$month", total: { $sum: "$price" } } },
      ]),

      // 9. Actions (Procedure and Service Charges)
      Action.aggregate([
        {
          $match: {
            ...matchFilter,
            patientId: { $exists: true, $ne: null },
          },
        },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.category",
            total: {
              $sum: {
                $multiply: [
                  { $toDouble: { $ifNull: ["$items.rate", 0] } },
                  { $toDouble: { $ifNull: ["$items.quantity", 1] } },
                ],
              },
            },
          },
        },
      ]),

      // 10. Pharmacy Total Revenue by Type
      PharmacyReceipt.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: "$type",
            total: { $sum: { $toDouble: { $ifNull: ["$totalAmount", 0] } } },
          },
        },
      ]),

      // 11. Monthly Pharmacy Sales Revenue (Current Year)
      PharmacyReceipt.aggregate([
        {
          $match: {
            ...matchFilter,
            type: "pharmacy-sale",
            $or: [
              { createdAt: { $gte: new Date(currentYear, 0, 1) } },
              { date: { $gte: new Date(currentYear, 0, 1).toISOString() } },
            ],
          },
        },
        {
          $project: {
            month: {
              $month: {
                $ifNull: ["$createdAt", { $toDate: "$date" }],
              },
            },
            totalAmount: { $toDouble: { $ifNull: ["$totalAmount", 0] } },
          },
        },
        { $group: { _id: "$month", total: { $sum: "$totalAmount" } } },
      ]),

      // 12. Advance Receipts Total
      AdvanceReceipt.aggregate([
        { $match: matchFilter },
        { $group: { _id: null, total: { $sum: { $toDouble: { $ifNull: ["$advanceAmount", 0] } } } } },
      ]),

      // 13. Department Stats
      Staff.aggregate([
        { $match: matchFilter },
        { $group: { _id: { $ifNull: ["$department", "Other"] }, count: { $sum: 1 } } },
      ]),

      // 14. Top Recent Activities
      Appointment.find(matchFilter)
        .sort({ appointmentDate: -1, createdAt: -1 })
        .limit(3)
        .select("patientName doctorName appointmentDate")
        .lean(),

      PharmacyReceipt.find({ ...matchFilter, type: "pharmacy-sale" })
        .sort({ createdAt: -1, date: -1 })
        .limit(2)
        .select("totalAmount createdAt date")
        .lean(),

      Consultation.find(matchFilter)
        .sort({ createdAt: -1, date: -1 })
        .limit(2)
        .select("items createdAt date")
        .lean(),

      // 15. Only fetch transfers from active or recently active IPD patients for ward charge calculation
      Patient.find({
        ...matchFilter,
        transfers: { $exists: true, $not: { $size: 0 } },
      })
        .select("active transfers dischargeDate dischargedAt updatedAt")
        .lean(),
    ]);

    // Extract totals from aggregations
    const totalConsultationCharges = consultationRevenueAgg[0]?.total || 0;
    const totalInvestigationCharges = diagnosticsRevenueAgg[0]?.total || 0;
    const totalExpenses = totalExpensesAgg[0]?.total || 0;
    const totalAdvanceCharges = advanceReceiptsAgg[0]?.total || 0;

    let totalProcedureCharges = 0;
    let totalServiceCharges = 0;
    for (const act of actionRevenueAgg) {
      if (act._id === "Procedure Charges") totalProcedureCharges = act.total;
      if (act._id === "Service Charges") totalServiceCharges = act.total;
    }

    let pharmacySaleTotal = 0;
    let pharmacyReturnTotal = 0;
    for (const pr of pharmacyRevenueAgg) {
      if (pr._id === "pharmacy-sale") pharmacySaleTotal = pr.total;
      if (pr._id === "pharmacy-sale-return") pharmacyReturnTotal = pr.total;
    }
    const totalPharmacyCharges = Math.max(0, pharmacySaleTotal - pharmacyReturnTotal);

    // Calculate Ward charges from IPD patient transfers
    let totalWardCharges = 0;
    const resolveDischargeMoment = (p) => {
      if (!p || p.active !== false) return null;
      const candidates = [p.dischargeDate, p.dischargedAt, p.updatedAt];
      for (const candidate of candidates) {
        if (!candidate) continue;
        const m = dayjs(candidate);
        if (m.isValid()) return m;
      }
      return null;
    };

    for (const patient of activePatientsForWard) {
      const patientTransfers = patient.transfers || [];
      const dischargeMoment = resolveDischargeMoment(patient);
      const dischargeDt = dischargeMoment
        ? dischargeMoment.format("YYYY-MM-DD")
        : dayjs().format("YYYY-MM-DD");

      for (let i = 0; i < patientTransfers.length; i++) {
        const currentTransfer = patientTransfers[i];
        const nextTransfer = patientTransfers[i + 1] || {
          transferDate: dischargeDt,
        };

        const daysSpent = calculateDays(
          currentTransfer.transferDate,
          nextTransfer.transferDate,
        );
        const wardPrice = parseInt(currentTransfer.price || 0, 10);
        totalWardCharges += daysSpent * wardPrice;
      }
    }

    // Total Revenue
    const totalRevenue =
      totalWardCharges +
      totalConsultationCharges +
      totalServiceCharges +
      totalProcedureCharges +
      totalInvestigationCharges +
      totalPharmacyCharges;

    // Monthly revenue for current month (1-indexed month)
    const currentMonthNum = now.getMonth() + 1;
    const monthlyConsultation = monthlyConsultationAgg.find((m) => m._id === currentMonthNum)?.total || 0;
    const monthlyDiagnostics = monthlyDiagnosticsAgg.find((m) => m._id === currentMonthNum)?.total || 0;
    const monthlyPharmacy = monthlyPharmacyAgg.find((m) => m._id === currentMonthNum)?.total || 0;
    const monthlyRevenue = monthlyConsultation + monthlyDiagnostics + monthlyPharmacy;

    // Build 12-month chart data
    const monthlyData = Array.from({ length: 12 }, (_, i) => {
      const monthNum = i + 1;
      const monthDate = new Date(currentYear, i, 1);
      const consultation = monthlyConsultationAgg.find((m) => m._id === monthNum)?.total || 0;
      const investigation = monthlyDiagnosticsAgg.find((m) => m._id === monthNum)?.total || 0;
      const pharmacy = monthlyPharmacyAgg.find((m) => m._id === monthNum)?.total || 0;

      return {
        month: monthDate.toLocaleDateString("en-US", { month: "short" }),
        consultation,
        investigation,
        pharmacy,
        total: consultation + investigation + pharmacy,
      };
    });

    // Patient Growth Data for last 6 months via quick count/group
    const patientData = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const targetMonth = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
        const nextMonth = new Date(now.getFullYear(), now.getMonth() - 4 + i, 1);
        const count = await Patient.countDocuments({
          ...matchFilter,
          $or: [
            { createdAt: { $gte: targetMonth, $lt: nextMonth } },
            {
              registration_date: {
                $gte: targetMonth.toISOString().split("T")[0],
                $lt: nextMonth.toISOString().split("T")[0],
              },
            },
          ],
        });
        return {
          month: targetMonth.toLocaleDateString("en-US", { month: "short" }),
          count,
        };
      })
    );

    // Build recent activities list
    const recentActivities = [
      ...recentAppointments.map((appointment) => ({
        title: `Appointment: ${appointment.patientName || "Patient"} with Dr. ${
          appointment.doctorName || "Doctor"
        }`,
        time: new Date(appointment.appointmentDate || Date.now()).toLocaleDateString(),
      })),
      ...recentPharmacySales.map((receipt) => ({
        title: `Pharmacy Sale: ₹${(receipt.totalAmount || 0).toLocaleString()}`,
        time: new Date(receipt.createdAt || receipt.date || Date.now()).toLocaleDateString(),
      })),
      ...recentConsultations.map((receipt) => ({
        title: `Consultation: ₹${(receipt.items || [])
          .reduce(
            (sum, item) =>
              sum + parseFloat(item.charges || 0) * (item.quantity || 1),
            0,
          )
          .toLocaleString()}`,
        time: new Date(receipt.createdAt || receipt.date || Date.now()).toLocaleDateString(),
      })),
    ].sort((a, b) => new Date(b.time) - new Date(a.time));

    // Department breakdown
    const departmentStats = departmentStatsAgg.map((dept) => ({
      dept: dept._id,
      count: dept.count,
    }));

    res.json({
      totalPatients,
      activePatients,
      totalAppointments,
      todayAppointments,
      totalRevenue,
      monthlyRevenue,
      totalStaff,
      totalExpenses,
      pharmacyRevenue: totalPharmacyCharges,
      labRevenue: totalInvestigationCharges,
      consultationRevenue: totalConsultationCharges,
      procedureRevenue: totalProcedureCharges,
      serviceRevenue: totalServiceCharges,
      wardRevenue: totalWardCharges,
      recentActivities,
      monthlyData,
      patientData,
      departmentStats,
      billingBreakdown: {
        wardCharges: totalWardCharges,
        consultationCharges: totalConsultationCharges,
        investigationCharges: totalInvestigationCharges,
        serviceCharges: totalServiceCharges,
        procedureCharges: totalProcedureCharges,
        pharmacyCharges: totalPharmacyCharges,
      },
    });
  } catch (error) {
    console.error("Error calculating dashboard statistics:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
