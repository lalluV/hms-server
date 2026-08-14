const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const { getTenantConnection } = require("../utils/tenantDb");
const Hospital = require("../models/Hospital");
const {
  createPrescriptionToken,
  verifyPrescriptionToken,
} = require("../utils/prescriptionToken");
const {
  sendPrescriptionWhatsApp,
  mapWhatsAppHttpError,
} = require("../utils/whatsappCloud");

function slimDosage(dose = {}) {
  return {
    time: dose.time || "",
    amount: dose.amount,
    unit: dose.unit || "",
    beforeFood: Boolean(dose.beforeFood),
  };
}

function slimMedicine(med = {}) {
  return {
    lineId: med.lineId,
    item_code: med.item_code,
    name: med.name || med.medicine_name,
    medicine_name: med.medicine_name || med.name,
    description: med.description,
    correctedName: med.correctedName,
    type: med.type,
    generic_name: med.generic_name,
    dosage: med.dosage,
    timing: med.timing,
    frequency: med.frequency,
    duration: med.duration,
    durationText: med.durationText,
    quantity: med.quantity,
    dosages: Array.isArray(med.dosages) ? med.dosages.map(slimDosage) : [],
    patientDirections: med.patientDirections,
    directions: med.directions,
    instructions: med.instructions,
    route: med.route || "Oral",
    sequenceGroup: med.sequenceGroup,
    sequenceIndex: med.sequenceIndex,
    sequenceLabel: med.sequenceLabel,
  };
}

function buildPublicPatient(patient) {
  return {
    name: patient.name,
    age: patient.age,
    gender: patient.gender,
    UMRNo: patient.UMRNo,
    phone: patient.phone,
    pastMedicalHistory: patient.pastMedicalHistory || "",
    allergiesHistory: patient.allergiesHistory || "",
  };
}

function buildPublicHospital(hospital) {
  if (!hospital) return null;
  return {
    name: hospital.name,
    address: hospital.address,
    city: hospital.city,
    state: hospital.state,
    zipCode: hospital.zipCode,
    phone: hospital.phone,
    logoUrl: hospital.logoUrl,
  };
}

function buildPublicPrescription(prescription) {
  if (!prescription) return null;
  const vitals = Array.isArray(prescription.vitals)
    ? prescription.vitals.map((v) => ({
        time: v.time,
        temperature: v.temperature,
        heartRate: v.heartRate,
        bloodPressure: v.bloodPressure,
        spo2: v.spo2,
      }))
    : [];
  const doctorNotes = Array.isArray(prescription.doctorNotes)
    ? prescription.doctorNotes.map((n) => ({ content: n?.content || "" }))
    : [];
  const diagnosticData = Array.isArray(prescription.diagnosticData)
    ? prescription.diagnosticData.map((t) => ({ name: t?.name || "" }))
    : [];
  const medicineData = Array.isArray(prescription.medicineData)
    ? prescription.medicineData.map(slimMedicine)
    : [];

  return {
    prescriptionId: prescription.prescriptionId,
    date: prescription.date,
    doctorId: prescription.doctorId,
    symptoms: prescription.symptoms || "",
    pastMedicalHistory: prescription.pastMedicalHistory || "",
    allergiesHistory: prescription.allergiesHistory || "",
    provisionalDiagnosis: prescription.provisionalDiagnosis || "",
    weight: prescription.weight,
    height: prescription.height,
    vitals,
    doctorNotes,
    diagnosticData,
    medicineData,
  };
}

/**
 * PUBLIC (no auth): view a prescription via a signed token.
 * Defined BEFORE applyTenantEntitlements so the auth middleware does not apply.
 * GET /api/prescriptions/public/:token
 */
router.get("/public/:token", async (req, res) => {
  try {
    let decoded;
    try {
      decoded = verifyPrescriptionToken(req.params.token);
    } catch (err) {
      return res.status(400).json({ message: "Invalid or expired link." });
    }

    const { hospitalId, patientId, prescriptionId } = decoded;

    if (!mongoose.Types.ObjectId.isValid(hospitalId)) {
      return res.status(400).json({ message: "Invalid or expired link." });
    }
    const hospitalObjectId = new mongoose.Types.ObjectId(hospitalId);

    const connection = await getTenantConnection(hospitalId);
    if (!connection) {
      return res.status(500).json({ message: "Unable to load prescription." });
    }

    const Prescription = connection.model("Prescription");
    const Patient = connection.model("Patient");
    const Staff = connection.model("Staff");
    const rxId = String(prescriptionId);

    // 1. Try fetching directly from standalone Prescription collection
    let prescription = await Prescription.findOne({
      hospitalId: hospitalObjectId,
      prescriptionId: rxId,
    }).lean();

    let patientDoc = null;

    if (prescription) {
      patientDoc = await Patient.findById(prescription.patientId)
        .select(
          "name age gender UMRNo phone allergiesHistory pastMedicalHistory",
        )
        .lean();
    } else {
      // 2. Legacy fallback: query embedded array in Patient
      const [patientRow] = await Patient.aggregate([
        { $match: { UMRNo: patientId, hospitalId: hospitalObjectId } },
        {
          $project: {
            name: 1,
            age: 1,
            gender: 1,
            UMRNo: 1,
            phone: 1,
            allergiesHistory: 1,
            pastMedicalHistory: 1,
            prescriptionsMeta: {
              $map: {
                input: { $ifNull: ["$prescriptions", []] },
                as: "p",
                in: {
                  prescriptionId: "$$p.prescriptionId",
                  date: "$$p.date",
                },
              },
            },
            prescription: {
              $first: {
                $filter: {
                  input: { $ifNull: ["$prescriptions", []] },
                  as: "p",
                  cond: {
                    $eq: [{ $toString: "$$p.prescriptionId" }, rxId],
                  },
                },
              },
            },
          },
        },
      ]);

      if (patientRow && patientRow.prescription) {
        prescription = patientRow.prescription;
        patientDoc = patientRow;
      }
    }

    if (!prescription || !patientDoc) {
      return res.status(404).json({ message: "Prescription not found." });
    }

    const doctorPromise = prescription.doctorId
      ? Staff.findOne(
          { id: prescription.doctorId },
          { name: 1, qualification: 1, specialization: 1, id: 1, signatureUrl: 1 },
        )
          .lean()
          .catch(() => null)
      : Promise.resolve(null);

    const hospitalPromise = Hospital.findById(hospitalId)
      .select("name address city state zipCode phone logoUrl")
      .lean();

    const Stamp = connection.model("Stamp");
    const stampsPromise = Stamp.find({ isActive: true }).lean().catch(() => []);

    const [doctorDoc, hospital, stamps] = await Promise.all([
      doctorPromise,
      hospitalPromise,
      stampsPromise,
    ]);

    const doctor = doctorDoc
      ? {
          name: doctorDoc.name,
          qualification: doctorDoc.qualification,
          specialization: doctorDoc.specialization,
          signatureUrl: doctorDoc.signatureUrl || null,
        }
      : null;

    const departmentStamp =
      (stamps || []).find((s) => (s.department === "OPD" || s.department === "Consultation") && s.isDefault) ||
      (stamps || []).find((s) => s.department === "OPD" || s.department === "Consultation") ||
      null;

    const hospitalStamp =
      (stamps || []).find((s) => s.category === "hospital" && s.isDefault) ||
      (stamps || []).find((s) => s.category === "hospital") ||
      null;

    return res.json({
      hospital: buildPublicHospital(hospital),
      doctor,
      patient: buildPublicPatient(patientDoc),
      prescription: buildPublicPrescription(prescription),
      departmentStamp: departmentStamp
        ? { imageUrl: departmentStamp.imageUrl, name: departmentStamp.name }
        : null,
      hospitalStamp: hospitalStamp
        ? { imageUrl: hospitalStamp.imageUrl, name: hospitalStamp.name }
        : null,
    });
  } catch (error) {
    console.error("Public prescription view error:", error);
    return res.status(500).json({ message: "Unable to load prescription." });
  }
});

// Everything below requires authentication + active subscription + tenant DB
applyTenantEntitlements(router, { moduleKey: "core" });

const {
  resolveRequestDoctorIds,
  isDoctorRole,
} = require("../utils/doctorPatientAccess");

function buildDateStringRange(fromDate, toDate) {
  const start = fromDate ? String(fromDate).slice(0, 10) : null;
  const end = toDate ? String(toDate).slice(0, 10) : null;
  if (!start && !end) return null;
  const range = {};
  if (start) range.$gte = start;
  // Covers both "yyyy-MM-dd" and full ISO timestamps for the end day
  if (end) range.$lte = `${end}T23:59:59.999Z`;
  return range;
}

function enrichQueueRow(rx, patientMap) {
  const patient =
    patientMap.get(String(rx.patientId || "")) ||
    patientMap.get(String(rx.UMRNo || "")) ||
    null;

  return {
    ...rx,
    patientId: rx.patientId,
    UMRNo: rx.UMRNo || patient?.UMRNo || "",
    name: patient?.name || rx.patientName || "",
    age: patient?.age,
    gender: patient?.gender,
    phone: patient?.phone,
    allergiesHistory: patient?.allergiesHistory || "",
    pastMedicalHistory: patient?.pastMedicalHistory || "",
    paymentMethod: rx.paymentMethod || patient?.paymentMethod || "Personal",
    insurance_provider: rx.insurance_provider || patient?.insurance_provider,
    patient_type: patient?.patient_type || "OP",
    active: patient?.active !== false,
    registration_date: patient?.registration_date,
    consultantDoctor: rx.consultantDoctor || rx.doctorName || "",
    visitDate: rx.date,
    prescriptionId: rx.prescriptionId,
  };
}

/**
 * GET /api/prescriptions/queue
 * OPD visit queue — one row per Prescription (visit), joined with patient master.
 * Query: page, limit, search, fromDate, toDate, doctorId
 */
router.get("/queue", async (req, res) => {
  try {
    const Prescription = req.tenantDb.model("Prescription");
    const Patient = req.tenantDb.model("Patient");
    const {
      page = 1,
      limit = 20,
      search = "",
      fromDate = "",
      toDate = "",
      doctorId = "",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const andConditions = [{ hospitalId: req.hospitalId }];

    const dateRange = buildDateStringRange(fromDate, toDate);
    if (dateRange) {
      andConditions.push({ date: dateRange });
    }

    if (doctorId) {
      andConditions.push({ doctorId: String(doctorId) });
    } else if (isDoctorRole(req)) {
      const doctorIds = await resolveRequestDoctorIds(req);
      if (doctorIds.length) {
        andConditions.push({ doctorId: { $in: doctorIds } });
      }
    }

    if (search && String(search).trim().length >= 2) {
      const term = String(search).trim();
      const patientMatches = await Patient.find({
        hospitalId: req.hospitalId,
        $or: [
          { UMRNo: { $regex: term, $options: "i" } },
          { name: { $regex: term, $options: "i" } },
          { phone: { $regex: term, $options: "i" } },
        ],
      })
        .select("_id UMRNo")
        .lean();

      const patientIds = patientMatches.map((p) => p._id);
      const umrNos = patientMatches.map((p) => p.UMRNo).filter(Boolean);

      andConditions.push({
        $or: [
          { UMRNo: { $regex: term, $options: "i" } },
          { prescriptionId: { $regex: term, $options: "i" } },
          ...(patientIds.length ? [{ patientId: { $in: patientIds } }] : []),
          ...(umrNos.length ? [{ UMRNo: { $in: umrNos } }] : []),
        ],
      });
    }

    const filter =
      andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

    const [total, prescriptions] = await Promise.all([
      Prescription.countDocuments(filter),
      Prescription.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
    ]);

    const patientIdSet = new Set();
    const umrSet = new Set();
    for (const rx of prescriptions) {
      if (rx.patientId) patientIdSet.add(String(rx.patientId));
      if (rx.UMRNo) umrSet.add(String(rx.UMRNo));
    }

    const patients = await Patient.find({
      hospitalId: req.hospitalId,
      $or: [
        ...(patientIdSet.size
          ? [
              {
                _id: {
                  $in: [...patientIdSet]
                    .filter((id) => mongoose.Types.ObjectId.isValid(id))
                    .map((id) => new mongoose.Types.ObjectId(id)),
                },
              },
            ]
          : []),
        ...(umrSet.size ? [{ UMRNo: { $in: [...umrSet] } }] : []),
      ],
    })
      .select(
        "name age gender phone UMRNo allergiesHistory pastMedicalHistory paymentMethod insurance_provider patient_type active registration_date",
      )
      .lean();

    const patientMap = new Map();
    for (const p of patients) {
      patientMap.set(String(p._id), p);
      if (p.UMRNo) patientMap.set(String(p.UMRNo), p);
    }

    const rows = prescriptions.map((rx) =>
      enrichQueueRow(rx, patientMap),
    );

    res.json({
      visits: rows,
      prescriptions: rows,
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
    console.error("Error fetching OPD prescription queue:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * POST /api/prescriptions/check-in
 * Create today's OP visit for an existing patient (returning patient / front-desk check-in).
 * Idempotent for same patient+doctor+day when reuseToday=true (default).
 */
router.post("/check-in", async (req, res) => {
  try {
    const Prescription = req.tenantDb.model("Prescription");
    const Patient = req.tenantDb.model("Patient");
    const {
      patientId,
      UMRNo,
      doctorId,
      doctorName,
      consultantDoctor,
      reuseToday = true,
    } = req.body || {};

    let patient = null;
    if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
      patient = await Patient.findOne({
        _id: patientId,
        hospitalId: req.hospitalId,
      });
    }
    if (!patient && UMRNo) {
      patient = await Patient.findOne({
        UMRNo,
        hospitalId: req.hospitalId,
      });
    }
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    let resolvedDoctorId = doctorId || "";
    let resolvedDoctorName = consultantDoctor || doctorName || "";

    if (isDoctorRole(req) && !resolvedDoctorId) {
      const ids = await resolveRequestDoctorIds(req);
      resolvedDoctorId = ids[0] || req.user?.id || "";
      resolvedDoctorName = resolvedDoctorName || req.user?.name || "";
    }

    if (!resolvedDoctorId) {
      resolvedDoctorId = patient.doctorId || "";
      resolvedDoctorName =
        resolvedDoctorName || patient.consultantDoctor || "";
    }

    if (!resolvedDoctorId) {
      return res.status(400).json({
        message: "doctorId is required to check in an OP visit",
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const dateRange = buildDateStringRange(today, today);

    if (reuseToday) {
      const existing = await Prescription.findOne({
        hospitalId: req.hospitalId,
        $or: [{ patientId: patient._id }, { UMRNo: patient.UMRNo }],
        doctorId: String(resolvedDoctorId),
        date: dateRange,
      })
        .sort({ createdAt: -1 })
        .lean();

      if (existing) {
        return res.json({
          message: "Today's visit already exists",
          created: false,
          prescription: existing,
          patient,
        });
      }
    }

    const prescriptionId = `RX-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const prescriptionDoc = new Prescription({
      prescriptionId,
      hospitalId: req.hospitalId,
      patientId: patient._id,
      UMRNo: patient.UMRNo,
      doctorId: String(resolvedDoctorId),
      doctorName: resolvedDoctorName,
      consultantDoctor: resolvedDoctorName,
      date: new Date().toISOString().split("T")[0],
      symptoms: "",
      provisionalDiagnosis: "",
      vitals: [],
      doctorNotes: [],
      nurseNotes: [],
      diagnosticData: [],
      medicineData: [],
      paymentMethod: patient.paymentMethod || "Personal",
      insurance_provider: patient.insurance_provider,
      insurance_providerId: patient.insurance_providerId,
      policy_number: patient.policy_number,
      pharmacyStatus: "pending",
    });
    await prescriptionDoc.save();

    // Keep patient marked OP/active for queue visibility on master registry
    if (patient.patient_type !== "IP" && patient.patient_type !== "OPtoIP") {
      patient.patient_type = "OP";
      patient.active = true;
      if (resolvedDoctorId) patient.doctorId = String(resolvedDoctorId);
      if (resolvedDoctorName) patient.consultantDoctor = resolvedDoctorName;
      await patient.save();
    }

    res.status(201).json({
      message: "Patient checked in for today's OP visit",
      created: true,
      prescription: prescriptionDoc.toObject(),
      patient,
    });
  } catch (error) {
    console.error("Error checking in OP visit:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * GET /api/prescriptions
 * List prescriptions (e.g. for pharmacy queue, status filter)
 */
router.get("/", async (req, res) => {
  try {
    const Prescription = req.tenantDb.model("Prescription");
    const { status, doctorId, date, limit = 50, skip = 0 } = req.query;

    const filter = { hospitalId: req.hospitalId };
    if (status) filter.pharmacyStatus = status;
    if (doctorId) filter.doctorId = doctorId;
    if (date) filter.date = date;

    const prescriptions = await Prescription.find(filter)
      .sort({ createdAt: -1 })
      .skip(Number(skip))
      .limit(Number(limit))
      .lean();

    res.json(prescriptions);
  } catch (error) {
    console.error("Error fetching prescriptions:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * GET /api/prescriptions/patient/:patientId
 * Get all prescriptions for a specific patient (by UMRNo or _id)
 */
router.get("/patient/:patientId", async (req, res) => {
  try {
    const Prescription = req.tenantDb.model("Prescription");
    const Patient = req.tenantDb.model("Patient");
    const { patientId } = req.params;

    // Search by ObjectId or UMRNo
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

    // Build query clauses for patient
    const orClauses = [{ UMRNo: patientId }];
    if (mongoose.Types.ObjectId.isValid(patientId)) {
      orClauses.push({ patientId: new mongoose.Types.ObjectId(patientId) });
    }
    if (patient) {
      orClauses.push({ patientId: patient._id });
      if (patient.UMRNo) orClauses.push({ UMRNo: patient.UMRNo });
    }

    // 1. Fetch from standalone Prescription collection
    let prescriptions = await Prescription.find({
      hospitalId: req.hospitalId,
      $or: orClauses,
    })
      .sort({ createdAt: -1 })
      .lean();

    // 2. Include any legacy embedded prescriptions from Patient document if not already in standalone
    if (patient && Array.isArray(patient.prescriptions) && patient.prescriptions.length > 0) {
      const existingIds = new Set(
        prescriptions.map((p) => String(p.prescriptionId || p._id || "")),
      );
      for (const embedded of patient.prescriptions) {
        const eid = String(embedded.prescriptionId || embedded._id || "");
        if (eid && !existingIds.has(eid)) {
          prescriptions.push(embedded);
        }
      }
    }

    res.json(prescriptions || []);
  } catch (error) {
    console.error("Error fetching patient prescriptions:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * GET /api/prescriptions/:id
 * Get single prescription by ID
 */
router.get("/:id", async (req, res) => {
  try {
    const Prescription = req.tenantDb.model("Prescription");
    const rawId = decodeURIComponent(String(req.params.id || "").trim());

    let prescription = null;
    if (mongoose.Types.ObjectId.isValid(rawId)) {
      if (req.hospitalId) {
        prescription = await Prescription.findOne({
          _id: rawId,
          hospitalId: req.hospitalId,
        }).lean();
      }
      if (!prescription) {
        prescription = await Prescription.findById(rawId).lean();
      }
    }
    if (!prescription) {
      if (req.hospitalId) {
        prescription = await Prescription.findOne({
          prescriptionId: rawId,
          hospitalId: req.hospitalId,
        }).lean();
      }
      if (!prescription) {
        prescription = await Prescription.findOne({
          prescriptionId: rawId,
        }).lean();
      }
    }

    if (!prescription) {
      return res.status(404).json({ message: "Prescription not found" });
    }

    res.json(prescription);
  } catch (error) {
    console.error("Error fetching prescription:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * POST /api/prescriptions
 * Create a new prescription in dedicated collection
 */
router.post("/", async (req, res) => {
  try {
    const Prescription = req.tenantDb.model("Prescription");
    const Patient = req.tenantDb.model("Patient");

    const {
      patientId,
      UMRNo,
      prescriptionId = `RX-${Date.now()}`,
      doctorId,
      doctorName,
      consultantDoctor,
      department,
      date = new Date().toISOString().split("T")[0],
      symptoms,
      provisionalDiagnosis,
      weight,
      height,
      vitals,
      doctorNotes,
      nurseNotes,
      diagnosticData,
      medicineData,
      paymentMethod,
      insurance_provider,
      insurance_providerId,
      policy_number,
      coPayPercentage,
      coPayLimit,
      coPayType,
      coverage,
      expiry_date,
      commissionEarnerType,
      commissionEarnerId,
      commissionEarnerName,
      commissionRates,
    } = req.body;

    // Resolve patient record
    let patient = null;
    if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
      patient = await Patient.findOne({
        _id: patientId,
        hospitalId: req.hospitalId,
      });
    }
    if (!patient && UMRNo) {
      patient = await Patient.findOne({ UMRNo, hospitalId: req.hospitalId });
    }

    if (!patient) {
      return res
        .status(404)
        .json({ message: "Patient not found for prescription" });
    }

    const resolvedConsultant = consultantDoctor || doctorName || "";
    const resolvedDoctorName = doctorName || resolvedConsultant;

    const prescriptionDoc = new Prescription({
      prescriptionId,
      hospitalId: req.hospitalId,
      patientId: patient._id,
      UMRNo: patient.UMRNo || UMRNo,
      doctorId: String(doctorId),
      doctorName: resolvedDoctorName,
      consultantDoctor: resolvedConsultant || resolvedDoctorName,
      department,
      date,
      symptoms: symptoms ?? "",
      provisionalDiagnosis,
      weight,
      height,
      vitals: vitals || [],
      doctorNotes: doctorNotes || [],
      nurseNotes: nurseNotes || [],
      diagnosticData: diagnosticData || [],
      medicineData: medicineData || [],
      paymentMethod: paymentMethod || patient.paymentMethod || "Personal",
      insurance_provider: insurance_provider ?? patient.insurance_provider,
      insurance_providerId: insurance_providerId ?? patient.insurance_providerId,
      policy_number: policy_number ?? patient.policy_number,
      coPayPercentage: coPayPercentage ?? patient.coPayPercentage ?? 0,
      coPayLimit: coPayLimit ?? patient.coPayLimit ?? 0,
      coPayType: coPayType || patient.coPayType || "percentage",
      coverage: coverage ?? patient.coverage,
      expiry_date: expiry_date ?? patient.expiry_date,
      commissionEarnerType,
      commissionEarnerId,
      commissionEarnerName,
      commissionRates,
      pharmacyStatus: "pending",
    });
    await prescriptionDoc.save();

    res.status(201).json(prescriptionDoc.toObject());
  } catch (error) {
    console.error("Error creating prescription:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * PUT /api/prescriptions/:id
 * Update prescription / pharmacyStatus
 */
router.put("/:id", async (req, res) => {
  try {
    const Prescription = req.tenantDb.model("Prescription");
    const rawId = decodeURIComponent(String(req.params.id || "").trim());

    const orConditions = [{ prescriptionId: rawId }];
    if (mongoose.Types.ObjectId.isValid(rawId)) {
      orConditions.push({ _id: rawId });
    }

    const query = req.hospitalId
      ? { $or: orConditions, hospitalId: req.hospitalId }
      : { $or: orConditions };

    const body = { ...(req.body || {}) };
    // Master clinical history stays on Patient
    delete body.allergiesHistory;
    delete body.pastMedicalHistory;
    delete body.pastMedications;
    delete body.personalHistory;
    delete body._id;
    delete body.hospitalId;
    delete body.patientId;

    if (body.consultantDoctor && !body.doctorName) {
      body.doctorName = body.consultantDoctor;
    } else if (body.doctorName && !body.consultantDoctor) {
      body.consultantDoctor = body.doctorName;
    }

    let updated = await Prescription.findOneAndUpdate(
      query,
      { $set: body },
      { new: true },
    );

    if (!updated && req.hospitalId) {
      updated = await Prescription.findOneAndUpdate(
        { $or: orConditions },
        { $set: body },
        { new: true },
      );
    }

    if (!updated) {
      return res.status(404).json({ message: "Prescription not found" });
    }

    res.json(updated.toObject ? updated.toObject() : updated);
  } catch (error) {
    console.error("Error updating prescription:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * DELETE /api/prescriptions/:id
 * Remove a prescription visit (by Mongo _id or prescriptionId).
 */
router.delete("/:id", async (req, res) => {
  try {
    const Prescription = req.tenantDb.model("Prescription");
    const Patient = req.tenantDb.model("Patient");
    const rawId = decodeURIComponent(String(req.params.id || "").trim());

    const orConditions = [{ prescriptionId: rawId }];
    if (mongoose.Types.ObjectId.isValid(rawId)) {
      orConditions.push({ _id: rawId });
    }

    const query = req.hospitalId
      ? { $or: orConditions, hospitalId: req.hospitalId }
      : { $or: orConditions };

    let prescription = await Prescription.findOne(query).lean();
    if (!prescription && req.hospitalId) {
      prescription = await Prescription.findOne({ $or: orConditions }).lean();
    }
    if (!prescription) {
      return res.status(404).json({ message: "Prescription not found" });
    }

    await Prescription.deleteOne({ _id: prescription._id });

    res.json({
      message: "Prescription deleted",
      prescriptionId: prescription.prescriptionId,
    });
  } catch (error) {
    console.error("Error deleting prescription:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * POST /api/prescriptions/:patientId/:prescriptionId/send-whatsapp
 * Send prescription via WhatsApp (Meta Cloud API)
 */
router.post("/:patientId/:prescriptionId/send-whatsapp", async (req, res) => {
  try {
    const { patientId, prescriptionId } = req.params;
    const { viewBaseUrl } = req.body || {};

    if (!viewBaseUrl) {
      return res
        .status(400)
        .json({ message: "viewBaseUrl is required to build the view link." });
    }

    const Prescription = req.tenantDb.model("Prescription");
    const Patient = req.tenantDb.model("Patient");
    const Staff = req.tenantDb.model("Staff");

    let prescription = await Prescription.findOne({
      hospitalId: req.hospitalId,
      prescriptionId,
    }).lean();

    let patient = null;
    if (prescription) {
      patient = await Patient.findById(prescription.patientId).lean();
    } else {
      patient = await Patient.findOne({
        UMRNo: patientId,
        hospitalId: req.hospitalId,
      }).lean();
    }

    if (!patient) {
      return res.status(404).json({ message: "Patient not found." });
    }
    if (!prescription) {
      return res.status(404).json({ message: "Prescription not found." });
    }
    if (!patient.phone) {
      return res
        .status(400)
        .json({ message: "Patient does not have a mobile number on file." });
    }

    let doctorName = patient.consultantDoctor || prescription.doctorName || "";
    if (prescription.doctorId) {
      try {
        const doctorDoc = await Staff.findOne({
          id: prescription.doctorId,
        }).lean();
        if (doctorDoc?.name) doctorName = doctorDoc.name;
      } catch (err) {
        // best-effort
      }
    }

    const hospital = await Hospital.findById(req.hospitalId).lean();
    const hospitalName = hospital?.name || "Your Clinic";

    const token = createPrescriptionToken({
      hospitalId: String(req.hospitalId),
      patientId: patient.UMRNo,
      prescriptionId,
    });

    const cleanBase = String(viewBaseUrl).replace(/\/+$/, "");
    const viewUrl = `${cleanBase}/view/prescription/${token}`;

    const result = await sendPrescriptionWhatsApp({
      phone: patient.phone,
      patientName: patient.name,
      hospitalName,
      doctorName,
      token,
      viewUrl,
    });

    return res.json({
      success: true,
      viewUrl,
      destination: result.destination,
    });
  } catch (error) {
    console.error("Send prescription WhatsApp error:", error);

    const mapped = mapWhatsAppHttpError(error, res);
    if (mapped) return mapped;

    return res
      .status(500)
      .json({ message: "Failed to send prescription to patient." });
  }
});

module.exports = router;
