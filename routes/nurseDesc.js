const express = require("express");
const router = express.Router();
const NurseDesc = require("../models/NurseDesc");
const auth = require("../middleware/auth");

router.use(auth);

// Get all nurse descriptions
router.get("/", async (req, res) => {
  try {
    const descriptions = await NurseDesc.find({
      hospitalId: req.hospitalId,
    });
    res.json(descriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get nurse description by ID
router.get("/:id", async (req, res) => {
  try {
    const description = await NurseDesc.findOne({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!description) {
      return res.status(404).json({ message: "Nurse description not found" });
    }
    res.json(description);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new nurse description
router.post("/", async (req, res) => {
  try {
    const description = new NurseDesc({
      ...req.body,
      hospitalId: req.hospitalId,
    });
    const newDescription = await description.save();
    res.status(201).json(newDescription);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update nurse description
router.put("/:id", async (req, res) => {
  try {
    const description = await NurseDesc.findOneAndUpdate(
      { id: req.params.id, hospitalId: req.hospitalId },
      req.body,
      { new: true }
    );
    if (!description) {
      return res.status(404).json({ message: "Nurse description not found" });
    }
    res.json(description);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete nurse description
router.delete("/:id", async (req, res) => {
  try {
    const description = await NurseDesc.findOneAndDelete({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!description) {
      return res.status(404).json({ message: "Nurse description not found" });
    }
    res.json({ message: "Nurse description deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get descriptions by nurse ID
router.get("/nurse/:nurseId", async (req, res) => {
  try {
    const descriptions = await NurseDesc.find({
      nurseId: req.params.nurseId,
      hospitalId: req.hospitalId,
    });
    res.json(descriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get descriptions by patient ID
router.get("/patient/:patientId", async (req, res) => {
  try {
    const descriptions = await NurseDesc.find({
      patientId: req.params.patientId,
      hospitalId: req.hospitalId,
    });
    res.json(descriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get descriptions by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const descriptions = await NurseDesc.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      hospitalId: req.hospitalId,
    });
    res.json(descriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
