const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "pharmacy" });

function adjustmentLookup(id, hospitalId) {
  const base = { hospitalId };
  if (mongoose.Types.ObjectId.isValid(id)) {
    return { ...base, _id: id };
  }
  return { ...base, reference: id };
}

async function nextReference(Adjustment, hospitalId) {
  const count = await Adjustment.countDocuments({ hospitalId });
  return `ADJ-${String(count + 1).padStart(5, "0")}`;
}

router.get("/", async (req, res) => {
  try {
    const Adjustment = req.tenantDb.model("Adjustment");
    const adjustments = await Adjustment.find({ hospitalId: req.hospitalId })
      .sort({ createdAt: -1 })
      .lean();
    res.json(adjustments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const Adjustment = req.tenantDb.model("Adjustment");
    const adjustment = await Adjustment.findOne(
      adjustmentLookup(req.params.id, req.hospitalId),
    ).lean();
    if (!adjustment) {
      return res.status(404).json({ message: "Adjustment not found" });
    }
    res.json(adjustment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const Adjustment = req.tenantDb.model("Adjustment");
    const reference =
      req.body.reference ||
      (await nextReference(Adjustment, req.hospitalId));
    const adjustment = new Adjustment({
      ...req.body,
      reference,
      hospitalId: req.hospitalId,
    });
    const saved = await adjustment.save();
    res.status(201).json(saved);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const Adjustment = req.tenantDb.model("Adjustment");
    const { hospitalId, _id, ...updates } = req.body;
    const adjustment = await Adjustment.findOneAndUpdate(
      adjustmentLookup(req.params.id, req.hospitalId),
      updates,
      { new: true, runValidators: true },
    );
    if (!adjustment) {
      return res.status(404).json({ message: "Adjustment not found" });
    }
    res.json(adjustment);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const Adjustment = req.tenantDb.model("Adjustment");
    const adjustment = await Adjustment.findOneAndDelete(
      adjustmentLookup(req.params.id, req.hospitalId),
    );
    if (!adjustment) {
      return res.status(404).json({ message: "Adjustment not found" });
    }
    res.json({ message: "Adjustment deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
