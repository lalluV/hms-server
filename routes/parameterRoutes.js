const express = require("express");
const router = express.Router();
const Parameter = require("../models/Parameter");

// Get all parameters
router.get("/", async (req, res) => {
  try {
    const parameters = await Parameter.find();
    res.json(parameters);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get parameter by ID
router.get("/:id", async (req, res) => {
  try {
    const parameter = await Parameter.findById(req.params.id);
    if (!parameter) {
      return res.status(404).json({ message: "Parameter not found" });
    }
    res.json(parameter);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create parameter
router.post("/", async (req, res) => {
  const parameter = new Parameter(req.body);
  try {
    const newParameter = await parameter.save();
    res.status(201).json(newParameter);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update parameter
router.put("/:id", async (req, res) => {
  try {
    const parameter = await Parameter.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!parameter) {
      return res.status(404).json({ message: "Parameter not found" });
    }
    res.json(parameter);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete parameter
router.delete("/:id", async (req, res) => {
  try {
    const parameter = await Parameter.findByIdAndDelete(req.params.id);
    if (!parameter) {
      return res.status(404).json({ message: "Parameter not found" });
    }
    res.json({ message: "Parameter deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get parameters by category
router.get("/category/:category", async (req, res) => {
  try {
    const parameters = await Parameter.find({ category: req.params.category });
    res.json(parameters);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
