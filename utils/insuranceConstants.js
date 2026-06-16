/** Canonical bill / tariff / exclusion service keys */
const INSURANCE_SERVICE_KEYS = [
  "Ward",
  "Consultation",
  "Investigation",
  "Procedure",
  "Service",
  "Pharmacy",
];

const SERVICE_KEY_ALIASES = {
  ward: "Ward",
  room: "Ward",
  "room charges": "Ward",
  "ward charges": "Ward",
  icu: "Ward",
  "icu charges": "Ward",
  consultation: "Consultation",
  "consultation charges": "Consultation",
  investigation: "Investigation",
  "investigation charges": "Investigation",
  diagnostics: "Investigation",
  "diagnostics charges": "Investigation",
  procedure: "Procedure",
  "procedure charges": "Procedure",
  service: "Service",
  "service charges": "Service",
  pharmacy: "Pharmacy",
  "pharmacy charges": "Pharmacy",
};

function normalizeInsuranceServiceKey(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (INSURANCE_SERVICE_KEYS.includes(trimmed)) return trimmed;
  const alias = SERVICE_KEY_ALIASES[trimmed.toLowerCase()];
  return alias || null;
}

function emptyBillBreakdown() {
  return {
    Ward: 0,
    Consultation: 0,
    Investigation: 0,
    Procedure: 0,
    Service: 0,
    Pharmacy: 0,
  };
}

module.exports = {
  INSURANCE_SERVICE_KEYS,
  SERVICE_KEY_ALIASES,
  normalizeInsuranceServiceKey,
  emptyBillBreakdown,
};
