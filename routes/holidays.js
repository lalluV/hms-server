const express = require("express");
const router = express.Router();
const Holiday = require("../models/Holiday");

// Get all holidays
router.get("/", async (req, res) => {
  try {
    const holidays = await Holiday.find({});
    res.json(holidays);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get holiday by ID
router.get("/:id", async (req, res) => {
  try {
    const holiday = await Holiday.findOne({ id: req.params.id });
    if (!holiday) {
      return res.status(404).json({ message: "Holiday not found" });
    }
    res.json(holiday);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new holiday
router.post("/", async (req, res) => {
  try {
    const holiday = new Holiday(req.body);
    const newHoliday = await holiday.save();
    res.status(201).json(newHoliday);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update holiday
router.put("/:id", async (req, res) => {
  try {
    const holiday = await Holiday.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
    );
    if (!holiday) {
      return res.status(404).json({ message: "Holiday not found" });
    }
    res.json(holiday);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete holiday
router.delete("/:id", async (req, res) => {
  try {
    const holiday = await Holiday.findOneAndDelete({ id: req.params.id });
    if (!holiday) {
      return res.status(404).json({ message: "Holiday not found" });
    }
    res.json({ message: "Holiday deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get holidays by type
router.get("/type/:type", async (req, res) => {
  try {
    const holidays = await Holiday.find({ type: req.params.type });
    res.json(holidays);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get holidays by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const holidays = await Holiday.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    });
    res.json(holidays);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
