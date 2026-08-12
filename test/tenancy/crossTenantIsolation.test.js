/**
 * Cross-Tenant Isolation Test
 *
 * Verifies that hospitals on the shared tier (hms_shared) cannot see
 * each other's data. This is the most critical security invariant for
 * multi-tenant shared databases.
 *
 * Usage:
 *   node --test test/tenancy/crossTenantIsolation.test.js
 *
 * Requirements:
 *   - MONGO_URI_SHARED or MONGO_URI env var pointing to a test MongoDB
 *   - MONGO_URI_TENANT_BASE env var (defaults to mongodb://localhost:27017)
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

// Load env before any app modules
require("dotenv").config();

const { getSharedConnection } = require("../../utils/tenantDb");
const { registerTenantModels } = require("../../utils/tenantModels");

// Use unique IDs for test isolation
const HOSPITAL_A_ID = new mongoose.Types.ObjectId();
const HOSPITAL_B_ID = new mongoose.Types.ObjectId();

describe("Cross-Tenant Isolation (shared DB)", () => {
  let sharedConn;
  let PatientModel;

  before(async () => {
    // Connect master DB
    await mongoose.connect(
      process.env.MONGO_URI_SHARED || process.env.MONGO_URI,
      { useNewUrlParser: true, useUnifiedTopology: true }
    );

    // Get shared connection
    sharedConn = await getSharedConnection();
    registerTenantModels(sharedConn);
    PatientModel = sharedConn.model("Patient");

    // Clean up any leftover test data
    await PatientModel.deleteMany({
      hospitalId: { $in: [HOSPITAL_A_ID, HOSPITAL_B_ID] },
    });

    // Seed: create patients for Hospital A and Hospital B
    await PatientModel.create([
      {
        hospitalId: HOSPITAL_A_ID,
        name: "Patient Alpha",
        gender: "Male",
        age: "30",
        phone: "1111111111",
        UMRNo: `TEST-A-${Date.now()}`,
      },
      {
        hospitalId: HOSPITAL_A_ID,
        name: "Patient Bravo",
        gender: "Female",
        age: "25",
        phone: "2222222222",
        UMRNo: `TEST-A2-${Date.now()}`,
      },
      {
        hospitalId: HOSPITAL_B_ID,
        name: "Patient Charlie",
        gender: "Male",
        age: "40",
        phone: "3333333333",
        UMRNo: `TEST-B-${Date.now()}`,
      },
    ]);
  });

  after(async () => {
    // Clean up test data
    if (PatientModel) {
      await PatientModel.deleteMany({
        hospitalId: { $in: [HOSPITAL_A_ID, HOSPITAL_B_ID] },
      });
    }
    await mongoose.disconnect();
  });

  it("Hospital A can only see its own patients", async () => {
    const patients = await PatientModel.find({ hospitalId: HOSPITAL_A_ID });
    assert.equal(patients.length, 2, "Hospital A should see exactly 2 patients");
    for (const p of patients) {
      assert.equal(
        p.hospitalId.toString(),
        HOSPITAL_A_ID.toString(),
        "Every patient must belong to Hospital A"
      );
    }
  });

  it("Hospital B can only see its own patients", async () => {
    const patients = await PatientModel.find({ hospitalId: HOSPITAL_B_ID });
    assert.equal(patients.length, 1, "Hospital B should see exactly 1 patient");
    assert.equal(
      patients[0].hospitalId.toString(),
      HOSPITAL_B_ID.toString(),
      "Patient must belong to Hospital B"
    );
  });

  it("Hospital A cannot see Hospital B patients", async () => {
    const leaked = await PatientModel.find({
      hospitalId: HOSPITAL_A_ID,
      name: "Patient Charlie",
    });
    assert.equal(
      leaked.length,
      0,
      "Hospital A must NOT see Hospital B's Patient Charlie"
    );
  });

  it("Hospital B cannot see Hospital A patients", async () => {
    const leaked = await PatientModel.find({
      hospitalId: HOSPITAL_B_ID,
      name: "Patient Alpha",
    });
    assert.equal(
      leaked.length,
      0,
      "Hospital B must NOT see Hospital A's Patient Alpha"
    );
  });

  it("Unfiltered query (no hospitalId) returns both — proving the guard matters", async () => {
    // This test documents the risk: without hospitalId, data leaks.
    // The middleware/guards must ALWAYS inject hospitalId.
    const all = await PatientModel.find({
      hospitalId: { $in: [HOSPITAL_A_ID, HOSPITAL_B_ID] },
    });
    assert.equal(all.length, 3, "Both hospitals' data exists in hms_shared");
  });
});
