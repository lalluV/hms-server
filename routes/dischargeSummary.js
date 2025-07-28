const express = require("express");
const router = express.Router();
const axios = require("axios");

const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

const deepseekApi = axios.create({
  baseURL: DEEPSEEK_API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
  },
});

// Middleware to validate request
const validateRequest = (req, res, next) => {
  const { patientData } = req.body;
  if (!patientData) {
    return res.status(400).json({ error: "Patient data is required" });
  }
  next();
};

// Generate discharge summary
router.post("/", validateRequest, async (req, res) => {
  try {
    const { patientData } = req.body;

    // Construct a comprehensive prompt
    const prompt = `Using the patient record below, generate a complete hospital discharge summary. 

Instructions:
- Use clear medical language, professional formatting.
- Organize into headings: Patient Details, Admission Info, Chief Complaints, History, Diagnosis, Investigations, Vitals, Treatment Given, Discharge Condition, Discharge Instructions, Medications, Follow-up.
- Include only what's relevant and available.
- Where information is missing, skip or mark as "Not documented".

Here is the patient object:
${JSON.stringify(patientData, null, 2)}`;

    const response = await deepseekApi.post("/chat/completions", {
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content:
            "You are a senior doctor generating a formal hospital discharge summary. Format the output professionally, using sections like Patient Info, History, Diagnosis, Treatment, Vitals, Discharge Instructions, and Follow-Up.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 4000,
      temperature: 0.3,
      top_p: 0.9,
      frequency_penalty: 0.5,
    });

    const summary = response.data.choices[0].message.content;

    // Log the request for auditing
    console.log(
      `Generated discharge summary for patient at ${new Date().toISOString()}`
    );

    res.json({
      summary,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error generating discharge summary:", error);
    res.status(500).json({
      error: "Failed to generate discharge summary",
      details: error.message,
    });
  }
});

/**
 * POST /rewrite-section
 * Body: { sectionType: string, inputText: string, age?: number, gender?: string }
 * Returns: { rewritten: string }
 */
router.post("/rewrite-section", async (req, res) => {
  try {
    const { sectionType, inputText, age, gender } = req.body;
    // Improved input validation
    if (
      !sectionType ||
      typeof sectionType !== "string" ||
      !sectionType.trim()
    ) {
      return res.status(400).json({
        error: "sectionType is required and must be a non-empty string",
      });
    }
    if (!inputText || typeof inputText !== "string" || !inputText.trim()) {
      return res.status(400).json({
        error: "inputText is required and must be a non-empty string",
      });
    }
    if (age && (typeof age !== "number" || age < 0 || age > 130)) {
      return res
        .status(400)
        .json({ error: "age must be a valid number between 0 and 130" });
    }
    if (
      gender &&
      !["male", "female", "other", "Male", "Female", "Other"].includes(gender)
    ) {
      return res
        .status(400)
        .json({ error: "gender must be 'male', 'female', or 'other'" });
    }

    // Build context for the prompt, but do not include age/gender in rewritten output
    let context = "";
    if (age) context += `Age: ${age}. `;
    if (gender) context += `Gender: ${gender}. `;

    const prompt = `\n${context}\nRewrite the following doctor's notes as a well-formatted "${sectionType.replace(
      /_/g,
      " "
    )}" section.\nUse clear, professional medical language and structure. Only include relevant details.\nDo not include age or gender in the rewritten text, even if provided, only return if provided in Doctor's notes: inputText.\nReturn only the rewritten text, with no heading, explanations, or placeholders below.\n\nDoctor's notes:\n${inputText}\n`;

    let response;
    try {
      response = await deepseekApi.post(
        "/chat/completions",
        {
          model: "deepseek-chat",
          messages: [
            {
              role: "system",
              content: `You are a senior doctor rewriting clinical notes into a formal, well-structured section for a medical record.`,
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          max_tokens: 800,
          temperature: 0.3,
          top_p: 0.9,
          frequency_penalty: 0.5,
        },
        { timeout: 15000 } // 15s timeout
      );
    } catch (apiError) {
      console.error(
        "DeepSeek API error:",
        apiError?.response?.data || apiError.message
      );
      return res.status(502).json({
        error: "Failed to contact DeepSeek API",
        details: apiError?.response?.data || apiError.message,
      });
    }

    if (
      !response?.data?.choices ||
      !response.data.choices[0]?.message?.content
    ) {
      return res
        .status(500)
        .json({ error: "Invalid response from DeepSeek API" });
    }
    const rewritten = response.data.choices[0].message.content;
    res.json({ rewritten });
  } catch (error) {
    console.error("Error rewriting section:", error);
    res.status(500).json({
      error: "Failed to rewrite section",
      details: error.message,
    });
  }
});

module.exports = router;
