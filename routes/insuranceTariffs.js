const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);

// Get all insurance tariffs
router.get("/", async (req, res) => {
  try {
    const InsuranceTariff = req.tenantDb.model("InsuranceTariff");
    const tariffs = await InsuranceTariff.find({ hospitalId: req.hospitalId });
    res.json(tariffs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get insurance tariff by ID
router.get("/:id", async (req, res) => {
  try {
    const InsuranceTariff = req.tenantDb.model("InsuranceTariff");
    const tariff = await InsuranceTariff.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!tariff) return res.status(404).json({ message: "Tariff not found" });
    res.json(tariff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create insurance tariff
router.post("/", async (req, res) => {
  try {
    const InsuranceTariff = req.tenantDb.model("InsuranceTariff");
    const tariff = new InsuranceTariff({
      ...req.body,
      hospitalId: req.hospitalId,
    });
    const newTariff = await tariff.save();
    res.status(201).json(newTariff);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update insurance tariff
router.put("/:id", async (req, res) => {
  try {
    const InsuranceTariff = req.tenantDb.model("InsuranceTariff");
    const tariff = await InsuranceTariff.findOneAndUpdate(
      { _id: req.params.id, hospitalId: req.hospitalId },
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
    const InsuranceTariff = req.tenantDb.model("InsuranceTariff");
    const tariff = await InsuranceTariff.findOneAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!tariff) return res.status(404).json({ message: "Tariff not found" });
    res.json({ message: "Tariff deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get tariffs by companyId
router.get("/company/:companyId", async (req, res) => {
  try {
    const InsuranceTariff = req.tenantDb.model("InsuranceTariff");
    const tariffs = await InsuranceTariff.find({
      companyId: req.params.companyId,
      hospitalId: req.hospitalId,
    });
    res.json(tariffs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
