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

    // Construct a comprehensive prompt for HTML output
    const prompt = `Using the patient record below, generate a complete hospital discharge summary in HTML format following medical standards.

Instructions:
- Generate clean, professional HTML with proper structure
- Use semantic HTML tags: <h1>, <h2>, <h3>, <p>, <ul>, <li>
- Include inline CSS styling for professional appearance
- Organize into these sections: Patient Information, Emergency Assessment, Admission Details, Clinical Summary, Hospital Course, Investigations, Treatment Given, Insulin Management, Discharge Medications, Discharge Condition, Discharge Instructions, Follow-up Plan, Emergency Contact, Medical Team
- Include length of stay calculation if available
- SUMMARIZE data instead of showing raw tables:
  * Emergency Assessment: Include MLC number, chief complaints, emergency symptoms, casualty treatment details, and initial assessment findings
  * Vitals: Show trends and key findings (e.g., "Blood pressure remained stable 120-130/70-80 mmHg throughout admission")
  * Investigations: Summarize abnormal results and key findings only (e.g., "CBC showed mild anemia, liver function tests within normal limits")
  * Insulin: Summarize management approach and blood sugar control (e.g., "Blood sugar well controlled with Regular Insulin 8-12 units before meals")
  * Treatment: List key medications and their purpose (e.g., "Antibiotics for infection, pain management with paracetamol")
- Extract clinical course from doctor and nurse notes
- Include complications if mentioned in notes
- Focus on CLINICAL INSIGHTS and PATTERNS, not raw data
- Use appropriate colors, spacing, and typography for medical documents
- Where information is missing, skip or mark as "Not documented"
- Ensure the summary is comprehensive and ready for clinical use
- Make it print-friendly with proper page breaks
- Keep it concise but comprehensive - prioritize clinical significance over data volume

Patient Data:
${JSON.stringify(patientData, null, 2)}`;

    const response = await deepseekApi.post("/chat/completions", {
      model: "deepseek-reasoner", // Upgraded to reasoning model
      messages: [
        {
          role: "system",
          content:
            "You are a senior medical consultant with 20+ years of experience generating comprehensive hospital discharge summaries in HTML format. Your summaries are used for clinical continuity of care, insurance purposes, and legal documentation.\n\nREASONING APPROACH:\n1. Analyze patient data systematically\n2. Identify clinical patterns and relationships\n3. Assess treatment effectiveness\n4. Evaluate discharge readiness\n5. Consider follow-up requirements\n6. Ensure medical accuracy and completeness\n\nHTML FORMATTING REQUIREMENTS:\n- Generate complete, valid HTML with inline CSS styling\n- Use professional medical document styling (clean, readable fonts, appropriate colors)\n- Include proper semantic structure with headings, paragraphs, and lists\n- Make it print-friendly with appropriate margins and page breaks\n- Use consistent styling throughout the document\n- Include proper spacing and typography for medical documents\n- SUMMARIZE data instead of showing raw tables - focus on clinical insights\n- For Emergency Assessment: prioritize chief complaints, emergency symptoms, MLC details, and initial casualty assessment\n- For vitals: describe trends and ranges, not individual readings\n- For investigations: highlight abnormal findings and clinical significance\n- For insulin: summarize management approach and control status\n- For treatment: list key medications with purposes, not detailed schedules\n- Focus on clinical accuracy, completeness, and professional presentation suitable for healthcare providers and patients.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 8000, // Increased for more detailed reasoning
      temperature: 0.1, // Lower for more consistent reasoning
      top_p: 0.9,
      frequency_penalty: 0.2,
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
