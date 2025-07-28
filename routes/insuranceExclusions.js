const express = require("express");
const router = express.Router();
const InsuranceExclusion = require("../models/InsuranceExclusion");

// Get all insurance exclusions
router.get("/", async (req, res) => {
  try {
    const exclusions = await InsuranceExclusion.find();
    res.json(exclusions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get insurance exclusion by ID
router.get("/:id", async (req, res) => {
  try {
    const exclusion = await InsuranceExclusion.findById(req.params.id);
    if (!exclusion)
      return res.status(404).json({ message: "Exclusion not found" });
    res.json(exclusion);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create insurance exclusion
router.post("/", async (req, res) => {
  const exclusion = new InsuranceExclusion(req.body);
  try {
    const newExclusion = await exclusion.save();
    res.status(201).json(newExclusion);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update insurance exclusion
router.put("/:id", async (req, res) => {
  try {
    const exclusion = await InsuranceExclusion.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!exclusion)
      return res.status(404).json({ message: "Exclusion not found" });
    res.json(exclusion);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete insurance exclusion
router.delete("/:id", async (req, res) => {
  try {
    const exclusion = await InsuranceExclusion.findByIdAndDelete(req.params.id);
    if (!exclusion)
      return res.status(404).json({ message: "Exclusion not found" });
    res.json({ message: "Exclusion deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get exclusions by companyId
router.get("/company/:companyId", async (req, res) => {
  try {
    const exclusions = await InsuranceExclusion.find({
      companyId: req.params.companyId,
    });
    res.json(exclusions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
