const crypto = require("crypto");
const {
  buildEntitlements,
  isSubscriptionAccessAllowed,
} = require("../services/entitlementsService");
const { localYmd } = require("./localDate");

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const rateBuckets = new Map();

function sanitizePhone(value) {
  return String(value || "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeAge(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return String(parseInt(digits, 10));
}

function normalizeGender(value) {
  const g = String(value || "").trim().toLowerCase();
  if (g === "male" || g === "m") return "Male";
  if (g === "female" || g === "f") return "Female";
  return "";
}

function buildPublicRegistrationKey({ hospitalId, phone, name, age, gender }) {
  const payload = [
    String(hospitalId || ""),
    sanitizePhone(phone),
    normalizeName(name),
    normalizeAge(age),
    normalizeGender(gender),
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function checkPublicOpRateLimit(req) {
  const hospitalId = req.hospitalId || "unknown";
  const key = `${hospitalId}:${getClientIp(req)}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - bucket.count),
    retryAfterSec: Math.ceil(
      (bucket.windowStart + RATE_WINDOW_MS - now) / 1000,
    ),
  };
}

/** Test helper — clears in-memory buckets between cases. */
function resetPublicOpRateLimit() {
  rateBuckets.clear();
}

function assertHospitalAllowsPublicOp(hospital) {
  if (!hospital || hospital.active === false) {
    return {
      ok: false,
      status: 404,
      message: "Hospital registration is not available.",
    };
  }
  if (hospital.databaseStatus !== "active") {
    return {
      ok: false,
      status: 503,
      message: "Hospital registration is temporarily unavailable.",
    };
  }
  if (!isSubscriptionAccessAllowed(hospital)) {
    return {
      ok: false,
      status: 403,
      message: "Hospital registration is not available for this subscription.",
    };
  }
  const entitlements = buildEntitlements(hospital);
  if (
    entitlements?.modules?.opd !== true &&
    entitlements?.modules?.core !== true
  ) {
    return {
      ok: false,
      status: 403,
      message: "Outpatient registration is not included in this plan.",
    };
  }
  return { ok: true, entitlements };
}

function validatePublicOpPayload(body = {}) {
  const errors = {};
  const name = String(body.name || "").trim().replace(/\s+/g, " ");
  const gender = normalizeGender(body.gender);
  const age = normalizeAge(body.age);
  const phone = sanitizePhone(body.phone);
  const email = String(body.email || "").trim();
  const street_address = String(body.street_address || "").trim();
  const city = String(body.city || "").trim();
  const state = String(body.state || "Telangana").trim() || "Telangana";
  const postal_code =
    String(body.postal_code || "506002").trim() || "506002";
  const doctorId = String(body.doctorId || "").trim();

  if (!name) errors.name = "Full name is required";
  else if (name.length > 120) errors.name = "Name is too long";

  if (!gender) errors.gender = "Gender is required";

  if (!age) errors.age = "Age is required";
  else {
    const ageNum = Number(age);
    if (!Number.isFinite(ageNum) || ageNum < 0 || ageNum > 120) {
      errors.age = "Enter a valid age";
    }
  }

  if (!phone) errors.phone = "Contact number is required";
  else if (!/^[1-9]\d{9}$/.test(phone)) {
    errors.phone = "Enter a valid 10-digit mobile number (no leading 0)";
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Enter a valid email address";
  }

  if (!doctorId) {
    errors.consultantDoctor = "Consultant doctor is required";
  } else if (doctorId.length > 80) {
    errors.consultantDoctor = "Select a valid consultant doctor";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      name,
      gender,
      age,
      phone,
      email,
      street_address,
      city,
      state,
      postal_code,
      country: "India",
      doctorId,
    },
  };
}

function publicDoctorQuery(hospitalId) {
  return {
    hospitalId,
    active: true,
    type: "Doctor",
  };
}

async function listPublicConsultantDoctors(connection, hospitalId) {
  const Staff = connection.model("Staff");
  const doctors = await Staff.find(publicDoctorQuery(hospitalId))
    .select("id name specialization")
    .sort({ name: 1 })
    .lean();

  return doctors
    .filter((doctor) => String(doctor?.id || "").trim() && String(doctor?.name || "").trim())
    .map((doctor) => ({
      id: String(doctor.id),
      name: String(doctor.name).trim(),
      specialization: String(doctor.specialization || "").trim(),
    }));
}

async function findActiveConsultantDoctor(connection, hospitalId, doctorId) {
  const id = String(doctorId || "").trim();
  if (!id) return null;
  const Staff = connection.model("Staff");
  const doctor = await Staff.findOne({
    ...publicDoctorQuery(hospitalId),
    id,
  })
    .select("id name specialization")
    .lean();
  if (!doctor || !String(doctor.name || "").trim()) return null;
  return {
    id: String(doctor.id),
    name: String(doctor.name).trim(),
    specialization: String(doctor.specialization || "").trim(),
  };
}

async function createPublicOpVisit(connection, { hospitalId, patient, doctor }) {
  const Prescription = connection.model("Prescription");
  const consultantDoctor = doctor.name;
  const prescriptionId = `RX-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
  return Prescription.create({
    prescriptionId,
    hospitalId,
    patientId: patient._id,
    UMRNo: patient.UMRNo,
    doctorId: String(doctor.id),
    doctorName: consultantDoctor,
    consultantDoctor,
    date: localYmd(),
    symptoms: "",
    vitals: [],
    doctorNotes: [],
    nurseNotes: [],
    diagnosticData: [],
    medicineData: [],
    paymentMethod: "Personal",
    insurance_provider: "",
    insurance_providerId: "",
    policy_number: "",
    coPayPercentage: 0,
    coPayLimit: 0,
    coPayType: "percentage",
    pharmacyStatus: "pending",
  });
}

function buildTrustedPublicPatientDoc({ hospitalId, data, publicRegistrationKey }) {
  const now = new Date().toISOString();
  return {
    hospitalId,
    name: data.name,
    gender: data.gender,
    age: data.age,
    phone: data.phone,
    email: data.email || "",
    street_address: data.street_address || "",
    city: data.city || "",
    state: data.state || "Telangana",
    postal_code: data.postal_code || "506002",
    country: "India",
    registered_by: "Public self-registration",
    registration_date: now,
    publicRegistrationKey,
    modifiedBy: [
      {
        user: "Public self-registration",
        type: "Public",
        modifiedTime: now,
      },
    ],
  };
}

function toPublicRegistrationResponse(patient, { created, consultantDoctor }) {
  const body = {
    status: created ? "created" : "existing",
    UMRNo: patient.UMRNo,
    name: patient.name,
    registration_date: patient.registration_date,
  };
  if (created && consultantDoctor) {
    body.consultantDoctor = consultantDoctor;
  }
  return body;
}

module.exports = {
  sanitizePhone,
  normalizeName,
  normalizeAge,
  normalizeGender,
  buildPublicRegistrationKey,
  checkPublicOpRateLimit,
  resetPublicOpRateLimit,
  assertHospitalAllowsPublicOp,
  validatePublicOpPayload,
  listPublicConsultantDoctors,
  findActiveConsultantDoctor,
  createPublicOpVisit,
  buildTrustedPublicPatientDoc,
  toPublicRegistrationResponse,
  RATE_LIMIT,
  RATE_WINDOW_MS,
};
