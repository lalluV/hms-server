const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const OPENAI_API_BASE_URL =
  process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_FALLBACK_MODEL =
  process.env.OPENAI_FALLBACK_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4.1-mini";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_PRIMARY_MODEL =
  process.env.GEMINI_PARSE_MODEL ||
  process.env.GEMINI_TRANSCRIBE_MODEL ||
  "gemini-3.1-flash-lite";

const openaiClient = axios.create({
  baseURL: OPENAI_API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
    ...(OPENAI_API_KEY ? { Authorization: `Bearer ${OPENAI_API_KEY}` } : {}),
  },
});

/**
 * Check if an error from Gemini or network is transient (503 high demand, rate limits, timeouts).
 */
function isTransientGeminiError(error) {
  if (!error) return false;
  const status =
    error.status ||
    error.statusCode ||
    error?.response?.status ||
    error?.response?.data?.error?.code;
  if ([503, 429, 502, 504, 500].includes(Number(status))) return true;

  const statusStr = String(
    error.status || error?.response?.data?.error?.status || "",
  ).toUpperCase();
  if (
    [
      "UNAVAILABLE",
      "RESOURCE_EXHAUSTED",
      "DEADLINE_EXCEEDED",
      "INTERNAL",
    ].includes(statusStr)
  ) {
    return true;
  }

  const code = String(error.code || "").toUpperCase();
  if (
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNABORTED",
      "ENOTFOUND",
      "EAI_AGAIN",
    ].includes(code)
  ) {
    return true;
  }

  const msg = String(
    error.message ||
      error?.response?.data?.error?.message ||
      error?.details ||
      "",
  ).toLowerCase();
  if (
    msg.includes("high demand") ||
    msg.includes("temporary") ||
    msg.includes("temporarily") ||
    msg.includes("spikes in demand") ||
    msg.includes("overloaded") ||
    msg.includes("rate limit") ||
    msg.includes("quota") ||
    msg.includes("resource has been exhausted") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("empty response")
  ) {
    return true;
  }
  return false;
}

/**
 * Timeout helper for promises.
 */
function withTimeout(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`AI request timed out after ${timeoutMs}ms`);
      err.code = "ECONNABORTED";
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * OpenAI-style messages → Gemini systemInstruction + contents.
 */
function openAiMessagesToGemini(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systemChunks = [];
  const contents = [];
  for (const message of list) {
    const text = String(message?.content || "").trim();
    if (!text) continue;
    if (message.role === "system") {
      systemChunks.push(text);
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) {
      prev.parts[0].text = `${prev.parts[0].text}\n\n${text}`;
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }
  if (!contents.length) {
    contents.push({ role: "user", parts: [{ text: "Return valid JSON." }] });
  }
  if (contents[0].role !== "user") {
    contents.unshift({
      role: "user",
      parts: [{ text: "Continue with the JSON response." }],
    });
  }
  return {
    systemInstruction: systemChunks.length
      ? systemChunks.join("\n\n")
      : undefined,
    contents,
  };
}

/**
 * Call Gemini with timeout and return in OpenAI chat.completions response format.
 */
async function callGemini(
  messages,
  {
    model = GEMINI_PRIMARY_MODEL,
    apiKey = GEMINI_API_KEY,
    timeoutMs = 30000,
    maxTokens = 16384,
    responseJson = true,
  } = {},
) {
  if (!apiKey) {
    const err = new Error("GEMINI_API_KEY is not configured");
    err.status = 503;
    throw err;
  }

  const { systemInstruction, contents } = openAiMessagesToGemini(messages);
  const client = new GoogleGenAI({ apiKey });

  const config = {
    temperature: 0.1,
    topP: 0.9,
    maxOutputTokens: maxTokens,
  };

  if (responseJson) {
    config.responseMimeType = "application/json";
  }

  // Minimal thinking for models that support it
  if (String(model).includes("3.") || String(model).includes("2.5")) {
    config.thinkingConfig = { thinkingLevel: "minimal" };
  }

  if (systemInstruction) {
    config.systemInstruction = systemInstruction;
  }

  const response = await withTimeout(
    client.models.generateContent({
      model,
      contents,
      config,
    }),
    timeoutMs,
  );

  const content = String(response?.text || "").trim();
  if (!content) {
    throw new Error("Empty response from Gemini");
  }

  const finishRaw = String(
    response?.candidates?.[0]?.finishReason || "STOP",
  ).toUpperCase();
  const finish_reason =
    finishRaw === "MAX_TOKENS" || finishRaw === "LENGTH" ? "length" : "stop";

  return {
    data: {
      model,
      provider: "gemini",
      choices: [
        {
          message: { role: "assistant", content },
          finish_reason,
        },
      ],
    },
  };
}

/**
 * Call OpenAI (GPT-4.1 Mini) fallback with timeout.
 */
async function callOpenAiFallback(
  messages,
  {
    model = OPENAI_FALLBACK_MODEL,
    timeoutMs = 25000,
    maxTokens = 16384,
    responseJson = true,
  } = {},
) {
  if (!OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY is not configured for fallback");
    err.status = 503;
    throw err;
  }

  const payload = {
    model,
    messages: Array.isArray(messages) ? messages : [],
    temperature: 0.1,
    max_tokens: maxTokens,
  };

  if (responseJson) {
    payload.response_format = { type: "json_object" };
  }

  try {
    const response = await openaiClient.post("/chat/completions", payload, {
      timeout: timeoutMs,
    });
    return {
      data: {
        ...response.data,
        provider: "openai",
      },
    };
  } catch (error) {
    // If gpt-4.1-mini is not recognized on an older OpenAI key, fallback to gpt-4o-mini
    if (
      model === "gpt-4.1-mini" &&
      (error?.response?.status === 404 ||
        error?.response?.data?.error?.code === "model_not_found" ||
        /model/i.test(String(error?.response?.data?.error?.message || "")))
    ) {
      console.warn(
        "OpenAI gpt-4.1-mini not found; falling back to gpt-4o-mini…",
      );
      payload.model = "gpt-4o-mini";
      const retryResponse = await openaiClient.post(
        "/chat/completions",
        payload,
        { timeout: timeoutMs },
      );
      return {
        data: {
          ...retryResponse.data,
          provider: "openai",
        },
      };
    }
    throw error;
  }
}

/**
 * AI Completion with instant failover from Gemini to GPT-4.1 Mini on 503 / high demand / timeout.
 */
async function aiCompletionWithFallback(
  messages,
  {
    geminiModel = GEMINI_PRIMARY_MODEL,
    openAiModel = OPENAI_FALLBACK_MODEL,
    timeoutMs = 30000,
    maxTokens = 16384,
    responseJson = true,
  } = {},
) {
  // If Gemini API key is not configured, go straight to OpenAI
  if (!GEMINI_API_KEY) {
    console.warn(
      "[AI Completion] GEMINI_API_KEY not configured, using OpenAI directly",
    );
    return callOpenAiFallback(messages, {
      model: openAiModel,
      timeoutMs,
      maxTokens,
      responseJson,
    });
  }

  // 1. Try Primary: Gemini
  try {
    const result = await callGemini(messages, {
      model: geminiModel,
      timeoutMs,
      maxTokens,
      responseJson,
    });
    return result;
  } catch (geminiError) {
    const isTransient = isTransientGeminiError(geminiError);
    const geminiErrMsg =
      geminiError?.response?.data?.error?.message ||
      geminiError?.message ||
      String(geminiError);

    console.warn(
      `[AI Failover] Gemini error (transient=${isTransient}): ${geminiErrMsg}. Switching to OpenAI (${openAiModel})…`,
    );

    // 2. Instant Fallback to OpenAI GPT-4.1 Mini
    if (OPENAI_API_KEY) {
      try {
        const fallbackResult = await callOpenAiFallback(messages, {
          model: openAiModel,
          timeoutMs: Math.min(timeoutMs, 25000),
          maxTokens,
          responseJson,
        });
        console.log(
          `[AI Failover] Successfully completed request via OpenAI (${fallbackResult.data?.model || openAiModel})`,
        );
        return fallbackResult;
      } catch (openAiError) {
        console.error(
          "[AI Failover] OpenAI fallback also failed:",
          openAiError?.response?.data || openAiError.message,
        );
        const combinedError = new Error(
          "AI service is temporarily experiencing high demand across providers. Please try again.",
        );
        combinedError.status = 503;
        combinedError.details = {
          gemini: geminiErrMsg,
          openai:
            openAiError?.response?.data?.error?.message || openAiError.message,
        };
        throw combinedError;
      }
    } else {
      throw geminiError;
    }
  }
}

module.exports = {
  aiCompletionWithFallback,
  callGemini,
  callOpenAiFallback,
  isTransientGeminiError,
  openAiMessagesToGemini,
};
