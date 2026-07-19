const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const { runHealekaAgent } = require("../utils/healekaAgent");
const { executeTool } = require("../utils/healekaAgentTools");

applyTenantEntitlements(router, { moduleKey: "core" });

/**
 * GET /api/healeka-agent/todays-op
 * Today's OP list for Doctor/Nurse quick patient picker.
 * Doctors: own patients by default. Nurses: hospital OP list.
 */
router.get("/todays-op", async (req, res) => {
  try {
    const role = req.user?.type || "Staff";
    if (role !== "Doctor" && role !== "Nurse") {
      return res
        .status(403)
        .json({ error: "Today's OP list is available for Doctor and Nurse." });
    }
    const limit = Math.min(Number(req.query.limit) || 30, 40);
    const mineOnly =
      req.query.mineOnly === "true" ||
      (req.query.mineOnly !== "false" && role === "Doctor");

    const result = await executeTool(
      "list_todays_op",
      { limit, mineOnly },
      {
        tenantDb: req.tenantDb,
        hospitalId: req.hospitalId,
        role,
        userId: req.user?.userId || req.user?.id,
        staffMongoId: req.user?.id,
      },
    );

    if (result?.error) {
      return res.status(400).json({ error: result.error });
    }
    return res.json(result);
  } catch (err) {
    console.error("[HealekaAgent] todays-op error:", err.message);
    return res.status(500).json({
      error: err.message || "Failed to load today's OP list",
    });
  }
});

/**
 * POST /api/healeka-agent/chat
 * Body: {
 *   messages, pageContext?, userName?,
 *   confirmActionId?, cancelActionId?
 * }
 */
router.post("/chat", async (req, res) => {
  try {
    const {
      messages,
      pageContext,
      userName,
      confirmActionId,
      cancelActionId,
    } = req.body || {};

    const isConfirmOrCancel = Boolean(confirmActionId || cancelActionId);
    if (
      !isConfirmOrCancel &&
      (!Array.isArray(messages) || messages.length === 0)
    ) {
      return res
        .status(400)
        .json({ error: "messages array with at least one entry is required" });
    }

    const result = await runHealekaAgent({
      tenantDb: req.tenantDb,
      hospitalId: req.hospitalId,
      user: req.user,
      userName: userName || req.user?.name,
      messages: messages || [],
      pageContext,
      confirmActionId,
      cancelActionId,
    });

    return res.json(result);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      console.error("[HealekaAgent] chat error:", err.message);
    }
    return res.status(status).json({
      error: err.message || "Healeka AI request failed",
    });
  }
});

module.exports = router;
