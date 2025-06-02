const express = require("express");
const router = express.Router();
const Patient = require("../models/Patient");

// Get all patients
router.get("/", async (req, res) => {
  try {
    const patients = await Patient.find({});
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
