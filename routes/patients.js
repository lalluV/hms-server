const express = require("express");
const router = express.Router();
const Patient = require("../models/Patient");
const Action = require("../models/Action");
const Consultation = require("../models/Consultation");
const DiagnosticsReceipt = require("../models/DiagnosticsReceipt");
const PharmacyReceipt = require("../models/PharmacyReceipt");
const AdvanceReceipt = require("../models/AdvanceReceipt");
const InsuranceTariff = require("../models/InsuranceTariff");
const InsuranceExclusion = require("../models/InsuranceExclusion");
const auth = require("../middleware/auth");

router.use(auth);

// Get all patients with pagination support
router.get("/", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = "",
      patientType = "",
      status = "",
      paymentMethod = "",
    } = req.query;

    // Build query
    const query = { hospitalId: req.hospitalId };

    // Filter by patient type (OP, IP, OPtoIP)
    if (patientType) {
      if (patientType === "OP") {
        query.patient_type = "OP";
        query.active = true;
      } else if (patientType === "IP") {
        query.$or = [{ patient_type: "IP" }, { patient_type: "OPtoIP" }];
        query.active = true;
      } else if (patientType === "discharged") {
        query.active = false;
      }
    }

    // Filter by status (active/inactive)
    if (status === "active") {
      query.active = true;
    } else if (status === "inactive") {
      query.active = false;
    }

    // Filter by payment method
    if (paymentMethod) {
      query.paymentMethod = paymentMethod;
    }

    // Search filter
    if (search && search.length >= 2) {
      query.$or = [
        { UMRNo: { $regex: search, $options: "i" } },
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count
    const total = await Patient.countDocuments(query);

    // Get paginated patients
    const patients = await Patient.find(query)
      .sort({ registration_date: -1 })
      .skip(skip)
      .limit(limitNum);

    // Format registration date
    const formattedPatients = patients.map((patient) => ({
      ...patient.toObject(),
      registration_date: new Date(
        patient.registration_date
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
    const patients = await Patient.find({
      phone: req.params.phoneNumber,
      hospitalId: req.hospitalId,
    });
    res.json(patients);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get patient by ID
router.get("/:id", async (req, res) => {
  try {
    const patient = await Patient.findOne({
      UMRNo: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    res.json(patient);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new patient
router.post("/", async (req, res) => {
  try {
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
    const patient = await Patient.findOneAndUpdate(
      { UMRNo: req.params.id, hospitalId: req.hospitalId },
      { $set: req.body },
      { new: true, runValidators: true }
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
    const patient = await Patient.findOne({
      UMRNo: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }

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
    const patient = await Patient.findOne({
      UMRNo: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    const historyIndex = patient.medicalHistory.findIndex(
      (h) => h._id.toString() === req.params.historyId
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
    const { id } = req.params;
    const { endDate } = req.query;

    const patient = await Patient.findOne({
      UMRNo: id,
      hospitalId: req.hospitalId,
    });
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    // Fetch all receipts for this patient
    const consultationReceipts = await Consultation.find({
      patientId: id,
      hospitalId: req.hospitalId,
    });
    const actionReceipts = await Action.find({
      patientId: id,
      hospitalId: req.hospitalId,
    });
    const diagnosticsReceipts = await DiagnosticsReceipt.find({
      patientId: id,
      hospitalId: req.hospitalId,
    });
    const pharmacyReceipts = await PharmacyReceipt.find({
      patientId: id,
      hospitalId: req.hospitalId,
    });
    const advanceReceipts = await AdvanceReceipt.find({
      patientId: id,
      hospitalId: req.hospitalId,
    });

    // Fetch insurance data
    const insuranceTariffs = await InsuranceTariff.find({
      hospitalId: req.hospitalId,
    });
    const insuranceExclusions = await InsuranceExclusion.find({
      hospitalId: req.hospitalId,
    });

    // Calculate bill breakdown
    const dayjs = require("dayjs");
    const calculateEndDate = endDate ? new Date(endDate) : new Date();
    const isDischarged = patient?.active === false;
    const dischargeDt = isDischarged
      ? patient?.dischargeDate || dayjs(calculateEndDate).format("YYYY-MM-DD")
      : dayjs(calculateEndDate).format("YYYY-MM-DD");

    // Calculate ward charges
    let wardCharges = 0;
    const patientTransfers = patient.transfers || [];
    for (let i = 0; i < patientTransfers.length; i++) {
      const currentTransfer = patientTransfers[i];
      const nextTransfer = patientTransfers[i + 1] || {
        transferDate: dischargeDt,
      };
      const daysSpent =
        dayjs(nextTransfer.transferDate).diff(
          dayjs(currentTransfer.transferDate),
          "day"
        ) + 1;
      const wardPrice = parseInt(currentTransfer.price, 10);
      wardCharges += daysSpent * wardPrice;
    }

    // Calculate consultation charges
    const consultationCharges = consultationReceipts.reduce(
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
    const investigationCharges = diagnosticsReceipts.reduce(
      (total, receipt) =>
        total +
        (receipt.items || []).reduce(
          (sum, item) => sum + parseFloat(item.price || 0),
          0
        ),
      0
    );

    // Calculate procedure charges
    const procedureCharges = actionReceipts.reduce(
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
    const serviceCharges = actionReceipts.reduce(
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
    const pharmacyCharges = pharmacyReceipts.reduce(
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

    const billBreakdown = {
      Ward: wardCharges,
      Consultation: consultationCharges,
      Investigation: investigationCharges,
      Procedure: procedureCharges,
      Service: serviceCharges,
      Pharmacy: pharmacyCharges,
    };

    // Calculate insurance coverage
    const applicableTariff = insuranceTariffs.find(
      (t) => t.companyId === patient.insurance_providerId
    );
    const applicableExclusions = insuranceExclusions.filter(
      (e) => e.companyId === patient.insurance_providerId
    );

    const totalBill = Object.values(billBreakdown).reduce(
      (sum, amount) => sum + (amount || 0),
      0
    );

    // Apply exclusions
    const exclusionsApplied = [];
    const billAfterExclusions = { ...billBreakdown };
    applicableExclusions.forEach((exclusion) => {
      if (billAfterExclusions[exclusion.excludedService]) {
        exclusionsApplied.push({
          service: exclusion.excludedService,
          amount: billAfterExclusions[exclusion.excludedService],
          reason: exclusion.description,
        });
        billAfterExclusions[exclusion.excludedService] = 0;
      }
    });

    // Calculate coverage (simplified - you may want to use the full calculation logic)
    let insuranceCoverage = 0;
    let patientPayable = totalBill;
    const coverageBreakdown = [];

    if (applicableTariff) {
      Object.entries(billAfterExclusions).forEach(([service, amount]) => {
        if (amount > 0) {
          const serviceKey = service.toLowerCase().replace(" ", "");
          const coveragePercentage =
            applicableTariff[`${serviceKey}CoveragePercentage`] ||
            applicableTariff.coveragePercentage ||
            0;
          const deductible =
            applicableTariff[`${serviceKey}Deductible`] ||
            applicableTariff.deductible ||
            0;
          const coverageLimit =
            applicableTariff[`${serviceKey}CoverageLimit`] ||
            applicableTariff.coverageLimit ||
            0;

          const amountAfterDeductible = Math.max(0, amount - deductible);
          let coverage = (amountAfterDeductible * coveragePercentage) / 100;

          if (coverageLimit > 0) {
            coverage = Math.min(coverage, coverageLimit);
          }

          insuranceCoverage += coverage;
          const patientShare = amount - coverage;
          patientPayable -= coverage;

          coverageBreakdown.push({
            service,
            amount,
            coverage,
            patientShare,
            excluded: false,
            coveragePercentage,
            coverageLimit,
            deductible,
          });
        }
      });
    }

    patientPayable = Math.max(0, patientPayable);

    res.json({
      totalBill,
      insuranceCoverage,
      patientPayable,
      breakdown: billBreakdown,
      coverageBreakdown,
      exclusionsApplied,
      endDate: calculateEndDate,
      patient: {
        UMRNo: patient.UMRNo,
        name: patient.name,
        age: patient.age,
        gender: patient.gender,
        phone: patient.phone,
        insurance_providerId: patient.insurance_providerId,
      },
    });
  } catch (error) {
    console.error("Error calculating interim bill:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
