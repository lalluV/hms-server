const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildEntitlements,
  isSubscriptionAccessAllowed,
  SUBSCRIPTION_STATUS,
} = require("../services/entitlementsService");
const { getPlanConfig } = require("../config/planEntitlements");

describe("entitlementsService", () => {
  it("buildEntitlements keeps basic OP-only with doctor OP clinical enabled", () => {
    const h = {
      subscriptionPlan: "basic",
      subscriptionStatus: "active",
      active: true,
    };
    const e = buildEntitlements(h);
    assert.equal(e.modules.opd, true);
    assert.equal(e.modules.clinical, true);
    assert.equal(e.modules.ipd, false);
    assert.equal(e.modules.ipdNursePanel, false);
    assert.equal(e.modules.ipdDoctorRecord, false);
    assert.equal(e.modules.insurance, false);
    assert.equal(e.isAccessAllowed, true);
  });

  it("buildEntitlements enables IPD operations but not nurse or doctor IPD record for pro", () => {
    const h = {
      subscriptionPlan: "pro",
      subscriptionStatus: "active",
      active: true,
    };
    const e = buildEntitlements(h);
    assert.equal(e.modules.ipd, true);
    assert.equal(e.modules.ipdNursePanel, false);
    assert.equal(e.modules.ipdDoctorRecord, false);
    assert.equal(e.modules.insurance, true);
    assert.equal(e.isAccessAllowed, true);
  });

  it("buildEntitlements enables full IPD doctor record for enterprise", () => {
    const h = {
      subscriptionPlan: "enterprise",
      subscriptionStatus: "active",
      active: true,
    };
    const e = buildEntitlements(h);
    assert.equal(e.modules.ipd, true);
    assert.equal(e.modules.ipdNursePanel, true);
    assert.equal(e.modules.ipdDoctorRecord, true);
    assert.equal(e.modules.insurance, true);
    assert.equal(e.isAccessAllowed, true);
  });

  it("moduleOverrides can force doctor IPD record on for pro", () => {
    const h = {
      subscriptionPlan: "pro",
      subscriptionStatus: "active",
      active: true,
      moduleOverrides: { ipdDoctorRecord: true },
    };
    const e = buildEntitlements(h);
    assert.equal(e.modules.ipdDoctorRecord, true);
  });

  it("isSubscriptionAccessAllowed is false when canceled", () => {
    const h = {
      subscriptionStatus: SUBSCRIPTION_STATUS.CANCELED,
      active: true,
    };
    assert.equal(isSubscriptionAccessAllowed(h), false);
  });

  it("buildEntitlements turns all modules off when subscription is canceled", () => {
    const h = {
      subscriptionPlan: "enterprise",
      subscriptionStatus: SUBSCRIPTION_STATUS.CANCELED,
      active: true,
    };
    const e = buildEntitlements(h);
    assert.equal(e.isAccessAllowed, false);
    assert.equal(e.modules.core, false);
    assert.equal(e.modules.ipd, false);
    assert.equal(e.modules.ipdNursePanel, false);
    assert.equal(e.modules.ipdDoctorRecord, false);
  });

  it("isSubscriptionAccessAllowed is false when hospital inactive", () => {
    const h = { subscriptionStatus: "active", active: false };
    assert.equal(isSubscriptionAccessAllowed(h), false);
  });
});

describe("planEntitlements", () => {
  it("getPlanConfig falls back for unknown plan", () => {
    const { modules } = getPlanConfig("unknown-plan-xyz");
    assert.equal(typeof modules.core, "boolean");
  });
});
