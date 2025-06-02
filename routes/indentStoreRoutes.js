const express = require("express");
const router = express.Router();
const IndentStore = require("../models/IndentStore");

// Get all indents
router.get("/", async (req, res) => {
  try {
    const indents = await IndentStore.find();
    res.json(indents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get indent by ID
router.get("/:id", async (req, res) => {
  try {
    const indent = await IndentStore.findById(req.params.id);
    if (!indent) {
      return res.status(404).json({ message: "Indent not found" });
    }
    res.json(indent);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create indent
router.post("/", async (req, res) => {
  const indent = new IndentStore(req.body);
  try {
    const newIndent = await indent.save();
    res.status(201).json(newIndent);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update indent
router.put("/:id", async (req, res) => {
  try {
    const indent = await IndentStore.findOneAndUpdate(
      { indentId: req.params.id },
      req.body,
      { new: true }
    );
    if (!indent) {
      return res.status(404).json({ message: "Indent not found" });
    }
    res.json(indent);
  } catch (error) {
    console.error("Update error:", error);
    res.status(400).json({ message: error.message });
  }
});

// Delete indent
router.delete("/:id", async (req, res) => {
  try {
    const indent = await IndentStore.findByIdAndDelete(req.params.id);
    if (!indent) {
      return res.status(404).json({ message: "Indent not found" });
    }
    res.json({ message: "Indent deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get indents by status
router.get("/status/:status", async (req, res) => {
  try {
    const indents = await IndentStore.find({ status: req.params.status });
    res.json(indents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get indents by department
router.get("/department/:department", async (req, res) => {
  try {
    const indents = await IndentStore.find({
      department: req.params.department,
    });
    res.json(indents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get indents by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const indents = await IndentStore.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    });
    res.json(indents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
