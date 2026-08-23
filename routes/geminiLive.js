const express = require("express");
const multer = require("multer");
const { GoogleGenAI } = require("@google/genai");
const {
  applyEntitlementsNoTenantDb,
} = require("../utils/applyTenantEntitlements");

const router = express.Router();

applyEntitlementsNoTenantDb(router, { moduleKey: "core" });

/** Record → transcribe (not Live). Override with GEMINI_TRANSCRIBE_MODEL. */
const GEMINI_TRANSCRIBE_MODEL =
  process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.1-flash-lite";

const INLINE_MAX_BYTES = 15 * 1024 * 1024;

const TRANSCRIBE_PROMPT =
  "You are a strict verbatim medical audio transcription system.\n\n" +
  "TASK:\n" +
  "Transcribe the provided audio clip accurately and verbatim.\n\n" +
  "CRITICAL RULES TO PREVENT HALLUCINATIONS ON SILENCE OR NOISE:\n" +
  "1. SILENCE & BACKGROUND NOISE: If the audio contains silence, static, hiss, breathing, keyboard typing, coughs, room background noise, or inaudible mumbles with NO clear spoken words, you MUST return an EXACT EMPTY STRING: \"\".\n" +
  "2. NEVER GUESS OR INVENT WORDS: Do NOT hallucinate, infer, or complete sentences that were not explicitly spoken by a person in the recording.\n" +
  "3. NO PLACEHOLDERS OR DISCLAIMERS: Do NOT output labels or filler phrases like '[silence]', '[no audio]', '[ambient noise]', '[background noise]', 'Thank you', 'Thank you for watching', 'Subtitles by', 'None', 'Silence', or transcription disclaimers.\n" +
  "4. VERBATIM ONLY: Output ONLY the exact spoken transcript text. No greetings, no preamble, no markdown formatting, no conversational replies, and no chart structuring.\n" +
  "5. MEDICAL ACCURACY: Preserve spoken medicine names, dosages, strengths, frequencies (e.g. OD, BD, TDS, QID, SOS, HS), routes, lab test names, numbers, and clinical terms precisely as spoken.\n" +
  "6. LANGUAGE: Transcribe in the speaker's language and script (support multilingual medical dictation and code-switching).\n" +
  "7. If you are not 100% confident actual human words are spoken, output nothing (empty string \"\").";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 1,
  },
});

const KNOWN_SILENCE_HALLUCINATIONS = new Set([
  "",
  ".",
  "...",
  "you",
  "thank you",
  "thank you.",
  "thank you!",
  "thank you for watching",
  "thank you for watching.",
  "thank you very much.",
  "subtitles by the amara.org community",
  "subtitles by",
  "please subscribe",
  "thanks for watching",
  "thanks for watching!",
  "silence",
  "silence.",
  "[silence]",
  "[noise]",
  "[background noise]",
  "[ambient noise]",
  "[music]",
  "[applause]",
  "[laughter]",
  "[inaudible]",
  "[unintelligible]",
  "no audio",
  "no speech",
  "no speech detected",
  "no speech detected.",
  "no words spoken",
  "none",
  "bye",
  "bye.",
  "goodbye",
  "goodbye.",
]);

function extractText(response) {
  if (!response) return "";
  let raw = "";
  if (typeof response.text === "string" && response.text.trim()) {
    raw = response.text.trim();
  } else {
    const parts = response?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      raw = parts
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .join("")
        .trim();
    }
  }

  // Strip markdown code blocks if present
  raw = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();

  // Silence & hallucination guard
  const normalized = raw.toLowerCase().replace(/[.,!?;:'"]/g, "").trim();
  if (
    !raw ||
    KNOWN_SILENCE_HALLUCINATIONS.has(normalized) ||
    KNOWN_SILENCE_HALLUCINATIONS.has(raw.toLowerCase().trim()) ||
    /^\[.*\]$/.test(raw.trim())
  ) {
    return "";
  }

  return raw;
}

/**
 * POST /api/gemini-live/transcribe
 * multipart field "audio" — MediaRecorder blob (webm/mp4/ogg/wav).
 * Returns { transcript, model }.
 */
router.post("/transcribe", upload.single("audio"), async (req, res) => {
  // Long Gemini round-trips; avoid proxy/socket closing mid-response.
  req.setTimeout?.(180000);
  res.setTimeout?.(180000);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "GEMINI_API_KEY is not configured on the server",
    });
  }

  if (!req.file?.buffer?.length) {
    return res.status(400).json({ error: "No audio file uploaded" });
  }

  console.log(
    `[gemini-live/transcribe] bytes=${req.file.buffer.length} mime=${req.file.mimetype || "?"}`,
  );

  const mimeType = String(req.file.mimetype || "audio/webm").split(";")[0];
  const allowed = new Set([
    "audio/webm",
    "audio/mp4",
    "audio/mpeg",
    "audio/mp3",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/aac",
    "audio/flac",
    "audio/m4a",
    "video/webm", // some browsers label MediaRecorder this way
  ]);
  if (!allowed.has(mimeType) && !mimeType.startsWith("audio/")) {
    return res.status(400).json({
      error: `Unsupported audio type: ${mimeType}`,
    });
  }

  const audioMime = mimeType === "video/webm" ? "audio/webm" : mimeType;

  try {
    const client = new GoogleGenAI({ apiKey });
    const buffer = req.file.buffer;
    let contents;

    if (buffer.length <= INLINE_MAX_BYTES) {
      contents = [
        {
          role: "user",
          parts: [
            { text: TRANSCRIBE_PROMPT },
            {
              inlineData: {
                mimeType: audioMime,
                data: buffer.toString("base64"),
              },
            },
          ],
        },
      ];
    } else {
      // Files API for larger clips (Node Buffer accepted by @google/genai).
      const uploaded = await client.files.upload({
        file: buffer,
        config: { mimeType: audioMime },
      });
      if (!uploaded?.uri) {
        return res
          .status(502)
          .json({ error: "Failed to upload audio to Gemini" });
      }
      contents = [
        {
          role: "user",
          parts: [
            { text: TRANSCRIBE_PROMPT },
            {
              fileData: {
                fileUri: uploaded.uri,
                mimeType: uploaded.mimeType || audioMime,
              },
            },
          ],
        },
      ];
    }

    const response = await client.models.generateContent({
      model: GEMINI_TRANSCRIBE_MODEL,
      contents,
      config: {
        temperature: 0.0, // Strict zero temperature to eliminate hallucinations on silence
        systemInstruction:
          "You are a strict verbatim audio transcription assistant. If the audio is silent or contains only background room noise, you must return an empty string with zero words. Never hallucinate or guess speech.",
      },
    });

    const transcript = extractText(response);
    return res.json({
      transcript,
      model: GEMINI_TRANSCRIBE_MODEL,
    });
  } catch (error) {
    console.error("Gemini consult transcribe error:", error);
    return res.status(500).json({
      error: "Failed to transcribe audio",
      detail: error?.message || String(error),
    });
  }
});

module.exports = router;
