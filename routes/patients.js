const express = require("express");
const router = express.Router();
const Patient = require("../models/Patient");

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
    const query = {};

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
    const patients = await Patient.find({ phone: req.params.phoneNumber });
    res.json(patients);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get patient by ID
router.get("/:id", async (req, res) => {
  try {
    const patient = await Patient.findOne({ UMRNo: req.params.id });
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
    const patient = new Patient(req.body);
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
      { UMRNo: req.params.id },
      req.body,
      { new: true }
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
    const patient = await Patient.findOneAndDelete({ UMRNo: req.params.id });
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
    const patient = await Patient.findOne({ UMRNo: req.params.id });
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
    const patient = await Patient.findOne({ UMRNo: req.params.id });
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

module.exports = router;
