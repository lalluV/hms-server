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
  process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.5-flash-lite";

const INLINE_MAX_BYTES = 15 * 1024 * 1024;

/** Used when Gemini transcription fails. */
const OPENAI_TRANSCRIBE_MODEL =
  process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-transcribe";
/** gpt-transcribe treats prompt as context about the recording, not instructions. */
const OPENAI_TRANSCRIBE_CONTEXT =
  "Doctor's clinical dictation in an Indian hospital: symptoms, examination, diagnosis, medicine brand names with letter suffixes and strengths, doses, frequencies, and lab tests. English mixed with Telugu or Hindi.";

const TRANSCRIBE_PROMPT =
  "You are a verbatim medical dictation transcriber for an Indian hospital.\n\n" +
  "TASK: Write down every word the speaker said, in the order said, exactly as heard. You are a recorder, not an editor.\n\n" +
  "EXACTNESS RULES:\n" +
  "1. Every spoken word appears in the output. Do not summarize, paraphrase, reorder, merge, shorten, or drop words or clauses, including negatives, numbers, and short words.\n" +
  "2. Do not correct, complete, or replace a word with a more familiar word. An unfamiliar word (brand names, product names, abbreviations, local terms) is written as it sounded, never swapped for a similar known word, a generic name, or a different product.\n" +
  "3. Letters spoken one by one are written as capital letters exactly as spoken. Letter or number suffixes after a word are kept, including single letters.\n" +
  "4. Numbers, strengths, units, doses, durations, and frequencies are written exactly as spoken. Do not convert, calculate, or add units that were not said.\n" +
  "5. Do not add anything that was not said: no punctuation-driven words, no labels, no headings, no structure, no explanations.\n" +
  "6. If one word is unclear, write your best phonetic rendering of what was heard. Never leave it out and never substitute a different word.\n" +
  "7. Keep the speaker's language and script, including mixed-language speech.\n\n" +
  "SILENCE RULE: Only when the whole clip has no human speech (silence, noise, breathing, typing, coughs), return an empty string. Never output placeholders, captions, greetings, or disclaimers.\n\n" +
  "OUTPUT: only the transcript text. No markdown, no preamble.";

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
  if (typeof response === "string") {
    raw = response.trim();
  } else if (typeof response.text === "string" && response.text.trim()) {
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
  raw = raw
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();

  // Silence & hallucination guard
  const normalized = raw
    .toLowerCase()
    .replace(/[.,!?;:'"]/g, "")
    .trim();
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
  if (!apiKey && !process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: "No transcription API key is configured on the server",
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
  const buffer = req.file.buffer;

  if (apiKey) {
    try {
      const transcript = await transcribeWithGemini(apiKey, buffer, audioMime);
      return res.json({ transcript, model: GEMINI_TRANSCRIBE_MODEL });
    } catch (error) {
      console.warn(
        `[gemini-live/transcribe] Gemini failed (${error?.message || error}); trying ${OPENAI_TRANSCRIBE_MODEL}`,
      );
    }
  }

  try {
    const transcript = await transcribeWithOpenAi(buffer, audioMime);
    return res.json({ transcript, model: OPENAI_TRANSCRIBE_MODEL });
  } catch (error) {
    console.error("Consult transcribe error (all providers):", error);
    return res.status(500).json({
      error: "Failed to transcribe audio",
      detail: error?.message || String(error),
    });
  }
});

async function transcribeWithGemini(apiKey, buffer, audioMime) {
  const client = new GoogleGenAI({ apiKey });
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
      throw new Error("Failed to upload audio to Gemini");
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
        "You are a verbatim audio transcriber. Write exactly what was spoken, every word, with no corrections, substitutions, or additions. Return an empty string only when the whole clip has no human speech.",
    },
  });

  return extractText(response);
}

const AUDIO_EXTENSIONS = {
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/aac": "m4a",
};

async function transcribeWithOpenAi(buffer, audioMime) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const ext = AUDIO_EXTENSIONS[audioMime] || "webm";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: audioMime }), `audio.${ext}`);
  form.append("model", OPENAI_TRANSCRIBE_MODEL);
  form.append("prompt", OPENAI_TRANSCRIBE_CONTEXT);

  const response = await fetch(
    `${process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1"}/audio/transcriptions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(120000),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
        `OpenAI transcription failed (${response.status})`,
    );
  }
  return extractText(String(data?.text || ""));
}

module.exports = router;
