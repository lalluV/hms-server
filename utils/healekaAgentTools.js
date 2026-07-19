/**
 * Role-gated tools for the Healeka AI agent (deep reads + field-gated writes).
 * Tools not listed for a role are omitted from the OpenAI tools list.
 */

const {
  searchMasterMedicines,
  searchMasterDiagnostics,
  searchMasterParameters,
  searchMasterLabItems,
} = require("./meilisearch");
const {
  ACTION_ROLE_ACCESS,
  ACTION_TOOL_DEFINITIONS,
  ACTION_HANDLERS,
} = require("./healekaAgentActions");

const MAX_ROWS = 40;
const PATIENT_LIMIT = 25;
const INVENTORY_LIMIT = 40;
const LOW_STOCK_THRESHOLD = 10;

const ALL_STAFF_ROLES = [
  "SuperAdmin",
  "Admin",
  "Doctor",
  "Nurse",
  "Pharmacist",
  "LabTechnician",
  "Phlebotomist",
  "Receptionist",
  "Accountant",
  "HR Manager",
  "IT Support",
  "PRO",
];

const CLINICAL_ROLES = ["Doctor", "Nurse", "SuperAdmin", "Admin"];

const PATIENT_ACCESS_ROLES = [
  "Doctor",
  "Nurse",
  "Receptionist",
  "SuperAdmin",
  "Admin",
  "Pharmacist",
  "LabTechnician",
  "Phlebotomist",
  "PRO",
];

const ROLE_TOOL_ACCESS = {
  search_patients: PATIENT_ACCESS_ROLES,
  get_patient_summary: PATIENT_ACCESS_ROLES,
  get_appointments: [
    "Receptionist",
    "Doctor",
    "Admin",
    "SuperAdmin",
    "Nurse",
    "PRO",
  ],
  get_opd_ipd_census: [
    "Admin",
    "SuperAdmin",
    "Doctor",
    "Nurse",
    "Receptionist",
  ],
  search_pharmacy_inventory: ["Pharmacist", "SuperAdmin", "Admin"],
  search_lab_inventory: [
    "LabTechnician",
    "Phlebotomist",
    "SuperAdmin",
    "Admin",
  ],
  get_lab_sales: [
    "LabTechnician",
    "Phlebotomist",
    "SuperAdmin",
    "Admin",
  ],
  get_pharmacy_sales: ["Pharmacist", "SuperAdmin", "Admin"],
  get_expenses: ["Accountant", "SuperAdmin", "Admin"],
  get_staff_directory: [
    "HR Manager",
    "Admin",
    "SuperAdmin",
    "IT Support",
  ],
  get_insurance_info: ["Accountant", "Admin", "SuperAdmin"],
  search_master_catalog: ALL_STAFF_ROLES,
  explain_hms_howto: ALL_STAFF_ROLES,
  search_consultations: [
    "Doctor",
    "Nurse",
    "Receptionist",
    "Admin",
    "SuperAdmin",
    "PRO",
  ],
  search_receipts: [
    "Pharmacist",
    "LabTechnician",
    "Phlebotomist",
    "Admin",
    "SuperAdmin",
    "Accountant",
    "Receptionist",
  ],
  count_patients: [
    "Admin",
    "SuperAdmin",
    "Doctor",
    "Nurse",
    "Receptionist",
  ],
  list_todays_op: [
    "Admin",
    "SuperAdmin",
    "Doctor",
    "Nurse",
    "Receptionist",
  ],
  find_doctor_by_name: ALL_STAFF_ROLES,
  ...ACTION_ROLE_ACCESS,
};

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "search_patients",
      description:
        "Search hospital patients by UMR number, name, or phone. Returns a short list.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "UMR, patient name, or phone number",
          },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_patient_summary",
      description:
        "Get a summary for one patient by MongoDB id or UMR. Clinical detail depends on caller role.",
      parameters: {
        type: "object",
        properties: {
          patientId: {
            type: "string",
            description: "Patient MongoDB ObjectId",
          },
          umr: { type: "string", description: "UMR number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_appointments",
      description:
        "List appointments for a date (YYYY-MM-DD) or today if omitted.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Appointment date YYYY-MM-DD; defaults to today",
          },
          doctorId: {
            type: "string",
            description: "Optional doctor id filter",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_opd_ipd_census",
      description:
        "OP/IP patient counts and ward bed occupancy for the hospital.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_pharmacy_inventory",
      description:
        "Search pharmacy inventory by medicine name or item code. Can filter low stock.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Medicine name or item code" },
          lowStockOnly: {
            type: "boolean",
            description: "If true, only items at or below low-stock threshold",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_lab_inventory",
      description: "Search lab inventory by item name or code.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Lab item name or code" },
          lowStockOnly: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_lab_sales",
      description: "Recent lab/diagnostics sale receipts summary.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max receipts (default 10)" },
          days: {
            type: "number",
            description: "Lookback days (default 7)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pharmacy_sales",
      description: "Recent pharmacy sale receipts summary.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number" },
          days: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_expenses",
      description: "List recent expenses, optionally filtered by category.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string" },
          limit: { type: "number" },
          days: { type: "number", description: "Lookback days (default 30)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_staff_directory",
      description:
        "List staff by role/type or department. Never returns passwords.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Staff role type e.g. Doctor, Nurse",
          },
          department: { type: "string" },
          query: { type: "string", description: "Name search" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_insurance_info",
      description: "List insurance companies and a brief tariff overview.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional company name filter",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_master_catalog",
      description:
        "Search shared master catalogs: medicines, diagnostics, parameters, or lab items.",
      parameters: {
        type: "object",
        properties: {
          catalog: {
            type: "string",
            enum: ["medicines", "diagnostics", "parameters", "lab_items"],
          },
          query: { type: "string" },
        },
        required: ["catalog", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_consultations",
      description:
        "Search consultation receipts by patient name, phone, or patientId.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          days: { type: "number", description: "Lookback days (default 14)" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_receipts",
      description:
        "Search pharmacy and/or lab receipts by patient name, phone, or id.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: {
            type: "string",
            enum: ["pharmacy", "lab", "both"],
            description: "Default both",
          },
          days: { type: "number" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "count_patients",
      description:
        "Count patients by type (OP/IP/all) and optional active filter.",
      parameters: {
        type: "object",
        properties: {
          patient_type: {
            type: "string",
            enum: ["OP", "IP", "all"],
            description: "Default all",
          },
          activeOnly: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_todays_op",
      description:
        "List today's OP patients (registration_date or appointment_date). For Doctors, defaults to their own patients (mineOnly). Nurses/Admin see hospital OP list. Use when doctor/nurse needs to pick a patient for Rx or vitals.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number" },
          mineOnly: {
            type: "boolean",
            description:
              "If true (default for Doctor), only patients linked to the logged-in doctor. Nurses should omit or set false.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_doctor_by_name",
      description: "Find doctor staff by name for appointments or routing.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explain_hms_howto",
      description:
        "Explain how to use Healeka HMS for a topic (appointments, pharmacy sale, lab, IPD, etc.). Role-aware product help.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Feature or workflow to explain",
          },
        },
        required: ["topic"],
      },
    },
  },
];

function getToolsForRole(role) {
  const reads = TOOL_DEFINITIONS.filter((t) => {
    const allowed = ROLE_TOOL_ACCESS[t.function.name] || [];
    return allowed.includes(role);
  });
  const actions = ACTION_TOOL_DEFINITIONS.filter((t) => {
    const allowed = ROLE_TOOL_ACCESS[t.function.name] || [];
    return allowed.includes(role);
  });
  return [...reads, ...actions];
}

function roleCanUseTool(role, toolName) {
  return (ROLE_TOOL_ACCESS[toolName] || []).includes(role);
}

function sumBatchQty(batches) {
  if (!Array.isArray(batches)) return 0;
  return batches.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0);
}

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysAgoDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - (Number(days) || 7));
  return d;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function search_patients(ctx, args) {
  const Patient = ctx.tenantDb.model("Patient");
  const q = String(args.query || "").trim();
  if (!q) return { patients: [], message: "Empty query", searched: [] };

  const limit = Math.min(Number(args.limit) || 15, PATIENT_LIMIT);
  const digits = q.replace(/\D/g, "");
  const searched = [];
  let patients = [];
  let matchReason = "";

  // 1) Exact UMR
  searched.push("exact_UMR");
  let exact = await Patient.find({
    hospitalId: ctx.hospitalId,
    UMRNo: q,
  })
    .select(
      "UMRNo name gender age phone patient_type patient_status wardName selectedBed doctorId consultantDoctor active admissionDate",
    )
    .limit(limit)
    .lean();
  if (!exact.length) {
    exact = await Patient.find({
      hospitalId: ctx.hospitalId,
      UMRNo: { $regex: `^${escapeRegex(q)}$`, $options: "i" },
    })
      .select(
        "UMRNo name gender age phone patient_type patient_status wardName selectedBed doctorId consultantDoctor active admissionDate",
      )
      .limit(limit)
      .lean();
  }
  if (exact.length) {
    patients = exact;
    matchReason = "exact_UMR";
  }

  // 2) Phone digits
  if (!patients.length && digits.length >= 6) {
    searched.push("phone_digits");
    const phoneHits = await Patient.find({
      hospitalId: ctx.hospitalId,
      $or: [
        { phone: { $regex: escapeRegex(digits) } },
        { emergency_phone: { $regex: escapeRegex(digits) } },
      ],
    })
      .select(
        "UMRNo name gender age phone patient_type patient_status wardName selectedBed doctorId consultantDoctor active admissionDate",
      )
      .limit(limit)
      .lean();
    if (phoneHits.length) {
      patients = phoneHits;
      matchReason = "phone";
    }
  }

  // 3) Fuzzy name / partial UMR / phone string
  if (!patients.length) {
    searched.push("name_or_partial");
    const filter = {
      hospitalId: ctx.hospitalId,
      $or: [
        { UMRNo: { $regex: escapeRegex(q), $options: "i" } },
        { name: { $regex: escapeRegex(q), $options: "i" } },
        { phone: { $regex: escapeRegex(q), $options: "i" } },
      ],
    };
    patients = await Patient.find(filter)
      .select(
        "UMRNo name gender age phone patient_type patient_status wardName selectedBed doctorId consultantDoctor active admissionDate",
      )
      .limit(limit)
      .lean();
    matchReason = patients.length ? "fuzzy" : "none";
  }

  if (ctx.role === "Doctor" && patients.length > 3 && ctx.userId) {
    const preferred = patients.filter(
      (p) =>
        String(p.doctorId) === String(ctx.userId) ||
        String(p.doctorId) === String(ctx.staffMongoId),
    );
    if (preferred.length) patients = preferred.slice(0, limit);
  }

  return {
    matchReason,
    searched,
    count: patients.length,
    patients: patients.map((p) => ({
      id: p._id,
      UMRNo: p.UMRNo,
      name: p.name,
      gender: p.gender,
      age: p.age,
      phone: p.phone,
      patient_type: p.patient_type,
      patient_status: p.patient_status,
      wardName: p.wardName,
      selectedBed: p.selectedBed,
      consultantDoctor: p.consultantDoctor,
      admissionDate: p.admissionDate,
      active: p.active,
    })),
    message:
      patients.length === 0
        ? `No patients found for "${q}" (tried: ${searched.join(", ")}). Try full UMR or phone.`
        : undefined,
  };
}

async function get_patient_summary(ctx, args) {
  const Patient = ctx.tenantDb.model("Patient");
  const clinical = CLINICAL_ROLES.includes(ctx.role);

  let patient = null;
  if (args.patientId) {
    patient = await Patient.findOne({
      _id: args.patientId,
      hospitalId: ctx.hospitalId,
    }).lean();
  } else if (args.umr) {
    patient = await Patient.findOne({
      UMRNo: args.umr,
      hospitalId: ctx.hospitalId,
    }).lean();
    if (!patient) {
      patient = await Patient.findOne({
        hospitalId: ctx.hospitalId,
        UMRNo: { $regex: `^${escapeRegex(args.umr)}$`, $options: "i" },
      }).lean();
    }
  }

  if (!patient) return { error: "Patient not found" };

  const base = {
    id: patient._id,
    UMRNo: patient.UMRNo,
    name: patient.name,
    gender: patient.gender,
    age: patient.age,
    phone: patient.phone,
    email: patient.email,
    patient_type: patient.patient_type,
    patient_status: patient.patient_status,
    wardName: patient.wardName,
    selectedBed: patient.selectedBed,
    consultantDoctor: patient.consultantDoctor,
    doctorId: patient.doctorId,
    admissionDate: patient.admissionDate,
    admissionTime: patient.admissionTime,
    dischargeTo: patient.dischargeTo,
    insurance_provider: patient.insurance_provider,
    paymentMethod: patient.paymentMethod,
    provisionalDiagnosis: patient.provisionalDiagnosis,
    allergiesHistory: patient.allergiesHistory,
    active: patient.active,
  };

  const patientIdStr = String(patient._id);
  let recentPharmacy = [];
  let recentLab = [];
  try {
    const since = daysAgoDate(30);
    const PharmacyReceipt = ctx.tenantDb.model("PharmacyReceipt");
    const DiagnosticsReceipt = ctx.tenantDb.model("DiagnosticsReceipt");
    const [ph, lab] = await Promise.all([
      PharmacyReceipt.find({
        hospitalId: ctx.hospitalId,
        createdAt: { $gte: since },
        $or: [
          { patientId: patientIdStr },
          { patientName: patient.name },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("receiptId totalAmount paymentStatus type createdAt")
        .lean(),
      DiagnosticsReceipt.find({
        hospitalId: ctx.hospitalId,
        createdAt: { $gte: since },
        $or: [
          { patientId: patientIdStr },
          { patientName: patient.name },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .select(
          "receiptId totalAmount paymentStatus overallStatus createdAt totalTests completedTests",
        )
        .lean(),
    ]);
    recentPharmacy = ph;
    recentLab = lab;
  } catch {
    /* ignore */
  }

  if (!clinical) {
    return {
      summary: {
        ...base,
        recentPharmacyReceipts: recentPharmacy,
        recentLabReceipts: recentLab,
      },
      note: "Clinical notes, vitals, prescriptions, and investigations are restricted for your role.",
    };
  }

  const recentNotes = (patient.doctorNotes || []).slice(-10).map((n) => ({
    date: n.date || n.createdAt || n.timestamp,
    note: typeof n === "string" ? n : n.note || n.text || n.content,
    doctor: n.doctor || n.doctorName,
  }));
  const recentNurse = (patient.nurseNotes || []).slice(-10).map((n) => ({
    date: n.date || n.createdAt,
    note: typeof n === "string" ? n : n.note || n.text || n.content,
  }));
  const recentRx = [...(patient.prescriptions || [])]
    .sort(
      (a, b) =>
        new Date(b.date || b.createdAt || 0) -
        new Date(a.date || a.createdAt || 0),
    )
    .slice(0, 8)
    .map((rx) => {
      const meds = Array.isArray(rx.medicineData)
        ? rx.medicineData
        : Array.isArray(rx.medicines)
          ? rx.medicines
          : Array.isArray(rx.items)
            ? rx.items
            : [];
      const activeMeds = meds.filter((m) => m?.isActive !== false);
      const labs = Array.isArray(rx.diagnosticData) ? rx.diagnosticData : [];
      const rxDate = rx.date || rx.createdAt;
      const d = rxDate ? new Date(rxDate) : null;
      const isToday =
        d &&
        !Number.isNaN(d.getTime()) &&
        d.toDateString() === new Date().toDateString();
      return {
        prescriptionId: rx.prescriptionId,
        date: rxDate,
        isToday,
        consultantDoctor: rx.consultantDoctor || "",
        doctorId: rx.doctorId || "",
        provisionalDiagnosis: rx.provisionalDiagnosis || "",
        medicineCount: activeMeds.length,
        medicines: activeMeds.slice(0, 15).map((m) =>
          typeof m === "string"
            ? m
            : m.name || m.medicineName || m.generic_name || m.description || m.item_code,
        ),
        labCount: labs.length,
        labs: labs
          .slice(0, 10)
          .map((t) => t?.name || t?.description || t?.test_name)
          .filter(Boolean),
        openPath: patient.UMRNo && rx.prescriptionId
          ? `/consultation/${patient.UMRNo}/prescription/${rx.prescriptionId}`
          : undefined,
      };
    });
  const recentLabs = (patient.investigations || []).slice(-10).map((i) => ({
    name: i.name || i.testName || i.item_name,
    status: i.status,
    date: i.date || i.createdAt,
  }));
  const recentVitals = (patient.vitals || []).slice(-10);
  const recentProcedures = (patient.procedures || []).slice(-5);
  const recentTreatment = (patient.treatment || []).slice(-5);

  return {
    summary: {
      ...base,
      chiefComplaintsPresentIllnessHistory:
        patient.chiefComplaintsPresentIllnessHistory,
      pastMedicalHistory: patient.pastMedicalHistory,
      recentDoctorNotes: recentNotes,
      recentNurseNotes: recentNurse,
      recentPrescriptions: recentRx,
      recentInvestigations: recentLabs,
      recentVitals,
      recentProcedures,
      recentTreatment,
      recentPharmacyReceipts: recentPharmacy,
      recentLabReceipts: recentLab,
    },
  };
}

async function get_appointments(ctx, args) {
  const Appointment = ctx.tenantDb.model("Appointment");
  const date = args.date || todayYmd();
  const filter = {
    hospitalId: ctx.hospitalId,
    $or: [
      { appointmentDate: date },
      { slotDate: date },
    ],
  };
  if (args.doctorId) {
    filter.doctorId = String(args.doctorId);
  } else if (ctx.role === "Doctor" && ctx.userId) {
    filter.$and = [
      {
        $or: [
          { doctorId: String(ctx.userId) },
          { doctorId: String(ctx.staffMongoId) },
          { doctor: String(ctx.userId) },
        ],
      },
    ];
  }

  const appts = await Appointment.find(filter)
    .sort({ time: 1, slotTime: 1 })
    .limit(MAX_ROWS)
    .lean();

  return {
    date,
    count: appts.length,
    appointments: appts.map((a) => ({
      id: a._id,
      name: a.name || a.fullName,
      phone: a.phone || a.mobile,
      doctor: a.doctorName || a.doctor,
      time: a.time || a.slotTime,
      status: a.status,
      treatment: a.treatment,
      notes: a.notes,
    })),
  };
}

async function get_opd_ipd_census(ctx) {
  const Patient = ctx.tenantDb.model("Patient");
  const Ward = ctx.tenantDb.model("Ward");

  const [opCount, ipCount, wards] = await Promise.all([
    Patient.countDocuments({
      hospitalId: ctx.hospitalId,
      patient_type: { $in: ["OP", "op", "Outpatient"] },
      active: { $ne: false },
    }),
    Patient.countDocuments({
      hospitalId: ctx.hospitalId,
      patient_type: { $in: ["IP", "ip", "Inpatient"] },
      active: { $ne: false },
      patient_status: { $nin: ["Discharged", "discharged"] },
    }),
    Ward.find({ hospitalId: ctx.hospitalId }).lean(),
  ]);

  const wardOccupancy = wards.map((w) => {
    const beds = w.beds || [];
    const occupied = beds.filter(
      (b) => b.status && String(b.status).toLowerCase() !== "empty",
    ).length;
    return {
      wardName: w.wardName,
      totalBeds: beds.length,
      occupied,
      empty: beds.length - occupied,
    };
  });

  return {
    opActiveApprox: opCount,
    ipActive: ipCount,
    wards: wardOccupancy,
  };
}

async function search_pharmacy_inventory(ctx, args) {
  const PharmacyInventory = ctx.tenantDb.model("PharmacyInventory");
  const q = String(args.query || "").trim();
  const filter = { hospitalId: ctx.hospitalId, active: { $ne: false } };
  if (q) {
    filter.$or = [
      { generic_name: { $regex: escapeRegex(q), $options: "i" } },
      { generic_name2: { $regex: escapeRegex(q), $options: "i" } },
      { item_code: { $regex: escapeRegex(q), $options: "i" } },
      { description: { $regex: escapeRegex(q), $options: "i" } },
    ];
  }

  let items = await PharmacyInventory.find(filter).limit(80).lean();
  let mapped = items.map((item) => {
    const qty = sumBatchQty(item.batches);
    return {
      id: item._id,
      item_code: item.item_code,
      generic_name: item.generic_name,
      manufacturer: item.manufacturer,
      type: item.type,
      totalQuantity: qty,
      batchCount: (item.batches || []).length,
    };
  });

  if (args.lowStockOnly) {
    mapped = mapped.filter((i) => i.totalQuantity <= LOW_STOCK_THRESHOLD);
  } else if (!q) {
    mapped = mapped
      .filter((i) => i.totalQuantity <= LOW_STOCK_THRESHOLD)
      .slice(0, INVENTORY_LIMIT);
    return {
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      items: mapped,
      note: "No query provided; returning low-stock items.",
    };
  }

  return {
    lowStockThreshold: LOW_STOCK_THRESHOLD,
    items: mapped.slice(0, INVENTORY_LIMIT),
  };
}

async function search_lab_inventory(ctx, args) {
  const LabInventory = ctx.tenantDb.model("LabInventory");
  const q = String(args.query || "").trim();
  const filter = { hospitalId: ctx.hospitalId, active: { $ne: false } };
  if (q) {
    filter.$or = [
      { name: { $regex: escapeRegex(q), $options: "i" } },
      { item_code: { $regex: escapeRegex(q), $options: "i" } },
      { description: { $regex: escapeRegex(q), $options: "i" } },
    ];
  }

  let items = await LabInventory.find(filter).limit(50).lean();
  let mapped = items.map((item) => {
    const qty = sumBatchQty(item.batches);
    return {
      id: item._id,
      name: item.name,
      item_code: item.item_code,
      category: item.category,
      unit: item.unit,
      totalQuantity: qty,
    };
  });

  if (args.lowStockOnly || !q) {
    mapped = mapped.filter((i) => i.totalQuantity <= LOW_STOCK_THRESHOLD);
  }

  return { items: mapped.slice(0, MAX_ROWS) };
}

async function get_lab_sales(ctx, args) {
  const DiagnosticsReceipt = ctx.tenantDb.model("DiagnosticsReceipt");
  const limit = Math.min(Number(args.limit) || 10, MAX_ROWS);
  const since = daysAgoDate(args.days || 7);

  const receipts = await DiagnosticsReceipt.find({
    hospitalId: ctx.hospitalId,
    createdAt: { $gte: since },
    type: { $nin: ["purchase", "purchase-return"] },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return {
    count: receipts.length,
    receipts: receipts.map((r) => ({
      receiptId: r.receiptId,
      patientName: r.patientName,
      totalAmount: r.totalAmount,
      paymentStatus: r.paymentStatus,
      overallStatus: r.overallStatus,
      totalTests: r.totalTests,
      completedTests: r.completedTests,
      createdAt: r.createdAt,
      itemNames: (r.items || [])
        .slice(0, 8)
        .map((i) => i.name || i.testName || i.item_name),
    })),
  };
}

async function get_pharmacy_sales(ctx, args) {
  const PharmacyReceipt = ctx.tenantDb.model("PharmacyReceipt");
  const limit = Math.min(Number(args.limit) || 10, MAX_ROWS);
  const since = daysAgoDate(args.days || 7);

  const receipts = await PharmacyReceipt.find({
    hospitalId: ctx.hospitalId,
    createdAt: { $gte: since },
    $or: [
      { type: { $in: ["sale", "Sale", "pharmacy-sale", "pharmacy_sale"] } },
      { type: { $exists: false } },
      { patientName: { $exists: true, $ne: null } },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return {
    count: receipts.length,
    receipts: receipts.map((r) => ({
      receiptId: r.receiptId,
      patientName: r.patientName,
      totalAmount: r.totalAmount,
      paymentStatus: r.paymentStatus,
      type: r.type,
      createdAt: r.createdAt,
      itemCount: (r.items || []).length,
    })),
  };
}

async function get_expenses(ctx, args) {
  const Expense = ctx.tenantDb.model("Expense");
  const limit = Math.min(Number(args.limit) || 15, MAX_ROWS);
  const since = daysAgoDate(args.days || 30);
  const filter = {
    hospitalId: ctx.hospitalId,
    createdAt: { $gte: since },
  };
  if (args.category) {
    filter.category = { $regex: escapeRegex(args.category), $options: "i" };
  }

  const expenses = await Expense.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const total = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  return {
    totalAmountInResults: total,
    expenses: expenses.map((e) => ({
      id: e._id,
      category: e.category,
      amount: e.amount,
      description: e.description || e.remarks,
      createdAt: e.createdAt || e.createdAtOriginal,
    })),
  };
}

async function get_staff_directory(ctx, args) {
  const Staff = ctx.tenantDb.model("Staff");
  const filter = { hospitalId: ctx.hospitalId };
  if (args.type) filter.type = args.type;
  if (args.department) {
    filter.department = { $regex: escapeRegex(args.department), $options: "i" };
  }
  if (args.query) {
    filter.name = { $regex: escapeRegex(args.query), $options: "i" };
  }

  const staff = await Staff.find(filter)
    .select(
      "name email phone type department position specialization active qualification",
    )
    .limit(MAX_ROWS)
    .lean();

  return {
    staff: staff.map((s) => ({
      id: s._id,
      name: s.name,
      email: s.email,
      phone: s.phone,
      type: s.type,
      department: s.department,
      position: s.position,
      specialization: s.specialization,
      active: s.active,
    })),
  };
}

async function get_insurance_info(ctx, args) {
  const InsuranceCompany = ctx.tenantDb.model("InsuranceCompany");
  const InsuranceTariff = ctx.tenantDb.model("InsuranceTariff");
  const filter = { hospitalId: ctx.hospitalId };
  if (args.query) {
    filter.name = { $regex: escapeRegex(args.query), $options: "i" };
  }

  const companies = await InsuranceCompany.find(filter).limit(MAX_ROWS).lean();
  const companyIds = companies.map((c) => String(c._id));
  let tariffCounts = [];
  if (companyIds.length) {
    tariffCounts = await InsuranceTariff.aggregate([
      {
        $match: {
          hospitalId: ctx.hospitalId,
          companyId: { $in: companyIds },
        },
      },
      { $group: { _id: "$companyId", count: { $sum: 1 } } },
    ]).catch(() => []);
  }
  const countMap = Object.fromEntries(
    (tariffCounts || []).map((t) => [String(t._id), t.count]),
  );

  return {
    companies: companies.map((c) => ({
      id: c._id,
      name: c.name,
      contactPerson: c.contactPerson,
      phone: c.phone,
      status: c.status,
      tariffCount: countMap[String(c._id)] || 0,
    })),
  };
}

async function search_master_catalog(ctx, args) {
  const catalog = args.catalog;
  const query = String(args.query || "").trim();
  if (!query) return { results: [], message: "Empty query" };

  let results = [];
  let source = "meilisearch";
  try {
    if (catalog === "medicines") {
      results = (await searchMasterMedicines(query, 10)) || [];
    } else if (catalog === "diagnostics") {
      results = (await searchMasterDiagnostics(query, 10)) || [];
    } else if (catalog === "parameters") {
      results = (await searchMasterParameters(query, 10)) || [];
    } else if (catalog === "lab_items") {
      results = (await searchMasterLabItems(query, 10)) || [];
    } else {
      return { error: "Unknown catalog" };
    }
  } catch (err) {
    results = [];
  }

  // MongoDB fallback when Meilisearch is empty/unavailable
  if (!results.length) {
    source = "mongodb";
    try {
      const rx = { $regex: escapeRegex(query), $options: "i" };
      if (catalog === "medicines") {
        const MasterMedicine = require("../models/MasterMedicine");
        results = await MasterMedicine.find({
          $or: [
            { generic_name: rx },
            { generic_name2: rx },
            { item_code: rx },
            { description: rx },
          ],
        })
          .limit(10)
          .lean();
      } else if (catalog === "diagnostics") {
        const MasterDiagnostic = require("../models/MasterDiagnostic");
        results = await MasterDiagnostic.find({
          $or: [{ name: rx }, { test_code: rx }, { description: rx }],
        })
          .limit(10)
          .lean();
      } else if (catalog === "parameters") {
        const MasterParameter = require("../models/MasterParameter");
        results = await MasterParameter.find({
          $or: [{ name: rx }, { parameter_code: rx }],
        })
          .limit(10)
          .lean();
      } else if (catalog === "lab_items") {
        const MasterLabItem = require("../models/MasterLabItem");
        results = await MasterLabItem.find({
          $or: [{ name: rx }, { item_code: rx }, { description: rx }],
        })
          .limit(10)
          .lean();
      }
    } catch (err) {
      return { error: "Catalog search failed", detail: err.message };
    }
  }

  return {
    catalog,
    source,
    results: (results || []).slice(0, 10).map((r) => ({
      id: r.id || r._id,
      name: r.name || r.generic_name || r.item_name,
      code: r.item_code || r.test_code || r.parameter_code || r.code,
      type: r.type || r.category || r.deptname,
    })),
  };
}

function explain_hms_howto(ctx, args) {
  const topic = String(args.topic || "").toLowerCase();
  const role = ctx.role;

  const guides = {
    appointments:
      "Reception: use Appointments from the sidebar → Add Appointment, pick doctor, date, and slot. Patients can also be registered under Patients first, then linked.",
    pharmacy:
      "Pharmacy: Sidebar → Pharmacy Sale to sell medicines; Purchase for vendor bills; Inventory to add stock; Adjustments for stock corrections; Indent for ward requests.",
    lab: "Lab: Sidebar → Lab Sale to book tests; History for past bills; Inventory for reagents/consumables; Purchase for vendor bills.",
    ipd: "IPD: Admit from patient profile (set ward/bed). Doctors use Patient Records / IPD screens; Nurses use Nurse IPD panels when entitled. Discharge via patient Discharge flow.",
    opd: "OPD: Register patient as OP, create appointment or walk-in consultation. Doctors open Consultations / Prescription from the Doctor app.",
    prescription:
      "Doctors/Nurses: use Healeka AI chat to write or update a visit Rx in plain language (add/stop meds, labs, notes) — Confirm before save. Or open Consultation → Prescription screen / AI Write. Today's visit is reused automatically; say 'new visit' only if you need a separate prescription. Share via WhatsApp/public link when available.",
    expenses:
      "Accountant/Admin: Expenses module to log categories and amounts. Tax reports under Tax / Accounts for GST summaries.",
    staff:
      "HR/Admin: Staff Management for employees, attendance, shifts, and salaries. User credentials are managed under Staff / User management.",
    insurance:
      "Insurance: configure companies, tariffs, and exclusions under Insurance. Link patient payment method to insurance on registration.",
    inventory:
      "Pharmacy and Lab each have Inventory screens. Stock is batch-based; quantity is sum of batch quantities. Use Adjustments for corrections.",
  };

  let matched = null;
  for (const [key, text] of Object.entries(guides)) {
    if (topic.includes(key)) {
      matched = text;
      break;
    }
  }

  const roleTips = {
    Doctor:
      "As a Doctor you mainly use the mobile-style app: Home, Patients, Consultations, Patient Records, Profile.",
    Nurse:
      "As a Nurse you use Home, Patients, Consultations, Patient Records, and IPD nurse tools when enabled.",
    Receptionist:
      "As Receptionist focus on Dashboard, Patients, Appointments, and OP billing.",
    Pharmacist: "As Pharmacist focus on Pharmacy sale, purchase, inventory, and indents.",
    LabTechnician:
      "As LabTechnician focus on Lab sale, purchase, inventory, and test completion.",
    Phlebotomist: "As Phlebotomist focus on Lab sale and history / sample collection flows.",
    Accountant:
      "As Accountant focus on Expenses, Tax reports, Insurance, and Commission.",
    "HR Manager": "As HR Manager focus on Staff management and user access.",
    Admin: "As Admin you manage staff, stamps, and hospital settings.",
    SuperAdmin: "As SuperAdmin you have full hospital module access.",
    "IT Support": "As IT Support you manage users, stamps, and settings.",
    PRO: "As PRO you work with consultations, services, and commission.",
  };

  return {
    topic: args.topic,
    guide:
      matched ||
      "Ask about a specific area: appointments, pharmacy, lab, IPD, OPD, prescription, expenses, staff, insurance, or inventory.",
    roleTip: roleTips[role] || "",
    note: "For register/book/cancel/add-note/create-or-update-prescription, use prepare_* tools, collect required fields, then wait for user Confirm before execute_*. Prefer prepare_update_prescription when a visit already exists.",
  };
}

async function search_consultations(ctx, args) {
  const Consultation = ctx.tenantDb.model("Consultation");
  const q = String(args.query || "").trim();
  const limit = Math.min(Number(args.limit) || 15, MAX_ROWS);
  const since = daysAgoDate(args.days || 14);
  const rx = new RegExp(escapeRegex(q), "i");
  const rows = await Consultation.find({
    hospitalId: ctx.hospitalId,
    createdAt: { $gte: since },
    $or: [
      { patientName: rx },
      { patientPhone: rx },
      { patientId: q },
      { receiptId: rx },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return {
    count: rows.length,
    consultations: rows.map((c) => ({
      id: c._id,
      receiptId: c.receiptId,
      patientName: c.patientName,
      patientPhone: c.patientPhone,
      patientId: c.patientId,
      totalAmount: c.totalAmount,
      paymentStatus: c.paymentStatus,
      doctor: c.doctorData?.name || c.doctorData?.doctorName,
      createdAt: c.createdAt,
    })),
  };
}

async function search_receipts(ctx, args) {
  const q = String(args.query || "").trim();
  const kind = args.kind || "both";
  const limit = Math.min(Number(args.limit) || 10, MAX_ROWS);
  const since = daysAgoDate(args.days || 14);
  const rx = new RegExp(escapeRegex(q), "i");
  const filter = {
    hospitalId: ctx.hospitalId,
    createdAt: { $gte: since },
    $or: [
      { patientName: rx },
      { patientPhone: rx },
      { patientId: q },
      { receiptId: rx },
    ],
  };
  const out = { pharmacy: [], lab: [] };
  if (kind === "pharmacy" || kind === "both") {
    const PharmacyReceipt = ctx.tenantDb.model("PharmacyReceipt");
    out.pharmacy = await PharmacyReceipt.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select(
        "receiptId patientName patientPhone totalAmount paymentStatus type createdAt",
      )
      .lean();
  }
  if (kind === "lab" || kind === "both") {
    const DiagnosticsReceipt = ctx.tenantDb.model("DiagnosticsReceipt");
    out.lab = await DiagnosticsReceipt.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select(
        "receiptId patientName patientPhone totalAmount paymentStatus overallStatus createdAt",
      )
      .lean();
  }
  return out;
}

async function count_patients(ctx, args) {
  const Patient = ctx.tenantDb.model("Patient");
  const type = args.patient_type || "all";
  const filter = { hospitalId: ctx.hospitalId };
  if (args.activeOnly !== false) filter.active = { $ne: false };
  if (type === "OP") {
    filter.patient_type = { $in: ["OP", "op", "Outpatient"] };
  } else if (type === "IP") {
    filter.patient_type = { $in: ["IP", "ip", "Inpatient"] };
  }
  const count = await Patient.countDocuments(filter);
  return { patient_type: type, count, filterApplied: filter };
}

async function list_todays_op(ctx, args) {
  const Patient = ctx.tenantDb.model("Patient");
  const today = todayYmd();
  const limit = Math.min(Number(args.limit) || 25, PATIENT_LIMIT);
  const mineOnly =
    args.mineOnly === true ||
    (args.mineOnly !== false && ctx.role === "Doctor");

  const filter = {
    hospitalId: ctx.hospitalId,
    patient_type: { $in: ["OP", "op", "Outpatient"] },
    $or: [
      { registration_date: today },
      { appointment_date: today },
      { registration_date: { $regex: today } },
    ],
  };

  let doctorFilter = null;
  if (mineOnly && ctx.role === "Doctor") {
    const Staff = ctx.tenantDb.model("Staff");
    const me = await Staff.findById(ctx.staffMongoId)
      .select("id name")
      .lean();
    const doctorClauses = [];
    if (me?.id) doctorClauses.push({ doctorId: String(me.id) });
    if (me?.name) {
      doctorClauses.push({
        consultantDoctor: {
          $regex: escapeRegex(me.name),
          $options: "i",
        },
      });
    }
    if (ctx.userId) {
      doctorClauses.push({ doctorId: String(ctx.userId) });
    }
    if (doctorClauses.length) {
      doctorFilter = { $or: doctorClauses };
    }
  }

  const query = doctorFilter ? { $and: [filter, doctorFilter] } : filter;
  const rows = await Patient.find(query)
    .select(
      "UMRNo name gender age phone consultantDoctor doctorId registration_date appointment_date",
    )
    .sort({ registration_date: -1, name: 1 })
    .limit(limit)
    .lean();

  return {
    date: today,
    count: rows.length,
    mineOnly: Boolean(doctorFilter),
    patients: rows.map((p) => ({
      UMRNo: p.UMRNo,
      name: p.name,
      gender: p.gender,
      age: p.age,
      phone: p.phone,
      consultantDoctor: p.consultantDoctor,
      doctorId: p.doctorId,
      registration_date: p.registration_date,
      appointment_date: p.appointment_date,
    })),
  };
}

async function find_doctor_by_name(ctx, args) {
  const Staff = ctx.tenantDb.model("Staff");
  const q = String(args.query || "").trim();
  if (!q) return { doctors: [] };
  const doctors = await Staff.find({
    hospitalId: ctx.hospitalId,
    type: "Doctor",
    name: { $regex: escapeRegex(q), $options: "i" },
    active: { $ne: false },
  })
    .select("name specialization department phone email")
    .limit(10)
    .lean();
  return {
    doctors: doctors.map((d) => ({
      id: d._id,
      name: d.name,
      specialization: d.specialization,
      department: d.department,
      phone: d.phone,
    })),
  };
}

const HANDLERS = {
  search_patients,
  get_patient_summary,
  get_appointments,
  get_opd_ipd_census,
  search_pharmacy_inventory,
  search_lab_inventory,
  get_lab_sales,
  get_pharmacy_sales,
  get_expenses,
  get_staff_directory,
  get_insurance_info,
  search_master_catalog,
  explain_hms_howto,
  search_consultations,
  search_receipts,
  count_patients,
  list_todays_op,
  find_doctor_by_name,
  ...ACTION_HANDLERS,
};

async function executeTool(toolName, args, ctx) {
  if (!roleCanUseTool(ctx.role, toolName)) {
    return { error: `Tool ${toolName} is not allowed for role ${ctx.role}` };
  }
  const handler = HANDLERS[toolName];
  if (!handler) return { error: `Unknown tool: ${toolName}` };
  try {
    return await handler(ctx, args || {});
  } catch (err) {
    console.error(`[HealekaAgent] tool ${toolName} error:`, err.message);
    return { error: `Tool failed: ${err.message}` };
  }
}

module.exports = {
  ROLE_TOOL_ACCESS,
  getToolsForRole,
  roleCanUseTool,
  executeTool,
  CLINICAL_ROLES,
};
