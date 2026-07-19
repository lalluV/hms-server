const axios = require("axios");

/**
 * AiSensy WhatsApp integration.
 *
 * Sends a WhatsApp template message via an AiSensy "API Campaign".
 * Configure the following environment variables on the server:
 *   AISENSY_API_KEY        - API key from AiSensy dashboard (Manage > API Key)
 *   AISENSY_CAMPAIGN_NAME  - the API campaign name (default: prescription_ready)
 *   AISENSY_SENDER_NAME    - display name / userName for the campaign
 *   AISENSY_API_URL        - optional override for the API endpoint
 */

const AISENSY_API_URL =
  process.env.AISENSY_API_URL ||
  "https://backend.aisensy.com/campaign/t1/api/v2";

/**
 * Normalise an Indian mobile number to the AiSensy destination format
 * (country code + number, digits only, no leading +).
 * @param {string} rawPhone
 * @returns {string|null}
 */
function normalizeDestination(rawPhone) {
  if (!rawPhone) return null;

  let digits = String(rawPhone).replace(/\D/g, "");

  // Strip a leading 0 (national trunk prefix)
  if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  // Bare 10-digit number -> assume India (+91)
  if (digits.length === 10) {
    digits = `91${digits}`;
  }

  if (digits.length < 11 || digits.length > 15) {
    return null;
  }

  return digits;
}

/**
 * Send a prescription-ready WhatsApp message to the patient.
 *
 * Expects an AiSensy template with 4 body params in this order:
 *   {{1}} patient name, {{2}} hospital name, {{3}} view link, {{4}} doctor name
 *
 * @param {object} params
 * @param {string} params.phone        - patient's mobile number
 * @param {string} params.patientName  - patient's name ({{1}})
 * @param {string} params.hospitalName - hospital name ({{2}})
 * @param {string} params.viewUrl      - public prescription link ({{3}})
 * @param {string} params.doctorName   - consulting doctor name ({{4}})
 * @returns {Promise<{ success: boolean, destination: string, data?: any }>}
 */
async function sendPrescriptionWhatsApp({
  phone,
  patientName,
  hospitalName,
  viewUrl,
  doctorName,
}) {
  const apiKey = process.env.AISENSY_API_KEY;
  const campaignName =
    process.env.AISENSY_CAMPAIGN_NAME || "prescription_ready";
  const senderName = process.env.AISENSY_SENDER_NAME || hospitalName || "Clinic";

  if (!apiKey) {
    const error = new Error(
      "AISENSY_API_KEY is not configured. Set it in the server environment.",
    );
    error.code = "AISENSY_NOT_CONFIGURED";
    throw error;
  }

  const destination = normalizeDestination(phone);
  if (!destination) {
    const error = new Error(
      `Invalid or missing patient mobile number: "${phone}".`,
    );
    error.code = "INVALID_DESTINATION";
    throw error;
  }

  const templateParams = [
    patientName || "Patient",
    hospitalName || senderName,
    viewUrl,
    doctorName || "-",
  ];

  const payload = {
    apiKey,
    campaignName,
    destination,
    userName: senderName,
    templateParams,
    source: "hms-prescription",
  };

  try {
    const response = await axios.post(AISENSY_API_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });
    return { success: true, destination, data: response.data };
  } catch (err) {
    const apiError = new Error(
      err.response?.data?.errorMessage ||
        err.response?.data?.message ||
        err.message ||
        "Failed to send WhatsApp message via AiSensy.",
    );
    apiError.code = "AISENSY_SEND_FAILED";
    apiError.status = err.response?.status;
    apiError.details = err.response?.data;
    throw apiError;
  }
}

module.exports = {
  sendPrescriptionWhatsApp,
  normalizeDestination,
};
