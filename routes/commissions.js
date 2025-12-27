const express = require("express");
const router = express.Router();
const Patient = require("../models/Patient");
const Consultation = require("../models/Consultation");
const Action = require("../models/Action");
const DiagnosticsReceipt = require("../models/DiagnosticsReceipt");
const PharmacyReceipt = require("../models/PharmacyReceipt");
const AdvanceReceipt = require("../models/AdvanceReceipt");
const auth = require("../middleware/auth");

router.use(auth);

// Helper functions (same logic as frontend commissionService)
const getReceiptType = (receipt) => {
  if (
    receipt.type === "pharmacy-sale" ||
    receipt.type === "pharmacy-sale-return"
  ) {
    return "pharmacy";
  }
  if (receipt.type === "lab" || receipt.type === "diagnostic") {
    return "lab";
  }
  if (receipt.items && receipt.items.length > 0) {
    for (const item of receipt.items) {
      if (
        item.category?.includes("Consultation") ||
        item.mainCategory?.includes("Consultation") ||
        item.name?.toLowerCase().includes("consultation") ||
        item.name?.toLowerCase().includes("visit") ||
        (item.charges && !item.rate && !item.price)
      ) {
        return "consultation";
      }
      if (
        item.category?.includes("Procedure") ||
        item.mainCategory?.includes("Procedure") ||
        item.category?.includes("Surgery") ||
        item.mainCategory?.includes("Surgery") ||
        item.name?.toLowerCase().includes("surgery") ||
        item.name?.toLowerCase().includes("procedure") ||
        item.name?.toLowerCase().includes("operation") ||
        (item.rate && !item.charges)
      ) {
        return "surgery";
      }
      if (
        item.category?.includes("Test") ||
        item.mainCategory?.includes("Test") ||
        item.category?.includes("Lab") ||
        item.mainCategory?.includes("Lab") ||
        item.name?.toLowerCase().includes("test") ||
        item.name?.toLowerCase().includes("lab") ||
        item.name?.toLowerCase().includes("diagnostic") ||
        (item.price && !item.charges && !item.rate)
      ) {
        return "lab";
      }
      if (
        item.category?.includes("Medicine") ||
        item.mainCategory?.includes("Medicine") ||
        item.category?.includes("Drug") ||
        item.mainCategory?.includes("Drug") ||
        item.name?.toLowerCase().includes("medicine") ||
        item.name?.toLowerCase().includes("drug") ||
        item.name?.toLowerCase().includes("tablet") ||
        item.name?.toLowerCase().includes("capsule") ||
        item.batches
      ) {
        return "pharmacy";
      }
    }
    const firstItem = receipt.items[0];
    if (receipt.doctorData && firstItem.charges) {
      return "consultation";
    }
    if (firstItem.rate) {
      return "surgery";
    }
    if (firstItem.price) {
      return "lab";
    }
    if (firstItem.batches) {
      return "pharmacy";
    }
  }
  if (receipt.doctorData) {
    return "consultation";
  }
  return null;
};

const getReceiptAmount = (receipt) => {
  if (!receipt) return 0;
  if (receipt.totalAmount && typeof receipt.totalAmount === "number") {
    return receipt.totalAmount;
  }
  if (!receipt.items || !Array.isArray(receipt.items)) return 0;
  return receipt.items.reduce((total, item) => {
    if (typeof item.charges === "number") {
      return total + item.charges * (item.quantity || 1);
    }
    if (typeof item.rate === "number") {
      return total + item.rate * (item.quantity || 1);
    }
    if (typeof item.price === "number") {
      return total + item.price * (item.quantity || 1);
    }
    if (item.batches && Array.isArray(item.batches)) {
      const batchTotal = item.batches.reduce(
        (batchSum, batch) => batchSum + (batch.bill_amount || 0),
        0
      );
      return total + batchTotal;
    }
    if (typeof item.bill_amount === "number") {
      return total + item.bill_amount;
    }
    return total;
  }, 0);
};

const findPatientForReceipt = (receipt, patients) => {
  return patients.find((p) => {
    const receiptPatientId = receipt.patientId;
    const patientUMR = p.UMRNo;
    const patientId = p.patientId;
    const patientDbId = p._id?.toString();
    if (receiptPatientId === patientUMR) return true;
    if (receiptPatientId === patientId) return true;
    if (receiptPatientId === patientDbId) return true;
    if (String(receiptPatientId) === String(patientUMR)) return true;
    if (String(receiptPatientId) === String(patientId)) return true;
    if (String(receiptPatientId) === String(patientDbId)) return true;
    return false;
  });
};

const calculateMonthlyTotals = (receipts, advanceReceipts, patients) => {
  const monthlyTotals = {};
  const currentMonth = new Date().toISOString().slice(0, 7);
  receipts.forEach((receipt) => {
    const patient = findPatientForReceipt(receipt, patients);
    if (
      patient &&
      patient.commissionEarnerType === "PRO" &&
      patient.patient_type === "OP"
    ) {
      const receiptDate = new Date(receipt.createdAt || new Date());
      const receiptMonth = receiptDate.toISOString().slice(0, 7);
      if (receiptMonth === currentMonth) {
        const amount = getReceiptAmount(receipt) - (receipt.discount || 0);
        const key = `${patient.commissionEarnerId}_${receiptMonth}`;
        monthlyTotals[key] = (monthlyTotals[key] || 0) + Math.max(0, amount);
      }
    }
  });
  advanceReceipts.forEach((receipt) => {
    const patient = findPatientForReceipt(receipt, patients);
    if (
      patient &&
      patient.commissionEarnerType === "PRO" &&
      patient.patient_type === "IP"
    ) {
      const receiptDate = new Date(receipt.createdAt || new Date());
      const receiptMonth = receiptDate.toISOString().slice(0, 7);
      if (receiptMonth === currentMonth) {
        if (
          receipt.receiptType === "Final Bill" ||
          receipt.type === "advance"
        ) {
          const totalCharges =
            (receipt.consultationCharges || 0) +
            (receipt.investigationCharges || 0) +
            (receipt.pharmacyCharges || 0) +
            (receipt.wardCharges || 0) +
            (receipt.serviceCharges || 0) +
            (receipt.procedureCharges || 0);
          const discountAmount = receipt.discount || 0;
          const totalBill = receipt.totalBill || 0;
          const discountPercentage =
            totalBill > 0 ? discountAmount / totalBill : 0;
          const finalAmount = Math.max(
            0,
            totalCharges - totalCharges * discountPercentage
          );
          const key = `${patient.commissionEarnerId}_${receiptMonth}`;
          monthlyTotals[key] = (monthlyTotals[key] || 0) + finalAmount;
        } else {
          const amount =
            (receipt.totalAmount || receipt.advanceAmount || 0) -
            (receipt.discount || 0);
          const key = `${patient.commissionEarnerId}_${receiptMonth}`;
          monthlyTotals[key] = (monthlyTotals[key] || 0) + Math.max(0, amount);
        }
      }
    }
  });
  return monthlyTotals;
};

const calculateOPCommission = (patient, receipts, monthlyTotals) => {
  const {
    commissionEarnerType,
    commissionEarnerId,
    commissionEarnerName,
    commissionRates,
  } = patient;
  const receiptBreakdown = [];
  let totalReceiptAmount = 0;
  let totalDiscountAmount = 0;
  let totalFinalAmount = 0;
  let totalRegularCommission = 0;
  receipts.forEach((receipt) => {
    const receiptType = getReceiptType(receipt);
    if (!receiptType) return;
    const receiptAmount = getReceiptAmount(receipt);
    const discountAmount = receipt.discount || 0;
    const finalAmount = Math.max(0, receiptAmount - discountAmount);
    if (finalAmount > 0) {
      const commissionRate = commissionRates?.[receiptType] || 0;
      const regularCommissionAmount = finalAmount * commissionRate;
      totalReceiptAmount += receiptAmount;
      totalDiscountAmount += discountAmount;
      totalFinalAmount += finalAmount;
      totalRegularCommission += regularCommissionAmount;
      receiptBreakdown.push({
        receiptId: receipt.receiptId || receipt._id,
        receiptType,
        receiptAmount,
        discountAmount,
        finalAmount,
        commissionRate,
        commissionAmount: regularCommissionAmount,
        receiptDate: receipt.createdAt || new Date().toISOString(),
      });
    }
  });
  if (totalFinalAmount <= 0) return null;
  let proBonusAmount = 0;
  if (commissionEarnerType === "PRO" && totalFinalAmount > 0) {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const monthlyKey = `${commissionEarnerId}_${currentMonth}`;
    const monthlyTotal = monthlyTotals[monthlyKey] || 0;
    if (monthlyTotal >= 500000) {
      const excessAmount = monthlyTotal - 500000;
      const bonusEligibleAmount = Math.min(excessAmount, totalFinalAmount);
      proBonusAmount = bonusEligibleAmount * 0.05;
    }
  }
  const totalCommissionAmount = totalRegularCommission + proBonusAmount;
  return {
    commissionId: `COMM-${Date.now()}-${Math.random().toString().slice(2, 6)}`,
    patientId: patient.UMRNo || patient.patientId,
    patientName: patient.name,
    patientType: "OP",
    commissionEarnerType,
    commissionEarnerId,
    commissionEarnerName,
    receiptId: receipts[0]?.receiptId || receipts[0]?._id,
    receiptType: "OP Summary",
    receiptAmount: totalReceiptAmount,
    discountAmount: totalDiscountAmount,
    finalAmount: totalFinalAmount,
    commissionRate:
      totalFinalAmount > 0 ? totalRegularCommission / totalFinalAmount : 0,
    regularCommissionAmount: totalRegularCommission,
    proBonusAmount,
    commissionAmount: totalCommissionAmount,
    receiptBreakdown,
    status: "Pending",
    settlementDate: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    receiptDate: receipts[0]?.createdAt || new Date().toISOString(),
  };
};

const calculateIPCommission = (receipt, patient, monthlyTotals) => {
  const {
    commissionEarnerType,
    commissionEarnerId,
    commissionEarnerName,
    commissionRates,
  } = patient;
  const discountAmount = receipt.discount || 0;
  const totalBill = receipt.totalBill || 0;
  const discountPercentage = totalBill > 0 ? discountAmount / totalBill : 0;
  const chargeMappings = [
    {
      chargeField: "consultationCharges",
      commissionType: "consultation",
      amount: receipt.consultationCharges || 0,
      label: "Consultation",
    },
    {
      chargeField: "investigationCharges",
      commissionType: "lab",
      amount: receipt.investigationCharges || 0,
      label: "Lab/Investigation",
    },
    {
      chargeField: "pharmacyCharges",
      commissionType: "pharmacy",
      amount: receipt.pharmacyCharges || 0,
      label: "Pharmacy",
    },
    {
      chargeField: "surgeryCharges",
      commissionType: "surgery",
      amount:
        (receipt.wardCharges || 0) +
        (receipt.serviceCharges || 0) +
        (receipt.procedureCharges || 0),
      label: "Surgery (Ward+Service+Procedure)",
    },
  ];
  const chargeBreakdown = [];
  let totalRegularCommission = 0;
  let totalFinalAmount = 0;
  chargeMappings.forEach(({ commissionType, amount, label }) => {
    if (amount > 0) {
      const chargeDiscount = amount * discountPercentage;
      const finalChargeAmount = Math.max(0, amount - chargeDiscount);
      if (finalChargeAmount > 0) {
        const commissionRate = commissionRates?.[commissionType] || 0;
        const regularCommissionAmount = finalChargeAmount * commissionRate;
        totalRegularCommission += regularCommissionAmount;
        totalFinalAmount += finalChargeAmount;
        chargeBreakdown.push({
          type: commissionType,
          label,
          originalAmount: amount,
          discount: chargeDiscount,
          finalAmount: finalChargeAmount,
          commissionRate,
          commissionAmount: regularCommissionAmount,
        });
      }
    }
  });
  let proBonusAmount = 0;
  if (commissionEarnerType === "PRO" && totalFinalAmount > 0) {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const monthlyKey = `${commissionEarnerId}_${currentMonth}`;
    const monthlyTotal = monthlyTotals[monthlyKey] || 0;
    if (monthlyTotal >= 500000) {
      const excessAmount = monthlyTotal - 500000;
      const bonusEligibleAmount = Math.min(excessAmount, totalFinalAmount);
      proBonusAmount = bonusEligibleAmount * 0.05;
    }
  }
  const totalCommissionAmount = totalRegularCommission + proBonusAmount;
  return {
    commissionId: `COMM-${Date.now()}-${Math.random().toString().slice(2, 6)}`,
    patientId: patient.UMRNo || patient.patientId,
    patientName: patient.name,
    patientType: "IP",
    commissionEarnerType,
    commissionEarnerId,
    commissionEarnerName,
    receiptId: receipt.receiptId || receipt._id,
    receiptType: "Final Bill",
    receiptAmount: totalBill,
    discountAmount,
    finalAmount: totalFinalAmount,
    commissionRate:
      totalFinalAmount > 0 ? totalRegularCommission / totalFinalAmount : 0,
    regularCommissionAmount: totalRegularCommission,
    proBonusAmount,
    commissionAmount: totalCommissionAmount,
    chargeBreakdown,
    status: "Pending",
    settlementDate: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    receiptDate: receipt.createdAt || new Date().toISOString(),
  };
};

// Get all commissions
router.get("/", async (req, res) => {
  try {
    const [
      patients,
      consultationReceipts,
      actionReceipts,
      diagnosticsReceipts,
      pharmacyReceipts,
      advanceReceipts,
    ] = await Promise.all([
      Patient.find({ hospitalId: req.hospitalId }),
      Consultation.find({ hospitalId: req.hospitalId }),
      Action.find({
        patientId: { $exists: true, $ne: null },
        hospitalId: req.hospitalId,
      }),
      DiagnosticsReceipt.find({ hospitalId: req.hospitalId }),
      PharmacyReceipt.find({
        type: "pharmacy-sale",
        hospitalId: req.hospitalId,
      }),
      AdvanceReceipt.find({ hospitalId: req.hospitalId }),
    ]);

    const allReceipts = [
      ...consultationReceipts,
      ...actionReceipts,
      ...pharmacyReceipts,
      ...diagnosticsReceipts,
    ];

    const monthlyTotals = calculateMonthlyTotals(
      allReceipts,
      advanceReceipts,
      patients
    );

    const patientReceipts = {};
    const patientAdvanceReceipts = {};

    allReceipts.forEach((receipt) => {
      const patient = findPatientForReceipt(receipt, patients);
      if (
        patient &&
        patient.commissionEarnerType &&
        patient.commissionEarnerId &&
        patient.patient_type === "OP"
      ) {
        const patientId = patient.UMRNo || patient.patientId;
        if (!patientReceipts[patientId]) {
          patientReceipts[patientId] = {
            patient,
            receipts: [],
          };
        }
        patientReceipts[patientId].receipts.push(receipt);
      }
    });

    advanceReceipts.forEach((receipt) => {
      const patient = findPatientForReceipt(receipt, patients);
      if (
        patient &&
        patient.commissionEarnerType &&
        patient.commissionEarnerId &&
        patient.patient_type === "IP"
      ) {
        const patientId = patient.UMRNo || patient.patientId;
        if (!patientAdvanceReceipts[patientId]) {
          patientAdvanceReceipts[patientId] = {
            patient,
            receipts: [],
          };
        }
        patientAdvanceReceipts[patientId].receipts.push(receipt);
      }
    });

    const commissions = [];

    Object.values(patientReceipts).forEach(
      ({ patient, receipts: patientReceiptsList }) => {
        const commission = calculateOPCommission(
          patient,
          patientReceiptsList,
          monthlyTotals
        );
        if (commission) {
          commissions.push(commission);
        }
      }
    );

    Object.values(patientAdvanceReceipts).forEach(
      ({ patient, receipts: patientAdvanceReceiptsList }) => {
        const groupedReceipts = {};
        patientAdvanceReceiptsList.forEach((receipt) => {
          const receiptId = receipt.receiptId || receipt._id;
          if (!groupedReceipts[receiptId]) {
            groupedReceipts[receiptId] = receipt;
          }
        });
        Object.values(groupedReceipts).forEach((receipt) => {
          const commission = calculateIPCommission(
            receipt,
            patient,
            monthlyTotals
          );
          if (commission) {
            commissions.push(commission);
          }
        });
      }
    );

    res.json(commissions);
  } catch (error) {
    console.error("Error calculating commissions:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get commission summary report
router.get("/summary", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate
      ? new Date(startDate)
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const end = endDate ? new Date(endDate) : new Date();

    // Get commissions by calling the same logic
    const [
      patients,
      consultationReceipts,
      actionReceipts,
      diagnosticsReceipts,
      pharmacyReceipts,
      advanceReceipts,
    ] = await Promise.all([
      Patient.find({ hospitalId: req.hospitalId }),
      Consultation.find({ hospitalId: req.hospitalId }),
      Action.find({
        patientId: { $exists: true, $ne: null },
        hospitalId: req.hospitalId,
      }),
      DiagnosticsReceipt.find({ hospitalId: req.hospitalId }),
      PharmacyReceipt.find({
        type: "pharmacy-sale",
        hospitalId: req.hospitalId,
      }),
      AdvanceReceipt.find({ hospitalId: req.hospitalId }),
    ]);

    const allReceipts = [
      ...consultationReceipts,
      ...actionReceipts,
      ...pharmacyReceipts,
      ...diagnosticsReceipts,
    ];

    const monthlyTotals = calculateMonthlyTotals(
      allReceipts,
      advanceReceipts,
      patients
    );

    const patientReceipts = {};
    const patientAdvanceReceipts = {};

    allReceipts.forEach((receipt) => {
      const patient = findPatientForReceipt(receipt, patients);
      if (
        patient &&
        patient.commissionEarnerType &&
        patient.commissionEarnerId &&
        patient.patient_type === "OP"
      ) {
        const patientId = patient.UMRNo || patient.patientId;
        if (!patientReceipts[patientId]) {
          patientReceipts[patientId] = {
            patient,
            receipts: [],
          };
        }
        patientReceipts[patientId].receipts.push(receipt);
      }
    });

    advanceReceipts.forEach((receipt) => {
      const patient = findPatientForReceipt(receipt, patients);
      if (
        patient &&
        patient.commissionEarnerType &&
        patient.commissionEarnerId &&
        patient.patient_type === "IP"
      ) {
        const patientId = patient.UMRNo || patient.patientId;
        if (!patientAdvanceReceipts[patientId]) {
          patientAdvanceReceipts[patientId] = {
            patient,
            receipts: [],
          };
        }
        patientAdvanceReceipts[patientId].receipts.push(receipt);
      }
    });

    const allCommissions = [];

    Object.values(patientReceipts).forEach(
      ({ patient, receipts: patientReceiptsList }) => {
        const commission = calculateOPCommission(
          patient,
          patientReceiptsList,
          monthlyTotals
        );
        if (commission) {
          allCommissions.push(commission);
        }
      }
    );

    Object.values(patientAdvanceReceipts).forEach(
      ({ patient, receipts: patientAdvanceReceiptsList }) => {
        const groupedReceipts = {};
        patientAdvanceReceiptsList.forEach((receipt) => {
          const receiptId = receipt.receiptId || receipt._id;
          if (!groupedReceipts[receiptId]) {
            groupedReceipts[receiptId] = receipt;
          }
        });
        Object.values(groupedReceipts).forEach((receipt) => {
          const commission = calculateIPCommission(
            receipt,
            patient,
            monthlyTotals
          );
          if (commission) {
            allCommissions.push(commission);
          }
        });
      }
    );

    const filteredCommissions = allCommissions.filter((comm) => {
      const commDate = new Date(comm.createdAt);
      return commDate >= start && commDate <= end;
    });

    const summary = {
      totalCommissions: filteredCommissions.length,
      totalAmount: filteredCommissions.reduce(
        (sum, comm) => sum + (comm.commissionAmount || 0),
        0
      ),
      pendingAmount: filteredCommissions
        .filter((comm) => comm.status === "Pending")
        .reduce((sum, comm) => sum + (comm.commissionAmount || 0), 0),
      settledAmount: filteredCommissions
        .filter((comm) => comm.status === "Settled")
        .reduce((sum, comm) => sum + (comm.commissionAmount || 0), 0),
      byEarnerType: {},
      byReceiptType: {},
      topEarners: [],
    };

    filteredCommissions.forEach((comm) => {
      if (!summary.byEarnerType[comm.commissionEarnerType]) {
        summary.byEarnerType[comm.commissionEarnerType] = {
          count: 0,
          amount: 0,
        };
      }
      summary.byEarnerType[comm.commissionEarnerType].count += 1;
      summary.byEarnerType[comm.commissionEarnerType].amount +=
        comm.commissionAmount || 0;
    });

    filteredCommissions.forEach((comm) => {
      if (!summary.byReceiptType[comm.receiptType]) {
        summary.byReceiptType[comm.receiptType] = { count: 0, amount: 0 };
      }
      summary.byReceiptType[comm.receiptType].count += 1;
      summary.byReceiptType[comm.receiptType].amount +=
        comm.commissionAmount || 0;
    });

    const earnerTotals = {};
    filteredCommissions.forEach((comm) => {
      if (!earnerTotals[comm.commissionEarnerId]) {
        earnerTotals[comm.commissionEarnerId] = {
          id: comm.commissionEarnerId,
          name: comm.commissionEarnerName,
          type: comm.commissionEarnerType,
          amount: 0,
          count: 0,
        };
      }
      earnerTotals[comm.commissionEarnerId].amount +=
        comm.commissionAmount || 0;
      earnerTotals[comm.commissionEarnerId].count += 1;
    });

    summary.topEarners = Object.values(earnerTotals)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);

    res.json(summary);
  } catch (error) {
    console.error("Error generating commission summary:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get patients with commission links (for debug)
router.get("/patients-with-commission", async (req, res) => {
  try {
    const patients = await Patient.find({
      commissionEarnerType: { $exists: true, $ne: null },
      commissionEarnerId: { $exists: true, $ne: null },
      commissionEarnerName: { $exists: true, $ne: null },
      hospitalId: req.hospitalId,
    });
    res.json(patients);
  } catch (error) {
    console.error("Error fetching patients with commission:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
