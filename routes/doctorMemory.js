const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const { resolveRequestDoctorIds } = require("../utils/doctorPatientAccess");
const {
  suggestFromPractice,
  backfillClinicalCasesForTenant,
  rebuildClinicalCasesForTenant,
} = require("../utils/doctorMemory");

applyTenantEntitlements(router, { moduleKey: "core" });

/**
 * POST /api/doctor-memory/suggest
 * Suggest tap-to-add medicine/lab pills from this doctor's signed history.
 * No pharmacy or lab catalog — memory only.
 */
router.post("/suggest", async (req, res) => {
  try {
    const doctorIds = await resolveRequestDoctorIds(req);
    if (!doctorIds.length) {
      return res.status(401).json({ message: "Doctor identity required" });
    }

    const {
      extractedClinical,
      currentReview,
      umr,
      prescriptionId,
    } = req.body || {};

    if (!extractedClinical || typeof extractedClinical !== "object") {
      return res.status(400).json({
        message: "extractedClinical is required",
      });
    }

    const result = await suggestFromPractice({
      tenantDb: req.tenantDb,
      hospitalId: req.hospitalId,
      doctorIds,
      umr: umr ? String(umr).trim() : "",
      extractedClinical,
      currentReview: currentReview || {},
      excludePrescriptionId: prescriptionId
        ? String(prescriptionId).trim()
        : "",
    });

    res.json(result);
  } catch (error) {
    console.error("doctor-memory/suggest error:", error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * POST /api/doctor-memory/backfill
 * Index all prescriptions for this hospital (admin/doctor one-time).
 */
router.post("/backfill", async (req, res) => {
  try {
    const doctorIds = await resolveRequestDoctorIds(req);
    if (!doctorIds.length) {
      return res.status(401).json({ message: "Doctor identity required" });
    }

    const clearFirst = Boolean(req.body?.clear);
    const result = clearFirst
      ? await rebuildClinicalCasesForTenant(req.tenantDb, req.hospitalId)
      : await backfillClinicalCasesForTenant(req.tenantDb, req.hospitalId);
    res.json({ ok: true, clear: clearFirst, ...result });
  } catch (error) {
    console.error("doctor-memory/backfill error:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
