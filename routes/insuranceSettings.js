const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "insurance" });

const DEFAULT_SETTINGS = {
  defaultCoveragePercentage: 80,
  defaultCoverageLimit: 0,
  defaultProcessingTime: "7-10 days",
  autoCalculateInsurance: true,
  requirePolicyNumber: true,
  requiredDocuments: [
    "Insurance Card",
    "Policy Document",
    "ID Proof",
  ],
  optionalDocuments: [
    "Previous Medical Records",
    "Discharge Summary",
    "Prescription Details",
  ],
};

router.get("/", async (req, res) => {
  try {
    const InsuranceSettings = req.tenantDb.model("InsuranceSettings");
    let settings = await InsuranceSettings.findOne({
      hospitalId: req.hospitalId,
    });
    if (!settings) {
      return res.json({ ...DEFAULT_SETTINGS, _defaults: true });
    }
    res.json(settings.toObject());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put("/", async (req, res) => {
  try {
    const InsuranceSettings = req.tenantDb.model("InsuranceSettings");
    const settings = await InsuranceSettings.findOneAndUpdate(
      { hospitalId: req.hospitalId },
      { ...req.body, hospitalId: req.hospitalId },
      { new: true, upsert: true, runValidators: true },
    );
    res.json(settings);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;
