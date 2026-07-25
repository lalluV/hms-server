const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizePhone,
  normalizeName,
  normalizeAge,
  normalizeGender,
  buildPublicRegistrationKey,
  checkPublicOpRateLimit,
  resetPublicOpRateLimit,
  assertHospitalAllowsPublicOp,
  validatePublicOpPayload,
  buildTrustedPublicPatientDoc,
  toPublicRegistrationResponse,
  RATE_LIMIT,
} = require("../utils/publicOpRegistration");

describe("publicOpRegistration utils", () => {
  beforeEach(() => {
    resetPublicOpRateLimit();
  });

  it("normalizes phone, name, age, and gender for identity matching", () => {
    assert.equal(sanitizePhone("09876543210"), "9876543210");
    assert.equal(normalizeName("  Ram   Kumar "), "ram kumar");
    assert.equal(normalizeAge("045"), "45");
    assert.equal(normalizeGender("female"), "Female");
    assert.equal(normalizeGender("M"), "Male");
  });

  it("builds a stable public registration key for the same identity", () => {
    const a = buildPublicRegistrationKey({
      hospitalId: "h1",
      phone: "09876543210",
      name: "Ram Kumar",
      age: "30",
      gender: "Male",
    });
    const b = buildPublicRegistrationKey({
      hospitalId: "h1",
      phone: "9876543210",
      name: "  ram   kumar ",
      age: "030",
      gender: "male",
    });
    const different = buildPublicRegistrationKey({
      hospitalId: "h1",
      phone: "9876543210",
      name: "Sita Kumari",
      age: "28",
      gender: "Female",
    });

    assert.equal(a, b);
    assert.notEqual(a, different);
    assert.equal(a.length, 64);
  });

  it("validates required fields and rejects invalid phone/email", () => {
    const bad = validatePublicOpPayload({
      name: "",
      gender: "Other",
      age: "200",
      phone: "0123",
      email: "bad@",
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.name);
    assert.ok(bad.errors.gender);
    assert.ok(bad.errors.age);
    assert.ok(bad.errors.phone);
    assert.ok(bad.errors.email);

    const good = validatePublicOpPayload({
      name: "Ram Kumar",
      gender: "Male",
      age: "30",
      phone: "9876543210",
      email: "ram@example.com",
      street_address: "Street 1",
      city: "Warangal",
    });
    assert.equal(good.ok, true);
    assert.equal(good.data.phone, "9876543210");
    assert.equal(good.data.country, "India");
  });

  it("forces trusted defaults and ignores client-controlled billing fields", () => {
    const validated = validatePublicOpPayload({
      name: "Ram Kumar",
      gender: "Male",
      age: "30",
      phone: "9876543210",
      doctorId: "doc-1",
      paymentMethod: "Insurance",
      insurance_providerId: "ins-1",
      hospitalId: "spoof",
    });
    assert.equal(validated.ok, true);

    const doc = buildTrustedPublicPatientDoc({
      hospitalId: "real-hospital",
      data: validated.data,
      publicRegistrationKey: "abc",
    });

    assert.equal(doc.hospitalId, "real-hospital");
    assert.equal(doc.patient_type, "OP");
    assert.equal(doc.active, true);
    assert.equal(doc.paymentMethod, "Personal");
    assert.equal(doc.registered_by, "Public self-registration");
    assert.equal(doc.doctorId, "");
    assert.equal(doc.insurance_providerId, "");
    assert.equal(doc.publicRegistrationKey, "abc");
    assert.equal(doc.consultantDoctor, "");
  });

  it("returns only minimal confirmation fields", () => {
    const response = toPublicRegistrationResponse(
      {
        UMRNo: "UMR00000001",
        name: "Ram Kumar",
        registration_date: "2026-07-25T00:00:00.000Z",
        phone: "9876543210",
        street_address: "secret",
      },
      { created: true },
    );
    assert.deepEqual(response, {
      status: "created",
      UMRNo: "UMR00000001",
      name: "Ram Kumar",
      registration_date: "2026-07-25T00:00:00.000Z",
    });
  });

  it("rejects inactive, unprovisioned, or subscription-blocked hospitals", () => {
    assert.equal(
      assertHospitalAllowsPublicOp({
        active: false,
        databaseStatus: "active",
        subscriptionStatus: "active",
      }).ok,
      false,
    );
    assert.equal(
      assertHospitalAllowsPublicOp({
        active: true,
        databaseStatus: "pending",
        subscriptionStatus: "active",
      }).status,
      503,
    );
    assert.equal(
      assertHospitalAllowsPublicOp({
        active: true,
        databaseStatus: "active",
        subscriptionStatus: "canceled",
        subscriptionPlan: "pro",
      }).ok,
      false,
    );
    assert.equal(
      assertHospitalAllowsPublicOp({
        active: true,
        databaseStatus: "active",
        subscriptionStatus: "active",
        subscriptionPlan: "pro",
      }).ok,
      true,
    );
  });

  it("rate-limits repeated public registration attempts per IP/hospital", () => {
    const req = {
      hospitalId: "h1",
      ip: "1.2.3.4",
      headers: {},
    };

    for (let i = 0; i < RATE_LIMIT; i += 1) {
      const result = checkPublicOpRateLimit(req);
      assert.equal(result.allowed, true);
    }

    const blocked = checkPublicOpRateLimit(req);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec > 0);

    const otherHospital = checkPublicOpRateLimit({
      ...req,
      hospitalId: "h2",
    });
    assert.equal(otherHospital.allowed, true);
  });
});
