const express = require("express");
const router = express.Router();
const IndentStore = require("../models/IndentStore");
const auth = require("../middleware/auth");

router.use(auth);

// Get all indents
router.get("/", async (req, res) => {
  try {
    const indents = await IndentStore.find({ hospitalId: req.hospitalId });
    res.json(indents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get indent by ID
router.get("/:id", async (req, res) => {
  try {
    const indent = await IndentStore.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
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
  const indent = new IndentStore({ ...req.body, hospitalId: req.hospitalId });
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
      { indentId: req.params.id, hospitalId: req.hospitalId },
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
    const indent = await IndentStore.findOneAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
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
    const indents = await IndentStore.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
    });
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
      hospitalId: req.hospitalId,
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
      hospitalId: req.hospitalId,
    });
    res.json(indents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
