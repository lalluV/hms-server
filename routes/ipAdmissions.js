const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const { admitPatient, updateEraChart } = require("../utils/admitPatient");

applyTenantEntitlements(router, { moduleKey: "core" });

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match admissions by wardId and/or ward name. */
function buildWardAdmissionFilter(wardId, wardName) {
  const or = [];
  const id = wardId && String(wardId).trim();
  const name = wardName && String(wardName).trim();
  if (id) or.push({ wardId: id });
  if (name) {
    or.push({
      wardName: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
    });
  }
  if (!or.length) return null;
  return or.length === 1 ? or[0] : { $or: or };
}

function normalizeWardName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function admissionRowMatchesWard(row, ward) {
  const rowId = row?.wardId && String(row.wardId).trim();
  const wardId = ward?.wardId && String(ward.wardId).trim();
  if (rowId && wardId && rowId === wardId) return true;
  const rowName = normalizeWardName(row?.wardName);
  const wardName = normalizeWardName(ward?.wardName);
  return Boolean(rowName && wardName && rowName === wardName);
}

async function buildStatusAdmissionCondition(status, hospitalId, Patient) {
  if (!status || status === "all") return null;
  if (status === "Admitted") {
    return { patient_status: "Admitted" };
  }
  if (status === "Discharged") {
    const dischargedPatients = await Patient.find({
      hospitalId,
      $or: [
        { patient_status: "Discharged" },
        {
          active: false,
          dischargeDate: { $exists: true, $nin: [null, ""] },
        },
      ],
    })
      .select("_id UMRNo")
      .lean();

    const patientIds = dischargedPatients.map((p) => p._id).filter(Boolean);
    const umrs = dischargedPatients.map((p) => p.UMRNo).filter(Boolean);

    const or = [{ patient_status: "Discharged" }];
    if (patientIds.length) {
      or.push({ patientId: { $in: patientIds } });
    }
    if (umrs.length) {
      or.push({ UMRNo: { $in: umrs } });
    }
    return { $or: or };
  }
  return { patient_status: status };
}

/** Active census count — excludes stale Admitted rows for discharged patients. */
async function countActiveCensusAdmissions(IPAdmission, Patient, filter) {
  const patientCollection = Patient.collection.name;
  const result = await IPAdmission.aggregate([
    { $match: filter },
    {
      $lookup: {
        from: patientCollection,
        localField: "patientId",
        foreignField: "_id",
        as: "_patientDoc",
      },
    },
    {
      $addFields: {
        _patient: { $arrayElemAt: ["$_patientDoc", 0] },
      },
    },
    {
      $match: {
        patient_status: "Admitted",
        $nor: [
          { "_patient.active": false },
          { "_patient.patient_status": "Discharged" },
        ],
      },
    },
    { $count: "total" },
  ]);
  return result[0]?.total ?? 0;
}

async function appendDoctorAdmissionScope(req, Patient, andConditions) {
  const {
    resolveRequestDoctorIds,
    isDoctorRole,
  } = require("../utils/doctorPatientAccess");
  if (!isDoctorRole(req)) return;
  const doctorIds = await resolveRequestDoctorIds(req);
  if (!doctorIds.length) return;
  const assignedPatients = await Patient.find({
    hospitalId: req.hospitalId,
    doctorId: { $in: doctorIds },
  })
    .select("_id")
    .lean();
  const assignedIds = assignedPatients.map((p) => p._id);
  andConditions.push({
    $or: [
      { doctorId: { $in: doctorIds } },
      ...(assignedIds.length ? [{ patientId: { $in: assignedIds } }] : []),
    ],
  });
}

/**
 * POST /api/ip-admissions
 * Admit a patient to Inpatient (Ward/Bed)
 */
router.post("/", async (req, res) => {
  try {
    const result = await admitPatient({
      tenantDb: req.tenantDb,
      hospitalId: req.hospitalId,
      body: req.body,
    });
    return res.status(result.httpStatus).json(result.payload);
  } catch (error) {
    console.error("Error creating IP admission:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * GET /api/ip-admissions
 * IPD roster — one row per IPAdmission stay, with optional patient enrichment.
 * Query: page, limit, search, fromDate, toDate, status (Admitted|Discharged|all)
 */
router.get("/", async (req, res) => {
  try {
    const IPAdmission = req.tenantDb.model("IPAdmission");
    const Patient = req.tenantDb.model("Patient");
    const {
      page = 1,
      limit = 20,
      search = "",
      fromDate = "",
      toDate = "",
      status = "Admitted",
      wardId = "",
      wardName = "",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const andConditions = [{ hospitalId: req.hospitalId }];

    const statusCondition = await buildStatusAdmissionCondition(
      status,
      req.hospitalId,
      Patient,
    );
    if (statusCondition) {
      andConditions.push(statusCondition);
    }

    const wardFilter = buildWardAdmissionFilter(wardId, wardName);
    if (wardFilter) {
      andConditions.push(wardFilter);
    }

    if (fromDate || toDate) {
      const start = fromDate ? String(fromDate).slice(0, 10) : null;
      const end = toDate ? String(toDate).slice(0, 10) : null;
      const dateRange = {};
      if (start) dateRange.$gte = start;
      if (end) dateRange.$lte = end;
      if (Object.keys(dateRange).length) {
        andConditions.push({ admissionDate: dateRange });
      }
    }

    if (search && String(search).trim().length >= 2) {
      const term = String(search).trim();
      andConditions.push({
        $or: [
          { UMRNo: { $regex: term, $options: "i" } },
          { patientName: { $regex: term, $options: "i" } },
          { ipNumber: { $regex: term, $options: "i" } },
          { wardName: { $regex: term, $options: "i" } },
          { selectedBed: { $regex: term, $options: "i" } },
          { consultantDoctor: { $regex: term, $options: "i" } },
        ],
      });
    }

    await appendDoctorAdmissionScope(req, Patient, andConditions);

    const filter =
      andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

    const sort =
      status === "Discharged"
        ? {
            dischargeDate: -1,
            dischargedAt: -1,
            admissionDate: -1,
            createdAt: -1,
          }
        : { admissionDate: -1, createdAt: -1 };

    const admissionsPromise = IPAdmission.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limitNum)
      .lean();

    const totalPromise =
      status === "Admitted"
        ? countActiveCensusAdmissions(IPAdmission, Patient, filter)
        : IPAdmission.countDocuments(filter);

    const [total, admissions] = await Promise.all([
      totalPromise,
      admissionsPromise,
    ]);

    const patientIds = [
      ...new Set(
        admissions
          .map((a) => a.patientId)
          .filter(Boolean)
          .map((id) => String(id)),
      ),
    ]
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const patients = patientIds.length
      ? await Patient.find({
          hospitalId: req.hospitalId,
          _id: { $in: patientIds },
        })
          .select(
            "name age gender phone UMRNo allergiesHistory paymentMethod insurance_provider",
          )
          .lean()
      : [];
    const legacyFlags = patientIds.length
      ? await Patient.collection
          .find(
            { _id: { $in: patientIds } },
            { projection: { active: 1, patient_status: 1 } },
          )
          .toArray()
      : [];
    const legacyMap = new Map(
      legacyFlags.map((row) => [String(row._id), row]),
    );

    const patientMap = new Map(patients.map((p) => [String(p._id), p]));

    const rows = admissions
      .map((admission) => {
        const patient =
          patientMap.get(String(admission.patientId || "")) || null;
        const legacy = legacyMap.get(String(admission.patientId || "")) || null;
        const legacyDischarged =
          legacy?.patient_status === "Discharged" || legacy?.active === false;
        const resolvedStatus =
          admission.patient_status === "Discharged" ||
          (admission.patient_status === "Admitted" && legacyDischarged)
            ? "Discharged"
            : admission.patient_status;

        return {
          ...admission,
          name: patient?.name || admission.patientName || "",
          age: patient?.age,
          gender: patient?.gender,
          phone: patient?.phone,
          allergiesHistory: patient?.allergiesHistory || "",
          paymentMethod: admission.paymentMethod || patient?.paymentMethod,
          insurance_provider:
            admission.insurance_provider || patient?.insurance_provider,
          patient_status: resolvedStatus,
          dischargedAt: admission.dischargedAt || "",
          active: resolvedStatus === "Admitted",
          patient_type: "IP",
          admissionId: admission._id,
          _legacyDischarged: legacyDischarged,
        };
      })
      .filter((row) => {
        if (status === "Discharged") {
          if (row.patient_status === "Discharged") return true;
          return false;
        }
        if (status !== "Admitted") return true;
        if (row.patient_status !== "Admitted") return false;
        if (row._legacyDischarged) return false;
        return true;
      })
      .map(({ _legacyDischarged, ...row }) => row);

    res.json({
      admissions: rows,
      patients: rows,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
        totalItems: total,
        itemsPerPage: limitNum,
        hasNextPage: pageNum * limitNum < total,
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    console.error("Error fetching IP admissions list:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * GET /api/ip-admissions/ward-patient-counts
 * Inpatient count per ward (IPAdmission rows only; matches roster filters).
 */
router.get("/ward-patient-counts", async (req, res) => {
  try {
    const IPAdmission = req.tenantDb.model("IPAdmission");
    const Patient = req.tenantDb.model("Patient");
    const Ward = req.tenantDb.model("Ward");
    const status = req.query.status || "Admitted";

    const andConditions = [{ hospitalId: req.hospitalId }];
    const statusCondition = await buildStatusAdmissionCondition(
      status,
      req.hospitalId,
      Patient,
    );
    if (statusCondition) {
      andConditions.push(statusCondition);
    }
    await appendDoctorAdmissionScope(req, Patient, andConditions);

    const filter =
      andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

    const admissionRows = await IPAdmission.find(filter)
      .select("wardId wardName patientId patient_status")
      .lean();

    let roster = [];
    if (admissionRows.length) {
      const patientIds = [
        ...new Set(
          admissionRows
            .map((a) => a.patientId)
            .filter(Boolean)
            .filter((pid) => mongoose.Types.ObjectId.isValid(String(pid)))
            .map((pid) => new mongoose.Types.ObjectId(String(pid))),
        ),
      ];
      const patients = patientIds.length
        ? await Patient.find({
            hospitalId: req.hospitalId,
            _id: { $in: patientIds },
          })
            .select("_id active patient_status")
            .lean()
        : [];
      const patientById = new Map(patients.map((p) => [String(p._id), p]));

      roster = admissionRows
        .filter((row) => {
          if (status !== "Admitted") return true;
          if (row.patient_status !== "Admitted") return false;
          const patient = patientById.get(String(row.patientId || ""));
          if (patient?.active === false) return false;
          if (patient?.patient_status === "Discharged") return false;
          return true;
        })
        .map((row) => ({
          wardId: row.wardId,
          wardName: row.wardName,
        }));
    }

    const wards = await Ward.find({
      hospitalId: req.hospitalId,
      status: { $ne: "inactive" },
    })
      .select("wardId wardName")
      .lean();

    const wardCounts = wards.map((ward) => ({
      wardId: ward.wardId,
      wardName: ward.wardName,
      count: roster.filter((row) => admissionRowMatchesWard(row, ward)).length,
    }));

    res.json({
      total: roster.length,
      wardCounts,
    });
  } catch (error) {
    console.error("Error fetching ward patient counts:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * GET /api/ip-admissions/active
 * Get all active Inpatient admissions (Live Bed Board)
 */
router.get("/active", async (req, res) => {
  try {
    const IPAdmission = req.tenantDb.model("IPAdmission");
    const admissions = await IPAdmission.find({
      hospitalId: req.hospitalId,
      patient_status: "Admitted",
    })
      .sort({ admissionDate: -1, createdAt: -1 })
      .lean();

    res.json(admissions);
  } catch (error) {
    console.error("Error fetching active admissions:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * GET /api/ip-admissions/patient/:patientId
 * Get complete admission history for a specific patient
 */
router.get("/patient/:patientId", async (req, res) => {
  try {
    const IPAdmission = req.tenantDb.model("IPAdmission");
    const Patient = req.tenantDb.model("Patient");
    const { patientId } = req.params;

    let patient = null;
    if (mongoose.Types.ObjectId.isValid(patientId)) {
      patient = await Patient.findOne({
        _id: patientId,
        hospitalId: req.hospitalId,
      }).lean();
    }
    if (!patient) {
      patient = await Patient.findOne({
        UMRNo: patientId,
        hospitalId: req.hospitalId,
      }).lean();
    }

    if (!patient) {
      const directList = await IPAdmission.find({
        hospitalId: req.hospitalId,
        $or: [
          ...(mongoose.Types.ObjectId.isValid(patientId)
            ? [{ _id: patientId }, { patientId }]
            : []),
          { ipNumber: patientId },
          { UMRNo: patientId },
        ],
      })
        .sort({ admissionDate: -1, createdAt: -1 })
        .lean();

      if (directList && directList.length > 0) {
        return res.json(directList);
      }

      return res.status(404).json({ message: "Patient not found" });
    }

    const admissions = await IPAdmission.find({
      hospitalId: req.hospitalId,
      $or: [{ patientId: patient._id }, { UMRNo: patient.UMRNo }],
    })
      .sort({ admissionDate: -1, createdAt: -1 })
      .lean();

    res.json(admissions);
  } catch (error) {
    console.error("Error fetching patient admission history:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * GET /api/ip-admissions/:id
 * Get single admission record with all charts and vitals
 */
router.get("/:id", async (req, res) => {
  try {
    const IPAdmission = req.tenantDb.model("IPAdmission");
    const { id } = req.params;

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { ipNumber: id }], hospitalId: req.hospitalId }
      : { ipNumber: id, hospitalId: req.hospitalId };

    const admission = await IPAdmission.findOne(query).lean();
    if (!admission) {
      return res.status(404).json({ message: "Admission record not found" });
    }

    res.json(admission);
  } catch (error) {
    console.error("Error fetching admission:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * PUT /api/ip-admissions/:id
 * Update clinical stay charts. Discharge fields and the ERA casualty
 * snapshots are not accepted here.
 */
const STAY_PATCH_KEYS = [
  "mlcNo",
  "consultantDoctor",
  "doctorId",
  "medicalOfficerName",
  "medicalOfficerId",
  "patientRepresentiveOfficer",
  "consultantHistory",
  "wardName",
  "wardId",
  "selectedBed",
  "transfers",
  "chiefComplaintsPresentIllnessHistory",
  "consciousness",
  "gcs",
  "pupils",
  "height",
  "weight",
  "systemicExamination",
  "provisionalDiagnosis",
  "vitals",
  "doctorNotes",
  "nurseNotes",
  "insulinChart",
  "investigations",
  "procedures",
  "treatment",
  "otNotes",
  "surgeryNotes",
  "paymentMethod",
  "insurance_provider",
  "insurance_providerId",
  "policy_number",
  "coPayPercentage",
  "coPayLimit",
  "coPayType",
  "coverage",
  "expiry_date",
  "claimNumber",
  "preAuthAmount",
  "approvedAmount",
  "commissionEarnerType",
  "commissionEarnerId",
  "commissionEarnerName",
  "commissionRates",
  "finalBillAmount",
  "discount",
  "insurance",
  "paymentStatus",
];

/**
 * PUT /api/ip-admissions/:id/era
 * Save an edited ER form onto this stay. Does not open a second admission.
 */
router.put("/:id/era", async (req, res) => {
  try {
    const result = await updateEraChart({
      tenantDb: req.tenantDb,
      hospitalId: req.hospitalId,
      admissionId: req.params.id,
      body: req.body,
    });
    res.status(result.httpStatus).json(result.payload);
  } catch (error) {
    console.error("Error updating ER assessment:", error);
    res.status(500).json({ message: error.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const IPAdmission = req.tenantDb.model("IPAdmission");
    const { id } = req.params;
    const patch = {};
    for (const key of STAY_PATCH_KEYS) {
      if (req.body?.[key] !== undefined) patch[key] = req.body[key];
    }

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { ipNumber: id }], hospitalId: req.hospitalId }
      : { ipNumber: id, hospitalId: req.hospitalId };

    const updated = await IPAdmission.findOneAndUpdate(
      query,
      {
        $set: patch,
        $unset: {
          repeatLabs: "",
          summarySections: "",
          dischargeMedications: "",
          counselling: "",
        },
      },
      { new: true },
    );

    if (!updated) {
      return res.status(404).json({ message: "Admission record not found" });
    }

    res.json(updated);
  } catch (error) {
    console.error("Error updating admission:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * POST /api/ip-admissions/:id/transfer-bed
 * Log bed/ward transfer
 */
router.post("/:id/transfer-bed", async (req, res) => {
  try {
    const IPAdmission = req.tenantDb.model("IPAdmission");
    const { id } = req.params;
    const { toWardId, toWardName, toBed, price, transferDate } = req.body;

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { ipNumber: id }], hospitalId: req.hospitalId }
      : { ipNumber: id, hospitalId: req.hospitalId };

    const admission = await IPAdmission.findOne(query);
    if (!admission) {
      return res.status(404).json({ message: "Admission record not found" });
    }

    const transferEntry = {
      wardId: toWardId,
      wardName: toWardName,
      price: Number(price || 0),
      transferDate: transferDate || new Date().toISOString().split("T")[0],
    };

    admission.transfers.push(transferEntry);
    admission.wardId = toWardId;
    admission.wardName = toWardName;
    admission.selectedBed = toBed;

    await admission.save();

    res.json(admission);
  } catch (error) {
    console.error("Error logging bed transfer:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * POST /api/ip-admissions/:id/discharge
 * Discharge patient, save discharge summary, finalize billing, and release bed
 */
router.post("/:id/discharge", async (req, res) => {
  try {
    const IPAdmission = req.tenantDb.model("IPAdmission");
    const Patient = req.tenantDb.model("Patient");
    const { id } = req.params;

    const {
      dischargeDate = new Date().toISOString().split("T")[0],
      dischargedAt = new Date().toISOString(),
      dischargeCondition = "Stable",
      dischargeTo = "Home",
      dischargeDestination,
      finalDiagnosis,
      dischargeInstructions,
      followUpPlan,
      dischargeMedications,
      dischargeSummary,
      dischargeSummaryType = "standard",
      counselling,
      finalBillAmount,
      discount = 0,
      insurance = 0,
      paymentStatus = "settled",
    } = req.body;

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { ipNumber: id }], hospitalId: req.hospitalId }
      : { ipNumber: id, hospitalId: req.hospitalId };

    const admission = await IPAdmission.findOne(query);
    if (!admission) {
      return res.status(404).json({ message: "Admission record not found" });
    }

    const DischargeSummary = req.tenantDb.model("DischargeSummary");

    admission.patient_status = "Discharged";
    admission.dischargedAt = dischargedAt;
    admission.finalBillAmount = finalBillAmount ?? admission.finalBillAmount;
    admission.discount = discount;
    admission.insurance = insurance;
    admission.paymentStatus = paymentStatus;
    await admission.save();

    const summary = await DischargeSummary.findOneAndUpdate(
      { hospitalId: req.hospitalId, admissionId: admission._id },
      {
        $set: {
          hospitalId: req.hospitalId,
          patientId: admission.patientId,
          admissionId: admission._id,
          ipNumber: admission.ipNumber,
          UMRNo: admission.UMRNo,
          admissionDate: admission.admissionDate,
          dischargeDate,
          dischargeTime: req.body.dischargeTime || "",
          lengthOfStay: req.body.lengthOfStay,
          dischargeCondition,
          dischargeDestination: dischargeDestination || dischargeTo,
          dischargeTo,
          finalDiagnosis: finalDiagnosis || "",
          hospitalCourse: req.body.hospitalCourse || "",
          dischargeInstructions: dischargeInstructions || "",
          dangerSigns: req.body.dangerSigns || "",
          followUpPlan: followUpPlan || "",
          counselling: counselling || "",
          summarySections: req.body.summarySections || [],
          dischargeMedications: dischargeMedications || [],
          repeatLabs: req.body.repeatLabs || [],
          procedures: req.body.procedures || [],
          summary: dischargeSummary || "",
          summaryType: dischargeSummaryType,
          dischargeSummaryStatus: req.body.dischargeSummaryStatus || "draft",
          dischargeSummaryMeta: req.body.dischargeSummaryMeta || null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    const patient = await Patient.findById(admission.patientId);
    const { presentPatient } = require("../utils/patientFields");

    res.json({
      message: "Patient discharged successfully",
      admission,
      dischargeSummary: summary,
      patient: patient
        ? presentPatient(patient, { roster: "discharged" })
        : null,
    });
  } catch (error) {
    console.error("Error discharging patient:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
