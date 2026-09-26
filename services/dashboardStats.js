const mongoose = require("mongoose");
const dayjs = require("dayjs");

const HOSPITAL_TZ = "Asia/Kolkata";
const CLOSED_ADMISSION_STATUSES = new Set([
  "Discharged",
  "Expired",
  "LAMA",
  "Transferred",
]);

const calendarToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: HOSPITAL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const resolveRange = (timeframe, todayStr) => {
  const today = dayjs(todayStr);
  if (timeframe === "today") return { start: todayStr, end: todayStr };
  if (timeframe === "month") {
    return { start: today.startOf("month").format("YYYY-MM-DD"), end: todayStr };
  }
  if (timeframe === "6m") {
    return {
      start: today.startOf("month").subtract(5, "month").format("YYYY-MM-DD"),
      end: todayStr,
    };
  }
  return null;
};

const chartBuckets = (timeframe, todayStr) => {
  const today = dayjs(todayStr);
  if (timeframe === "today") return [{ key: todayStr, label: "Today" }];
  if (timeframe === "month") {
    const start = today.startOf("month");
    const days = today.date();
    return Array.from({ length: days }, (_, i) => {
      const d = start.add(i, "day");
      return { key: d.format("YYYY-MM-DD"), label: d.format("D MMM") };
    });
  }
  const months = timeframe === "6m" ? 6 : 12;
  return Array.from({ length: months }, (_, i) => {
    const d = today.startOf("month").subtract(months - 1 - i, "month");
    return { key: d.format("YYYY-MM"), label: d.format("MMM") };
  });
};

const inRange = (dayKey, range) => {
  if (!dayKey || dayKey === "unknown") return !range;
  if (!range) return true;
  return dayKey >= range.start && dayKey <= range.end;
};

const sumMap = (map, range) => {
  let total = 0;
  for (const [key, value] of Object.entries(map || {})) {
    if (inRange(key, range)) total += Number(value) || 0;
  }
  return total;
};

const addToMap = (map, key, amount) => {
  if (!key || !amount) return;
  map[key] = (map[key] || 0) + amount;
};

const rowsToDayMap = (rows) => {
  const map = {};
  for (const row of rows || []) {
    addToMap(map, row._id || "unknown", Number(row.total) || 0);
  }
  return map;
};

const eventDateExpr = (primary, fallback) => ({
  $convert: {
    input: { $ifNull: [primary, fallback || null] },
    to: "date",
    onError: null,
    onNull: null,
  },
});

const dayKeyExpr = (dateExpr) => ({
  $cond: [
    { $eq: [dateExpr, null] },
    "unknown",
    {
      $dateToString: {
        format: "%Y-%m-%d",
        date: dateExpr,
        timezone: HOSPITAL_TZ,
      },
    },
  ],
});

const moneyExpr = (path) => ({
  $convert: { input: { $ifNull: [path, 0] }, to: "double", onError: 0, onNull: 0 },
});

const lineAmountExpr = (ratePath, qtyPath) => ({
  $multiply: [
    moneyExpr(ratePath),
    {
      $cond: [
        { $gt: [moneyExpr(qtyPath), 0] },
        moneyExpr(qtyPath),
        1,
      ],
    },
  ],
});

const admissionEndDate = (admission, todayStr) => {
  if (!CLOSED_ADMISSION_STATUSES.has(admission?.patient_status)) return todayStr;
  const candidates = [
    admission.dischargeDate,
    admission.dischargedAt,
    admission.updatedAt,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = dayjs(candidate);
    if (parsed.isValid()) return parsed.format("YYYY-MM-DD");
  }
  return todayStr;
};

const staySegments = (admission, wardPriceById, todayStr) => {
  const transfers = (Array.isArray(admission?.transfers) ? admission.transfers : [])
    .filter((transfer) => transfer && transfer.transferDate);
  const source = transfers.length
    ? transfers
    : admission?.admissionDate
      ? [
          {
            transferDate: admission.admissionDate,
            wardId: admission.wardId,
            price: wardPriceById[admission.wardId] || 0,
          },
        ]
      : [];
  const endDate = admissionEndDate(admission, todayStr);

  return source
    .map((transfer, index) => {
      const start = dayjs(transfer.transferDate);
      if (!start.isValid()) return null;
      const nextDate = source[index + 1]?.transferDate;
      const end = nextDate ? dayjs(nextDate) : dayjs(endDate);
      if (!end.isValid()) return null;
      const listedPrice = Number(transfer.price);
      const price =
        Number.isFinite(listedPrice) && listedPrice > 0
          ? listedPrice
          : Number(wardPriceById[transfer.wardId] || wardPriceById[admission.wardId] || 0);
      return {
        start: start.format("YYYY-MM-DD"),
        end: end.format("YYYY-MM-DD"),
        price,
      };
    })
    .filter(Boolean);
};

const accumulateWardDays = (segments, todayStr) => {
  const map = {};
  for (const segment of segments) {
    let cursor = dayjs(segment.start);
    const end = dayjs(segment.end);
    if (!cursor.isValid() || !end.isValid() || segment.price <= 0) continue;
    let guard = 0;
    while ((cursor.isBefore(end, "day") || cursor.isSame(end, "day")) && guard < 4000) {
      const key = cursor.format("YYYY-MM-DD");
      if (key <= todayStr) addToMap(map, key, segment.price);
      cursor = cursor.add(1, "day");
      guard += 1;
    }
  }
  return map;
};

async function computeDashboardStatistics(tenantDb, hospitalId, timeframeQuery, asOfDate) {
  const Patient = tenantDb.model("Patient");
  const Appointment = tenantDb.model("Appointment");
  const Consultation = tenantDb.model("Consultation");
  const Action = tenantDb.model("Action");
  const DiagnosticsReceipt = tenantDb.model("DiagnosticsReceipt");
  const PharmacyReceipt = tenantDb.model("PharmacyReceipt");
  const Expense = tenantDb.model("Expense");
  const Staff = tenantDb.model("Staff");
  const IPAdmission = tenantDb.model("IPAdmission");
  const Ward = tenantDb.model("Ward");

    const hospitalObjId = mongoose.Types.ObjectId.isValid(hospitalId)
      ? new mongoose.Types.ObjectId(hospitalId)
      : hospitalId;

    // Match filter that safely matches either string or ObjectId in Mongo
    const matchFilter = {
      hospitalId: { $in: [hospitalId, hospitalObjId] },
    };

    const timeframe = ["today", "month", "6m", "all"].includes(timeframeQuery)
      ? timeframeQuery
      : "all";
    const todayStr = asOfDate || calendarToday();
    const range = resolveRange(timeframe, todayStr);
    const monthStart = dayjs(todayStr).startOf("month").format("YYYY-MM-DD");

    const dayGroupStages = (primary, fallback) => [
      { $addFields: { eventDate: eventDateExpr(primary, fallback) } },
      { $addFields: { dayKey: dayKeyExpr("$eventDate") } },
    ];

    const [
      totalPatients,
      activePatients,
      totalStaff,
      consultationByDay,
      diagnosticsByDay,
      actionByDay,
      pharmacyByDay,
      expenseByDay,
      patientByDay,
      appointmentByDay,
      departmentStatsAgg,
      recentAppointments,
      recentPharmacySales,
      recentConsultations,
      admissions,
      wards,
      legacyWardPatients,
    ] = await Promise.all([
      Patient.countDocuments(matchFilter),
      Patient.countDocuments({ ...matchFilter, active: true }),
      Staff.countDocuments(matchFilter),

      Consultation.aggregate([
        { $match: matchFilter },
        ...dayGroupStages("$createdAt", "$date"),
        { $unwind: { path: "$items", preserveNullAndEmptyArrays: false } },
        {
          $group: {
            _id: "$dayKey",
            total: { $sum: lineAmountExpr("$items.charges", "$items.quantity") },
          },
        },
      ]),

      DiagnosticsReceipt.aggregate([
        {
          $match: {
            ...matchFilter,
            type: {
              $nin: [
                "lab-purchase",
                "lab-purchase-return",
                "lab-Indent",
                "lab-indent",
              ],
            },
          },
        },
        ...dayGroupStages("$createdAt", "$date"),
        { $unwind: { path: "$items", preserveNullAndEmptyArrays: false } },
        {
          $group: {
            _id: "$dayKey",
            total: {
              $sum: {
                $cond: [
                  { $eq: ["$type", "lab-sale-return"] },
                  { $multiply: [moneyExpr("$items.price"), -1] },
                  moneyExpr("$items.price"),
                ],
              },
            },
          },
        },
      ]),

      Action.aggregate([
        { $match: { ...matchFilter, patientId: { $exists: true, $ne: null } } },
        ...dayGroupStages("$createdAt", "$date"),
        { $unwind: { path: "$items", preserveNullAndEmptyArrays: false } },
        {
          $group: {
            _id: {
              day: "$dayKey",
              category: {
                $toLower: {
                  $ifNull: [
                    "$items.category",
                    { $ifNull: ["$items.mainCategory", ""] },
                  ],
                },
              },
            },
            total: { $sum: lineAmountExpr("$items.rate", "$items.quantity") },
          },
        },
      ]),

      PharmacyReceipt.aggregate([
        {
          $match: {
            ...matchFilter,
            type: { $in: ["pharmacy-sale", "pharmacy", "pharmacy-sale-return"] },
          },
        },
        ...dayGroupStages("$createdAt", "$date"),
        {
          $group: {
            _id: "$dayKey",
            total: {
              $sum: {
                $cond: [
                  { $eq: ["$type", "pharmacy-sale-return"] },
                  { $multiply: [moneyExpr("$totalAmount"), -1] },
                  moneyExpr("$totalAmount"),
                ],
              },
            },
          },
        },
      ]),

      Expense.aggregate([
        { $match: matchFilter },
        ...dayGroupStages("$createdAt", "$createdAtOriginal"),
        { $group: { _id: "$dayKey", total: { $sum: moneyExpr("$amount") } } },
      ]),

      Patient.aggregate([
        { $match: matchFilter },
        ...dayGroupStages("$createdAt", "$registration_date"),
        { $group: { _id: "$dayKey", total: { $sum: 1 } } },
      ]),

      Appointment.aggregate([
        { $match: matchFilter },
        ...dayGroupStages("$appointmentDate", "$createdAt"),
        { $group: { _id: "$dayKey", total: { $sum: 1 } } },
      ]),

      Staff.aggregate([
        { $match: matchFilter },
        { $group: { _id: { $ifNull: ["$department", "Other"] }, count: { $sum: 1 } } },
      ]),

      Appointment.find(matchFilter)
        .sort({ appointmentDate: -1, createdAt: -1 })
        .limit(3)
        .select("patientName doctorName appointmentDate")
        .lean(),

      PharmacyReceipt.find({
        ...matchFilter,
        type: { $in: ["pharmacy-sale", "pharmacy"] },
      })
        .sort({ createdAt: -1, date: -1 })
        .limit(2)
        .select("totalAmount createdAt date")
        .lean(),

      Consultation.find(matchFilter)
        .sort({ createdAt: -1, date: -1 })
        .limit(2)
        .select("items createdAt date")
        .lean(),

      IPAdmission.find(matchFilter)
        .select(
          "patientId transfers patient_status dischargeDate dischargedAt admissionDate wardId updatedAt",
        )
        .lean(),

      Ward.find(matchFilter).select("wardId price").lean(),

      Patient.aggregate([
        {
          $match: {
            ...matchFilter,
            "transfers.0": { $exists: true },
          },
        },
        {
          $project: {
            transfers: 1,
            active: 1,
            dischargeDate: 1,
            dischargedAt: 1,
            updatedAt: 1,
            patient_status: 1,
          },
        },
      ]),
    ]);

    const consultationMap = rowsToDayMap(consultationByDay);
    const labMap = rowsToDayMap(diagnosticsByDay);
    const pharmacyMap = rowsToDayMap(pharmacyByDay);
    const expenseMap = rowsToDayMap(expenseByDay);
    const patientRegMap = rowsToDayMap(patientByDay);
    const appointmentMap = rowsToDayMap(appointmentByDay);

    const procedureMap = {};
    const serviceMap = {};
    for (const row of actionByDay) {
      const day = row?._id?.day || "unknown";
      const category = String(row?._id?.category || "");
      const amount = Number(row.total) || 0;
      if (category.includes("procedure")) addToMap(procedureMap, day, amount);
      else if (category.includes("service")) addToMap(serviceMap, day, amount);
    }

    const wardPriceById = {};
    for (const ward of wards) {
      wardPriceById[String(ward.wardId)] = Number(ward.price) || 0;
    }

    const coveredPatients = new Set(
      (admissions || []).map((admission) => String(admission.patientId)),
    );
    const legacyByPatient = {};
    for (const patient of legacyWardPatients || []) {
      legacyByPatient[String(patient._id)] = patient;
    }

    const wardMap = {};
    const addStay = (record) => {
      const segments = staySegments(record, wardPriceById, todayStr);
      const days = accumulateWardDays(segments, todayStr);
      for (const [day, amount] of Object.entries(days)) {
        addToMap(wardMap, day, amount);
      }
    };

    for (const admission of admissions || []) {
      const legacy = legacyByPatient[String(admission.patientId)];
      const hasTransfers =
        Array.isArray(admission.transfers) && admission.transfers.length > 0;
      if (!hasTransfers && legacy?.transfers?.length) {
        addStay({
          ...admission,
          transfers: legacy.transfers,
          dischargeDate: admission.dischargeDate || legacy.dischargeDate,
          dischargedAt: admission.dischargedAt || legacy.dischargedAt,
          patient_status:
            admission.patient_status ||
            (legacy.active === false ? "Discharged" : "Admitted"),
        });
      } else {
        addStay(admission);
      }
    }

    for (const patient of legacyWardPatients || []) {
      if (coveredPatients.has(String(patient._id))) continue;
      addStay({
        ...patient,
        patient_status:
          patient.patient_status ||
          (patient.active === false ? "Discharged" : "Admitted"),
      });
    }

    const monthRange = { start: monthStart, end: todayStr };
    const totalConsultationCharges = sumMap(consultationMap, range);
    const totalInvestigationCharges = sumMap(labMap, range);
    const totalProcedureCharges = sumMap(procedureMap, range);
    const totalServiceCharges = sumMap(serviceMap, range);
    const totalPharmacyCharges = sumMap(pharmacyMap, range);
    const totalWardCharges = sumMap(wardMap, range);
    const totalExpenses = sumMap(expenseMap, range);

    const totalRevenue =
      totalWardCharges +
      totalConsultationCharges +
      totalServiceCharges +
      totalProcedureCharges +
      totalInvestigationCharges +
      totalPharmacyCharges;

    const monthlyRevenue =
      sumMap(consultationMap, monthRange) +
      sumMap(labMap, monthRange) +
      sumMap(procedureMap, monthRange) +
      sumMap(serviceMap, monthRange) +
      sumMap(pharmacyMap, monthRange) +
      sumMap(wardMap, monthRange);

    const buckets = chartBuckets(timeframe, todayStr);
    const dailyBuckets = timeframe === "today" || timeframe === "month";
    const streamMaps = [
      consultationMap,
      labMap,
      procedureMap,
      serviceMap,
      pharmacyMap,
      wardMap,
    ];

    const monthlyData = buckets.map((bucket) => {
      let total = 0;
      for (const map of streamMaps) {
        for (const [day, amount] of Object.entries(map)) {
          if (!day || day === "unknown" || !inRange(day, range)) continue;
          const key = dailyBuckets ? day : day.slice(0, 7);
          if (key === bucket.key) total += Number(amount) || 0;
        }
      }
      return { month: bucket.label, total };
    });

    const patientData = buckets.map((bucket) => {
      let count = 0;
      for (const [day, amount] of Object.entries(patientRegMap)) {
        if (!day || day === "unknown" || !inRange(day, range)) continue;
        const key = dailyBuckets ? day : day.slice(0, 7);
        if (key === bucket.key) count += Number(amount) || 0;
      }
      return { month: bucket.label, count };
    });

    const todayAppointments = appointmentMap[todayStr] || 0;
    const totalAppointments = sumMap(appointmentMap, null);
    const periodAppointments = range
      ? sumMap(appointmentMap, range)
      : totalAppointments;

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

    const departmentStats = departmentStatsAgg.map((dept) => ({
      dept: dept._id,
      count: dept.count,
    }));

    return {
      timeframe,
      totalPatients,
      activePatients,
      totalAppointments,
      todayAppointments,
      periodAppointments,
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
    };
}


module.exports = {
  HOSPITAL_TZ,
  calendarToday,
  eventDateExpr,
  dayKeyExpr,
  computeDashboardStatistics,
};
