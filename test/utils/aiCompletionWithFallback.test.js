const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isTransientGeminiError,
  openAiMessagesToGemini,
} = require("../../utils/aiCompletionWithFallback");

test("isTransientGeminiError identifies 503 high demand and unavailable errors", () => {
  // Direct 503 error object from Gemini
  const err503 = {
    status: 503,
    message:
      "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
  };
  assert.equal(isTransientGeminiError(err503), true);

  // Gemini REST/SDK error response format
  const errGeminiRest = {
    response: {
      status: 503,
      data: {
        error: {
          code: 503,
          message:
            "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
          status: "UNAVAILABLE",
        },
      },
    },
  };
  assert.equal(isTransientGeminiError(errGeminiRest), true);

  // Status string UNAVAILABLE
  const errUnavailable = {
    status: "UNAVAILABLE",
    message: "Service Unavailable",
  };
  assert.equal(isTransientGeminiError(errUnavailable), true);

  // Rate limit 429
  const err429 = {
    status: 429,
    message: "Resource has been exhausted",
  };
  assert.equal(isTransientGeminiError(err429), true);

  // Network timeout
  const errTimeout = {
    code: "ECONNABORTED",
    message: "AI request timed out after 30000ms",
  };
  assert.equal(isTransientGeminiError(errTimeout), true);
});

test("isTransientGeminiError rejects non-transient errors (e.g. 400 Bad Request)", () => {
  const err400 = {
    status: 400,
    message: "Invalid prompt syntax or schema",
  };
  assert.equal(isTransientGeminiError(err400), false);

  const errAuth = {
    status: 401,
    message: "API key not valid",
  };
  assert.equal(isTransientGeminiError(errAuth), false);
});

test("openAiMessagesToGemini converts OpenAI messages to Gemini contents + systemInstruction", () => {
  const messages = [
    { role: "system", content: "You are a clinical assistant." },
    { role: "user", content: "Patient has fever and cough." },
    { role: "assistant", content: '{"medicines": ["Paracetamol"]}' },
    { role: "user", content: "Add Azithromycin 500mg." },
  ];

  const result = openAiMessagesToGemini(messages);

  assert.equal(result.systemInstruction, "You are a clinical assistant.");
  assert.equal(Array.isArray(result.contents), true);
  assert.equal(result.contents.length, 3);
  assert.equal(result.contents[0].role, "user");
  assert.equal(result.contents[0].parts[0].text, "Patient has fever and cough.");
  assert.equal(result.contents[1].role, "model");
  assert.equal(
    result.contents[1].parts[0].text,
    '{"medicines": ["Paracetamol"]}',
  );
  assert.equal(result.contents[2].role, "user");
  assert.equal(result.contents[2].parts[0].text, "Add Azithromycin 500mg.");
});
