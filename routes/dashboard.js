const express = require("express");
const router = express.Router();
const Patient = require("../models/Patient");
const Appointment = require("../models/Appointment");
const Consultation = require("../models/Consultation");
const Action = require("../models/Action");
const DiagnosticsReceipt = require("../models/DiagnosticsReceipt");
const PharmacyReceipt = require("../models/PharmacyReceipt");
const AdvanceReceipt = require("../models/AdvanceReceipt");
const Expense = require("../models/Expense");
const Staff = require("../models/Staff");
const dayjs = require("dayjs");
const auth = require("../middleware/auth");

router.use(auth);

// Helper function to calculate days between dates
const calculateDays = (startDate, endDate) => {
  const start = dayjs(startDate);
  const end = dayjs(endDate || new Date());
  return end.diff(start, "day") + 1;
};

// Get dashboard statistics
router.get("/statistics", async (req, res) => {
  try {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const today = new Date().toDateString();

    // Fetch all data in parallel
    const [
      patients,
      appointments,
      consultationReceipts,
      actionReceipts,
      diagnosticsReceipts,
      pharmacyReceipts,
      advanceReceipts,
      expenses,
      staff,
    ] = await Promise.all([
      Patient.find({ hospitalId: req.hospitalId }),
      Appointment.find({ hospitalId: req.hospitalId }),
      Consultation.find({ hospitalId: req.hospitalId }),
      Action.find({
        patientId: { $exists: true, $ne: null },
        hospitalId: req.hospitalId,
      }),
      DiagnosticsReceipt.find({ hospitalId: req.hospitalId }),
      PharmacyReceipt.find({ hospitalId: req.hospitalId }),
      AdvanceReceipt.find({ hospitalId: req.hospitalId }),
      Expense.find({ hospitalId: req.hospitalId }),
      Staff.find({ hospitalId: req.hospitalId }),
    ]);

    // Calculate consultation charges
    const totalConsultationCharges = consultationReceipts.reduce(
      (total, receipt) =>
        total +
        (receipt.items || []).reduce(
          (sum, item) =>
            sum + parseFloat(item.charges || 0) * (item.quantity || 1),
          0
        ),
      0
    );

    // Calculate investigation charges
    const totalInvestigationCharges = diagnosticsReceipts.reduce(
      (total, receipt) =>
        total +
        (receipt.items || []).reduce(
          (sum, item) => sum + parseFloat(item.price || 0),
          0
        ),
      0
    );

    // Calculate procedure charges
    const totalProcedureCharges = actionReceipts.reduce(
      (total, receipt) =>
        total +
        (receipt.items || [])
          .filter((data) => data.category === "Procedure Charges")
          .reduce(
            (sum, item) =>
              sum + parseFloat(item.rate || 0) * (item.quantity || 1),
            0
          ),
      0
    );

    // Calculate service charges
    const totalServiceCharges = actionReceipts.reduce(
      (total, receipt) =>
        total +
        (receipt.items || [])
          .filter((data) => data.category === "Service Charges")
          .reduce(
            (sum, item) =>
              sum + parseFloat(item.rate || 0) * (item.quantity || 1),
            0
          ),
      0
    );

    // Calculate pharmacy charges
    const pharmacySaleReceipts = pharmacyReceipts.filter(
      (data) => data.type === "pharmacy-sale"
    );
    const pharmacyReturnReceipts = pharmacyReceipts.filter(
      (data) => data.type === "pharmacy-sale-return"
    );

    const totalPharmacySaleCharges = pharmacySaleReceipts.reduce(
      (total, receipt) =>
        total +
        (receipt.items || []).reduce((prev, item) => {
          const batchTotal = (item?.batches || []).reduce(
            (batchPrev, { bill_amount }) =>
              batchPrev + parseFloat(bill_amount || 0),
            0
          );
          return prev + batchTotal;
        }, 0),
      0
    );

    const totalPharmacyReturnCharges = pharmacyReturnReceipts.reduce(
      (total, receipt) =>
        total +
        (receipt.items || []).reduce((prev, item) => {
          const batchTotal = (item?.batches || []).reduce(
            (batchPrev, { bill_amount }) =>
              batchPrev + parseFloat(bill_amount || 0),
            0
          );
          return prev + batchTotal;
        }, 0),
      0
    );

    const totalPharmacyCharges =
      totalPharmacySaleCharges - totalPharmacyReturnCharges;

    // Calculate ward charges for all patients
    let totalWardCharges = 0;
    const allPatients = patients.filter(
      (patient) => patient.active === true || patient.active === false
    );

    allPatients.forEach((patient) => {
      const patientTransfers = patient.transfers || [];
      const isDischarged = patient?.active === false;
      const dischargeDt = isDischarged
        ? patient?.dischargeDate || dayjs().format("YYYY-MM-DD")
        : dayjs().format("YYYY-MM-DD");

      for (let i = 0; i < patientTransfers.length; i++) {
        const currentTransfer = patientTransfers[i];
        const nextTransfer = patientTransfers[i + 1] || {
          transferDate: dischargeDt,
        };

        const daysSpent = calculateDays(
          currentTransfer.transferDate,
          nextTransfer.transferDate
        );
        const wardPrice = parseInt(currentTransfer.price || 0, 10);

        totalWardCharges += daysSpent * wardPrice;
      }
    });

    // Calculate advance payments
    const totalAdvanceCharges = advanceReceipts.reduce(
      (total, receipt) => total + parseFloat(receipt.advanceAmount || 0),
      0
    );

    // Calculate total revenue
    const totalRevenue =
      totalWardCharges +
      totalConsultationCharges +
      totalServiceCharges +
      totalProcedureCharges +
      totalInvestigationCharges +
      totalPharmacyCharges;

    // Calculate monthly revenue
    const monthlyConsultationCharges = consultationReceipts
      .filter(
        (receipt) => new Date(receipt.createdAt || receipt.date) >= thisMonth
      )
      .reduce(
        (total, receipt) =>
          total +
          (receipt.items || []).reduce(
            (sum, item) =>
              sum + parseFloat(item.charges || 0) * (item.quantity || 1),
            0
          ),
        0
      );

    const monthlyInvestigationCharges = diagnosticsReceipts
      .filter(
        (receipt) => new Date(receipt.createdAt || receipt.date) >= thisMonth
      )
      .reduce(
        (total, receipt) =>
          total +
          (receipt.items || []).reduce(
            (sum, item) => sum + parseFloat(item.price || 0),
            0
          ),
        0
      );

    const monthlyPharmacyCharges = pharmacySaleReceipts
      .filter(
        (receipt) => new Date(receipt.createdAt || receipt.date) >= thisMonth
      )
      .reduce(
        (total, receipt) =>
          total +
          (receipt.items || []).reduce((prev, item) => {
            const batchTotal = (item?.batches || []).reduce(
              (batchPrev, { bill_amount }) =>
                batchPrev + parseFloat(bill_amount || 0),
              0
            );
            return prev + batchTotal;
          }, 0),
        0
      );

    const monthlyRevenue =
      monthlyConsultationCharges +
      monthlyInvestigationCharges +
      monthlyPharmacyCharges;

    // Calculate today's appointments
    const todayAppointments = appointments.filter(
      (appointment) =>
        new Date(appointment.appointmentDate).toDateString() === today
    ).length;

    // Calculate active patients
    const activePatientsCount = patients.filter(
      (patient) => patient.active === true
    ).length;

    // Calculate total expenses
    const totalExpenses = expenses.reduce(
      (sum, expense) => sum + parseFloat(expense.amount || 0),
      0
    );

    // Generate recent activities
    const recentActivities = [
      ...appointments.slice(0, 3).map((appointment) => ({
        title: `Appointment: ${appointment.patientName || "Patient"} with Dr. ${
          appointment.doctorName || "Doctor"
        }`,
        time: new Date(appointment.appointmentDate).toLocaleDateString(),
      })),
      ...pharmacySaleReceipts.slice(0, 2).map((receipt) => ({
        title: `Pharmacy Sale: ₹${(receipt.totalAmount || 0).toLocaleString()}`,
        time: new Date(receipt.createdAt || receipt.date).toLocaleDateString(),
      })),
      ...consultationReceipts.slice(0, 2).map((receipt) => ({
        title: `Consultation: ₹${(receipt.items || [])
          .reduce(
            (sum, item) =>
              sum + parseFloat(item.charges || 0) * (item.quantity || 1),
            0
          )
          .toLocaleString()}`,
        time: new Date(receipt.createdAt || receipt.date).toLocaleDateString(),
      })),
    ].sort((a, b) => new Date(b.time) - new Date(a.time));

    // Generate monthly data for charts
    const monthlyData = Array.from({ length: 12 }, (_, i) => {
      const month = new Date(now.getFullYear(), i, 1);
      const monthConsultationRevenue = consultationReceipts
        .filter((receipt) => {
          const receiptDate = new Date(receipt.createdAt || receipt.date);
          return (
            receiptDate.getMonth() === i &&
            receiptDate.getFullYear() === now.getFullYear()
          );
        })
        .reduce(
          (total, receipt) =>
            total +
            (receipt.items || []).reduce(
              (sum, item) =>
                sum + parseFloat(item.charges || 0) * (item.quantity || 1),
              0
            ),
          0
        );

      const monthInvestigationRevenue = diagnosticsReceipts
        .filter((receipt) => {
          const receiptDate = new Date(receipt.createdAt || receipt.date);
          return (
            receiptDate.getMonth() === i &&
            receiptDate.getFullYear() === now.getFullYear()
          );
        })
        .reduce(
          (total, receipt) =>
            total +
            (receipt.items || []).reduce(
              (sum, item) => sum + parseFloat(item.price || 0),
              0
            ),
          0
        );

      const monthPharmacyRevenue = pharmacySaleReceipts
        .filter((receipt) => {
          const receiptDate = new Date(receipt.createdAt || receipt.date);
          return (
            receiptDate.getMonth() === i &&
            receiptDate.getFullYear() === now.getFullYear()
          );
        })
        .reduce(
          (total, receipt) =>
            total +
            (receipt.items || []).reduce((prev, item) => {
              const batchTotal = (item?.batches || []).reduce(
                (batchPrev, { bill_amount }) =>
                  batchPrev + parseFloat(bill_amount || 0),
                0
              );
              return prev + batchTotal;
            }, 0),
          0
        );

      return {
        month: month.toLocaleDateString("en-US", { month: "short" }),
        consultation: monthConsultationRevenue,
        investigation: monthInvestigationRevenue,
        pharmacy: monthPharmacyRevenue,
        total:
          monthConsultationRevenue +
          monthInvestigationRevenue +
          monthPharmacyRevenue,
      };
    });

    // Generate patient data for line chart (last 6 months)
    const patientData = Array.from({ length: 6 }, (_, i) => {
      const month = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
      const monthPatients = patients.filter((patient) => {
        const registrationDate = new Date(patient.registration_date);
        return (
          registrationDate.getMonth() === month.getMonth() &&
          registrationDate.getFullYear() === month.getFullYear()
        );
      }).length;

      return {
        month: month.toLocaleDateString("en-US", { month: "short" }),
        count: monthPatients,
      };
    });

    // Calculate department statistics
    const departmentStats = staff.reduce((acc, member) => {
      const dept = member.department || "Other";
      acc[dept] = (acc[dept] || 0) + 1;
      return acc;
    }, {});

    res.json({
      totalPatients: patients.length,
      activePatients: activePatientsCount,
      totalAppointments: appointments.length,
      todayAppointments,
      totalRevenue,
      monthlyRevenue,
      totalStaff: staff.length,
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
      departmentStats: Object.entries(departmentStats).map(([dept, count]) => ({
        dept,
        count,
      })),
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
