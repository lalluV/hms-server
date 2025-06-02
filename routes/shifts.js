const express = require("express");
const router = express.Router();
const Shift = require("../models/Shift");

// Get all shifts
router.get("/", async (req, res) => {
  try {
    const shifts = await Shift.find({});
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get shift by ID
router.get("/:id", async (req, res) => {
  try {
    const shift = await Shift.findOne({ id: req.params.id });
    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }
    res.json(shift);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new shift
router.post("/", async (req, res) => {
  try {
    const shift = new Shift(req.body);
    const newShift = await shift.save();
    res.status(201).json(newShift);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update shift
router.put("/:id", async (req, res) => {
  try {
    const shift = await Shift.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
    );
    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }
    res.json(shift);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete shift
router.delete("/:id", async (req, res) => {
  try {
    const shift = await Shift.findOneAndDelete({ id: req.params.id });
    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }
    res.json({ message: "Shift deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get shifts by staff ID
router.get("/staff/:staffId", async (req, res) => {
  try {
    const shifts = await Shift.find({ staffId: req.params.staffId });
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get shifts by type
router.get("/type/:type", async (req, res) => {
  try {
    const shifts = await Shift.find({ type: req.params.type });
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get shifts by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const shifts = await Shift.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    });
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
