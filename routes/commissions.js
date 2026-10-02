const express = require("express");
const mongoose = require("mongoose");
const Hospital = require("../models/Hospital");
const router = express.Router();

const DEFAULT_PRO_RULES = { threshold: 500000, bonusPercentage: 5 };

function normalizeProRules(raw) {
  const threshold = Number(raw?.threshold);
  const bonusPercentage = Number(raw?.bonusPercentage);
  return {
    threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 500000,
    bonusPercentage:
      Number.isFinite(bonusPercentage) &&
      bonusPercentage >= 0 &&
      bonusPercentage <= 100
        ? bonusPercentage
        : 5,
  };
}

function proBonusAmountFor(earnerType, earnerId, finalAmount, monthlyTotals, rules) {
  const settings = normalizeProRules(rules);
  if (earnerType !== "PRO" || finalAmount <= 0 || settings.bonusPercentage <= 0) {
    return 0;
  }
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthlyTotal = monthlyTotals[`${earnerId}_${currentMonth}`] || 0;
  if (monthlyTotal < settings.threshold) return 0;
  const excessAmount = monthlyTotal - settings.threshold;
  const bonusEligibleAmount = Math.min(excessAmount, finalAmount);
  return bonusEligibleAmount * (settings.bonusPercentage / 100);
}

async function loadProRules(req) {
  const hospitalId = req.hospitalId || req.user?.hospitalId;
  if (!hospitalId) return { ...DEFAULT_PRO_RULES };
  const hospital = await Hospital.findById(hospitalId)
    .select("settings.proCommission")
    .lean();
  return normalizeProRules(hospital?.settings?.proCommission);
}
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "commission" });

// Helper functions (same logic as frontend commissionService)
const getReceiptType = (receipt) => {
  if (
    receipt.type === "pharmacy-sale" ||
    receipt.type === "pharmacy-sale-return"
  ) {
    return "pharmacy";
  }
  if (
    receipt.type === "lab" ||
    receipt.type === "diagnostic" ||
    receipt.type === "lab-sale"
  ) {
    return "lab";
  }
  if (receipt.type === "consultation") return "consultation";
  if (
    receipt.type === "action" ||
    receipt.type === "service" ||
    receipt.type === "procedure"
  ) {
    return "surgery";
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
        0,
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

function hasCommissionEarner(event) {
  return Boolean(event?.commissionEarnerType && event?.commissionEarnerId);
}

function eventForReceipt(receipt, ctx) {
  const admissionId = String(receipt?.admissionId || "");
  if (admissionId && ctx.byAdmission.has(admissionId)) {
    return { kind: "ip", event: ctx.byAdmission.get(admissionId) };
  }
  const prescriptionId = String(receipt?.prescriptionId || "");
  if (prescriptionId && ctx.byPrescription.has(prescriptionId)) {
    return { kind: "op", event: ctx.byPrescription.get(prescriptionId) };
  }

  const person =
    ctx.people.get(String(receipt?.patientId || "")) ||
    ctx.people.get(String(receipt?.umrNo || "")) ||
    ctx.people.get(String(receipt?.patientUmr || ""));
  if (!person) return null;
  const key = String(person._id);
  const isStayBill =
    receipt?.type === "advance" || receipt?.receiptType === "Final Bill";
  if (isStayBill) {
    const stays = (ctx.staysByPatient.get(key) || []).filter(
      hasCommissionEarner,
    );
    const open = stays.find((stay) => stay.patient_status === "Admitted");
    const stay =
      open ||
      [...stays].sort((a, b) =>
        String(b.admissionDate || "").localeCompare(
          String(a.admissionDate || ""),
        ),
      )[0];
    if (stay) return { kind: "ip", event: stay };
  }
  const visits = (ctx.visitsByPatient.get(key) || []).filter(
    hasCommissionEarner,
  );
  const visit = [...visits].sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || "")),
  )[0];
  if (visit && !isStayBill) return { kind: "op", event: visit };
  return null;
}

function personForEvent(event, people) {
  return (
    people.get(String(event?.patientId || "")) ||
    people.get(String(event?.UMRNo || "")) ||
    null
  );
}

function subjectFromEvent(event, person, kind) {
  return {
    UMRNo: person?.UMRNo || event.UMRNo || "",
    name: person?.name || event.patientName || "",
    phone: person?.phone || "",
    patient_type: kind === "ip" ? "IP" : "OP",
    commissionEarnerType: event.commissionEarnerType,
    commissionEarnerId: event.commissionEarnerId,
    commissionEarnerName: event.commissionEarnerName,
    commissionRates: event.commissionRates || {},
    prescriptionId: kind === "op" ? String(event.prescriptionId || "") : "",
    admissionId: kind === "ip" ? String(event._id) : "",
  };
}

const calculateMonthlyTotals = (receipts, advanceReceipts, ctx) => {
  const monthlyTotals = {};
  const currentMonth = new Date().toISOString().slice(0, 7);
  const add = (earnerId, amount) => {
    const key = `${earnerId}_${currentMonth}`;
    monthlyTotals[key] = (monthlyTotals[key] || 0) + Math.max(0, amount);
  };

  receipts.forEach((receipt) => {
    const match = eventForReceipt(receipt, ctx);
    if (
      !match ||
      match.kind !== "op" ||
      !hasCommissionEarner(match.event) ||
      match.event.commissionEarnerType !== "PRO"
    ) {
      return;
    }
    const receiptDate = new Date(receipt.createdAt || new Date());
    if (receiptDate.toISOString().slice(0, 7) !== currentMonth) return;
    add(
      match.event.commissionEarnerId,
      getReceiptAmount(receipt) - (receipt.discount || 0),
    );
  });

  advanceReceipts.forEach((receipt) => {
    const match = eventForReceipt(receipt, ctx);
    if (
      !match ||
      match.kind !== "ip" ||
      !hasCommissionEarner(match.event) ||
      match.event.commissionEarnerType !== "PRO"
    ) {
      return;
    }
    const receiptDate = new Date(receipt.createdAt || new Date());
    if (receiptDate.toISOString().slice(0, 7) !== currentMonth) return;
    if (receipt.receiptType === "Final Bill" || receipt.type === "advance") {
      const totalCharges =
        (receipt.consultationCharges || 0) +
        (receipt.investigationCharges || 0) +
        (receipt.pharmacyCharges || 0) +
        (receipt.wardCharges || 0) +
        (receipt.serviceCharges || 0) +
        (receipt.procedureCharges || 0);
      const discountAmount = receipt.discount || 0;
      const totalBill = receipt.totalBill || 0;
      const discountPercentage = totalBill > 0 ? discountAmount / totalBill : 0;
      add(
        match.event.commissionEarnerId,
        Math.max(0, totalCharges - totalCharges * discountPercentage),
      );
    } else {
      add(
        match.event.commissionEarnerId,
        (receipt.totalAmount || receipt.advanceAmount || 0) -
          (receipt.discount || 0),
      );
    }
  });
  return monthlyTotals;
};

async function loadReferralContext(req) {
  const Patient = req.tenantDb.model("Patient");
  const Prescription = req.tenantDb.model("Prescription");
  const IPAdmission = req.tenantDb.model("IPAdmission");
  const [patients, prescriptions, admissions, legacyPatients] =
    await Promise.all([
      Patient.find({ hospitalId: req.hospitalId })
        .select("UMRNo name phone")
        .lean(),
      Prescription.find({ hospitalId: req.hospitalId })
        .select(
          "prescriptionId patientId UMRNo date doctorName commissionEarnerType commissionEarnerId commissionEarnerName commissionRates",
        )
        .lean(),
      IPAdmission.find({ hospitalId: req.hospitalId })
        .select(
          "patientId UMRNo patientName admissionDate dischargeDate patient_status ipNumber commissionEarnerType commissionEarnerId commissionEarnerName commissionRates",
        )
        .lean(),
      Patient.collection
        .find({
          hospitalId: mongoose.Types.ObjectId.isValid(String(req.hospitalId))
            ? {
                $in: [
                  req.hospitalId,
                  new mongoose.Types.ObjectId(String(req.hospitalId)),
                ],
              }
            : req.hospitalId,
          commissionEarnerId: { $nin: [null, ""] },
        })
        .project({
          UMRNo: 1,
          commissionEarnerType: 1,
          commissionEarnerId: 1,
          commissionEarnerName: 1,
          commissionRates: 1,
        })
        .toArray(),
    ]);
  const legacyByPatient = new Map();
  legacyPatients.forEach((person) => {
    if (!hasCommissionEarner(person)) return;
    legacyByPatient.set(String(person._id), person);
    if (person.UMRNo) legacyByPatient.set(String(person.UMRNo), person);
  });
  const withLegacyEarner = (event) => {
    if (hasCommissionEarner(event)) return event;
    const legacy =
      legacyByPatient.get(String(event.patientId || "")) ||
      legacyByPatient.get(String(event.UMRNo || ""));
    if (!hasCommissionEarner(legacy)) return event;
    return {
      ...event,
      commissionEarnerType: legacy.commissionEarnerType,
      commissionEarnerId: String(legacy.commissionEarnerId),
      commissionEarnerName: legacy.commissionEarnerName || "",
      commissionRates: legacy.commissionRates || {},
    };
  };
  const people = new Map();
  patients.forEach((person) => {
    people.set(String(person._id), person);
    if (person.UMRNo) people.set(String(person.UMRNo), person);
  });
  const visits = prescriptions.map(withLegacyEarner);
  const stays = admissions.map(withLegacyEarner);
  const byPrescription = new Map();
  const visitsByPatient = new Map();
  visits.forEach((visit) => {
    if (visit.prescriptionId) {
      byPrescription.set(String(visit.prescriptionId), visit);
    }
    const key = String(visit.patientId || "");
    if (!visitsByPatient.has(key)) visitsByPatient.set(key, []);
    visitsByPatient.get(key).push(visit);
  });
  const byAdmission = new Map();
  const staysByPatient = new Map();
  stays.forEach((stay) => {
    byAdmission.set(String(stay._id), stay);
    const key = String(stay.patientId || "");
    if (!staysByPatient.has(key)) staysByPatient.set(key, []);
    staysByPatient.get(key).push(stay);
  });
  return {
    people,
    byPrescription,
    byAdmission,
    visitsByPatient,
    staysByPatient,
    prescriptions: visits,
    admissions: stays,
  };
}

async function computeCommissions(req) {
  const Consultation = req.tenantDb.model("Consultation");
  const Action = req.tenantDb.model("Action");
  const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
  const PharmacyReceipt = req.tenantDb.model("PharmacyReceipt");
  const AdvanceReceipt = req.tenantDb.model("AdvanceReceipt");
  const ctx = await loadReferralContext(req);
  const proRules = await loadProRules(req);

  const [
    consultationReceipts,
    actionReceipts,
    diagnosticsReceipts,
    pharmacyReceipts,
    advanceReceipts,
  ] = await Promise.all([
    Consultation.find({ hospitalId: req.hospitalId }).lean(),
    Action.find({
      patientId: { $exists: true, $ne: null },
      hospitalId: req.hospitalId,
    }).lean(),
    DiagnosticsReceipt.find({ hospitalId: req.hospitalId }).lean(),
    PharmacyReceipt.find({
      type: "pharmacy-sale",
      hospitalId: req.hospitalId,
    }).lean(),
    AdvanceReceipt.find({ hospitalId: req.hospitalId }).lean(),
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
    ctx,
  );

  const visitReceipts = {};
  allReceipts.forEach((receipt) => {
    const match = eventForReceipt(receipt, ctx);
    if (!match || match.kind !== "op" || !hasCommissionEarner(match.event)) {
      return;
    }
    const key = String(match.event.prescriptionId);
    if (!visitReceipts[key]) {
      visitReceipts[key] = {
        patient: subjectFromEvent(
          match.event,
          personForEvent(match.event, ctx.people),
          "op",
        ),
        receipts: [],
      };
    }
    visitReceipts[key].receipts.push(receipt);
  });

  const stayAdvances = {};
  const rememberStay = (bucket, event, receipt) => {
    const key = String(event._id);
    if (!bucket[key]) {
      bucket[key] = {
        patient: subjectFromEvent(
          event,
          personForEvent(event, ctx.people),
          "ip",
        ),
        receipts: [],
      };
    }
    bucket[key].receipts.push(receipt);
  };
  advanceReceipts.forEach((receipt) => {
    const match = eventForReceipt(receipt, ctx);
    if (!match || match.kind !== "ip" || !hasCommissionEarner(match.event)) {
      return;
    }
    rememberStay(stayAdvances, match.event, receipt);
  });

  const stayClinical = {};
  allReceipts.forEach((receipt) => {
    const match = eventForReceipt(receipt, ctx);
    if (!match || match.kind !== "ip" || !hasCommissionEarner(match.event)) {
      return;
    }
    rememberStay(stayClinical, match.event, receipt);
  });

  const isFinalBillReceipt = (receipt) =>
    receipt?.receiptType === "Final Bill" ||
    String(receipt?.remarks || "")
      .toLowerCase()
      .includes("final bill");

  const commissions = [];
  Object.values(visitReceipts).forEach(({ patient, receipts }) => {
    const commission = calculateOPCommission(
      patient,
      receipts,
      monthlyTotals,
      proRules,
    );
    if (commission) {
      commission.prescriptionId = patient.prescriptionId;
      commissions.push(commission);
    }
  });
  const stayKeys = new Set([
    ...Object.keys(stayAdvances),
    ...Object.keys(stayClinical),
  ]);
  stayKeys.forEach((key) => {
    const patient = stayAdvances[key]?.patient || stayClinical[key]?.patient;
    const advances = stayAdvances[key]?.receipts || [];
    const finals = advances.filter(isFinalBillReceipt);
    if (finals.length) {
      const grouped = {};
      finals.forEach((receipt) => {
        grouped[String(receipt.receiptId || receipt._id)] = receipt;
      });
      Object.values(grouped).forEach((receipt) => {
        const commission = calculateIPCommission(
          receipt,
          patient,
          monthlyTotals,
          proRules,
        );
        if (commission) {
          commission.admissionId = patient.admissionId;
          commissions.push(commission);
        }
      });
      return;
    }
    const clinical = stayClinical[key]?.receipts || [];
    if (clinical.length) {
      const commission = calculateOPCommission(
        patient,
        clinical,
        monthlyTotals,
        proRules,
      );
      if (commission) {
        commission.patientType = "IP";
        commission.receiptType = "Hospital stay";
        commission.admissionId = patient.admissionId;
        commissions.push(commission);
      }
      return;
    }
    advances.forEach((receipt) => {
      const commission = calculateIPCommission(
        receipt,
        patient,
        monthlyTotals,
        proRules,
      );
      if (commission) {
        commission.admissionId = patient.admissionId;
        commissions.push(commission);
      }
    });
  });

  return { commissions, ctx };
}

function referralCase(event, person, kind) {
  const assigned = hasCommissionEarner(event);
  const when = kind === "ip" ? event.admissionDate : event.date;
  return {
    id: kind === "ip" ? `ip:${event._id}` : `op:${event.prescriptionId}`,
    source: kind === "ip" ? "IP" : "OP",
    prescriptionId: kind === "op" ? String(event.prescriptionId || "") : "",
    admissionId: kind === "ip" ? String(event._id) : "",
    UMRNo: person?.UMRNo || event.UMRNo || "",
    name: person?.name || event.patientName || "",
    phone: person?.phone || "",
    patient_type: kind === "ip" ? "IP" : "OP",
    roster:
      kind === "op"
        ? "OP"
        : event.patient_status === "Admitted"
          ? "IP"
          : "Discharged",
    eventDate: when || "",
    eventLabel:
      kind === "ip"
        ? `IP stay ${event.ipNumber || ""}`.trim()
        : `OP visit ${event.prescriptionId || ""}`.trim(),
    assigned,
    commissionEarnerType: event.commissionEarnerType || "",
    commissionEarnerId: event.commissionEarnerId || "",
    commissionEarnerName: event.commissionEarnerName || "",
    commissionRates: event.commissionRates || {
      consultation: 0,
      surgery: 0,
      pharmacy: 0,
      lab: 0,
    },
  };
}

const calculateOPCommission = (patient, receipts, monthlyTotals, proRules) => {
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
  const proBonusAmount = proBonusAmountFor(
    commissionEarnerType,
    commissionEarnerId,
    totalFinalAmount,
    monthlyTotals,
    proRules,
  );
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

const calculateIPCommission = (receipt, patient, monthlyTotals, proRules) => {
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
  if (totalFinalAmount <= 0) {
    const billAmount =
      Number(receipt.totalBill) ||
      Number(receipt.advanceAmount) ||
      Number(receipt.totalAmount) ||
      0;
    const stayRate = Number(commissionRates?.surgery) || 0;
    if (billAmount > 0 && stayRate > 0) {
      const discountAmountFallback = Number(receipt.discount) || 0;
      const finalBill = Math.max(0, billAmount - discountAmountFallback);
      const regular = finalBill * stayRate;
      totalFinalAmount = finalBill;
      totalRegularCommission = regular;
      chargeBreakdown.push({
        type: "surgery",
        label: "Hospital bill",
        originalAmount: billAmount,
        discount: discountAmountFallback,
        finalAmount: finalBill,
        commissionRate: stayRate,
        commissionAmount: regular,
      });
    }
  }
  if (totalFinalAmount <= 0) return null;
  const proBonusAmount = proBonusAmountFor(
    commissionEarnerType,
    commissionEarnerId,
    totalFinalAmount,
    monthlyTotals,
    proRules,
  );
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
    receiptAmount: totalBill || totalFinalAmount,
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

router.get("/pro-rules", async (req, res) => {
  try {
    const rules = await loadProRules(req);
    res.json(rules);
  } catch (error) {
    console.error("Error loading PRO rules:", error);
    res.status(500).json({ message: error.message });
  }
});

router.put("/pro-rules", async (req, res) => {
  try {
    const type = String(req.user?.type || "");
    if (!["SuperAdmin", "Admin", "Accountant"].includes(type)) {
      return res.status(403).json({ message: "You cannot change the PRO bonus." });
    }
    const rules = normalizeProRules(req.body);
    const hospitalId = req.hospitalId || req.user?.hospitalId;
    const hospital = await Hospital.findById(hospitalId);
    if (!hospital) {
      return res.status(404).json({ message: "Hospital not found" });
    }
    hospital.settings = hospital.settings || {};
    hospital.settings.proCommission = rules;
    hospital.markModified("settings");
    await hospital.save();
    res.json(rules);
  } catch (error) {
    console.error("Error saving PRO rules:", error);
    res.status(500).json({ message: error.message });
  }
});

router.put("/assign", async (req, res) => {
  try {
    const {
      source,
      prescriptionId,
      admissionId,
      commissionEarnerType,
      commissionEarnerId,
      commissionEarnerName,
      commissionRates,
    } = req.body || {};
    if (!commissionEarnerType || !commissionEarnerId) {
      return res
        .status(400)
        .json({ message: "Choose a referrer before saving" });
    }
    const patch = {
      commissionEarnerType,
      commissionEarnerId,
      commissionEarnerName: commissionEarnerName || "",
      commissionRates: commissionRates || {},
    };
    if (source === "IP") {
      const IPAdmission = req.tenantDb.model("IPAdmission");
      const updated = await IPAdmission.findOneAndUpdate(
        { _id: admissionId, hospitalId: req.hospitalId },
        { $set: patch },
        { new: true },
      );
      if (!updated) {
        return res.status(404).json({ message: "Admission not found" });
      }
      return res.json(updated);
    }
    const Prescription = req.tenantDb.model("Prescription");
    const updated = await Prescription.findOneAndUpdate(
      { prescriptionId, hospitalId: req.hospitalId },
      { $set: patch },
      { new: true },
    );
    if (!updated) {
      return res.status(404).json({ message: "Prescription not found" });
    }
    return res.json(updated);
  } catch (error) {
    console.error("Error assigning referrer:", error);
    return res.status(500).json({ message: error.message });
  }
});

// Get all commissions
router.get("/", async (req, res) => {
  try {
    const { commissions } = await computeCommissions(req);
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
    const { commissions } = await computeCommissions(req);
    const filteredCommissions = commissions.filter((comm) => {
      const commDate = new Date(comm.receiptDate || comm.createdAt);
      return commDate >= start && commDate <= end;
    });

    const summary = {
      totalCommissions: filteredCommissions.length,
      totalAmount: filteredCommissions.reduce(
        (sum, comm) => sum + (comm.commissionAmount || 0),
        0,
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

// Visits and stays used by referral assignment
router.get("/referral-cases", async (req, res) => {
  try {
    const { ctx } = await computeCommissions(req);
    const assignedOnly = req.query.assigned === "true";
    const unassignedOnly = req.query.assigned === "false";
    const cases = [];
    ctx.prescriptions.forEach((visit) => {
      const row = referralCase(visit, personForEvent(visit, ctx.people), "op");
      if (assignedOnly && !row.assigned) return;
      if (unassignedOnly && row.assigned) return;
      cases.push(row);
    });
    ctx.admissions.forEach((stay) => {
      const row = referralCase(stay, personForEvent(stay, ctx.people), "ip");
      if (assignedOnly && !row.assigned) return;
      if (unassignedOnly && row.assigned) return;
      cases.push(row);
    });
    cases.sort((a, b) =>
      String(b.eventDate).localeCompare(String(a.eventDate)),
    );
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    const matched = q
      ? cases.filter((row) =>
          [
            row.name,
            row.UMRNo,
            row.phone,
            row.eventLabel,
            row.commissionEarnerName,
            row.roster,
          ]
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : cases;
    const limit = Number(req.query.limit) || 0;
    res.json(limit > 0 ? matched.slice(0, limit) : matched);
  } catch (error) {
    console.error("Error fetching referral cases:", error);
    res.status(500).json({ message: error.message });
  }
});

// Assigned visits and stays (debug)
router.get("/patients-with-commission", async (req, res) => {
  try {
    const { ctx } = await computeCommissions(req);
    const cases = [];
    ctx.prescriptions.forEach((visit) => {
      if (!hasCommissionEarner(visit)) return;
      cases.push(referralCase(visit, personForEvent(visit, ctx.people), "op"));
    });
    ctx.admissions.forEach((stay) => {
      if (!hasCommissionEarner(stay)) return;
      cases.push(referralCase(stay, personForEvent(stay, ctx.people), "ip"));
    });
    res.json(cases);
  } catch (error) {
    console.error("Error fetching referral cases:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
