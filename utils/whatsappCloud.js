const axios = require("axios");

/**
 * Meta WhatsApp Cloud API — multi-template sender.
 *
 * Shared env:
 *   WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID
 *   WHATSAPP_TEMPLATE_LANGUAGE (default: en)
 *   WHATSAPP_API_VERSION (default: v21.0)
 *
 * Per-template name overrides (optional):
 *   WHATSAPP_TEMPLATE_PRESCRIPTION
 *   WHATSAPP_TEMPLATE_APPOINTMENT_BOOKED
 *   WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMED
 *   WHATSAPP_TEMPLATE_APPOINTMENT_RESCHEDULED
 *   WHATSAPP_TEMPLATE_APPOINTMENT_CANCELLED
 *   WHATSAPP_TEMPLATE_LAB_REPORT_READY
 */

const GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

/** Canonical keys used by HMS → Meta template name + shape */
const TEMPLATE_CATALOG = {
  prescription_ready: {
    envKey: "WHATSAPP_TEMPLATE_PRESCRIPTION",
    defaultName: "prescription_ready",
    /** body: patient, hospital, doctor */
    hasUrlButton: true,
  },
  appointment_booked: {
    envKey: "WHATSAPP_TEMPLATE_APPOINTMENT_BOOKED",
    defaultName: "appointment_booked",
    /** body: patient, hospital, doctor, date, time */
    hasUrlButton: false,
  },
  appointment_confirmed: {
    envKey: "WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMED",
    defaultName: "appointment_confirmed",
    /** body: patient, hospital, doctor, date, time */
    hasUrlButton: false,
  },
  appointment_rescheduled: {
    envKey: "WHATSAPP_TEMPLATE_APPOINTMENT_RESCHEDULED",
    defaultName: "appointment_rescheduled",
    /** body: patient, hospital, doctor, newDate, newTime */
    hasUrlButton: false,
  },
  appointment_cancelled: {
    envKey: "WHATSAPP_TEMPLATE_APPOINTMENT_CANCELLED",
    defaultName: "appointment_cancelled",
    /** body: patient, hospital, doctor, date, time */
    hasUrlButton: false,
  },
  lab_report_ready: {
    envKey: "WHATSAPP_TEMPLATE_LAB_REPORT_READY",
    defaultName: "lab_report_ready",
    /** body: patient, hospital, testsSummary */
    hasUrlButton: false,
  },
};

function normalizeDestination(rawPhone) {
  if (!rawPhone) return null;

  let digits = String(rawPhone).replace(/\D/g, "");

  if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  if (digits.length === 10) {
    digits = `91${digits}`;
  }

  if (digits.length < 11 || digits.length > 15) {
    return null;
  }

  return digits;
}

function getCredentials() {
  return {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
  };
}

function resolveTemplate(templateKey) {
  const entry = TEMPLATE_CATALOG[templateKey];
  if (!entry) {
    const error = new Error(`Unknown WhatsApp template key: "${templateKey}".`);
    error.code = "WHATSAPP_UNKNOWN_TEMPLATE";
    throw error;
  }
  return {
    name: process.env[entry.envKey] || entry.defaultName,
    hasUrlButton: entry.hasUrlButton,
  };
}

/**
 * Low-level template send.
 *
 * @param {object} opts
 * @param {string} opts.phone
 * @param {string} opts.templateKey - key from TEMPLATE_CATALOG
 * @param {string[]} opts.bodyParams - ordered body variable values
 * @param {string} [opts.buttonUrlSuffix] - dynamic URL button suffix (if template has one)
 */
async function sendWhatsAppTemplate({
  phone,
  templateKey,
  bodyParams = [],
  buttonUrlSuffix,
}) {
  const { accessToken, phoneNumberId, templateLanguage } = getCredentials();

  if (!accessToken || !phoneNumberId) {
    const error = new Error(
      "WhatsApp Cloud API is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.",
    );
    error.code = "WHATSAPP_NOT_CONFIGURED";
    throw error;
  }

  const { name: templateName, hasUrlButton } = resolveTemplate(templateKey);

  const destination = normalizeDestination(phone);
  if (!destination) {
    const error = new Error(
      `Invalid or missing patient mobile number: "${phone}".`,
    );
    error.code = "INVALID_DESTINATION";
    throw error;
  }

  if (hasUrlButton && !buttonUrlSuffix) {
    const error = new Error(
      `Template "${templateKey}" requires a dynamic URL button suffix.`,
    );
    error.code = "INVALID_DESTINATION";
    throw error;
  }

  const components = [
    {
      type: "body",
      parameters: bodyParams.map((text) => ({
        type: "text",
        text: String(text ?? "-"),
      })),
    },
  ];

  if (hasUrlButton) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: String(buttonUrlSuffix) }],
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: destination,
    type: "template",
    template: {
      name: templateName,
      language: { code: templateLanguage },
      components,
    },
  };

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });
    return {
      success: true,
      destination,
      templateKey,
      templateName,
      data: response.data,
    };
  } catch (err) {
    const metaError =
      err.response?.data?.error?.message ||
      err.response?.data?.error?.error_user_msg ||
      err.response?.data?.message ||
      err.message ||
      "Failed to send WhatsApp message via Meta Cloud API.";
    const apiError = new Error(metaError);
    apiError.code = "WHATSAPP_SEND_FAILED";
    apiError.status = err.response?.status;
    apiError.details = err.response?.data;
    throw apiError;
  }
}

/** Prescription ready — URL button suffix = public Rx token */
async function sendPrescriptionWhatsApp({
  phone,
  patientName,
  hospitalName,
  doctorName,
  token,
}) {
  return sendWhatsAppTemplate({
    phone,
    templateKey: "prescription_ready",
    bodyParams: [
      patientName || "Patient",
      hospitalName || "Clinic",
      doctorName || "-",
    ],
    buttonUrlSuffix: token,
  });
}

/**
 * Appointment lifecycle templates.
 * @param {'appointment_booked'|'appointment_confirmed'|'appointment_rescheduled'|'appointment_cancelled'} templateKey
 */
async function sendAppointmentWhatsApp({
  templateKey,
  phone,
  patientName,
  hospitalName,
  doctorName,
  date,
  time,
}) {
  const allowed = new Set([
    "appointment_booked",
    "appointment_confirmed",
    "appointment_rescheduled",
    "appointment_cancelled",
  ]);
  if (!allowed.has(templateKey)) {
    const error = new Error(`Invalid appointment template: "${templateKey}".`);
    error.code = "WHATSAPP_UNKNOWN_TEMPLATE";
    throw error;
  }

  return sendWhatsAppTemplate({
    phone,
    templateKey,
    bodyParams: [
      patientName || "Patient",
      hospitalName || "Clinic",
      doctorName || "-",
      date || "-",
      time || "-",
    ],
  });
}

/** Lab / diagnostics report ready (no URL button — collect at hospital / app) */
async function sendLabReportWhatsApp({
  phone,
  patientName,
  hospitalName,
  testsSummary,
}) {
  return sendWhatsAppTemplate({
    phone,
    templateKey: "lab_report_ready",
    bodyParams: [
      patientName || "Patient",
      hospitalName || "Clinic",
      testsSummary || "your tests",
    ],
  });
}

function mapWhatsAppHttpError(error, res) {
  if (error.code === "WHATSAPP_NOT_CONFIGURED") {
    return res.status(503).json({
      message:
        "WhatsApp sending is not configured. Please contact the administrator.",
    });
  }
  if (
    error.code === "INVALID_DESTINATION" ||
    error.code === "WHATSAPP_UNKNOWN_TEMPLATE"
  ) {
    return res.status(400).json({ message: error.message });
  }
  if (error.code === "WHATSAPP_SEND_FAILED") {
    return res.status(502).json({
      message: error.message || "Failed to send WhatsApp message.",
    });
  }
  return null;
}

module.exports = {
  TEMPLATE_CATALOG,
  normalizeDestination,
  sendWhatsAppTemplate,
  sendPrescriptionWhatsApp,
  sendAppointmentWhatsApp,
  sendLabReportWhatsApp,
  mapWhatsAppHttpError,
};
