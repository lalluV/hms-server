const express = require("express");
const router = express.Router();
const Action = require("../models/Action");

// Get all actions
router.get("/", async (req, res) => {
  try {
    const actions = await Action.find({});
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get action by ID
router.get("/:id", async (req, res) => {
  try {
    const action = await Action.findOne({ id: req.params.id });
    if (!action) {
      return res.status(404).json({ message: "Action not found" });
    }
    res.json(action);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new action
router.post("/", async (req, res) => {
  try {
    const action = new Action(req.body);
    const newAction = await action.save();
    res.status(201).json(newAction);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update action
router.put("/:id", async (req, res) => {
  try {
    const action = await Action.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
    );
    if (!action) {
      return res.status(404).json({ message: "Action not found" });
    }
    res.json(action);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete action
router.delete("/:id", async (req, res) => {
  try {
    const action = await Action.findOneAndDelete({ id: req.params.id });
    if (!action) {
      return res.status(404).json({ message: "Action not found" });
    }
    res.json({ message: "Action deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by patient ID
router.get("/patient/:patientId", async (req, res) => {
  try {
    const actions = await Action.find({
      patientId: req.params.patientId,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const actions = await Action.find({
      doctorId: req.params.doctorId,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by type
router.get("/type/:type", async (req, res) => {
  try {
    const actions = await Action.find({
      type: req.params.type,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by status
router.get("/status/:status", async (req, res) => {
  try {
    const actions = await Action.find({
      status: req.params.status,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const actions = await Action.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
