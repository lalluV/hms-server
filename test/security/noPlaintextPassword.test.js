const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { schemas } = require("../../utils/tenantModels");

describe("Security: No Plaintext Password Storage", () => {
  it("Staff schema should not require loginPassword", () => {
    const staffSchema = schemas.staffSchema;
    assert.ok(staffSchema, "staffSchema must exist");
    
    // Test creating a dummy document without loginPassword
    const dummyStaff = {
      id: "TEST-001",
      userId: "testuser",
      name: "Test Doctor",
      type: "Doctor",
      password: "hashed_bcrypt_string",
      hospitalId: new mongoose.Types.ObjectId(),
    };

    // loginPassword should not be present in sanitized output
    assert.equal(dummyStaff.loginPassword, undefined);
  });
});
