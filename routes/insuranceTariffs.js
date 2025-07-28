const express = require("express");
const router = express.Router();
const InsuranceTariff = require("../models/InsuranceTariff");

// Get all insurance tariffs
router.get("/", async (req, res) => {
  try {
    const tariffs = await InsuranceTariff.find();
    res.json(tariffs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get insurance tariff by ID
router.get("/:id", async (req, res) => {
  try {
    const tariff = await InsuranceTariff.findById(req.params.id);
    if (!tariff) return res.status(404).json({ message: "Tariff not found" });
    res.json(tariff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create insurance tariff
router.post("/", async (req, res) => {
  const tariff = new InsuranceTariff(req.body);
  try {
    const newTariff = await tariff.save();
    res.status(201).json(newTariff);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update insurance tariff
router.put("/:id", async (req, res) => {
  try {
    const tariff = await InsuranceTariff.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!tariff) return res.status(404).json({ message: "Tariff not found" });
    res.json(tariff);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete insurance tariff
router.delete("/:id", async (req, res) => {
  try {
    const tariff = await InsuranceTariff.findByIdAndDelete(req.params.id);
    if (!tariff) return res.status(404).json({ message: "Tariff not found" });
    res.json({ message: "Tariff deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get tariffs by companyId
router.get("/company/:companyId", async (req, res) => {
  try {
    const tariffs = await InsuranceTariff.find({
      companyId: req.params.companyId,
    });
    res.json(tariffs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
