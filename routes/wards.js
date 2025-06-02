const express = require("express");
const router = express.Router();
const Ward = require("../models/Ward");

// Get all wards
router.get("/", async (req, res) => {
  try {
    const wards = await Ward.find({});
    res.json(wards);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get ward by ID
router.get("/:id", async (req, res) => {
  try {
    const ward = await Ward.findOne({ wardId: req.params.id });
    if (!ward) {
      return res.status(404).json({ message: "Ward not found" });
    }
    res.json(ward);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new ward
router.post("/", async (req, res) => {
  try {
    const ward = new Ward(req.body);
    const newWard = await ward.save();
    res.status(201).json(newWard);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update ward
router.put("/:id", async (req, res) => {
  try {
    const ward = await Ward.findOneAndUpdate(
      { wardId: req.params.id },
      req.body,
      {
        new: true,
      }
    );
    if (!ward) {
      return res.status(404).json({ message: "Ward not found" });
    }
    res.json(ward);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete ward
router.delete("/:id", async (req, res) => {
  try {
    const ward = await Ward.findOneAndDelete({ wardId: req.params.id });
    if (!ward) {
      return res.status(404).json({ message: "Ward not found" });
    }
    res.json({ message: "Ward deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get ward by type
router.get("/type/:type", async (req, res) => {
  try {
    const wards = await Ward.find({ type: req.params.type });
    res.json(wards);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get ward by status
router.get("/status/:status", async (req, res) => {
  try {
    const wards = await Ward.find({ status: req.params.status });
    res.json(wards);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
