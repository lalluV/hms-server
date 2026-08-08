const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildMasterLabCatalog,
  choosePreferredFormats,
  generateDeterministicCodes,
  inferIndianUnits,
  normalizeParameterRows,
} = require("../services/masterLabCatalogBuilder");
const {
  buildReviewQueue,
  validateMasterLabCatalog,
} = require("../services/masterLabCatalogValidator");
const { catalogHash, run: buildCatalogRun } = require("../scripts/buildMasterLabCatalog");
const {
  buildNameCategoryKey,
  loadCatalog,
  parseArgs: parseApplyArgs,
  resolveExistingParameter,
  summarizeParameterAction,
} = require("../scripts/applyMasterLabCatalog");

describe("master lab catalog builder", () => {
  it("generates stable deterministic codes", () => {
    const items = [
      { name: "Random Blood Sugar", groupCode: "BIO" },
      { name: "Random Blood Sugar", groupCode: "BIO" },
      { name: "Serum Creatinine", groupCode: "BIO" },
    ];
    generateDeterministicCodes(items, { prefix: "P" });
    assert.equal(items[0].generatedCode, "P-BIO-RBS");
    assert.equal(items[1].generatedCode, "P-BIO-RBS-2");
    assert.equal(items[2].generatedCode, "P-BIO-CREAT");
  });

  it("deduplicates canonical parameter names within a group", () => {
    const parameterCuration = [
      {
        name: "Hemoglobin",
        aliases: ["haemoglobin", "hb"],
        units: "g/dL",
        normalRange: { adult_male: "13-17", adult_female: "12-15", child: "11-16" },
        criticalValues: { low: "<7", high: ">20" },
        confidence: "medium",
      },
    ];
    const rows = [
      {
        PARAMCD: "LPR1",
        PARAMDESC: "Haemoglobin",
        TESTMAINGROUPCD: "PAT",
        NORMALRANGE: "Y",
        CRITICALVALUES: "N",
        ISACTIVE: "Y",
        METHOD: "",
      },
      {
        PARAMCD: "LPR2",
        PARAMDESC: "HB",
        TESTMAINGROUPCD: "PAT",
        NORMALRANGE: "Y",
        CRITICALVALUES: "N",
        ISACTIVE: "Y",
        METHOD: "",
      },
    ];

    const parameters = normalizeParameterRows(rows, parameterCuration);
    assert.equal(parameters.length, 1);
    assert.equal(parameters[0].record.name, "Hemoglobin");
    assert.equal(parameters[0].review.sourceRefs.length, 2);
  });

  it("infers Indian-standard units for common hematology analytes", () => {
    assert.equal(inferIndianUnits("Platelet Count"), "lakhs/cumm");
    assert.equal(inferIndianUnits("Total Leucocyte Count"), "cells/cumm");
    assert.equal(inferIndianUnits("RBC Count"), "millions/cumm");
    assert.equal(inferIndianUnits("Serum Sodium"), "mEq/L");
    assert.equal(inferIndianUnits("SGPT"), "IU/L");
    assert.equal(inferIndianUnits("Prothrombin Time"), "Sec");
  });

  it("prefers default format rows when selecting tests", () => {
    const templateRows = [{ FORMATCD: "FMT001", ISACTIVE: "Y" }];
    const formatRows = [
      {
        TESTCD: "BIO001",
        FORMATCD: "FMT001",
        FORMATDESC: "Lipid Profile",
        TESTMAINGROUPCD: "BIO",
        DEFAULTFORMAT: "Y",
        ISACTIVE: "Y",
        CREATEDT: "2",
        MINTIME: "1:Hours",
        MAXTIME: "4:Hours",
      },
      {
        TESTCD: "BIO001",
        FORMATCD: "FMT002",
        FORMATDESC: "Lipid Profile Alt",
        TESTMAINGROUPCD: "BIO",
        DEFAULTFORMAT: "N",
        ISACTIVE: "Y",
        CREATEDT: "1",
        MINTIME: "2:Hours",
        MAXTIME: "6:Hours",
      },
    ];

    const preferred = choosePreferredFormats(formatRows, templateRows);
    assert.equal(preferred.length, 1);
    assert.equal(preferred[0].preferred.FORMATCD, "FMT001");
    assert.equal(preferred[0].alternatives.length, 1);
  });
});

describe("master lab catalog validator", () => {
  it("flags dangling diagnostic parameter links", () => {
    const validation = validateMasterLabCatalog({
      parameters: [
        {
          record: {
            parameter_code: "P-BIO-GLUCOSE",
            name: "Glucose",
            units: "mg/dL",
            category: "Biochemistry",
            default_normal_range: { adult_male: "70-99", adult_female: "70-99", child: "70-99" },
            default_critical_values: { low: "", high: "" },
            active: true,
          },
          review: { confidence: "medium", warnings: [] },
        },
      ],
      diagnostics: [
        {
          record: {
            test_code: "T-BIO-GLUCOSE",
            name: "Glucose",
            deptname: "Biochemistry",
            subdeptname: "",
            description: "",
            default_fasting: "Not Required",
            default_reportsIn: "Same Day",
            default_testInstructions: [],
            active: true,
          },
          links: [{ parameter_code: "P-BIO-MISSING", parameter_name: "Missing", order: 0 }],
          review: { confidence: "low", warnings: [] },
        },
      ],
    });

    assert.equal(validation.valid, false);
    assert.ok(validation.issues.some((issue) => issue.message.includes("Dangling parameter link")));
    const queue = buildReviewQueue(validation);
    assert.ok(queue.some((item) => item.code === "T-BIO-GLUCOSE"));
  });
});

describe("master lab catalog apply helpers", () => {
  it("blocks legacy code replacement unless --replace-codes is enabled", () => {
    const record = {
      parameter_code: "P-BIO-GLUCOSE",
      name: "Glucose",
      category: "Biochemistry",
    };
    const indexes = {
      parametersByCode: new Map(),
      parametersByNameCategory: new Map([
        [
          buildNameCategoryKey(record.name, record.category),
          [{ _id: "abc", parameter_code: "OLD-CODE", name: record.name, category: record.category }],
        ],
      ]),
    };

    const resolution = resolveExistingParameter(record, indexes);
    const summary = summarizeParameterAction(record, resolution);
    assert.equal(summary.action, "blocked");
    assert.match(summary.reason, /code differs/);
  });

  it("replaces legacy codes when replaceCodes is enabled", () => {
    const record = {
      parameter_code: "P-BIO-GLUCOSE",
      name: "Glucose",
      category: "Biochemistry",
    };
    const indexes = {
      parametersByCode: new Map(),
      parametersByNameCategory: new Map([
        [
          buildNameCategoryKey(record.name, record.category),
          [{ _id: "abc", parameter_code: "LPR0199", name: record.name, category: record.category }],
        ],
      ]),
    };

    const resolution = resolveExistingParameter(record, indexes);
    const summary = summarizeParameterAction(record, resolution, { replaceCodes: true });
    assert.equal(summary.action, "update");
    assert.equal(summary.replaceCode, true);
  });

  it("defaults apply script to dry-run unless --apply is passed", () => {
    const options = parseApplyArgs([]);
    assert.equal(options.apply, false);
    assert.equal(parseApplyArgs(["--apply"]).apply, true);
    assert.equal(parseApplyArgs(["--replace-codes"]).replaceCodes, true);
  });
});

describe("master lab catalog preview artifacts", () => {
  it("validates committed preview files when present", () => {
    const outputDir = path.resolve(__dirname, "../data/master-lab-catalog/generated");
    if (!fs.existsSync(path.join(outputDir, "master-parameters.preview.json"))) {
      return;
    }

    const catalog = loadCatalog(outputDir);
    const hash = catalogHash(catalog.parameters, catalog.diagnostics);
    assert.equal(catalog.summary.catalogHash, hash);
    const validation = validateMasterLabCatalog(catalog);
    assert.equal(validation.valid, true);
    assert.ok(validation.counts.parameters > 0);
    assert.ok(validation.counts.diagnostics > 0);
  });
});

describe("master lab catalog build dry-run", () => {
  it("writes preview artifacts from fixture rows without touching the database", async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "master-lab-fixtures-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "master-lab-output-"));

    const parameterRows = [
      {
        PARAMCD: "LPR0134",
        PARAMDESC: "Haemoglobin",
        TESTMAINGROUPCD: "PAT",
        NORMALRANGE: "Y",
        CRITICALVALUES: "N",
        ISACTIVE: "Y",
        METHOD: "",
      },
    ];
    const formatRows = [
      {
        TESTCD: "PAT0012",
        FORMATCD: "FMT0745",
        FORMATDESC: "COMPLETE BLOOD COUNT",
        TESTMAINGROUPCD: "PAT",
        DEFAULTFORMAT: "Y",
        ISACTIVE: "Y",
        CREATEDT: "1",
        MINTIME: "2:Hours",
        MAXTIME: "4:Hours",
        REPORTTITLE: "DEPARTMENT OF PATHOLOGY",
        SPECIMEN: "Blood",
      },
    ];
    const templateRows = [{ TESTCD: "PAT0012", FORMATCD: "FMT0745", ISACTIVE: "Y" }];
    const sampleRows = [
      {
        TESTCD: "PAT0012",
        SPECIMENCD: "SPC3",
        SPECIMENNAME: "Blood",
        VACUTAINER: "LAVENDER",
        PRECAUTIONS: "",
        CLINICALHISTORY: "",
      },
    ];
    const specimenRows = [{ SPECIMENCD: "SPC3", SPECIMENNAME: "Blood", ISACTIVE: "Y" }];

    const files = {
      "Book1.xlsx": parameterRows,
      "Book2.xlsx": formatRows,
      "Book4.xlsx": templateRows,
      "Book5.xlsx": sampleRows,
      "Book6.xlsx": specimenRows,
    };
    const reader = (filePath) => {
      const fileName = path.basename(filePath);
      return Promise.resolve(files[fileName] || []);
    };

    const built = await buildMasterLabCatalog({ sourceDir: fixtureDir, reader });
    const catalog = {
      parameters: built.parameters.map(({ internal, ...entry }) => entry),
      diagnostics: built.diagnostics.map(({ internal, ...entry }) => entry),
    };

    await buildCatalogRun({
      sourceDir: fixtureDir,
      outputDir,
      validateOnly: false,
      reader,
    });

    assert.ok(catalog.parameters.length > 0);
    assert.ok(catalog.diagnostics.length > 0);
    assert.ok(fs.existsSync(path.join(outputDir, "master-parameters.preview.json")));
    assert.ok(fs.existsSync(path.join(outputDir, "master-diagnostics.preview.json")));
    assert.ok(fs.existsSync(path.join(outputDir, "review-queue.json")));
    assert.ok(fs.existsSync(path.join(outputDir, "summary.json")));
  });
});
