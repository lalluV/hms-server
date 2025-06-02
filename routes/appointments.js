const express = require("express");
const router = express.Router();
const Appointment = require("../models/Appointment");

// Get all appointments
router.get("/", async (req, res) => {
  try {
    const appointments = await Appointment.find({});
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get appointment by ID
router.get("/:id", async (req, res) => {
  try {
    const appointment = await Appointment.findOne({ id: req.params.id });
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new appointment
router.post("/", async (req, res) => {
  try {
    const appointment = new Appointment(req.body);
    const newAppointment = await appointment.save();
    res.status(201).json(newAppointment);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update appointment
router.put("/:id", async (req, res) => {
  try {
    const appointment = await Appointment.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
    );
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    res.json(appointment);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete appointment
router.delete("/:id", async (req, res) => {
  try {
    const appointment = await Appointment.findOneAndDelete({
      id: req.params.id,
    });
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    res.json({ message: "Appointment deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get appointments by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const appointments = await Appointment.find({
      doctorId: req.params.doctorId,
    });
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get appointments by patient ID
router.get("/patient/:patientId", async (req, res) => {
  try {
    const appointments = await Appointment.find({
      patientId: req.params.patientId,
    });
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
