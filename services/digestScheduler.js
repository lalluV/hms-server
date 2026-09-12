const mongoose = require("mongoose");
const dayjs = require("dayjs");
const Hospital = require("../models/Hospital");
const { resolveTenantConnection } = require("../utils/tenantRouter");
const {
  computeHospitalDailyDigest,
  formatDailyDigestWhatsAppMessage,
  formatDailyDigestCompactSummary,
} = require("./dailyDigestService");
const { sendDailyDigestWhatsApp } = require("../utils/whatsappCloud");

/**
 * Execute daily digest delivery for a specific hospital tenant.
 *
 * @param {string} hospitalId
 * @param {object} [options]
 * @param {string} [options.overridePhone] - Send to a specific phone (e.g. Test send from UI)
 * @param {Date|string} [options.targetDate] - Date to compute digest for (defaults to today)
 * @param {boolean} [options.force] - Force send even if already sent today
 */
async function runDailyDigestForHospital(hospitalId, options = {}) {
  const hospital = await Hospital.findById(hospitalId);
  if (!hospital) {
    throw new Error(`Hospital with ID ${hospitalId} not found.`);
  }

  const tenantDb = await resolveTenantConnection(hospitalId);
  const targetDate = options.targetDate || new Date();
  const digest = await computeHospitalDailyDigest(tenantDb, hospitalId, targetDate);

  const fullMessage = formatDailyDigestWhatsAppMessage(hospital.name, digest);
  const compactSummary = formatDailyDigestCompactSummary(hospital.name, digest);

  let recipients = [];
  if (options.overridePhone) {
    recipients = [{ phone: options.overridePhone, name: "Test Recipient", role: "Tester" }];
  } else {
    recipients = hospital.settings?.dailyDigest?.recipients || [];
    // Fallback to hospital primary phone if no specific recipient configured
    if (recipients.length === 0 && hospital.phone) {
      recipients = [{ phone: hospital.phone, name: hospital.name, role: "Hospital Contact" }];
    }
  }

  if (recipients.length === 0) {
    return {
      success: false,
      message: "No phone numbers configured to receive daily digest.",
      digest,
    };
  }

  const results = [];
  for (const recipient of recipients) {
    try {
      const res = await sendDailyDigestWhatsApp({
        phone: recipient.phone,
        hospitalName: hospital.name,
        dateStr: digest.formattedDate,
        summaryText: compactSummary,
        fullFormattedMessage: fullMessage,
      });
      results.push({
        phone: recipient.phone,
        name: recipient.name,
        status: "sent",
        data: res,
      });
    } catch (err) {
      console.error(
        `Failed to send daily digest to ${recipient.phone} (${hospital.name}):`,
        err.message
      );
      results.push({
        phone: recipient.phone,
        name: recipient.name,
        status: "failed",
        error: err.message,
      });
    }
  }

  // Update last sent metadata if this was not an override test
  if (!options.overridePhone) {
    if (!hospital.settings) hospital.settings = {};
    if (!hospital.settings.dailyDigest) hospital.settings.dailyDigest = {};
    hospital.settings.dailyDigest.lastSentDate = digest.date;
    hospital.settings.dailyDigest.lastSentAt = new Date();
    await hospital.save();
  }

  return {
    success: results.some((r) => r.status === "sent"),
    hospitalName: hospital.name,
    digest,
    fullMessage,
    results,
  };
}

let schedulerTimer = null;

/**
 * Start background scheduler checking every minute for hospitals ready to receive daily digest.
 */
function startDigestScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
  }

  console.log("⏰ Daily WhatsApp Digest Scheduler initialized.");

  const checkAndDispatch = async () => {
    try {
      if (mongoose.connection?.readyState !== 1) {
        return;
      }
      const now = dayjs();
      const currentHHmm = now.format("HH:mm");
      const currentDateStr = now.format("YYYY-MM-DD");

      // Find all active hospitals with daily digest enabled
      const hospitals = await Hospital.find({
        active: true,
        "settings.dailyDigest.enabled": true,
      })
        .select("_id name settings")
        .lean();

      for (const h of hospitals) {
        const scheduledTime = h.settings?.dailyDigest?.scheduledTime || "21:00";
        const lastSentDate = h.settings?.dailyDigest?.lastSentDate;

        if (scheduledTime === currentHHmm && lastSentDate !== currentDateStr) {
          console.log(
            `🚀 Triggering scheduled daily digest for ${h.name} (${h._id}) at ${currentHHmm}...`
          );
          runDailyDigestForHospital(h._id).catch((err) => {
            console.error(`Error in scheduled daily digest for ${h.name}:`, err);
          });
        }
      }
    } catch (err) {
      console.error("Error in daily digest scheduler tick:", err.message);
    }
  };

  // Run initial check and then every 60 seconds
  schedulerTimer = setInterval(checkAndDispatch, 60000);
  if (schedulerTimer.unref) {
    schedulerTimer.unref();
  }
}

module.exports = {
  runDailyDigestForHospital,
  startDigestScheduler,
};
