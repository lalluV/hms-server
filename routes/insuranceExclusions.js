const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);

// Get all insurance exclusions
router.get("/", async (req, res) => {
  try {
    const InsuranceExclusion = req.tenantDb.model("InsuranceExclusion");
    const exclusions = await InsuranceExclusion.find({
      hospitalId: req.hospitalId,
    });
    res.json(exclusions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get insurance exclusion by ID
router.get("/:id", async (req, res) => {
  try {
    const InsuranceExclusion = req.tenantDb.model("InsuranceExclusion");
    const exclusion = await InsuranceExclusion.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!exclusion)
      return res.status(404).json({ message: "Exclusion not found" });
    res.json(exclusion);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create insurance exclusion
router.post("/", async (req, res) => {
  try {
    const InsuranceExclusion = req.tenantDb.model("InsuranceExclusion");
    const exclusion = new InsuranceExclusion({
      ...req.body,
      hospitalId: req.hospitalId,
    });
    const newExclusion = await exclusion.save();
    res.status(201).json(newExclusion);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update insurance exclusion
router.put("/:id", async (req, res) => {
  try {
    const InsuranceExclusion = req.tenantDb.model("InsuranceExclusion");
    const exclusion = await InsuranceExclusion.findOneAndUpdate(
      { _id: req.params.id, hospitalId: req.hospitalId },
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
    const InsuranceExclusion = req.tenantDb.model("InsuranceExclusion");
    const exclusion = await InsuranceExclusion.findOneAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
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
    const InsuranceExclusion = req.tenantDb.model("InsuranceExclusion");
    const exclusions = await InsuranceExclusion.find({
      companyId: req.params.companyId,
      hospitalId: req.hospitalId,
    });
    res.json(exclusions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
