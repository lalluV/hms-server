const express = require("express");
const router = express.Router();
const Hospital = require("../models/Hospital");
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const {
  computeHospitalDailyDigest,
  formatDailyDigestWhatsAppMessage,
} = require("../services/dailyDigestService");
const { runDailyDigestForHospital } = require("../services/digestScheduler");

applyTenantEntitlements(router, { moduleKey: "core" });

const { computeDashboardStatistics } = require("../services/dashboardStats");

router.get("/statistics", async (req, res) => {
  try {
    const timeframe = ["today", "month", "6m", "all"].includes(req.query.timeframe)
      ? req.query.timeframe
      : "all";
    const stats = await computeDashboardStatistics(
      req.tenantDb,
      req.hospitalId,
      timeframe,
    );
    res.json(stats);
  } catch (error) {
    console.error("Error calculating dashboard statistics:", error);
    res.status(500).json({ message: error.message });
  }
});

// GET /api/dashboard/daily-digest/preview - Live preview of today's summary & settings
router.get("/daily-digest/preview", async (req, res) => {
  try {
    const hospitalId = req.hospitalId;
    const hospital = await Hospital.findById(hospitalId).lean();
    if (!hospital) {
      return res.status(404).json({ message: "Hospital not found" });
    }

    const digest = await computeHospitalDailyDigest(req.tenantDb, hospitalId, new Date());
    const fullMessage = formatDailyDigestWhatsAppMessage(hospital.name, digest);

    const defaultRecipients = hospital.phone
      ? [{ name: hospital.name, phone: hospital.phone, role: "Hospital Contact" }]
      : [];

    res.json({
      success: true,
      hospitalName: hospital.name,
      settings: hospital.settings?.dailyDigest || {
        enabled: false,
        recipients: defaultRecipients,
        scheduledTime: "21:00",
      },
      digest,
      fullMessage,
    });
  } catch (error) {
    console.error("Error previewing daily digest:", error);
    res.status(500).json({ message: error.message });
  }
});

// POST /api/dashboard/daily-digest/send-now - Immediate test/manual send via WhatsApp
router.post("/daily-digest/send-now", async (req, res) => {
  try {
    const hospitalId = req.hospitalId;
    const { overridePhone } = req.body || {};

    const result = await runDailyDigestForHospital(hospitalId, {
      overridePhone,
      force: true,
    });

    res.json(result);
  } catch (error) {
    console.error("Error sending daily digest now:", error);
    res.status(500).json({ message: error.message });
  }
});

// PUT /api/dashboard/daily-digest/settings - Update schedule and recipients
router.put("/daily-digest/settings", async (req, res) => {
  try {
    const hospitalId = req.hospitalId;
    const { enabled, recipients, scheduledTime } = req.body;

    const hospital = await Hospital.findById(hospitalId);
    if (!hospital) {
      return res.status(404).json({ message: "Hospital not found" });
    }

    if (!hospital.settings) hospital.settings = {};
    if (!hospital.settings.dailyDigest) hospital.settings.dailyDigest = {};

    if (typeof enabled === "boolean") {
      hospital.settings.dailyDigest.enabled = enabled;
    }
    if (Array.isArray(recipients)) {
      hospital.settings.dailyDigest.recipients = recipients.filter(
        (r) => r && r.phone && String(r.phone).trim()
      );
    }
    if (scheduledTime && typeof scheduledTime === "string") {
      hospital.settings.dailyDigest.scheduledTime = scheduledTime;
    }

    await hospital.save();

    res.json({
      success: true,
      settings: hospital.settings.dailyDigest,
    });
  } catch (error) {
    console.error("Error updating daily digest settings:", error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
