const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("Phase B visit-scoped billing fields", () => {
  const visitPaths = ["visitType", "prescriptionId", "admissionId"];

  for (const modelName of [
    "PharmacyReceipt",
    "DiagnosticsReceipt",
    "AdvanceReceipt",
    "Consultation",
    "Action",
  ]) {
    it(`${modelName} schema includes visit scope fields`, () => {
      const Model = require(`../models/${modelName}`);
      assert.ok(Model?.schema, `${modelName} must export a schema`);
      for (const path of visitPaths) {
        assert.ok(
          Model.schema.paths[path],
          `${modelName} must have ${path}`,
        );
      }
    });
  }
});
