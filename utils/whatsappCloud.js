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
 *   WHATSAPP_TEMPLATE_LAB_REPORT_READY  (URL button → /view/report/{{1}}, language: en)
 *   WHATSAPP_TEMPLATE_DISCHARGE_SUMMARY (URL button → /view/discharge/{{1}})
 *     When unset, discharge summaries are sent as a text message with the view link.
 */

const GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

/** Canonical keys used by HMS → Meta template name + shape */
const TEMPLATE_CATALOG = {
  prescription_ready: {
    envKey: "WHATSAPP_TEMPLATE_PRESCRIPTION",
    defaultName: "prescription_ready",
    /** Meta language for this template (prescription uses en_US; lab uses en) */
    defaultLanguage: "en_US",
    /** body: patient, hospital, doctor */
    hasUrlButton: true,
  },
  appointment_booked: {
    envKey: "WHATSAPP_TEMPLATE_APPOINTMENT_BOOKED",
    defaultName: "appointment_booked",
    /** Meta language for this template (prescription uses en_US; lab uses en) */
    defaultLanguage: "en",
    /** body: patient, hospital, doctor, date, time */
    hasUrlButton: false,
  },
  appointment_confirmed: {
    envKey: "WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMED",
    defaultName: "appointment_confirmed",
    /** Meta language for this template (prescription uses en_US; lab uses en) */
    defaultLanguage: "en",
    /** body: patient, hospital, doctor, date, time */
    hasUrlButton: false,
  },
  appointment_rescheduled: {
    envKey: "WHATSAPP_TEMPLATE_APPOINTMENT_RESCHEDULED",
    defaultName: "appointment_rescheduled",
    /** Meta language for this template (prescription uses en_US; lab uses en) */
    defaultLanguage: "en",
    /** body: patient, hospital, doctor, newDate, newTime */
    hasUrlButton: false,
  },
  appointment_cancelled: {
    envKey: "WHATSAPP_TEMPLATE_APPOINTMENT_CANCELLED",
    defaultName: "appointment_cancelled",
    /** Meta language for this template (prescription uses en_US; lab uses en) */
    defaultLanguage: "en",
    /** body: patient, hospital, doctor, date, time */
    hasUrlButton: false,
  },
  lab_report_ready: {
    envKey: "WHATSAPP_TEMPLATE_LAB_REPORT_READY",
    defaultName: "labr_report_ready",
    /** Meta language for this template (prescription uses en_US; lab uses en) */
    defaultLanguage: "en",
    /** body: patient, hospital, testsSummary */
    hasUrlButton: true,
  },
  daily_financial_digest: {
    envKey: "WHATSAPP_TEMPLATE_DAILY_DIGEST",
    defaultName: "daily_financial_digest",
    defaultLanguage: "en",
    hasUrlButton: false,
  },
  discharge_summary_ready: {
    envKey: "WHATSAPP_TEMPLATE_DISCHARGE_SUMMARY",
    defaultName: "discharge_summary_ready",
    defaultLanguage: "en",
    /** body: patient, hospital, doctor — URL button suffix is the public token */
    hasUrlButton: true,
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
  const perTemplateLanguage = process.env[`${entry.envKey}_LANGUAGE`];
  const templateLanguage =
    perTemplateLanguage ||
    entry.defaultLanguage ||
    process.env.WHATSAPP_TEMPLATE_LANGUAGE ||
    "en";

  return {
    name: process.env[entry.envKey] || entry.defaultName,
    hasUrlButton: entry.hasUrlButton,
    language: templateLanguage,
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
  const { accessToken, phoneNumberId } = getCredentials();

  if (!accessToken || !phoneNumberId) {
    const error = new Error(
      "WhatsApp Cloud API is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.",
    );
    error.code = "WHATSAPP_NOT_CONFIGURED";
    throw error;
  }

  const {
    name: templateName,
    hasUrlButton,
    language: templateLanguage,
  } = resolveTemplate(templateKey);

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

/** Discharge summary ready — template when configured, otherwise a text message with the link */
async function sendDischargeSummaryWhatsApp({
  phone,
  patientName,
  hospitalName,
  doctorName,
  token,
  viewUrl,
}) {
  if (process.env.WHATSAPP_TEMPLATE_DISCHARGE_SUMMARY) {
    try {
      return await sendWhatsAppTemplate({
        phone,
        templateKey: "discharge_summary_ready",
        bodyParams: [
          toWhatsAppTemplateParam(patientName || "Patient"),
          toWhatsAppTemplateParam(hospitalName || "Hospital"),
          toWhatsAppTemplateParam(doctorName || "-"),
        ],
        buttonUrlSuffix: token,
      });
    } catch (templateErr) {
      console.warn(
        "Discharge summary template failed, falling back to text:",
        templateErr.message,
      );
    }
  }

  const message =
    `*${hospitalName || "Hospital"}*\n\n` +
    `Dear ${patientName || "Patient"},\n\n` +
    `Your discharge summary is ready.\n` +
    `Consultant: ${doctorName || "-"}\n\n` +
    `Open your summary:\n${viewUrl}`;

  return sendWhatsAppTextMessage({ phone, message, previewUrl: true });
}

/** Lab / diagnostics report ready — URL button suffix = public report token */
async function sendLabReportWhatsApp({
  phone,
  patientName,
  hospitalName,
  testsSummary,
  token,
}) {
  return sendWhatsAppTemplate({
    phone,
    templateKey: "lab_report_ready",
    bodyParams: [
      patientName || "Patient",
      hospitalName || "Clinic",
      testsSummary || "your tests",
    ],
    buttonUrlSuffix: token,
  });
}

/**
 * Send a direct text message via Meta WhatsApp Cloud API.
 * Ideal for daily administrative digests or conversational responses within 24h window.
 */
async function sendWhatsAppTextMessage({ phone, message, previewUrl = false }) {
  const { accessToken, phoneNumberId } = getCredentials();

  if (!accessToken || !phoneNumberId) {
    const error = new Error(
      "WhatsApp Cloud API is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.",
    );
    error.code = "WHATSAPP_NOT_CONFIGURED";
    throw error;
  }

  const destination = normalizeDestination(phone);
  if (!destination) {
    const error = new Error(`Invalid or missing mobile number: "${phone}".`);
    error.code = "INVALID_DESTINATION";
    throw error;
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: destination,
    type: "text",
    text: {
      preview_url: Boolean(previewUrl),
      body: String(message || ""),
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
      type: "text",
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

/**
 * Approved template variables cannot contain line breaks, tabs, or long runs of spaces.
 */
function toWhatsAppTemplateParam(value) {
  const text = String(value ?? "")
    .replace(/\*/g, "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\r\n\t]+/g, " | ")
    .replace(/ {2,}/g, " ")
    .trim();
  return (text || "-").slice(0, 1024);
}

/**
 * Template vars cannot contain real newlines (Meta rejects the send).
 * Turn each original line into a bullet segment so the body stays readable.
 */
function toWhatsAppDigestTemplateParam(value) {
  const text = String(value ?? "")
    .replace(/\*/g, "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\r\n/g, "\n")
    .replace(/[\t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" • ")
    .replace(/ {2,}/g, " ")
    .trim();
  return (text || "-").slice(0, 1024);
}

/**
 * Send Daily Financial and Operations Digest to Hospital Owner / Director.
 *
 * Template first (works outside the 24h window — this is what actually
 * delivers). Then best-effort multi-line session text so formatting matches
 * the in-app preview. Follow-up failures must not fail the whole send.
 */
async function sendDailyDigestWhatsApp({
  phone,
  hospitalName,
  dateStr,
  summaryText,
  fullFormattedMessage,
}) {
  const richMessage = fullFormattedMessage || summaryText;
  // Multi-line body for template {{3}} — one metric per line via U+2028
  const templateBody =
    fullFormattedMessage || summaryText || "Daily digest ready.";

  if (process.env.WHATSAPP_TEMPLATE_DAILY_DIGEST) {
    try {
      const templateResult = await sendWhatsAppTemplate({
        phone,
        templateKey: "daily_financial_digest",
        bodyParams: [
          toWhatsAppTemplateParam(hospitalName || "Hospital"),
          toWhatsAppTemplateParam(dateStr || "Today"),
          toWhatsAppDigestTemplateParam(templateBody),
        ],
      });

      // Session window is open after template — send proper multi-line text.
      // Never let this fail the digest send (template already delivered).
      if (fullFormattedMessage) {
        try {
          await new Promise((r) => setTimeout(r, 800));
          await sendWhatsAppTextMessage({
            phone,
            message: fullFormattedMessage,
          });
        } catch (followUpErr) {
          console.warn(
            "Multi-line digest follow-up failed (template already sent):",
            followUpErr.message,
          );
        }
      }

      return templateResult;
    } catch (templateErr) {
      console.warn(
        "Template send failed for daily digest, falling back to direct text:",
        templateErr.message,
      );
    }
  }

  return sendWhatsAppTextMessage({
    phone,
    message: richMessage,
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
  sendWhatsAppTextMessage,
  sendPrescriptionWhatsApp,
  sendAppointmentWhatsApp,
  sendLabReportWhatsApp,
  sendDischargeSummaryWhatsApp,
  sendDailyDigestWhatsApp,
  mapWhatsAppHttpError,
};
