const express = require("express");
const router = express.Router();
const Prescription = require("../models/Prescription");

// Get all prescriptions
router.get("/", async (req, res) => {
  try {
    const prescriptions = await Prescription.find({});
    res.json(prescriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get prescription by ID
router.get("/:id", async (req, res) => {
  try {
    const prescription = await Prescription.findOne({ id: req.params.id });
    if (!prescription) {
      return res.status(404).json({ message: "Prescription not found" });
    }
    res.json(prescription);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new prescription
router.post("/", async (req, res) => {
  try {
    const prescription = new Prescription(req.body);
    const newPrescription = await prescription.save();
    res.status(201).json(newPrescription);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update prescription
router.put("/:id", async (req, res) => {
  try {
    const prescription = await Prescription.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
    );
    if (!prescription) {
      return res.status(404).json({ message: "Prescription not found" });
    }
    res.json(prescription);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete prescription
router.delete("/:id", async (req, res) => {
  try {
    const prescription = await Prescription.findOneAndDelete({
      id: req.params.id,
    });
    if (!prescription) {
      return res.status(404).json({ message: "Prescription not found" });
    }
    res.json({ message: "Prescription deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get prescriptions by patient ID
router.get("/patient/:patientId", async (req, res) => {
  try {
    const prescriptions = await Prescription.find({
      patientId: req.params.patientId,
    });
    res.json(prescriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get prescriptions by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const prescriptions = await Prescription.find({
      doctorId: req.params.doctorId,
    });
    res.json(prescriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get prescriptions by status
router.get("/status/:status", async (req, res) => {
  try {
    const prescriptions = await Prescription.find({
      status: req.params.status,
    });
    res.json(prescriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get prescriptions by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const prescriptions = await Prescription.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    });
    res.json(prescriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
