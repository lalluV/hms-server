const express = require("express");
const router = express.Router();
const Staff = require("../models/Staff");

// Get all staff members
router.get("/", async (req, res) => {
  try {
    const staff = await Staff.find({});
    res.json(staff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get staff member by ID
router.get("/:id", async (req, res) => {
  try {
    const staff = await Staff.findOne({ userId: req.params.id });
    if (!staff) {
      return res.status(404).json({ message: "Staff member not found" });
    }
    res.json(staff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new staff member
router.post("/", async (req, res) => {
  try {
    const staff = new Staff(req.body);
    const newStaff = await staff.save();
    res.status(201).json(newStaff);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update staff member
router.put("/:id", async (req, res) => {
  try {
    const staff = await Staff.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
    );
    if (!staff) {
      return res.status(404).json({ message: "Staff member not found" });
    }
    res.json(staff);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete staff member
router.delete("/:id", async (req, res) => {
  try {
    const staff = await Staff.findOneAndDelete({ id: req.params.id });
    if (!staff) {
      return res.status(404).json({ message: "Staff member not found" });
    }
    res.json({ message: "Staff member deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get staff by department
router.get("/department/:department", async (req, res) => {
  try {
    const staff = await Staff.find({ department: req.params.department });
    res.json(staff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get staff by type
router.get("/type/:type", async (req, res) => {
  try {
    const staff = await Staff.find({ type: req.params.type });
    res.json(staff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get staff by status
router.get("/status/:status", async (req, res) => {
  try {
    const staff = await Staff.find({ status: req.params.status });
    res.json(staff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update staff status
router.put("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const staff = await Staff.findOneAndUpdate(
      { id: req.params.id },
      { $set: { status } },
      { new: true }
    );
    if (!staff) {
      return res.status(404).json({ message: "Staff member not found" });
    }
    res.json(staff);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;
