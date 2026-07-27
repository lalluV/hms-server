const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const {
  applyEntitlementsNoTenantDb,
} = require("../utils/applyTenantEntitlements");

const router = express.Router();

applyEntitlementsNoTenantDb(router, { moduleKey: "core" });

const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";

/**
 * Keep aligned with hms/src/helpers/geminiLiveListenConfig.js
 * Live API uses short codes: te / hi / en (NOT te-IN).
 */
const LIVE_ADAPTATION_PHRASES = [
  'జ్వరం',
  'దగ్గు',
  'జలుబు',
  'నొప్పి',
  'తలనొప్పి',
  'శరీర నొప్పి',
  'వాంతులు',
  'విరేచనాలు',
  'ఆయాసం',
  'మందు',
  'టాబ్లెట్',
  'సిరప్',
  'ఇంజెక్షన్',
  'పరీక్ష',
  'jwaram',
  'daggu',
  'jalubu',
  'noppi',
  'talanoppi',
  'vantulu',
  'virechanaalu',
  'aayasam',
  'Dolo 650',
  'Dolo',
  'Crocin',
  'Pantop',
  'PAN 40',
  'Azithromycin',
  'Azithro',
  'Amoxicillin',
  'Augmentin',
  'Telma',
  'Metformin',
  'Montair',
  'Cetirizine',
  'T-Bact',
  'ORS',
  'PCM',
  'Paracetamol',
  'OD',
  'BD',
  'TDS',
  'SOS',
  'HS',
  'CBC',
  'CBP',
  'CUE',
  'LFT',
  'KFT',
  'HbA1c',
  'TSH',
  'ECG',
  'USG',
  'X-ray'
];

const SCRIBE_SYSTEM_INSTRUCTION = 'You are a silent medical scribe for a Telugu-speaking Indian hospital (Andhra / Telangana) OPD/IPD.\nThe consult is primarily TELUGU, often mixed with English medicine/lab names (code-switching).\nDo NOT speak, reply, or interrupt. Your only job is accurate input transcription.\n\nLANGUAGE (critical — do not ignore)\n- When the speaker uses Telugu, transcribe in TELUGU SCRIPT (తెలుగు). Do NOT force everything into English.\n- Keep English drug names, lab abbreviations, numbers and doses in Latin script as spoken (Dolo 650, BD, CBC, LFT).\n- Hindi, if spoken, may be in Devanagari or clear romanization.\n- Never invent English paraphrases during transcription; the chart writer will translate later.\n- Prefer common OPD Telugu terms when unsure: fever=జ్వరం, cough=దగ్గు, pain=నొప్పి, vomiting=వాంతులు, loose stools=విరేచనాలు, breathlessness=ఆయాసం.\n\nAUDIO\n- Expect soft/low voices, slow speech, and ward noise. Still capture faint patient Telugu answers.\n- Prefer a best-effort transcript over silence.\n\nTRANSCRIBE VERBATIM (do not reorder into a chart):\n- Complaints, history, exam remarks, diagnosis words, advice.\n- Medicines with strength/frequency/duration; labs; vitals.\n- Ignore pure greetings only when they contain no clinical content.';

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
            inputAudioTranscription: {
              // Live API short codes — te-IN / en-IN break recognition
              languageHints: {
                languageCodes: ["te", "en", "hi"],
              },
              adaptationPhrases: LIVE_ADAPTATION_PHRASES,
            },
            systemInstruction: {
              parts: [{ text: SCRIBE_SYSTEM_INSTRUCTION }],
            },
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
                endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
                prefixPaddingMs: 200,
                silenceDurationMs: 1800,
              },
              turnCoverage: "TURN_INCLUDES_ALL_INPUT",
              activityHandling: "NO_INTERRUPTION",
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
