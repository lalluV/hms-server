/**
 * Unit tests for doctor memory similarity and aggregation.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSearchContext,
  buildCaseFromPrescription,
  normalizeMedKey,
} = require("../utils/doctorMemory");

test("buildSearchContext parses labeled note sections", () => {
  const ctx = buildSearchContext({
    clinicalNote: `Complaints:
Fever 3 days
Diagnosis:
Viral fever`,
  });
  assert.ok(ctx.complaints.some((c) => /fever/i.test(c)));
  assert.ok(ctx.diagnosis.some((d) => /viral/i.test(d)));
  assert.ok(ctx.searchTokens.includes("fever"));
});

test("buildCaseFromPrescription snapshots meds without catalog", () => {
  const doc = buildCaseFromPrescription({
    hospitalId: "h1",
    doctorId: "d1",
    umr: "UMR0001",
    prescription: {
      prescriptionId: "rx1",
      date: "2026-08-01",
      medicineData: [
        {
          name: "Dolo 650mg",
          dosage: "650mg",
          frequency: { value: 2, unit: "/Day" },
          duration: { value: 3, unit: "Days" },
          isActive: true,
        },
      ],
      diagnosticData: [{ name: "CBP" }],
      doctorNotes: [{ content: "Complaints:\nFever\nDiagnosis:\nViral fever" }],
    },
  });
  assert.equal(doc.medicines[0].name, "Dolo 650mg");
  assert.equal(doc.labs[0].name, "CBP");
  assert.equal(normalizeMedKey("Dolo 650mg"), "dolo 650mg");
});
