const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const { normalizeRole } = require("../config/rolePermissions");
const {
  calculateBillBreakdown,
  calculateInsuranceCoverage,
  calculateTotalAdvance,
} = require("../utils/insuranceCalculation");

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
    } = req.query;

    const dayjs = require("dayjs");

    const andConditions = [{ hospitalId: req.hospitalId }];

    if (isDoctorWithoutIpdDoctorRecord(req)) {
      if (patientType && patientType !== "OP") {
        return sendModuleForbidden(
          res,
          "ipdDoctorRecord",
          "Doctor IPD patient record is not included in your subscription plan.",
        );
      }
      andConditions.push({ patient_type: "OP" });
    } else if (isNurseWithoutIpdPanel(req)) {
      if (patientType && patientType !== "OP") {
        return sendModuleForbidden(
          res,
          "ipdNursePanel",
          "Nurse IPD panel is not included in your subscription plan.",
        );
      }
      andConditions.push({ patient_type: "OP" });
    } else if (
      req.entitlements?.modules?.ipd !== true &&
      patientType !== "OP"
    ) {
      if (patientType) {
        return sendModuleForbidden(
          res,
          "ipd",
          "IPD patient access is not included in your subscription plan.",
        );
      }
      andConditions.push({ patient_type: "OP" });
    } else if (patientType) {
      if (patientType === "OP") {
        andConditions.push({ patient_type: "OP", active: true });
      } else if (patientType === "IP") {
        andConditions.push({
          $or: [{ patient_type: "IP" }, { patient_type: "OPtoIP" }],
          active: true,
        });
      } else if (patientType === "discharged") {
        andConditions.push({ active: false });
      }
    }

    if (status === "active") {
      andConditions.push({ active: true });
    } else if (status === "inactive") {
      andConditions.push({ active: false });
    }

    if (paymentMethod) {
      andConditions.push({ paymentMethod });
    }

    if (insuranceOnly === "true") {
      andConditions.push({
        $or: [
          { paymentMethod: "Insurance" },
          {
            insurance_providerId: { $exists: true, $nin: [null, ""] },
          },
        ],
      });
    }

    if (insuranceProviderId) {
      andConditions.push({ insurance_providerId: insuranceProviderId });
    }

    if (maxDaysAdmitted) {
      const cutoff = dayjs()
        .subtract(parseInt(maxDaysAdmitted, 10), "day")
        .format("YYYY-MM-DD");
      andConditions.push({
        $or: [
          { admissionDate: { $gte: cutoff } },
          { registration_date: { $gte: cutoff } },
        ],
      });
    }

    if (minDaysAdmitted) {
      const cutoff = dayjs()
        .subtract(parseInt(minDaysAdmitted, 10), "day")
        .format("YYYY-MM-DD");
      andConditions.push({
        $or: [
          { admissionDate: { $lte: cutoff } },
          { registration_date: { $lte: cutoff } },
        ],
      });
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

    const formattedPatients = patients.map((patient) => ({
      ...patient.toObject(),
      registration_date: new Date(
        patient.registration_date,
      ).toLocaleDateString(),
    }));

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
    if (isDoctorWithoutIpdDoctorRecord(req) || isNurseWithoutIpdPanel(req)) {
      query.patient_type = "OP";
    }
    const patients = await Patient.find(query);
    res.json(patients);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get patient by ID
router.get("/:id", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    const patient = await Patient.findOne({
      UMRNo: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    if (blockInpatientRecordAccess(req, res, patient)) return;
    res.json(patient);
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
    const patient = new Patient({ ...req.body, hospitalId: req.hospitalId });
    const newPatient = await patient.save();
    res.status(201).json(newPatient);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update patient
router.put("/:id", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    const existingPatient = await Patient.findOne({
      UMRNo: req.params.id,
      hospitalId: req.hospitalId,
    });
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
    const patient = await Patient.findOneAndUpdate(
      { UMRNo: req.params.id, hospitalId: req.hospitalId },
      { $set: req.body },
      { new: true, runValidators: true },
    );
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    res.json(patient);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete patient
router.delete("/:id", async (req, res) => {
  try {
    const Patient = req.tenantDb.model("Patient");
    const existingPatient = await Patient.findOne({
      UMRNo: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!existingPatient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    if (blockInpatientRecordAccess(req, res, existingPatient)) return;
    const patient = await Patient.findOneAndDelete({
      UMRNo: req.params.id,
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
    const patient = await Patient.findOne({
      UMRNo: req.params.id,
      hospitalId: req.hospitalId,
    });
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
    const patient = await Patient.findOne({
      UMRNo: req.params.id,
      hospitalId: req.hospitalId,
    });
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

    const patient = await Patient.findOne({
      UMRNo: id,
      hospitalId: req.hospitalId,
    });
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

    const insuranceCompany = (insuranceCompanies || []).find(
      (c) => String(c._id) === String(patient.insurance_providerId),
    );

    const settings = insuranceSettingsDoc?.toObject?.() || {};
    const billBreakdown = calculateBillBreakdown(
      patient,
      consultationReceipts,
      actionReceipts,
      diagnosticsReceipts,
      pharmacyReceipts,
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
            coPayType: patient.coPayType || "percentage",
            deductible: 0,
            coveragePercentage: 0,
            coverageLimit: 0,
            serviceCoverageDetails: {},
            tariffFound: false,
            tariffValid: false,
          }
        : calculateInsuranceCoverage(
            patient,
            insuranceTariffs,
            insuranceExclusions,
            billBreakdown,
            { endDate: calculateEndDate, settings },
          );

    const totalAdvancePaid = calculateTotalAdvance(
      advanceReceipts,
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
        patient_type: patient.patient_type,
        paymentMethod: patient.paymentMethod,
        insurance_providerId: patient.insurance_providerId,
        insurance_provider:
          patient.insurance_provider || insuranceCompany?.name || "",
        policy_number: patient.policy_number || "",
        coPayPercentage: patient.coPayPercentage,
        coPayLimit: patient.coPayLimit,
        coPayType: patient.coPayType,
        street_address: patient.street_address,
        city: patient.city,
        state: patient.state,
        postal_code: patient.postal_code,
        admissionDate: patient.admissionDate,
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
