const express = require("express");
const router = express.Router();
const Doctor = require("../models/Doctor");

// Get all doctors
router.get("/", async (req, res) => {
  try {
    const doctors = await Doctor.find({});
    res.json(doctors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get doctor by ID
router.get("/:id", async (req, res) => {
  try {
    const doctor = await Doctor.findOne({ id: req.params.id });
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }
    res.json(doctor);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new doctor
router.post("/", async (req, res) => {
  try {
    const doctor = new Doctor(req.body);
    const newDoctor = await doctor.save();
    res.status(201).json(newDoctor);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update doctor
router.put("/:id", async (req, res) => {
  try {
    const doctor = await Doctor.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
    );
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }
    res.json(doctor);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete doctor
router.delete("/:id", async (req, res) => {
  try {
    const doctor = await Doctor.findOneAndDelete({ id: req.params.id });
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }
    res.json({ message: "Doctor deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
