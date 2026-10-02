const HOSPITAL_TZ = process.env.HOSPITAL_TZ || "Asia/Kolkata";

/** Calendar date (YYYY-MM-DD) in the hospital's timezone, not UTC. */
function localYmd(date = new Date(), timeZone = HOSPITAL_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Wall-clock time (HH:mm, 24h) in the hospital's timezone. */
function localHm(date = new Date(), timeZone = HOSPITAL_TZ) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

module.exports = { HOSPITAL_TZ, localYmd, localHm };
