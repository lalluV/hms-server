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

module.exports = router;
