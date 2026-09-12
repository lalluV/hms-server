/**
 * Discharge AI Write Engine & Route
 * Single self-contained module for Inpatient Discharge Summary AI Write copilot.
 * 
 * Rules:
 * - Discharge care: Take-home medications WITH explicit duration (e.g. 5 days, like OPD).
 * - Extracts discharge fields: finalDiagnosis, dischargeInstructions, followUpPlan.
 * - Manages take-home dischargeMedications list directly.
 */

const express = require("express");
const router = express.Router();
const axios = require("axios");
const { aiCompletionWithFallback } = require("../utils/aiCompletionWithFallback");

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL =
  process.env.OPENAI_FALLBACK_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4.1-mini";
const PARSE_NOTE_MODEL =
  process.env.GEMINI_PARSE_MODEL ||
  process.env.GEMINI_TRANSCRIBE_MODEL ||
  "gemini-3.1-flash-lite";
const PARSE_NOTE_TIMEOUT_MS =
  Number(process.env.GEMINI_PARSE_TIMEOUT_MS) ||
  Number(process.env.OPENAI_PARSE_TIMEOUT_MS) ||
  30000;
const REVIEW_FOLLOWUP_DELTA_MAX_TOKENS =
  Number(process.env.OPENAI_FOLLOWUP_MAX_TOKENS) || 4096;
const REVIEW_FOLLOWUP_DELTA_RETRY_MAX_TOKENS =
  Number(process.env.OPENAI_FOLLOWUP_RETRY_MAX_TOKENS) || 8192;
const REVIEW_FOLLOWUP_REPLY_MAX_TOKENS = 60;

const openaiApi = axios.create({
  baseURL: OPENAI_API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  },
});

/* ========================================================================== */
/* Prompts                                                                    */
/* ========================================================================== */

const DISCHARGE_AI_SYSTEM_PROMPT = `You are a senior hospital discharge scribe for an Indian hospital EMR. Your job is to extract take-home discharge medications, repeat lab investigations, and discharge instructions from the doctor's dictation or chat updates. Return valid JSON only.`;

const DISCHARGE_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM = `

DISCHARGE SUMMARY FOLLOW-UP MODE — PATCH ONLY
1. DISCHARGE TAKE-HOME PRESCRIPTIONS (WITH DURATION):
- Medicines are take-home discharge prescriptions dispensed by pharmacy for outpatient consumption.
- DURATION IS REQUIRED (e.g. "5 days", "7 days", "10 days", "1 month"). Default to "5 days" if unspecified.
- Include accurate dosage, frequency, route, and plain English instructions.
- Only "add" actions apply for take-home medicines (or "remove" to drop a drug).

2. DISCHARGE LAB INVESTIGATIONS / REPEAT TESTS:
- Under "labOps", extract repeat or recommended lab tests (e.g. "Repeat CBC in 3 days", "LFT after 1 week", "Serum Creatinine", "Ultrasound Abdomen").
- Use clean test names (e.g. "Complete Blood Count (CBC)", "Liver Function Test (LFT)").

3. DISCHARGE FIELDS:
- "finalDiagnosis": Confirmed medical diagnosis at discharge (e.g. "Acute Gastroenteritis with moderate dehydration resolved").
- "dischargeCondition": Patient condition at discharge: "Stable" | "Improved" | "Recovering" | "Critical" | "Palliative" | "LAMA"
- "dischargeDestination": Destination: "Home" | "Outpatient Care" | "Another Hospital" | "Rehabilitation Center"
- "dischargeInstructions": Patient counselling, diet advice, precautions, activity, wound care, red-flag warning signs.
- "followUpPlan": Review timeline (e.g. "Review in OPD after 7 days with repeat CBC") and appointments.

4. ASSISTANT REPLY:
- assistantReply is required: ONE short, natural spoken sentence confirming the discharge updates.

Return exactly this JSON shape:
{
  "assistantReply": "one short natural spoken sentence",
  "clearReviewMedicines": false,
  "clearReviewLabs": false,
  "dischargeFields": {
    "finalDiagnosis": "",
    "dischargeCondition": "",
    "dischargeDestination": "",
    "dischargeInstructions": "",
    "followUpPlan": ""
  },
  "medicineOps": [
    {
      "op": "add" | "edit" | "remove",
      "match": "existing medicine name when editing or removing",
      "medicine": {
        "name": "Exact Brand or Generic Name (strip Tab/Inj/Cap)",
        "type": "Tablet" | "Capsules" | "Syrup" | "Ointment" | "Drops" | "Inhaler" | "Sachet",
        "duration": "5 days",
        "directions": "Directions in plain English",
        "dosages": [ { "time": "Morning" | "Afternoon" | "Evening" | "Night", "amount": 1, "beforeFood": false } ]
      }
    }
  ],
  "labOps": [
    {
      "op": "add" | "remove",
      "name": "Exact test name"
    }
  ]
}`;

function buildDischargeReviewFollowUpUserPrompt(instruction, currentChart) {
  const chart = currentChart && typeof currentChart === "object" ? currentChart : {};
  return `SETTING: DISCHARGE SUMMARY (Take-home discharge plan).
DURATION: Required for medicines (e.g. "5 days", "10 days").
LABS: Repeat or recommended investigations.
DISCHARGE FIELDS: finalDiagnosis, dischargeCondition, dischargeDestination, dischargeInstructions, followUpPlan.

CURRENT CHART:
${JSON.stringify(chart)}

INSTRUCTION:
${instruction}

REMINDER: Output minimal JSON patch for discharge take-home orders, labs, and fields.`;
}

function parseFollowUpDeltaJson(content) {
  let raw = String(content || "").trim();
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (jsonMatch) raw = jsonMatch[1].trim();

  const startIdx = raw.indexOf("{");
  const endIdx = raw.lastIndexOf("}");
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    raw = raw.substring(startIdx, endIdx + 1);
  }

  return JSON.parse(raw);
}

function isGreetingOnly(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!.,?…]+$/g, "")
    .trim();
  if (!t || t.length > 48) return false;
  if (
    /\b(diagnosis|discharge|medicine|tab|syrup|advice|review|follow|days|dolo|pantop)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  return /^(hi|hello|hey|good\s*(morning|afternoon|evening)|thanks)(\s+(there|doc|doctor))?$/.test(
    t,
  );
}

/* ========================================================================== */
/* Routes                                                                     */
/* ========================================================================== */

/**
 * POST /api/discharge-ai/review-followup
 * Handles Discharge Summary AI Write take-home medications & discharge fields.
 */
router.post("/review-followup", async (req, res) => {
  try {
    const { instruction, currentChart } = req.body || {};

    if (
      !instruction ||
      typeof instruction !== "string" ||
      !instruction.trim()
    ) {
      return res.status(400).json({
        error: "instruction is required and must be a non-empty string",
      });
    }

    const chart =
      currentChart && typeof currentChart === "object" ? currentChart : {};

    if (isGreetingOnly(instruction)) {
      return res.json({
        medicines: chart.medicines || [],
        dischargeFields: chart.dischargeFields || {
          finalDiagnosis: "",
          dischargeInstructions: "",
          followUpPlan: "",
        },
        assistantReply: "Hello Doctor. What are the discharge medications or instructions?",
      });
    }

    const userPrompt = buildDischargeReviewFollowUpUserPrompt(instruction, chart);
    const systemContent = `${DISCHARGE_AI_SYSTEM_PROMPT}\n${DISCHARGE_REVIEW_FOLLOWUP_SYSTEM_ADDENDUM}`;

    const followUpMessages = [
      { role: "system", content: systemContent },
      { role: "user", content: userPrompt },
    ];

    console.log("=== [DISCHARGE AI FOLLOW-UP INPUT] ===");
    console.log("Instruction:", instruction);

    let response;
    try {
      response = await aiCompletionWithFallback(followUpMessages, {
        geminiModel: PARSE_NOTE_MODEL,
        openAiModel: OPENAI_MODEL,
        timeoutMs: Math.min(PARSE_NOTE_TIMEOUT_MS, 30000),
        maxTokens: REVIEW_FOLLOWUP_DELTA_MAX_TOKENS,
        responseJson: true,
      });
    } catch (apiError) {
      console.error(
        "Discharge AI Follow-up error:",
        apiError?.response?.data || apiError.message,
      );
      return res.status(apiError?.status === 503 ? 503 : 502).json({
        error:
          apiError?.message ||
          "AI assistant is temporarily experiencing high demand. Please try again.",
        details:
          apiError?.response?.data || apiError.details || apiError.message,
      });
    }

    if (
      !response?.data?.choices ||
      !response.data.choices[0]?.message?.content
    ) {
      return res.status(500).json({ error: "Invalid response from Discharge AI" });
    }

    let content = response.data.choices[0].message.content.trim();
    let delta;
    try {
      delta = parseFollowUpDeltaJson(content);
    } catch (parseErr) {
      console.warn("Failed to parse Discharge AI delta JSON, retrying:", parseErr.message);
      try {
        const retry = await aiCompletionWithFallback(
          [
            ...followUpMessages,
            { role: "assistant", content },
            {
              role: "user",
              content: `Your previous JSON was invalid or truncated. Return a MINIMAL valid JSON patch only for discharge fields and medications.`,
            },
          ],
          {
            geminiModel: PARSE_NOTE_MODEL,
            openAiModel: OPENAI_MODEL,
            timeoutMs: Math.min(PARSE_NOTE_TIMEOUT_MS, 30000),
            maxTokens: REVIEW_FOLLOWUP_DELTA_RETRY_MAX_TOKENS,
            responseJson: true,
          },
        );
        content = retry?.data?.choices?.[0]?.message?.content?.trim() || "{}";
        delta = parseFollowUpDeltaJson(content);
      } catch (retryErr) {
        console.error("Discharge AI retry failed:", retryErr.message);
        return res.status(500).json({ error: "Failed to parse AI response" });
      }
    }

    // Merge discharge medicines
    let medicines = Array.isArray(chart.medicines) ? [...chart.medicines] : [];
    if (delta.clearReviewMedicines) {
      medicines = [];
    }

    for (const op of Array.isArray(delta.medicineOps) ? delta.medicineOps : []) {
      const matchName = String(op?.match || op?.medicine?.name || "")
        .trim()
        .toLowerCase();
      const kind = String(op?.op || "").toLowerCase();

      if (kind === "add" && op.medicine) {
        medicines.push({
          ...op.medicine,
          duration: op.medicine.duration || "5 days",
          action: "add",
        });
      } else if (kind === "remove" && matchName) {
        medicines = medicines.filter(
          (m) => String(m?.name || "").trim().toLowerCase() !== matchName,
        );
      } else if (kind === "edit" && op.medicine) {
        const idx = medicines.findIndex(
          (m) => String(m?.name || "").trim().toLowerCase() === matchName,
        );
        if (idx >= 0) {
          medicines[idx] = {
            ...medicines[idx],
            ...op.medicine,
            duration: op.medicine.duration || medicines[idx].duration || "5 days",
          };
        } else {
          medicines.push({
            ...op.medicine,
            duration: op.medicine.duration || "5 days",
            action: "add",
          });
        }
      }
    }

    // Merge discharge lab tests (repeat/recommended post-discharge investigations)
    let labTests = Array.isArray(chart.labTests) ? [...chart.labTests] : [];
    if (delta.clearReviewLabs) {
      labTests = [];
    }

    for (const op of Array.isArray(delta.labOps) ? delta.labOps : []) {
      const matchName = String(op?.match || op?.name || "")
        .trim()
        .toLowerCase();
      const kind = String(op?.op || "").toLowerCase();

      if (kind === "add" && op.name) {
        if (
          !labTests.some(
            (t) =>
              String(t?.name || t || "")
                .trim()
                .toLowerCase() === String(op.name).trim().toLowerCase(),
          )
        ) {
          labTests.push({
            name: op.name,
            action: "add",
            origin: "review",
          });
        }
      } else if (kind === "remove" || kind === "stop" || kind === "delete") {
        if (matchName) {
          labTests = labTests.filter(
            (t) =>
              String(t?.name || t || "")
                .trim()
                .toLowerCase() !== matchName,
          );
        }
      }
    }

    const existingFields = chart.dischargeFields || {};
    const incomingFields = delta.dischargeFields || {};
    const dischargeFields = {
      ...existingFields,
      finalDiagnosis:
        incomingFields.finalDiagnosis !== undefined
          ? String(incomingFields.finalDiagnosis).trim()
          : existingFields.finalDiagnosis || "",
      dischargeCondition:
        incomingFields.dischargeCondition !== undefined
          ? String(incomingFields.dischargeCondition).trim()
          : existingFields.dischargeCondition || "Stable",
      dischargeDestination:
        incomingFields.dischargeDestination !== undefined
          ? String(incomingFields.dischargeDestination).trim()
          : existingFields.dischargeDestination || "Home",
      dischargeInstructions:
        incomingFields.dischargeInstructions !== undefined
          ? String(incomingFields.dischargeInstructions).trim()
          : existingFields.dischargeInstructions || "",
      followUpPlan:
        incomingFields.followUpPlan !== undefined
          ? String(incomingFields.followUpPlan).trim()
          : existingFields.followUpPlan || "",
    };

    const result = {
      medicines,
      medicinesToApply: medicines,
      labTests,
      labTestsToApply: labTests,
      dischargeFields,
      assistantReply:
        String(delta.assistantReply || "").trim() ||
        "Updated discharge medications, labs, and instructions.",
    };

    return res.json(result);
  } catch (error) {
    console.error("Unexpected error in Discharge AI:", error);
    return res.status(500).json({
      error: error?.message || "Internal server error in Discharge AI",
    });
  }
});

/**
 * POST /api/discharge-ai/review-followup/reply-stream
 * Live plain-text token stream for discharge confirmation.
 */
router.post("/review-followup/reply-stream", async (req, res) => {
  const { instruction } = req.body || {};

  if (!instruction || typeof instruction !== "string" || !instruction.trim()) {
    res.status(400).end("instruction is required");
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  if (isGreetingOnly(instruction)) {
    res.write("Hello Doctor. Ready for discharge instructions.");
    res.end();
    return;
  }

  try {
    const upstream = await openaiApi.post(
      "/chat/completions",
      {
        model: OPENAI_MODEL,
        stream: true,
        temperature: 0.2,
        max_tokens: REVIEW_FOLLOWUP_REPLY_MAX_TOKENS,
        messages: [
          {
            role: "system",
            content:
              "You are a concise medical voice assistant for an Indian hospital discharge desk. Reply in ONE short, natural spoken sentence confirming the discharge order or instruction.",
          },
          {
            role: "user",
            content: `INSTRUCTION:\n${instruction}\n\nReply with ONE short spoken sentence confirming the discharge action.`,
          },
        ],
      },
      { responseType: "stream", timeout: 20000 },
    );

    let ended = false;
    const safeEnd = () => {
      if (!ended) {
        ended = true;
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    };

    upstream.data.on("data", (chunk) => {
      const lines = chunk
        .toString("utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (line === "data: [DONE]") {
          safeEnd();
          return;
        }
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          const deltaText = payload.choices?.[0]?.delta?.content;
          if (deltaText) res.write(deltaText);
        } catch {
          /* ignore */
        }
      }
    });

    upstream.data.on("end", safeEnd);
    upstream.data.on("error", () => safeEnd());
    req.on("close", () => {
      try {
        upstream.data.destroy();
      } catch {
        /* ignore */
      }
      safeEnd();
    });
  } catch (err) {
    console.warn("Discharge AI reply stream upstream error:", err?.message || err);
    res.write("Got it — updating discharge plan.");
    res.end();
  }
});

module.exports = router;
