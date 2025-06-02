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
    const { doctorInputs } = patientData;

    // Construct a comprehensive prompt
    const prompt = `Generate a detailed discharge summary for a patient with the following information:

Patient Information:
- Age Range: ${patientData.ageRange}
- Gender: ${patientData.gender}

Medical History:
- Chief Complaints: ${patientData.chiefComplaints}
- Past Medical History: ${patientData.pastMedicalHistory}
- Provisional Diagnosis: ${patientData.provisionalDiagnosis}

Treatment Course:
${patientData.treatmentCourse
  .map((note, index) => `Day ${index + 1}: ${note}`)
  .join("\n")}

Doctor's Final Assessment:
- Final Diagnosis: ${doctorInputs.finalDiagnosis}
- Treatment Response: ${doctorInputs.treatmentResponse}
- Complications: ${doctorInputs.complications || "None"}
- Discharge Condition: ${doctorInputs.dischargeCondition}

Discharge Instructions:
- Follow-up Instructions: ${doctorInputs.followUpInstructions}
- Dietary Restrictions: ${doctorInputs.dietaryRestrictions}
- Activity Restrictions: ${doctorInputs.activityRestrictions}
- Wound Care Instructions: ${doctorInputs.woundCareInstructions}
- Medication Instructions: ${doctorInputs.medicationInstructions}

Please generate a comprehensive discharge summary that includes:
1. A brief overview of the patient's condition and treatment
2. Final diagnosis and treatment response
3. Any complications encountered
4. Current condition at discharge
5. Detailed discharge instructions including:
   - Follow-up care
   - Medication schedule
   - Activity restrictions
   - Dietary guidelines
   - Wound care instructions
6. Emergency warning signs to watch for
7. Contact information for emergencies

Format the summary in a clear, professional medical style suitable for both healthcare providers and patients.`;

    const response = await deepseekApi.post("/chat/completions", {
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content:
            "You are a medical professional generating a discharge summary. Use clear, professional language while ensuring the information is accessible to patients.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 1000,
      temperature: 0.7,
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
