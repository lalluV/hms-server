const express = require("express");
const router = express.Router();
const Diagnostic = require("../models/Diagnostic");

// Get all diagnostics
router.get("/", async (req, res) => {
  try {
    const diagnostics = await Diagnostic.find({});
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostic by ID
router.get("/:id", async (req, res) => {
  try {
    const diagnostic = await Diagnostic.findOne({ id: req.params.id });
    if (!diagnostic) {
      return res.status(404).json({ message: "Diagnostic not found" });
    }
    res.json(diagnostic);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new diagnostic
router.post("/", async (req, res) => {
  try {
    const diagnostic = new Diagnostic(req.body);
    const newDiagnostic = await diagnostic.save();
    res.status(201).json(newDiagnostic);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update diagnostic
router.put("/:id", async (req, res) => {
  try {
    const diagnostic = await Diagnostic.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
    );
    if (!diagnostic) {
      return res.status(404).json({ message: "Diagnostic not found" });
    }
    res.json(diagnostic);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete diagnostic
router.delete("/:id", async (req, res) => {
  try {
    const diagnostic = await Diagnostic.findOneAndDelete({ id: req.params.id });
    if (!diagnostic) {
      return res.status(404).json({ message: "Diagnostic not found" });
    }
    res.json({ message: "Diagnostic deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics by patient ID
router.get("/patient/:patientId", async (req, res) => {
  try {
    const diagnostics = await Diagnostic.find({
      patientId: req.params.patientId,
    });
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const diagnostics = await Diagnostic.find({
      doctorId: req.params.doctorId,
    });
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
