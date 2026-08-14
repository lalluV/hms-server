/**
 * Unit tests for doctor memory direct prescription similarity and canonical deduplication.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSearchContext,
  buildCaseFromPrescription,
  normalizeMedKey,
  normalizeLabKey,
  scoreCase,
} = require("../utils/doctorMemory");

test("buildSearchContext parses labeled note sections and retains 2-letter clinical acronyms", () => {
  const ctx = buildSearchContext({
    clinicalNote: `Complaints:
Fever 3 days with severe headache
Past Medical History:
Known case of DM and HTN
Diagnosis:
Viral fever with URTI`,
  });

  assert.ok(ctx.complaints.some((c) => /fever/i.test(c)));
  assert.ok(ctx.diagnosis.some((d) => /viral/i.test(d)));
  assert.ok(ctx.searchTokens.includes("fever"));
  assert.ok(ctx.searchTokens.includes("dm"), "Retains DM abbreviation");
  assert.ok(ctx.searchTokens.includes("htn"), "Retains HTN abbreviation");
  assert.ok(ctx.searchTokens.includes("urti"), "Retains URTI abbreviation");
});

test("canonical medicine normalization deduplicates variations to the same key", () => {
  const variations = [
    "Tab Dolo 650",
    "Tab. Dolo 650 mg",
    "Dolo 650mg",
    "DOLO 650",
    "Tab Dolo 650mg 1-0-1",
    "Cap Dolo 650 mg TDS",
  ];

  const keys = variations.map(normalizeMedKey);
  const uniqueKeys = new Set(keys);
  assert.equal(uniqueKeys.size, 1, `Expected 1 unique key, got: ${[...uniqueKeys].join(", ")}`);
  assert.equal([...uniqueKeys][0], "dolo 650");
});

test("canonical lab normalization maps test synonyms to standard test keys", () => {
  const cbpVariations = [
    "CBP",
    "CBC",
    "Complete Blood Picture",
    "Complete Blood Count",
    "Hemogram",
  ];

  for (const name of cbpVariations) {
    assert.equal(normalizeLabKey(name), "cbp", `Failed for lab: ${name}`);
  }

  assert.equal(normalizeLabKey("LFT"), "lft");
  assert.equal(normalizeLabKey("Liver Function Tests"), "lft");
  assert.equal(normalizeLabKey("KFT"), "rft");
  assert.equal(normalizeLabKey("Renal Function Test"), "rft");
  assert.equal(normalizeLabKey("CUE"), "urine routine");
  assert.equal(normalizeLabKey("Complete Urine Examination"), "urine routine");
  assert.equal(normalizeLabKey("GRBS"), "rbs");
  assert.equal(normalizeLabKey("Random Blood Sugar"), "rbs");
});

test("asymmetric containment scoring matches brief notes against rich clinical records", () => {
  const briefContext = buildSearchContext({
    clinicalNote: "Complaints:\nHigh fever 2 days\nDiagnosis:\nViral fever",
  });

  const richPastCase = buildCaseFromPrescription({
    hospitalId: "h1",
    doctorId: "d1",
    umr: "UMR001",
    prescription: {
      prescriptionId: "rx-past-01",
      date: "2026-08-01",
      doctorNotes: [
        {
          content:
            "Complaints:\nHigh grade fever since 4 days associated with chills, rigors, body pains, nausea, headache\nExamination:\nThroat congested, chest clear\nDiagnosis:\nViral fever\nAdvice:\nDrink plenty of fluids, bed rest",
        },
      ],
      medicineData: [
        { name: "Tab Dolo 650mg", dosage: "650mg", frequency: { value: 3, unit: "/Day" }, duration: { value: 5, unit: "Days" } },
        { name: "Cap Pantocid 40mg", dosage: "40mg", frequency: { value: 1, unit: "/Day" }, duration: { value: 5, unit: "Days" } },
      ],
      diagnosticData: [{ name: "CBP" }],
    },
  });

  const score = scoreCase(richPastCase, briefContext, "UMR002");
  assert.ok(score >= 0.35, `Expected high similarity score for viral fever case, got ${score}`);
});

test("buildCaseFromPrescription directly parses raw Prescription document format", () => {
  const doc = buildCaseFromPrescription({
    hospitalId: "h1",
    doctorId: "d1",
    umr: "UMR0001",
    prescription: {
      prescriptionId: "rx1",
      date: "2026-08-01",
      medicineData: [
        {
          name: "Tab Dolo 650mg",
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

  assert.equal(doc.medicines[0].name, "Tab Dolo 650mg");
  assert.equal(doc.labs[0].name, "CBP");
  assert.equal(normalizeMedKey(doc.medicines[0].name), "dolo 650");
  assert.equal(normalizeLabKey(doc.labs[0].name), "cbp");
});
