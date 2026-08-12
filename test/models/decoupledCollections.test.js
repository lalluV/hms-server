const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { schemas, TENANT_MODELS } = require("../../utils/tenantModels");

describe("Decoupled Collections Architecture Test", () => {
  it("TENANT_MODELS should include Prescription and IPAdmission", () => {
    assert.ok(TENANT_MODELS.includes("Prescription"), "Prescription must be in TENANT_MODELS");
    assert.ok(TENANT_MODELS.includes("IPAdmission"), "IPAdmission must be in TENANT_MODELS");
    assert.ok(TENANT_MODELS.includes("Patient"), "Patient must be in TENANT_MODELS");
  });

  it("Prescription schema should support OP insurance and referral commission", () => {
    const rxSchema = schemas.prescriptionSchema;
    assert.ok(rxSchema, "Prescription schema must exist");

    const paths = rxSchema.paths;
    assert.ok(paths.prescriptionId, "Must have prescriptionId");
    assert.ok(paths.hospitalId, "Must have hospitalId");
    assert.ok(paths.patientId, "Must have patientId");
    assert.ok(paths.UMRNo, "Must have UMRNo");
    assert.ok(paths.medicineData, "Must have medicineData");
    assert.ok(paths.pharmacyStatus, "Must have pharmacyStatus");
    assert.ok(paths.insurance_provider, "Must have insurance_provider");
    assert.ok(paths.commissionEarnerId, "Must have commissionEarnerId");
  });

  it("IPAdmission schema should support bed transfers, charts, and insurance claims", () => {
    const ipSchema = schemas.ipAdmissionSchema;
    assert.ok(ipSchema, "IPAdmission schema must exist");

    const paths = ipSchema.paths;
    assert.ok(paths.ipNumber, "Must have ipNumber");
    assert.ok(paths.hospitalId, "Must have hospitalId");
    assert.ok(paths.patientId, "Must have patientId");
    assert.ok(paths.wardId, "Must have wardId");
    assert.ok(paths.transfers, "Must have transfers array");
    assert.ok(paths.vitals, "Must have vitals array");
    assert.ok(paths.nurseNotes, "Must have nurseNotes array");
    assert.ok(paths.dischargeSummary, "Must have dischargeSummary");
    assert.ok(paths.insurance_provider, "Must have insurance_provider");
    assert.ok(paths.commissionEarnerId, "Must have commissionEarnerId");
  });

  it("Patient schema should be lean and have activeAdmissionId pointer", () => {
    const patientSchema = schemas.patientSchema;
    assert.ok(patientSchema, "Patient schema must exist");

    const paths = patientSchema.paths;
    assert.ok(paths.UMRNo, "Must have UMRNo");
    assert.ok(paths.name, "Must have name");
    assert.ok(paths.phone, "Must have phone");
    assert.ok(paths.allergiesHistory, "Must have allergiesHistory");
    assert.ok(paths.activeAdmissionId, "Must have activeAdmissionId pointer");
    assert.ok(paths.paymentMethod, "Must have paymentMethod");
    assert.ok(paths.insurance_provider, "Must have insurance_provider");
  });
});
