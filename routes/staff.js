const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
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

// Get staff member by ID (userId)
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

// Get staff member by employee ID
router.get("/employee/:employeeId", async (req, res) => {
  try {
    const staff = await Staff.findOne({ id: req.params.employeeId });
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
    const { password, ...staffData } = req.body;

    // Check if staff member with userId already exists
    if (staffData.userId) {
      const existingStaff = await Staff.findOne({ userId: staffData.userId });
      if (existingStaff) {
        return res.status(400).json({ message: "User ID already exists" });
      }
    }

    // Hash password if provided
    if (password) {
      const salt = await bcrypt.genSalt(10);
      staffData.password = await bcrypt.hash(password, salt);
    }

    const staff = new Staff(staffData);
    const newStaff = await staff.save();
    res.status(201).json(newStaff);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update staff member by userId (must come before /:id route)
router.put("/user/:userId", async (req, res) => {
  try {
    const { password, ...updateData } = req.body;

    // Hash password if provided
    if (password) {
      const salt = await bcrypt.genSalt(10);
      updateData.password = await bcrypt.hash(password, salt);
    }

    const staff = await Staff.findOneAndUpdate(
      { userId: req.params.userId },
      updateData,
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

// Update staff member
router.put("/:id", async (req, res) => {
  try {
    const { password, ...updateData } = req.body;

    // Hash password if provided
    if (password) {
      const salt = await bcrypt.genSalt(10);
      updateData.password = await bcrypt.hash(password, salt);
    }

    const staff = await Staff.findOneAndUpdate(
      { id: req.params.id },
      updateData,
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
