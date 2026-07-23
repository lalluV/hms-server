const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "core" });

function doctorIdFromReq(req) {
  return String(req.user?.id || req.user?._id || "").trim();
}

router.post("/", async (req, res) => {
  try {
    const doctorId = doctorIdFromReq(req);
    if (!doctorId) {
      return res.status(401).json({ message: "Doctor identity required" });
    }
    const ClinicalOrderPackage = req.tenantDb.model("ClinicalOrderPackage");
    const pkg = new ClinicalOrderPackage({
      ...req.body,
      hospitalId: req.hospitalId,
      doctorId,
      active: req.body.active !== false,
    });
    await pkg.save();
    res.status(201).json(pkg);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const doctorId = doctorIdFromReq(req);
    if (!doctorId) {
      return res.status(401).json({ message: "Doctor identity required" });
    }
    const ClinicalOrderPackage = req.tenantDb.model("ClinicalOrderPackage");
    const filter = {
      hospitalId: req.hospitalId,
      doctorId,
      active: { $ne: false },
    };
    if (req.query.kind) filter.kind = req.query.kind;
    if (req.query.scope) {
      filter.$or = [
        { scope: req.query.scope },
        { scope: "both" },
        { scope: { $exists: false } },
        { scope: null },
      ];
    }
    const packages = await ClinicalOrderPackage.find(filter).sort({
      updatedAt: -1,
    });
    res.json(packages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const doctorId = doctorIdFromReq(req);
    const ClinicalOrderPackage = req.tenantDb.model("ClinicalOrderPackage");
    const pkg = await ClinicalOrderPackage.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
      doctorId,
    });
    if (!pkg) {
      return res.status(404).json({ message: "Package not found" });
    }
    res.json(pkg);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const doctorId = doctorIdFromReq(req);
    const ClinicalOrderPackage = req.tenantDb.model("ClinicalOrderPackage");
    const { hospitalId: _h, doctorId: _d, _id, ...safeBody } = req.body || {};
    const pkg = await ClinicalOrderPackage.findOneAndUpdate(
      { _id: req.params.id, hospitalId: req.hospitalId, doctorId },
      { $set: safeBody },
      { new: true }
    );
    if (!pkg) {
      return res.status(404).json({ message: "Package not found" });
    }
    res.json(pkg);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const doctorId = doctorIdFromReq(req);
    const ClinicalOrderPackage = req.tenantDb.model("ClinicalOrderPackage");
    const pkg = await ClinicalOrderPackage.findOneAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
      doctorId,
    });
    if (!pkg) {
      return res.status(404).json({ message: "Package not found" });
    }
    res.json({ message: "Package deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
