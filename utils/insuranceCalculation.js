const dayjs = require("dayjs");
const {
  eventScopeFromRecord,
  receiptBelongsToEvent,
} = require("./visitReceiptScope");
const {
  INSURANCE_SERVICE_KEYS,
  normalizeInsuranceServiceKey,
  emptyBillBreakdown,
} = require("./insuranceConstants");

const toAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
};

const getItems = (receipt) => receipt?.items || [];

const getBatchAmount = (batch) =>
  toAmount(
    batch?.bill_amount ?? toAmount(batch?.mrp) * toAmount(batch?.quantity),
  );

const getLineAmount = (rate, quantity) =>
  toAmount(rate) * (toAmount(quantity) || 1);

function getBillingEndDate(patient, endDate = new Date()) {
  if (!patient || patient.active !== false) {
    return dayjs(endDate).format("YYYY-MM-DD");
  }
  const candidates = [patient.dischargeDate, patient.dischargedAt, patient.updatedAt];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const m = dayjs(candidate);
    if (m.isValid()) return m.format("YYYY-MM-DD");
  }
  return dayjs(endDate).format("YYYY-MM-DD");
}

function matchesCompanyId(entity, targetId) {
  if (!targetId || !entity?.companyId) return false;
  return String(entity.companyId) === String(targetId);
}

function isTariffValid(tariff, asOf = new Date()) {
  if (!tariff) return false;
  const now = dayjs(asOf);
  if (tariff.validityFrom) {
    const from = dayjs(tariff.validityFrom);
    if (from.isValid() && now.isBefore(from, "day")) return false;
  }
  if (tariff.validityTo) {
    const to = dayjs(tariff.validityTo);
    if (to.isValid() && now.isAfter(to, "day")) return false;
  }
  return true;
}

function getTariffPrefix(serviceKey) {
  return serviceKey.toLowerCase();
}

function roundMoney(value) {
  return Math.round(toAmount(value) * 100) / 100;
}

/** A saved 0 means "not set" and inherits the general tariff rate. */
function tariffSpecific(tariff, key) {
  const amount = Number(tariff?.[key]);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function tariffCoveragePercentage(tariff, prefix) {
  const specific = tariffSpecific(tariff, `${prefix}CoveragePercentage`);
  if (specific > 0) return specific;
  return toAmount(tariff?.coveragePercentage);
}

function tariffCoverageLimit(tariff, prefix) {
  return tariffSpecific(tariff, `${prefix}CoverageLimit`);
}

function tariffDeductible(tariff, prefix) {
  return tariffSpecific(tariff, `${prefix}Deductible`);
}

function calculateWardChargesWithDailyInsurance(
  patient,
  applicableTariff,
  endDate = new Date(),
  generalDeductiblePool = 0,
) {
  const patientTransfers = patient.transfers || [];
  let totalWardCharges = 0;
  let totalWardCoverage = 0;
  let deductibleUsed = 0;
  const dailyBreakdown = [];
  const dischargeDt = getBillingEndDate(patient, endDate);
  const ownDeductible = tariffDeductible(applicableTariff, "ward");
  const dailyCoveragePercentage = tariffCoveragePercentage(
    applicableTariff,
    "ward",
  );
  const dailyCoverageLimit = tariffCoverageLimit(applicableTariff, "ward");
  let deductiblePool = ownDeductible > 0 ? 0 : toAmount(generalDeductiblePool);

  for (let i = 0; i < patientTransfers.length; i++) {
    const currentTransfer = patientTransfers[i];
    const nextTransfer = patientTransfers[i + 1] || {
      transferDate: dischargeDt,
    };

    const start = dayjs(currentTransfer.transferDate);
    const end = dayjs(nextTransfer.transferDate);
    const daysSpent =
      start.isValid() && end.isValid()
        ? Math.max(0, end.diff(start, "day") + 1)
        : 0;
    const wardPrice = toAmount(currentTransfer.price);

    for (let day = 0; day < daysSpent; day++) {
      const dailyCharge = wardPrice;
      let dailyDeductible = 0;
      if (ownDeductible > 0) {
        dailyDeductible = Math.min(ownDeductible, dailyCharge);
      } else if (deductiblePool > 0) {
        dailyDeductible = Math.min(deductiblePool, dailyCharge);
        deductiblePool -= dailyDeductible;
      }

      const amountAfterDeductible = Math.max(0, dailyCharge - dailyDeductible);
      let dailyCoverage =
        (amountAfterDeductible * dailyCoveragePercentage) / 100;

      if (dailyCoverageLimit > 0 && dailyCoverage > dailyCoverageLimit) {
        dailyCoverage = dailyCoverageLimit;
      }

      dailyCoverage = Math.min(dailyCoverage, dailyCharge);
      dailyCoverage = roundMoney(dailyCoverage);
      dailyDeductible = roundMoney(dailyDeductible);
      deductibleUsed += dailyDeductible;
      const dailyPatientShare = roundMoney(dailyCharge - dailyCoverage);

      totalWardCharges += dailyCharge;
      totalWardCoverage += dailyCoverage;

      dailyBreakdown.push({
        day: day + 1,
        date: dayjs(currentTransfer.transferDate)
          .add(day, "day")
          .format("YYYY-MM-DD"),
        wardName: currentTransfer.wardName,
        dailyCharge,
        dailyDeductible,
        amountAfterDeductible,
        dailyCoveragePercentage,
        dailyCoverageLimit,
        dailyCoverage,
        dailyPatientShare,
      });
    }
  }

  return {
    totalWardCharges: roundMoney(totalWardCharges),
    totalWardCoverage: roundMoney(totalWardCoverage),
    deductibleUsed: roundMoney(deductibleUsed),
    generalDeductibleRemaining: ownDeductible > 0 ? toAmount(generalDeductiblePool) : deductiblePool,
    deductiblePerDay: ownDeductible,
    dailyBreakdown,
  };
}

function calculateBillBreakdown(
  patient,
  consultationReceipts,
  actionReceipts,
  diagnosticsReceipts,
  pharmacyReceipts,
  endDate = new Date(),
) {
  if (!patient?.UMRNo) return emptyBillBreakdown();

  const patientId = patient.UMRNo;
  const end = dayjs(endDate);

  const filterByDate = (receipt) =>
    dayjs(receipt.createdAt).isBefore(end) ||
    dayjs(receipt.createdAt).isSame(end, "day");
  const scope = eventScopeFromRecord(patient);
  const onEvent = (receipt) => !scope || receiptBelongsToEvent(receipt, scope);

  const patientConsultations = consultationReceipts.filter(
    (r) => r.patientId === patientId && onEvent(r) && filterByDate(r),
  );
  const patientActions = actionReceipts.filter(
    (r) => r.patientId === patientId && onEvent(r) && filterByDate(r),
  );
  const patientDiagnostics = diagnosticsReceipts.filter(
    (r) => r.patientId === patientId && onEvent(r) && filterByDate(r),
  );
  const patientSales = pharmacyReceipts.filter(
    (r) => r.patientId === patientId && onEvent(r) && filterByDate(r),
  );

  let wardCharges = 0;
  const patientTransfers = patient.transfers || [];
  const dischargeDt = getBillingEndDate(patient, endDate);

  for (let i = 0; i < patientTransfers.length; i++) {
    const currentTransfer = patientTransfers[i];
    const nextTransfer = patientTransfers[i + 1] || {
      transferDate: dischargeDt,
    };
    const start = dayjs(currentTransfer.transferDate);
    const endDay = dayjs(nextTransfer.transferDate);
    const daysSpent =
      start.isValid() && endDay.isValid()
        ? Math.max(0, endDay.diff(start, "day") + 1)
        : 0;
    wardCharges += daysSpent * toAmount(currentTransfer.price);
  }

  const consultationCharges = patientConsultations.reduce(
    (total, receipt) =>
      total +
      getItems(receipt).reduce(
        (sum, item) => sum + getLineAmount(item.charges, item.quantity),
        0,
      ),
    0,
  );

  const investigationCharges = patientDiagnostics.reduce(
    (total, receipt) =>
      total +
      getItems(receipt).reduce((sum, item) => sum + toAmount(item.price), 0),
    0,
  );

  const procedureCharges = patientActions.reduce(
    (total, receipt) =>
      total +
      getItems(receipt)
        .filter((data) => data.category === "Procedure Charges")
        .reduce(
          (sum, item) => sum + getLineAmount(item.rate, item.quantity),
          0,
        ),
    0,
  );

  const serviceCharges = patientActions.reduce(
    (total, receipt) =>
      total +
      getItems(receipt)
        .filter((data) => data.category === "Service Charges")
        .reduce(
          (sum, item) => sum + getLineAmount(item.rate, item.quantity),
          0,
        ),
    0,
  );

  const pharmacyCharges = patientSales.reduce(
    (total, receipt) =>
      total +
      getItems(receipt).reduce((prev, item) => {
        const batchTotal = (item?.batches || []).reduce(
          (batchPrev, batch) => batchPrev + getBatchAmount(batch),
          0,
        );
        return receipt.type === "pharmacy-sale-return"
          ? prev - batchTotal
          : prev + batchTotal;
      }, 0),
    0,
  );

  return {
    Ward: wardCharges,
    Consultation: consultationCharges,
    Investigation: investigationCharges,
    Procedure: procedureCharges,
    Service: serviceCharges,
    Pharmacy: pharmacyCharges,
  };
}

function calculateTotalAdvance(advanceReceipts, patientId, endDate = new Date()) {
  const end = dayjs(endDate);
  return advanceReceipts
    .filter(
      (r) =>
        r.patientId === patientId &&
        (dayjs(r.createdAt).isBefore(end) ||
          dayjs(r.createdAt).isSame(end, "day")),
    )
    .reduce((sum, r) => sum + toAmount(r.advanceAmount), 0);
}

function calculateInsuranceCoverage(
  patient,
  tariffs,
  exclusions,
  billBreakdown,
  options = {},
) {
  const { endDate = new Date(), settings = {} } = options;
  const warnings = [];

  const totalBill = Object.values(billBreakdown || {}).reduce(
    (sum, amount) => sum + toAmount(amount),
    0,
  );

  const baseResult = {
    totalBill,
    insuranceCoverage: 0,
    patientPayable: totalBill,
    coverageBreakdown: INSURANCE_SERVICE_KEYS.map((service) => ({
      service,
      amount: toAmount(billBreakdown?.[service]),
      coverage: 0,
      patientShare: toAmount(billBreakdown?.[service]),
      excluded: false,
      coveragePercentage: 0,
      coverageLimit: 0,
      deductible: 0,
      insuranceCategory: getTariffPrefix(service),
      dailyBreakdown: null,
    })),
    exclusionsApplied: [],
    deductible: 0,
    coveragePercentage: 0,
    coverageLimit: 0,
    coPayPercentage: 0,
    coPayLimit: 0,
    coPayAmount: 0,
    coPayType: patient?.coPayType || "percentage",
    serviceCoverageDetails: {},
    warnings,
    tariffFound: false,
    tariffValid: false,
  };

  if (!patient?.insurance_providerId) {
    warnings.push("Patient has no insurance provider linked.");
    return baseResult;
  }

  if (settings.requirePolicyNumber && !patient.policy_number) {
    warnings.push("Policy number is required but missing on patient record.");
  }

  const applicableTariff = (tariffs || []).find((t) =>
    matchesCompanyId(t, patient.insurance_providerId),
  );

  if (!applicableTariff) {
    if (settings.defaultCoveragePercentage > 0) {
      const pct = toAmount(settings.defaultCoveragePercentage);
      let fallbackCoverage = (totalBill * pct) / 100;
      if (settings.defaultCoverageLimit > 0) {
        fallbackCoverage = Math.min(
          fallbackCoverage,
          toAmount(settings.defaultCoverageLimit),
        );
      }
      baseResult.insuranceCoverage = fallbackCoverage;
      baseResult.patientPayable = Math.max(0, totalBill - fallbackCoverage);
      baseResult.coveragePercentage = pct;
      warnings.push(
        "No company tariff found — applied default coverage from settings.",
      );
    } else {
      warnings.push("No tariff configured for this insurance company.");
    }
    return baseResult;
  }

  if (!isTariffValid(applicableTariff, endDate)) {
    warnings.push("Insurance tariff is outside its validity period.");
    baseResult.tariffFound = true;
    baseResult.tariffValid = false;
    return baseResult;
  }

  baseResult.tariffFound = true;
  baseResult.tariffValid = true;

  const applicableExclusions = (exclusions || []).filter(
    (e) =>
      matchesCompanyId(e, patient.insurance_providerId) &&
      (String(e.status || "active").toLowerCase() === "active"),
  );

  const exclusionsApplied = [];
  const billAfterExclusions = { ...billBreakdown };

  applicableExclusions.forEach((exclusion) => {
    const serviceKey = normalizeInsuranceServiceKey(exclusion.excludedService);
    if (!serviceKey || !billAfterExclusions[serviceKey]) return;
    exclusionsApplied.push({
      service: serviceKey,
      amount: billAfterExclusions[serviceKey],
      reason:
        exclusion.description ||
        exclusion.excludedCondition ||
        "Excluded by policy",
    });
    billAfterExclusions[serviceKey] = 0;
  });

  let generalDeductiblePool = tariffSpecific(applicableTariff, "deductible");

  const coverageBreakdown = INSURANCE_SERVICE_KEYS.map((service) => {
    const amount = toAmount(billBreakdown?.[service]);
    const serviceAfterExclusions = toAmount(billAfterExclusions?.[service]);
    const isExcluded = exclusionsApplied.some((ex) => ex.service === service);
    const prefix = getTariffPrefix(service);
    const coveragePercentage = tariffCoveragePercentage(
      applicableTariff,
      prefix,
    );
    const coverageLimit = tariffCoverageLimit(applicableTariff, prefix);

    let serviceCoverage = 0;
    let appliedDeductible = 0;
    let deductiblePerDay = 0;
    let dailyBreakdown = null;

    if (!isExcluded && serviceAfterExclusions > 0) {
      if (service === "Ward") {
        const wardCalc = calculateWardChargesWithDailyInsurance(
          patient,
          applicableTariff,
          endDate,
          generalDeductiblePool,
        );
        if (wardCalc.totalWardCharges > 0) {
          serviceCoverage = wardCalc.totalWardCoverage;
          dailyBreakdown = wardCalc.dailyBreakdown;
          appliedDeductible = wardCalc.deductibleUsed;
          deductiblePerDay = wardCalc.deductiblePerDay;
          generalDeductiblePool = wardCalc.generalDeductibleRemaining;
        } else {
          const ownDeductible = tariffDeductible(applicableTariff, prefix);
          if (ownDeductible > 0) {
            appliedDeductible = Math.min(ownDeductible, serviceAfterExclusions);
          } else if (generalDeductiblePool > 0) {
            appliedDeductible = Math.min(
              generalDeductiblePool,
              serviceAfterExclusions,
            );
            generalDeductiblePool -= appliedDeductible;
          }
          const amountAfterDeductible = Math.max(
            0,
            serviceAfterExclusions - appliedDeductible,
          );
          serviceCoverage =
            (amountAfterDeductible * coveragePercentage) / 100;
          if (coverageLimit > 0 && serviceCoverage > coverageLimit) {
            serviceCoverage = coverageLimit;
          }
          serviceCoverage = Math.min(serviceCoverage, serviceAfterExclusions);
        }
      } else {
        const ownDeductible = tariffDeductible(applicableTariff, prefix);
        if (ownDeductible > 0) {
          appliedDeductible = Math.min(ownDeductible, serviceAfterExclusions);
        } else if (generalDeductiblePool > 0) {
          appliedDeductible = Math.min(
            generalDeductiblePool,
            serviceAfterExclusions,
          );
          generalDeductiblePool -= appliedDeductible;
        }

        const amountAfterDeductible = Math.max(
          0,
          serviceAfterExclusions - appliedDeductible,
        );
        serviceCoverage = (amountAfterDeductible * coveragePercentage) / 100;

        if (coverageLimit > 0 && serviceCoverage > coverageLimit) {
          serviceCoverage = coverageLimit;
        }
        serviceCoverage = Math.min(serviceCoverage, serviceAfterExclusions);
      }
    }

    serviceCoverage = roundMoney(serviceCoverage);
    appliedDeductible = roundMoney(appliedDeductible);

    return {
      service,
      amount,
      coverage: serviceCoverage,
      patientShare: roundMoney(Math.max(0, amount - serviceCoverage)),
      excluded: isExcluded,
      coveragePercentage,
      coverageLimit,
      deductible: appliedDeductible,
      deductiblePerDay,
      insuranceCategory: prefix,
      dailyBreakdown,
    };
  });

  let totalInsuranceCoverage = roundMoney(
    coverageBreakdown.reduce((sum, item) => sum + item.coverage, 0),
  );
  const policyLimit = tariffSpecific(applicableTariff, "coverageLimit");
  if (policyLimit > 0 && totalInsuranceCoverage > policyLimit) {
    const scale = policyLimit / totalInsuranceCoverage;
    let scaled = 0;
    const coveredLines = coverageBreakdown.filter((item) => item.coverage > 0);
    coveredLines.forEach((item, index) => {
      if (index === coveredLines.length - 1) {
        item.coverage = roundMoney(Math.max(0, policyLimit - scaled));
      } else {
        item.coverage = roundMoney(item.coverage * scale);
        scaled += item.coverage;
      }
      item.patientShare = roundMoney(Math.max(0, item.amount - item.coverage));
    });
    totalInsuranceCoverage = roundMoney(
      coverageBreakdown.reduce((sum, item) => sum + item.coverage, 0),
    );
    warnings.push(
      `Policy coverage limit of ₹${policyLimit.toLocaleString("en-IN")} applied.`,
    );
  }

  const coPayPercentage = toAmount(patient.coPayPercentage);
  const coPayLimit = toAmount(patient.coPayLimit);
  const coPayType = patient.coPayType || "percentage";
  let coPayAmount = 0;

  if (coPayType === "percentage" && coPayPercentage > 0) {
    coPayAmount = (totalInsuranceCoverage * coPayPercentage) / 100;
    if (coPayLimit > 0 && coPayAmount > coPayLimit) {
      coPayAmount = coPayLimit;
    }
  } else if (coPayType === "fixed" && coPayLimit > 0) {
    coPayAmount = coPayLimit;
  }

  const patientPayable = Math.max(
    0,
    totalBill - totalInsuranceCoverage + coPayAmount,
  );

  const serviceCoverageDetails = {};
  for (const key of [
    "ward",
    "consultation",
    "investigation",
    "procedure",
    "service",
    "pharmacy",
  ]) {
    serviceCoverageDetails[key] = {
      coveragePercentage: tariffCoveragePercentage(applicableTariff, key),
      coverageLimit: tariffCoverageLimit(applicableTariff, key),
      deductible: tariffDeductible(applicableTariff, key),
    };
  }

  return {
    totalBill,
    insuranceCoverage: totalInsuranceCoverage,
    patientPayable,
    coverageBreakdown,
    exclusionsApplied,
    deductible: coverageBreakdown.reduce((sum, item) => sum + item.deductible, 0),
    coveragePercentage: toAmount(applicableTariff.coveragePercentage),
    coverageLimit: toAmount(applicableTariff.coverageLimit),
    coPayPercentage,
    coPayLimit,
    coPayAmount,
    coPayType,
    serviceCoverageDetails,
    warnings,
    tariffFound: true,
    tariffValid: true,
  };
}

module.exports = {
  calculateBillBreakdown,
  calculateInsuranceCoverage,
  calculateTotalAdvance,
  calculateWardChargesWithDailyInsurance,
  getBillingEndDate,
  isTariffValid,
  matchesCompanyId,
};
