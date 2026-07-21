const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const {
  applyEntitlementsNoTenantDb,
} = require("../utils/applyTenantEntitlements");

const router = express.Router();

applyEntitlementsNoTenantDb(router, { moduleKey: "core" });

const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";

const SCRIBE_SYSTEM_INSTRUCTION = `You are a silent medical scribe for an Indian hospital EMR.
Listen to the doctor-patient consultation (English, Telugu, Hindi, or mixed).
Do NOT speak or interrupt. Prefer accurate input transcription. Ignore small talk.`;

/**
 * POST /api/gemini-live/ephemeral-token
 * Short-lived token for Live listen (transcription only).
 * Chart writing uses GPT-4o-mini via /discharge-summary/parse-clinical-note.
 */
router.post("/ephemeral-token", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "GEMINI_API_KEY is not configured on the server",
    });
  }

  try {
    const client = new GoogleGenAI({ apiKey });
    const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const newSessionExpireTime = new Date(
      Date.now() + 2 * 60 * 1000,
    ).toISOString();

    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints: {
          model: GEMINI_LIVE_MODEL,
          config: {
            responseModalities: ["AUDIO"],
            inputAudioTranscription: {},
            systemInstruction: {
              parts: [{ text: SCRIBE_SYSTEM_INSTRUCTION }],
            },
            temperature: 0.2,
          },
        },
        httpOptions: { apiVersion: "v1alpha" },
      },
    });

    if (!token?.name) {
      return res.status(502).json({ error: "Failed to create ephemeral token" });
    }

    return res.json({
      token: token.name,
      model: GEMINI_LIVE_MODEL,
      expireTime,
    });
  } catch (error) {
    console.error("Gemini Live ephemeral token error:", error);
    return res.status(500).json({
      error: "Failed to create Gemini Live token",
      detail: error?.message || String(error),
    });
  }
});

module.exports = router;
