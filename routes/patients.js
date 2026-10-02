const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const { localYmd } = require("../utils/localDate");
const { normalizeRole } = require("../config/rolePermissions");
const {
  resolveRequestDoctorIds,
  patientVisibleToDoctorIds,
  isDoctorRole,
} = require("../utils/doctorPatientAccess");
const {
  calculateBillBreakdown,
  calculateInsuranceCoverage,
  calculateTotalAdvance,
} = require("../utils/insuranceCalculation");
const {
  extractSubdomain,
  requireSubdomain,
} = require("../middleware/subdomain");
const { getTenantConnection } = require("../utils/tenantDb");
const {
  buildPublicRegistrationKey,
  checkPublicOpRateLimit,
  assertHospitalAllowsPublicOp,
  validatePublicOpPayload,
  buildTrustedPublicPatientDoc,
  toPublicRegistrationResponse,
  normalizeName,
  normalizeAge,
  normalizeGender,
} = require("../utils/publicOpRegistration");
const { syncClinicalCasesFromPatient } = require("../utils/doctorMemory");
const { admitPatient } = require("../utils/admitPatient");
const { filterReceiptsForEvent } = require("../utils/visitReceiptScope");
const {
  pickPerson,
  presentPatient,
  attachLatestDischargedStay,
  objectIds,
  loadRosterSets,
  loadOpenAdmissionMap,
} = require("../utils/patientFields");
const mongoose = require("mongoose");

async function findPatientByIdOrUMR(Patient, idOrUmr, hospitalId) {
  if (!idOrUmr) return null;
  const decodedId = decodeURIComponent(String(idOrUmr).trim());
  let patient = null;

  // 1. Try by ObjectId if valid
  if (mongoose.Types.ObjectId.isValid(decodedId)) {
    if (hospitalId) {
      patient = await Patient.findOne({ _id: decodedId, hospitalId });
    }
    if (!patient) {
      patient = await Patient.findById(decodedId);
    }
  }

  // 2. Try by exact UMRNo
  if (!patient) {
    if (hospitalId) {
      patient = await Patient.findOne({ UMRNo: decodedId, hospitalId });
    }
    if (!patient) {
      patient = await Patient.findOne({ UMRNo: decodedId });
    }
  }

  // 3. Try case-insensitive UMRNo regex match
  if (!patient) {
    patient = await Patient.findOne({
      UMRNo: {
        $regex: new RegExp(
          `^${decodedId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        ),
      },
    });
  }

  // 4. Try by phone as fallback
  if (!patient) {
    patient = await Patient.findOne({ phone: decodedId });
  }

  // 5. Try resolving via IPAdmission document if idOrUmr was an admissionId or ipNumber
  if (!patient) {
    try {
      const IPAdmission = Patient.db.model("IPAdmission");
      const admQuery = hospitalId
        ? {
            hospitalId,
            $or: [
              ...(mongoose.Types.ObjectId.isValid(decodedId)
                ? [{ _id: decodedId }, { patientId: decodedId }]
                : []),
              { ipNumber: decodedId },
            ],
          }
        : {
            $or: [
              ...(mongoose.Types.ObjectId.isValid(decodedId)
                ? [{ _id: decodedId }, { patientId: decodedId }]
                : []),
              { ipNumber: decodedId },
            ],
          };
      const adm = await IPAdmission.findOne(admQuery).lean();
      if (adm) {
        if (adm.patientId) {
          patient = await Patient.findById(adm.patientId);
        }
        if (!patient && adm.UMRNo) {
          patient = await Patient.findOne({ UMRNo: adm.UMRNo });
        }
        if (!patient) {
          patient = new Patient({
            _id: adm.patientId || adm._id,
            hospitalId: adm.hospitalId,
            UMRNo: adm.UMRNo,
            name: adm.patientName || adm.name,
            age: adm.age,
            gender: adm.gender,
            phone: adm.phone,
            patient_type: adm.patient_type || "IP",
            activeAdmissionId: adm._id,
          });
        }
      }
    } catch (e) {
      // ignore fallback error
    }
  }

  return patient;
}

/**
 * PUBLIC (no auth): hospital branding for the self-registration page.
 * Defined BEFORE applyTenantEntitlements so auth middleware does not apply.
 * GET /api/patients/public/register-op-info
 */
router.get(
  "/public/register-op-info",
  extractSubdomain,
  requireSubdomain,
  async (req, res) => {
    try {
      const hospital = req.hospital;
      const access = assertHospitalAllowsPublicOp(hospital);
      if (!access.ok) {
        return res.status(access.status).json({ message: access.message });
      }

      return res.json({
        hospital: {
          name: hospital.name,
          code: hospital.code,
          address: hospital.address,
          city: hospital.city,
          state: hospital.state,
          zipCode: hospital.zipCode,
          phone: hospital.phone,
          logoUrl: hospital.logoUrl,
        },
      });
    } catch (error) {
      console.error("Public OP registration info error:", error);
      return res
        .status(500)
        .json({ message: "Unable to load registration page." });
    }
  },
);

/**
 * PUBLIC (no auth): create or reuse an OP patient from the shareable link.
 * POST /api/patients/public/register-op
 */
router.post(
  "/public/register-op",
  extractSubdomain,
  requireSubdomain,
  async (req, res) => {
    try {
      const rate = checkPublicOpRateLimit(req);
      if (!rate.allowed) {
        res.setHeader("Retry-After", String(rate.retryAfterSec));
        return res.status(429).json({
          message: "Too many registration attempts. Please try again later.",
        });
      }

      const hospital = req.hospital;
      const access = assertHospitalAllowsPublicOp(hospital);
      if (!access.ok) {
        return res.status(access.status).json({ message: access.message });
      }

      const validated = validatePublicOpPayload(req.body);
      if (!validated.ok) {
        return res.status(400).json({
          message: "Please correct the highlighted fields.",
          errors: validated.errors,
        });
      }

      const hospitalId = req.hospitalId;
      const connection = await getTenantConnection(hospitalId);
      if (!connection) {
        return res
          .status(500)
          .json({ message: "Unable to complete registration." });
      }

      const Patient = connection.model("Patient");
      const data = validated.data;
      const publicRegistrationKey = buildPublicRegistrationKey({
        hospitalId,
        phone: data.phone,
        name: data.name,
        age: data.age,
        gender: data.gender,
      });

      let existing = await Patient.findOne({
        hospitalId,
        publicRegistrationKey,
      });

      if (!existing) {
        const phoneMatches = await Patient.find({
          hospitalId,
          phone: data.phone,
        }).limit(25);

        existing = phoneMatches.find(
          (p) =>
            normalizeName(p.name) === normalizeName(data.name) &&
            normalizeAge(p.age) === normalizeAge(data.age) &&
            normalizeGender(p.gender) === normalizeGender(data.gender),
        );

        if (existing && !existing.publicRegistrationKey) {
          existing.publicRegistrationKey = publicRegistrationKey;
          try {
            await existing.save();
          } catch (err) {
            // Ignore race on key backfill; identity match already found.
          }
        }
      }

      if (existing) {
        return res.json(
          toPublicRegistrationResponse(existing, { created: false }),
        );
      }

      const patientDoc = buildTrustedPublicPatientDoc({
        hospitalId,
        data,
        publicRegistrationKey,
      });

      try {
        const patient = new Patient(patientDoc);
        const created = await patient.save();
        return res
          .status(201)
          .json(toPublicRegistrationResponse(created, { created: true }));
      } catch (error) {
        if (error?.code === 11000) {
          const raced = await Patient.findOne({
            hospitalId,
            publicRegistrationKey,
          });
          if (raced) {
            return res.json(
              toPublicRegistrationResponse(raced, { created: false }),
            );
          }
        }
        throw error;
      }
    } catch (error) {
      console.error("Public OP registration error:", error);
      return res.status(500).json({
        message: "Unable to complete registration. Please try again.",
      });
    }
  },
);

// Everything below requires authentication + active subscription + tenant DB
applyTenantEntitlements(router, { moduleKey: "core" });

const INPATIENT_TYPES = new Set(["IP", "OPtoIP"]);

function isInpatientPatient(patient) {
  return INPATIENT_TYPES.has(patient?.patient_type);
}

function isDoctorWithoutIpdDoctorRecord(req) {
  return (
    normalizeRole(req.user?.type) === "Doctor" &&
    req.entitlements?.modules?.ipdDoctorRecord !== true
  );
}

function isNurseWithoutIpdPanel(req) {
  return (
    normalizeRole(req.user?.type) === "Nurse" &&
    req.entitlements?.modules?.ipdNursePanel !== true
  );
}

function sendModuleForbidden(res, moduleKey, message) {
  return res.status(403).json({
    code: "MODULE_NOT_IN_PLAN",
    message,
    module: moduleKey,
  });
}

function blockInpatientRecordAccess(req, res, patient) {
  if (!isInpatientPatient(patient)) return false;

  if (req.entitlements?.modules?.ipd !== true) {
    sendModuleForbidden(
      res,
      "ipd",
      "IPD patient access is not included in your subscription plan.",
    );
    return true;
  }

  if (isDoctorWithoutIpdDoctorRecord(req)) {
    sendModuleForbidden(
      res,
      "ipdDoctorRecord",
      "Doctor IPD patient record is not included in your subscription plan.",
    );
    return true;
  }
  if (isNurseWithoutIpdPanel(req)) {
    sendModuleForbidden(
      res,
      "ipdNursePanel",
      "Nurse IPD panel is not included in your subscription plan.",
    );
    return true;
  }
  return false;
}

// Get all patients with pagination support
router.get("/", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");

    const {
      page = 1,
      limit = 20,
      search = "",
      patientType = "",
      status = "",
      paymentMethod = "",
      insuranceProviderId = "",
      insuranceOnly = "",
      maxDaysAdmitted = "",
      minDaysAdmitted = "",
      fromDate = "",
      toDate = "",
    } = req.query;

    const dayjs = require("dayjs");

    const andConditions = [{ hospitalId: req.hospitalId }];

    const IPAdmission = req.tenantDb.model("IPAdmission");
    const PrescriptionForRoster = req.tenantDb.model("Prescription");
    const roster = await loadRosterSets(
      IPAdmission,
      PrescriptionForRoster,
      req.hospitalId,
      Patient,
    );
    const forceOp =
      isDoctorWithoutIpdDoctorRecord(req) ||
      isNurseWithoutIpdPanel(req) ||
      (req.entitlements?.modules?.ipd !== true && patientType !== "OP");

    if (forceOp && patientType && patientType !== "OP") {
      const moduleKey = isDoctorWithoutIpdDoctorRecord(req)
        ? "ipdDoctorRecord"
        : isNurseWithoutIpdPanel(req)
          ? "ipdNursePanel"
          : "ipd";
      return sendModuleForbidden(
        res,
        moduleKey,
        "IPD patient access is not included in your subscription plan.",
      );
    }

    const rosterMode = forceOp
      ? "OP"
      : patientType || (status === "inactive" ? "discharged" : "");

    let ipIds = roster.openIds;
    if (rosterMode === "IP" && (maxDaysAdmitted || minDaysAdmitted)) {
      const admissionDate = {};
      if (maxDaysAdmitted) {
        admissionDate.$gte = dayjs()
          .subtract(parseInt(maxDaysAdmitted, 10), "day")
          .format("YYYY-MM-DD");
      }
      if (minDaysAdmitted) {
        admissionDate.$lte = dayjs()
          .subtract(parseInt(minDaysAdmitted, 10), "day")
          .format("YYYY-MM-DD");
      }
      const dated = await IPAdmission.find({
        hospitalId: req.hospitalId,
        patient_status: "Admitted",
        admissionDate,
      })
        .select("patientId")
        .lean();
      ipIds = dated.map((row) => String(row.patientId || "")).filter(Boolean);
    }

    if (rosterMode === "OP") {
      const excluded = objectIds(roster.excludeFromOp);
      if (excluded.length) andConditions.push({ _id: { $nin: excluded } });
    } else if (rosterMode === "IP") {
      andConditions.push({ _id: { $in: objectIds(ipIds) } });
    } else if (rosterMode === "discharged") {
      andConditions.push({ _id: { $in: objectIds(roster.dischargedIds) } });
    }

    if (paymentMethod || insuranceProviderId || insuranceOnly === "true") {
      const eventMatch = { hospitalId: req.hospitalId };
      if (paymentMethod) eventMatch.paymentMethod = paymentMethod;
      if (insuranceProviderId) {
        eventMatch.insurance_providerId = insuranceProviderId;
      }
      if (insuranceOnly === "true" && !paymentMethod) {
        eventMatch.$or = [
          { paymentMethod: "Insurance" },
          { insurance_providerId: { $exists: true, $nin: [null, ""] } },
        ];
      }
      const eventSelect = "patientId";
      const [insuredVisits, insuredStays] = await Promise.all([
        PrescriptionForRoster.find(eventMatch).select(eventSelect).lean(),
        IPAdmission.find(eventMatch).select(eventSelect).lean(),
      ]);
      const insuredIds = objectIds(
        [...insuredVisits, ...insuredStays].map((row) => row.patientId),
      );
      andConditions.push(
        insuredIds.length
          ? { _id: { $in: insuredIds } }
          : { _id: { $exists: false } },
      );
    }

    if (fromDate || toDate) {
      const start = fromDate ? dayjs(fromDate).format("YYYY-MM-DD") : null;
      const end = toDate ? dayjs(toDate).format("YYYY-MM-DD") : null;
      const dateRange = {};
      if (start) dateRange.$gte = start;
      if (end) dateRange.$lte = `${end}T23:59:59.999Z`;
      if (Object.keys(dateRange).length > 0) {
        andConditions.push({ registration_date: dateRange });
      }
    }

    if (search && search.length >= 2) {
      andConditions.push({
        $or: [
          { UMRNo: { $regex: search, $options: "i" } },
          { name: { $regex: search, $options: "i" } },
          { phone: { $regex: search, $options: "i" } },
        ],
      });
    }

    // Doctors: only assigned consultant patients OR patients with their visit.
    if (isDoctorRole(req)) {
      const doctorIds = await resolveRequestDoctorIds(req);
      const Prescription = req.tenantDb.model("Prescription");
      const [rxRows, stayRows] = await Promise.all([
        Prescription.find({
          hospitalId: req.hospitalId,
          doctorId: { $in: doctorIds },
        })
          .select("patientId")
          .lean(),
        IPAdmission.find({
          hospitalId: req.hospitalId,
          doctorId: { $in: doctorIds },
          patient_status: "Admitted",
        })
          .select("patientId")
          .lean(),
      ]);
      const visibleIds = objectIds(
        [...rxRows, ...stayRows].map((row) => row.patientId),
      );
      andConditions.push(
        visibleIds.length
          ? { _id: { $in: visibleIds } }
          : { _id: { $exists: false } },
      );
    }

    const query =
      andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const total = await Patient.countDocuments(query);

    const patients = await Patient.find(query)
      .sort({ registration_date: -1 })
      .skip(skip)
      .limit(limitNum);

    const patientIds = patients.map((p) => p._id);
    const umrNos = patients.map((p) => p.UMRNo).filter(Boolean);

    const visitMap = new Map();
    if (patientIds.length > 0 || umrNos.length > 0) {
      const Prescription = req.tenantDb.model("Prescription");
      const todayStr = dayjs().format("YYYY-MM-DD");

      const rxList = await Prescription.find({
        hospitalId: req.hospitalId,
        $or: [{ patientId: { $in: patientIds } }, { UMRNo: { $in: umrNos } }],
      })
        .select(
          "patientId UMRNo prescriptionId doctorId doctorName consultantDoctor date createdAt medicineData diagnosticData symptoms provisionalDiagnosis paymentMethod insurance_provider insurance_providerId policy_number coPayPercentage coPayLimit coPayType coverage expiry_date",
        )
        .sort({ createdAt: -1, date: -1 })
        .lean();

      for (const rx of rxList) {
        const pKey1 = rx.patientId ? String(rx.patientId) : null;
        const pKey2 = rx.UMRNo ? String(rx.UMRNo) : null;

        const rxDateStr = String(rx.date || "").slice(0, 10);
        const rxCreatedStr = rx.createdAt
          ? new Date(rx.createdAt).toISOString().slice(0, 10)
          : "";
        const isToday = rxDateStr === todayStr || rxCreatedStr === todayStr;

        const keys = [pKey1, pKey2].filter(Boolean);
        for (const k of keys) {
          if (!visitMap.has(k)) {
            visitMap.set(k, {
              lastVisitDate: rx.date || rx.createdAt,
              lastDoctorName: rx.consultantDoctor || rx.doctorName || "",
              lastPrescriptionId: rx.prescriptionId,
              todayVisit: null,
              lastRxCount: (rx.medicineData || []).length,
              lastTestCount: (rx.diagnosticData || []).length,
              lastDiagnosis: rx.provisionalDiagnosis || "",
              lastSymptoms: rx.symptoms || "",
              paymentMethod: rx.paymentMethod || "Personal",
              insurance_provider: rx.insurance_provider || "",
              insurance_providerId: rx.insurance_providerId || "",
              policy_number: rx.policy_number || "",
              coPayPercentage: rx.coPayPercentage ?? 0,
              coPayLimit: rx.coPayLimit ?? 0,
              coPayType: rx.coPayType || "percentage",
              coverage: rx.coverage || "",
              expiry_date: rx.expiry_date || "",
            });
          }
          const curr = visitMap.get(k);
          if (isToday && !curr.todayVisit) {
            curr.todayVisit = {
              prescriptionId: rx.prescriptionId,
              date: rx.date || rx.createdAt,
              doctorName: rx.doctorName || "",
              consultantDoctor: rx.consultantDoctor || rx.doctorName || "",
              doctorId: rx.doctorId || "",
              createdAt: rx.createdAt,
              medicineCount: (rx.medicineData || []).length,
              testCount: (rx.diagnosticData || []).length,
            };
          }
        }
      }
    }

    const admissionMap = await loadOpenAdmissionMap(
      IPAdmission,
      req.hospitalId,
      patientIds,
    );

    const formattedPatients = patients.map((patient) => {
      const pObj = presentPatient(patient, {
        admission: admissionMap.get(String(patient._id)) || null,
        roster: rosterMode === "discharged" ? "discharged" : "",
      });
      const rxInfo =
        visitMap.get(String(patient._id)) ||
        visitMap.get(String(patient.UMRNo)) ||
        {};

      return {
        ...pObj,
        registration_date: new Date(
          patient.registration_date,
        ).toLocaleDateString(),
        lastVisitDate: rxInfo.lastVisitDate || null,
        lastDoctorName: rxInfo.lastDoctorName || null,
        lastPrescriptionId: rxInfo.lastPrescriptionId || null,
        todayVisit: rxInfo.todayVisit || null,
        lastRxCount: rxInfo.lastRxCount || 0,
        lastTestCount: rxInfo.lastTestCount || 0,
        lastDiagnosis: rxInfo.lastDiagnosis || "",
        lastSymptoms: rxInfo.lastSymptoms || "",
        paymentMethod:
          pObj.paymentMethod || rxInfo.paymentMethod || "Personal",
        insurance_provider:
          pObj.insurance_provider || rxInfo.insurance_provider || "",
        insurance_providerId:
          pObj.insurance_providerId || rxInfo.insurance_providerId || "",
        policy_number: pObj.policy_number || rxInfo.policy_number || "",
        coPayPercentage: pObj.coPayPercentage ?? rxInfo.coPayPercentage ?? 0,
        coPayLimit: pObj.coPayLimit ?? rxInfo.coPayLimit ?? 0,
        coPayType: pObj.coPayType || rxInfo.coPayType || "percentage",
        coverage: pObj.coverage || rxInfo.coverage || "",
        expiry_date: pObj.expiry_date || rxInfo.expiry_date || "",
      };
    });

    res.json({
      patients: formattedPatients,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(total / limitNum),
        totalItems: total,
        itemsPerPage: limitNum,
        hasNextPage: pageNum < Math.ceil(total / limitNum),
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get patients by phone number
router.get("/phone/:phoneNumber", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    const query = {
      phone: req.params.phoneNumber,
      hospitalId: req.hospitalId,
    };
    const patients = await Patient.find(query);
    let rows = patients;
    if (isDoctorWithoutIpdDoctorRecord(req) || isNurseWithoutIpdPanel(req)) {
      const IPAdmission = req.tenantDb.model("IPAdmission");
      const openMap = await loadOpenAdmissionMap(
        IPAdmission,
        req.hospitalId,
        patients.map((row) => row._id),
      );
      rows = patients.filter((row) => !openMap.has(String(row._id)));
    }
    const IPAdmission = req.tenantDb.model("IPAdmission");
    const openMap = await loadOpenAdmissionMap(
      IPAdmission,
      req.hospitalId,
      rows.map((row) => row._id),
    );
    res.json(
      rows.map((row) =>
        presentPatient(row, {
          admission: openMap.get(String(row._id)) || null,
        }),
      ),
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get patient by ID
router.get("/:id", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    const patient = await findPatientByIdOrUMR(
      Patient,
      req.params.id,
      req.hospitalId,
    );
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    const IPAdmission = req.tenantDb.model("IPAdmission");
    const open = patient._id
      ? await IPAdmission.findOne({
          hospitalId: req.hospitalId,
          patientId: patient._id,
          patient_status: "Admitted",
        })
      : null;
    const latestDischarged =
      !open && patient._id
        ? await IPAdmission.findOne({
            hospitalId: req.hospitalId,
            patientId: patient._id,
            patient_status: "Discharged",
          })
            .sort({ dischargedAt: -1, dischargeDate: -1, updatedAt: -1 })
            .lean()
        : null;
    const view = presentPatient(patient, { admission: open });
    if (!open && latestDischarged) {
      attachLatestDischargedStay(view, latestDischarged);
    }
    if (blockInpatientRecordAccess(req, res, view)) return;
    if (isDoctorRole(req)) {
      const doctorIds = await resolveRequestDoctorIds(req);
      const prescriptions = await req.tenantDb
        .model("Prescription")
        .find({
          hospitalId: req.hospitalId,
          $or: [{ patientId: patient._id }, { UMRNo: patient.UMRNo }],
        })
        .select("doctorId")
        .lean()
        .catch(() => []);
      if (!patientVisibleToDoctorIds({ ...view, prescriptions }, doctorIds)) {
        return res.status(403).json({
          message:
            "Patient is not assigned to you and you have no visit on this record.",
        });
      }
    }

    res.json(view);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new patient
router.post("/", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    if (
      isDoctorWithoutIpdDoctorRecord(req) &&
      INPATIENT_TYPES.has(req.body?.patient_type)
    ) {
      return sendModuleForbidden(
        res,
        "ipdDoctorRecord",
        "Doctor IPD patient record is not included in your subscription plan.",
      );
    }
    if (
      isNurseWithoutIpdPanel(req) &&
      INPATIENT_TYPES.has(req.body?.patient_type)
    ) {
      return sendModuleForbidden(
        res,
        "ipdNursePanel",
        "Nurse IPD panel is not included in your subscription plan.",
      );
    }
    if (
      req.entitlements?.modules?.ipd !== true &&
      INPATIENT_TYPES.has(req.body?.patient_type)
    ) {
      return sendModuleForbidden(
        res,
        "ipd",
        "IPD patient registration is not included in your subscription plan.",
      );
    }
    if (INPATIENT_TYPES.has(req.body?.patient_type)) {
      const result = await admitPatient({
        tenantDb: req.tenantDb,
        hospitalId: req.hospitalId,
        body: req.body,
      });
      return res.status(result.httpStatus).json(result.payload);
    }

    const patient = new Patient(
      pickPerson(req.body, { hospitalId: req.hospitalId }),
    );
    const newPatient = await patient.save();

    let initialVisit = null;
    try {
      const Prescription = req.tenantDb.model("Prescription");
      const doctorId =
        req.body.doctorId ||
        (req.user?.type === "Doctor" ? req.user.id : "") ||
        "";
      const consultantDoctor =
        req.body.consultantDoctor ||
        req.body.doctorName ||
        (req.user?.type === "Doctor" ? req.user.name : "") ||
        "";

      if (doctorId) {
        const prescriptionId = `RX-${Date.now()}-${Math.floor(
          Math.random() * 9000 + 1000,
        )}`;
        const doc = await Prescription.create({
          prescriptionId,
          hospitalId: req.hospitalId,
          patientId: newPatient._id,
          UMRNo: newPatient.UMRNo,
          doctorId: String(doctorId),
          doctorName: consultantDoctor,
          consultantDoctor,
          date: localYmd(),
          symptoms: "",
          vitals: [],
          doctorNotes: [],
          nurseNotes: [],
          diagnosticData: [],
          medicineData: [],
          paymentMethod: req.body.paymentMethod || "Personal",
          insurance_provider: req.body.insurance_provider || "",
          insurance_providerId: req.body.insurance_providerId || "",
          policy_number: req.body.policy_number || "",
          coPayPercentage: req.body.coPayPercentage ?? 0,
          coPayLimit: req.body.coPayLimit ?? 0,
          coPayType: req.body.coPayType || "percentage",
          coverage: req.body.coverage || "",
          expiry_date: req.body.expiry_date || "",
          pharmacyStatus: "pending",
        });
        initialVisit = doc.toObject ? doc.toObject() : doc;
      }
    } catch (visitErr) {
      console.warn(
        "OP patient created but initial visit failed:",
        visitErr?.message || visitErr,
      );
    }

    res.status(201).json({
      ...presentPatient(newPatient),
      initialVisit,
      initialAdmission: null,
    });
  } catch (error) {
    console.error("POST /api/patients failed:", error?.message || error);
    if (error?.errors) {
      console.error(
        "Validation details:",
        Object.fromEntries(
          Object.entries(error.errors).map(([k, v]) => [k, v.message]),
        ),
      );
    }
    res.status(400).json({
      message: error.message,
      errors: error?.errors
        ? Object.fromEntries(
            Object.entries(error.errors).map(([k, v]) => [k, v.message]),
          )
        : undefined,
    });
  }
});

// Update patient
router.put("/:id", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    const existingPatient = await findPatientByIdOrUMR(
      Patient,
      req.params.id,
      req.hospitalId,
    );
    if (!existingPatient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    const requestedType =
      req.body?.patient_type || existingPatient.patient_type;
    if (
      isDoctorWithoutIpdDoctorRecord(req) &&
      INPATIENT_TYPES.has(requestedType)
    ) {
      return sendModuleForbidden(
        res,
        "ipdDoctorRecord",
        "Doctor IPD patient record is not included in your subscription plan.",
      );
    }
    if (isNurseWithoutIpdPanel(req) && INPATIENT_TYPES.has(requestedType)) {
      return sendModuleForbidden(
        res,
        "ipdNursePanel",
        "Nurse IPD panel is not included in your subscription plan.",
      );
    }
    if (
      req.entitlements?.modules?.ipd !== true &&
      INPATIENT_TYPES.has(requestedType)
    ) {
      return sendModuleForbidden(
        res,
        "ipd",
        "IPD patient updates are not included in your subscription plan.",
      );
    }

    const body = pickPerson(req.body || {});
    const patientFields = body;

    let patient = existingPatient;
    if (Object.keys(patientFields).length > 0) {
      patient = await Patient.findOneAndUpdate(
        { _id: existingPatient._id, hospitalId: req.hospitalId },
        { $set: patientFields },
        { new: true, runValidators: true },
      );
      if (!patient) {
        return res.status(404).json({ message: "Patient not found" });
      }
    } else {
      patient = await findPatientByIdOrUMR(
        Patient,
        req.params.id,
        req.hospitalId,
      );
    }

    const IPAdmission = req.tenantDb.model("IPAdmission");
    const open = await IPAdmission.findOne({
      hospitalId: req.hospitalId,
      patientId: patient._id,
      patient_status: "Admitted",
    });
    const hydrated = presentPatient(patient, { admission: open });

    syncClinicalCasesFromPatient(req.tenantDb, req.hospitalId, hydrated).catch(
      (err) => {
        console.warn("Clinical case sync failed:", err?.message || err);
      },
    );

    res.json(hydrated);
  } catch (error) {
    console.error("PUT /api/patients failed:", error?.message || error);
    res.status(400).json({ message: error.message });
  }
});

// Delete patient
router.delete("/:id", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    const existingPatient = await findPatientByIdOrUMR(
      Patient,
      req.params.id,
      req.hospitalId,
    );
    if (!existingPatient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    if (blockInpatientRecordAccess(req, res, existingPatient)) return;
    const patient = await Patient.findOneAndDelete({
      _id: existingPatient._id,
      hospitalId: req.hospitalId,
    });
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    res.json({ message: "Patient deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add medical history to patient
router.post("/:id/medical-history", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    const patient = await findPatientByIdOrUMR(
      Patient,
      req.params.id,
      req.hospitalId,
    );
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    if (blockInpatientRecordAccess(req, res, patient)) return;

    patient.medicalHistory.push(req.body);
    await patient.save();

    res.json(patient);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update medical history
router.put("/:id/medical-history/:historyId", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    const patient = await findPatientByIdOrUMR(
      Patient,
      req.params.id,
      req.hospitalId,
    );
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    if (blockInpatientRecordAccess(req, res, patient)) return;

    const historyIndex = patient.medicalHistory.findIndex(
      (h) => h._id.toString() === req.params.historyId,
    );

    if (historyIndex === -1) {
      return res.status(404).json({ message: "Medical history not found" });
    }

    patient.medicalHistory[historyIndex] = {
      ...patient.medicalHistory[historyIndex].toObject(),
      ...req.body,
    };

    await patient.save();
    res.json(patient);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Calculate interim bill for a patient
router.get("/:id/interim-bill", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    const Consultation = req.tenantDb.model("Consultation");
    const Action = req.tenantDb.model("Action");
    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
    const PharmacyReceipt = req.tenantDb.model("PharmacyReceipt");
    const AdvanceReceipt = req.tenantDb.model("AdvanceReceipt");
    const InsuranceTariff = req.tenantDb.model("InsuranceTariff");
    const InsuranceExclusion = req.tenantDb.model("InsuranceExclusion");
    const InsuranceSettings = req.tenantDb.model("InsuranceSettings");
    const InsuranceCompany = req.tenantDb.model("InsuranceCompany");

    const { id } = req.params;
    const { endDate } = req.query;
    const calculateEndDate = endDate ? new Date(endDate) : new Date();

    const patient = await findPatientByIdOrUMR(Patient, id, req.hospitalId);
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    if (blockInpatientRecordAccess(req, res, patient)) return;

    const [
      consultationReceipts,
      actionReceipts,
      diagnosticsReceipts,
      pharmacyReceipts,
      advanceReceipts,
      insuranceTariffs,
      insuranceExclusions,
      insuranceSettingsDoc,
      insuranceCompanies,
    ] = await Promise.all([
      Consultation.find({ patientId: id, hospitalId: req.hospitalId }),
      Action.find({ patientId: id, hospitalId: req.hospitalId }),
      DiagnosticsReceipt.find({ patientId: id, hospitalId: req.hospitalId }),
      PharmacyReceipt.find({ patientId: id, hospitalId: req.hospitalId }),
      AdvanceReceipt.find({ patientId: id, hospitalId: req.hospitalId }),
      InsuranceTariff.find({ hospitalId: req.hospitalId }),
      InsuranceExclusion.find({ hospitalId: req.hospitalId }),
      InsuranceSettings.findOne({ hospitalId: req.hospitalId }),
      InsuranceCompany.find({ hospitalId: req.hospitalId }),
    ]);

    const IPAdmission = req.tenantDb.model("IPAdmission");
    const Prescription = req.tenantDb.model("Prescription");
    const requestedAdmissionId = String(req.query.admissionId || "");
    const requestedPrescriptionId = String(req.query.prescriptionId || "");
    const [stayRows, latestVisit] = await Promise.all([
      IPAdmission.find({
        hospitalId: req.hospitalId,
        patientId: patient._id,
      })
        .sort({ admissionDate: -1, createdAt: -1 })
        .lean(),
      Prescription.findOne({
        hospitalId: req.hospitalId,
        patientId: patient._id,
      })
        .sort({ date: -1, createdAt: -1 })
        .lean(),
    ]);
    const openStay =
      stayRows.find((row) => row.patient_status === "Admitted") || null;
    const requestedStay = requestedAdmissionId
      ? stayRows.find((row) => String(row._id) === requestedAdmissionId) || null
      : null;
    const requestedVisit = requestedPrescriptionId
      ? await Prescription.findOne({
          hospitalId: req.hospitalId,
          prescriptionId: requestedPrescriptionId,
        }).lean()
      : null;
    const stay = requestedStay || openStay || null;
    const visit = requestedVisit || latestVisit;
    const coverageEvent = requestedStay || requestedVisit || openStay || visit || stayRows[0] || {};
    const coverageSubject = {
      paymentMethod: coverageEvent.paymentMethod || "Personal",
      insurance_providerId: coverageEvent.insurance_providerId || "",
      insurance_provider: coverageEvent.insurance_provider || "",
      policy_number: coverageEvent.policy_number || "",
      coPayPercentage: coverageEvent.coPayPercentage ?? 0,
      coPayLimit: coverageEvent.coPayLimit ?? 0,
      coPayType: coverageEvent.coPayType || "percentage",
      coverage: coverageEvent.coverage || "",
      expiry_date: coverageEvent.expiry_date || "",
    };

    const insuranceCompany = (insuranceCompanies || []).find(
      (c) => String(c._id) === String(coverageSubject.insurance_providerId),
    );

    const settings = insuranceSettingsDoc?.toObject?.() || {};
    const scopedConsultations = filterReceiptsForEvent(
      consultationReceipts,
      coverageEvent,
    );
    const scopedActions = filterReceiptsForEvent(actionReceipts, coverageEvent);
    const scopedDiagnostics = filterReceiptsForEvent(
      diagnosticsReceipts,
      coverageEvent,
    );
    const scopedPharmacy = filterReceiptsForEvent(
      pharmacyReceipts,
      coverageEvent,
    );
    const scopedAdvances = filterReceiptsForEvent(
      advanceReceipts,
      coverageEvent,
    );

    const billSource =
      coverageEvent && coverageEvent.transfers
        ? {
            ...(typeof patient.toObject === "function"
              ? patient.toObject()
              : patient),
            transfers: coverageEvent.transfers,
            active: coverageEvent.patient_status
              ? coverageEvent.patient_status === "Admitted"
              : patient.active,
            dischargeDate: coverageEvent.dischargeDate,
            dischargedAt: coverageEvent.dischargedAt,
          }
        : patient;
    const billBreakdown = calculateBillBreakdown(
      billSource,
      scopedConsultations,
      scopedActions,
      scopedDiagnostics,
      scopedPharmacy,
      calculateEndDate,
    );

    const insuranceResult =
      settings.autoCalculateInsurance === false
        ? {
            totalBill: Object.values(billBreakdown).reduce(
              (sum, amount) => sum + (Number(amount) || 0),
              0,
            ),
            insuranceCoverage: 0,
            patientPayable: Object.values(billBreakdown).reduce(
              (sum, amount) => sum + (Number(amount) || 0),
              0,
            ),
            coverageBreakdown: [],
            exclusionsApplied: [],
            warnings: ["Auto insurance calculation is disabled in settings."],
            coPayAmount: 0,
            coPayPercentage: 0,
            coPayLimit: 0,
            coPayType: coverageSubject.coPayType || "percentage",
            deductible: 0,
            coveragePercentage: 0,
            coverageLimit: 0,
            serviceCoverageDetails: {},
            tariffFound: false,
            tariffValid: false,
          }
        : calculateInsuranceCoverage(
            coverageSubject,
            insuranceTariffs,
            insuranceExclusions,
            billBreakdown,
            { endDate: calculateEndDate, settings },
          );

    const totalAdvancePaid = calculateTotalAdvance(
      scopedAdvances,
      id,
      calculateEndDate,
    );
    const balanceDue = Math.max(
      0,
      insuranceResult.patientPayable - totalAdvancePaid,
    );

    const hospitalRow = req.hospitalRow || req.hospital;

    res.json({
      ...insuranceResult,
      breakdown: billBreakdown,
      endDate: calculateEndDate,
      totalAdvancePaid,
      balanceDue,
      hospital: hospitalRow
        ? {
            name: hospitalRow.name,
            address: hospitalRow.address,
            city: hospitalRow.city,
            state: hospitalRow.state,
            zipCode: hospitalRow.zipCode,
            phone: hospitalRow.phone,
            email: hospitalRow.email,
            website: hospitalRow.website,
          }
        : null,
      patient: {
        UMRNo: patient.UMRNo,
        name: patient.name,
        age: patient.age,
        gender: patient.gender,
        phone: patient.phone,
        patient_type: stay ? "IP" : "OP",
        paymentMethod: coverageSubject.paymentMethod,
        insurance_providerId: coverageSubject.insurance_providerId,
        insurance_provider:
          coverageSubject.insurance_provider || insuranceCompany?.name || "",
        policy_number: coverageSubject.policy_number,
        coPayPercentage: coverageSubject.coPayPercentage,
        coPayLimit: coverageSubject.coPayLimit,
        coPayType: coverageSubject.coPayType,
        street_address: patient.street_address,
        city: patient.city,
        state: patient.state,
        postal_code: patient.postal_code,
        admissionDate: stay?.admissionDate || "",
        registration_date: patient.registration_date,
        consultantDoctor: patient.consultantDoctor,
        transfers: patient.transfers,
      },
      insuranceCompany: insuranceCompany
        ? {
            name: insuranceCompany.name,
            contactPerson: insuranceCompany.contactPerson,
            phone: insuranceCompany.phone,
            email: insuranceCompany.email,
            address: insuranceCompany.address,
            city: insuranceCompany.city,
            state: insuranceCompany.state,
            postalCode: insuranceCompany.postalCode,
          }
        : null,
    });
  } catch (error) {
    console.error("Error calculating interim bill:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
