const express = require("express");
const router = express.Router();
const Leave = require("../models/Leave");

// Get all leaves
router.get("/", async (req, res) => {
  try {
    const leaves = await Leave.find({});
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get leave by ID
router.get("/:id", async (req, res) => {
  try {
    const leave = await Leave.findOne({ id: req.params.id });
    if (!leave) {
      return res.status(404).json({ message: "Leave not found" });
    }
    res.json(leave);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new leave request
router.post("/", async (req, res) => {
  try {
    const leave = new Leave(req.body);
    const newLeave = await leave.save();
    res.status(201).json(newLeave);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update leave request
router.put("/:id", async (req, res) => {
  try {
    const leave = await Leave.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
    );
    if (!leave) {
      return res.status(404).json({ message: "Leave not found" });
    }
    res.json(leave);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete leave request
router.delete("/:id", async (req, res) => {
  try {
    const leave = await Leave.findOneAndDelete({ id: req.params.id });
    if (!leave) {
      return res.status(404).json({ message: "Leave not found" });
    }
    res.json({ message: "Leave deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get leaves by staff ID
router.get("/staff/:staffId", async (req, res) => {
  try {
    const leaves = await Leave.find({ staffId: req.params.staffId });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get leaves by status
router.get("/status/:status", async (req, res) => {
  try {
    const leaves = await Leave.find({ status: req.params.status });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get leaves by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const leaves = await Leave.find({
      startDate: { $lte: new Date(endDate) },
      endDate: { $gte: new Date(startDate) },
    });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
