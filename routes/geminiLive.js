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
  "Transcribe this medical consult / dictation audio accurately.\n" +
  "Rules:\n" +
  "- Output ONLY the transcript text. No preamble, labels, or markdown.\n" +
  "- Use the speaker’s language and script (auto-detect; support code-switching).\n" +
  "- Keep medicine names, strengths, frequencies (OD/BD/TDS/SOS/HS), lab abbreviations, numbers and doses as spoken.\n" +
  "- Do not invent clinical content. Do not structure into a chart.\n" +
  "- Skip pure greetings with no clinical content.\n" +
  "- If there is no speech, return an empty string.";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 1,
  },
});

function extractText(response) {
  if (!response) return "";
  if (typeof response.text === "string" && response.text.trim()) {
    return response.text.trim();
  }
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

/**
 * POST /api/gemini-live/transcribe
 * multipart field "audio" — MediaRecorder blob (webm/mp4/ogg/wav).
 * Returns { transcript, model }.
 */
router.post("/transcribe", upload.single("audio"), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "GEMINI_API_KEY is not configured on the server",
    });
  }

  if (!req.file?.buffer?.length) {
    return res.status(400).json({ error: "No audio file uploaded" });
  }

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
        temperature: 0.2,
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
