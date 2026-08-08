require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const MasterParameter = require("../models/MasterParameter");
const MasterDiagnostic = require("../models/MasterDiagnostic");
const { initializeMasterDatabase } = require("../utils/tenantDb");
const {
  indexAllMasterDiagnostics,
  indexAllMasterParameters,
} = require("../utils/meilisearch");
const { normalizeLookup } = require("../services/masterLabCatalogBuilder");
const { validateMasterLabCatalog } = require("../services/masterLabCatalogValidator");
const { catalogHash } = require("./buildMasterLabCatalog");

function parseArgs(argv) {
  const options = {
    inputDir: path.resolve(__dirname, "../data/master-lab-catalog/generated"),
    apply: false,
    reindex: true,
    expectedHash: "",
    replaceCodes: false,
  };

  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--replace-codes") options.replaceCodes = true;
    else if (arg === "--no-reindex") options.reindex = false;
    else if (arg.startsWith("--input-dir=")) options.inputDir = path.resolve(arg.slice(12));
    else if (arg.startsWith("--catalog-hash=")) options.expectedHash = arg.slice(15).trim();
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadCatalog(inputDir) {
  const summaryPath = path.join(inputDir, "summary.json");
  const parametersPath = path.join(inputDir, "master-parameters.preview.json");
  const diagnosticsPath = path.join(inputDir, "master-diagnostics.preview.json");

  for (const filePath of [summaryPath, parametersPath, diagnosticsPath]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing required catalog file: ${filePath}`);
    }
  }

  return {
    summary: readJson(summaryPath),
    parameters: readJson(parametersPath),
    diagnostics: readJson(diagnosticsPath),
  };
}

function buildNameCategoryKey(name, category) {
  return `${normalizeLookup(category)}:${normalizeLookup(name)}`;
}

function buildNameDeptKey(name, deptname) {
  return `${normalizeLookup(deptname)}:${normalizeLookup(name)}`;
}

async function loadExistingMasters() {
  const [parameters, diagnostics] = await Promise.all([
    MasterParameter.find({}).lean(),
    MasterDiagnostic.find({}).lean(),
  ]);

  const parametersByCode = new Map();
  const parametersByNameCategory = new Map();
  for (const parameter of parameters) {
    parametersByCode.set(parameter.parameter_code, parameter);
    const key = buildNameCategoryKey(parameter.name, parameter.category);
    if (!parametersByNameCategory.has(key)) parametersByNameCategory.set(key, []);
    parametersByNameCategory.get(key).push(parameter);
  }

  const diagnosticsByCode = new Map();
  const diagnosticsByNameDept = new Map();
  for (const diagnostic of diagnostics) {
    diagnosticsByCode.set(diagnostic.test_code, diagnostic);
    const key = buildNameDeptKey(diagnostic.name, diagnostic.deptname);
    if (!diagnosticsByNameDept.has(key)) diagnosticsByNameDept.set(key, []);
    diagnosticsByNameDept.get(key).push(diagnostic);
  }

  return {
    parametersByCode,
    parametersByNameCategory,
    diagnosticsByCode,
    diagnosticsByNameDept,
  };
}

function pickDeterministicMatch(matches) {
  const active = matches.filter((match) => match.active !== false);
  const pool = active.length ? active : matches;
  return [...pool].sort((left, right) => String(left._id).localeCompare(String(right._id)))[0];
}

function resolveExistingParameter(record, indexes, { allowAmbiguous = false } = {}) {
  const byCode = indexes.parametersByCode.get(record.parameter_code);
  if (byCode) return { doc: byCode, strategy: "parameter_code" };

  const key = buildNameCategoryKey(record.name, record.category);
  const matches = indexes.parametersByNameCategory.get(key) || [];
  if (matches.length === 1) return { doc: matches[0], strategy: "name+category" };
  if (matches.length > 1) {
    if (allowAmbiguous) {
      return { doc: pickDeterministicMatch(matches), strategy: "name+category" };
    }
    return {
      error: `Ambiguous existing parameter match for ${record.name} (${record.category}).`,
    };
  }
  return { doc: null, strategy: "create" };
}

function resolveExistingDiagnostic(record, indexes, { allowAmbiguous = false } = {}) {
  const byCode = indexes.diagnosticsByCode.get(record.test_code);
  if (byCode) return { doc: byCode, strategy: "test_code" };

  const key = buildNameDeptKey(record.name, record.deptname);
  const matches = indexes.diagnosticsByNameDept.get(key) || [];
  if (matches.length === 1) return { doc: matches[0], strategy: "name+deptname" };
  if (matches.length > 1) {
    if (allowAmbiguous) {
      return { doc: pickDeterministicMatch(matches), strategy: "name+deptname" };
    }
    return {
      error: `Ambiguous existing diagnostic match for ${record.name} (${record.deptname}).`,
    };
  }
  return { doc: null, strategy: "create" };
}

function summarizeParameterAction(record, resolution, { replaceCodes = false } = {}) {
  if (resolution.error) return { action: "blocked", reason: resolution.error };
  if (!resolution.doc) return { action: "create" };
  if (resolution.doc.parameter_code === record.parameter_code) return { action: "update" };
  if (replaceCodes && resolution.strategy === "name+category") {
    return { action: "update", replaceCode: true };
  }
  return {
    action: "blocked",
    reason: `Existing parameter ${resolution.doc.parameter_code} matches ${record.name} but code differs (${record.parameter_code}).`,
  };
}

function summarizeDiagnosticAction(record, resolution, { replaceCodes = false } = {}) {
  if (resolution.error) return { action: "blocked", reason: resolution.error };
  if (!resolution.doc) return { action: "create" };
  if (resolution.doc.test_code === record.test_code) return { action: "update" };
  if (replaceCodes && resolution.strategy === "name+deptname") {
    return { action: "update", replaceCode: true };
  }
  return {
    action: "blocked",
    reason: `Existing diagnostic ${resolution.doc.test_code} matches ${record.name} but code differs (${record.test_code}).`,
  };
}

async function applyMasterLabCatalog(options = parseArgs(process.argv.slice(2))) {
  const catalog = loadCatalog(options.inputDir);
  const hash = catalogHash(catalog.parameters, catalog.diagnostics);

  if (options.expectedHash && options.expectedHash !== hash) {
    throw new Error(
      `Catalog hash mismatch. Expected ${options.expectedHash}, got ${hash}. Rebuild or pass the current hash.`,
    );
  }
  if (catalog.summary.catalogHash && catalog.summary.catalogHash !== hash) {
    throw new Error(
      "Preview files no longer match summary.json catalogHash. Re-run catalog:build before applying.",
    );
  }

  const validation = validateMasterLabCatalog(catalog);
  if (!validation.valid) {
    throw new Error("Catalog validation failed. Fix preview files or rebuild before applying.");
  }

  await initializeMasterDatabase();
  const indexes = await loadExistingMasters();
  const parameterCodeToId = new Map();
  const report = {
    mode: options.apply ? "apply" : "dry-run",
    catalogHash: hash,
    parameters: { create: 0, update: 0, blocked: 0 },
    diagnostics: { create: 0, update: 0, blocked: 0 },
    blockedItems: [],
  };

  for (const entry of catalog.parameters) {
    const record = entry.record;
    const resolution = resolveExistingParameter(record, indexes, {
      allowAmbiguous: options.replaceCodes,
    });
    const summary = summarizeParameterAction(record, resolution, {
      replaceCodes: options.replaceCodes,
    });
    report.parameters[summary.action === "blocked" ? "blocked" : summary.action] += 1;

    if (summary.action === "blocked") {
      report.blockedItems.push({
        type: "parameter",
        code: record.parameter_code,
        reason: summary.reason,
      });
      continue;
    }

    if (!options.apply) continue;

    const payload = {
      parameter_code: record.parameter_code,
      name: record.name,
      units: record.units,
      category: record.category,
      default_normal_range: record.default_normal_range,
      default_critical_values: record.default_critical_values,
      active: record.active,
    };

    let saved;
    if (summary.action === "update") {
      saved = await MasterParameter.findByIdAndUpdate(resolution.doc._id, payload, {
        new: true,
        runValidators: true,
      });
      indexes.parametersByCode.delete(resolution.doc.parameter_code);
      indexes.parametersByCode.set(saved.parameter_code, saved);
    } else {
      saved = await MasterParameter.create(payload);
    }
    parameterCodeToId.set(record.parameter_code, saved._id);
  }

  if (options.apply) {
    const existingParameters = await MasterParameter.find({}, "_id parameter_code").lean();
    for (const parameter of existingParameters) {
      parameterCodeToId.set(parameter.parameter_code, parameter._id);
    }
  }

  for (const entry of catalog.diagnostics) {
    const record = entry.record;
    const resolution = resolveExistingDiagnostic(record, indexes, {
      allowAmbiguous: options.replaceCodes,
    });
    const summary = summarizeDiagnosticAction(record, resolution, {
      replaceCodes: options.replaceCodes,
    });
    report.diagnostics[summary.action === "blocked" ? "blocked" : summary.action] += 1;

    if (summary.action === "blocked") {
      report.blockedItems.push({
        type: "diagnostic",
        code: record.test_code,
        reason: summary.reason,
      });
      continue;
    }

    if (!options.apply) continue;

    const suggested_parameters = (entry.links || []).map((link, order) => {
      const parameterId = parameterCodeToId.get(link.parameter_code);
      if (!parameterId) {
        throw new Error(
          `Missing parameter ObjectId for link ${link.parameter_code} on diagnostic ${record.test_code}.`,
        );
      }
      return { parameterId, order };
    });

    const payload = {
      test_code: record.test_code,
      name: record.name,
      deptname: record.deptname,
      subdeptname: record.subdeptname || "",
      description: record.description || "",
      default_fasting: record.default_fasting,
      default_reportsIn: record.default_reportsIn,
      default_testInstructions: record.default_testInstructions || [],
      suggested_parameters,
      active: record.active,
    };

    if (summary.action === "update") {
      await MasterDiagnostic.findByIdAndUpdate(resolution.doc._id, payload, {
        new: true,
        runValidators: true,
      });
    } else {
      await MasterDiagnostic.create(payload);
    }
  }

  if (options.apply && report.blockedItems.length > 0) {
    throw new Error(
      `Apply completed with ${report.blockedItems.length} blocked item(s). Resolve conflicts before reindexing.`,
    );
  }

  if (options.apply && options.reindex) {
    await indexAllMasterParameters();
    await indexAllMasterDiagnostics();
    report.reindexed = true;
  }

  if (options.apply) {
    const [parameterCount, diagnosticCount] = await Promise.all([
      MasterParameter.countDocuments({}),
      MasterDiagnostic.countDocuments({}),
    ]);
    report.finalCounts = { parameters: parameterCount, diagnostics: diagnosticCount };
  }

  return report;
}

if (require.main === module) {
  applyMasterLabCatalog()
    .then((report) => {
      console.log(`Mode: ${report.mode}`);
      console.log(`Catalog hash: ${report.catalogHash}`);
      console.log(
        `Parameters -> create: ${report.parameters.create}, update: ${report.parameters.update}, blocked: ${report.parameters.blocked}`,
      );
      console.log(
        `Diagnostics -> create: ${report.diagnostics.create}, update: ${report.diagnostics.update}, blocked: ${report.diagnostics.blocked}`,
      );
      if (report.blockedItems.length) {
        console.log("Blocked items:");
        report.blockedItems.slice(0, 20).forEach((item) => {
          console.log(`  - ${item.type} ${item.code}: ${item.reason}`);
        });
        if (report.blockedItems.length > 20) {
          console.log(`  ... ${report.blockedItems.length - 20} more`);
        }
      }
      if (report.finalCounts) {
        console.log(
          `Final master counts -> parameters: ${report.finalCounts.parameters}, diagnostics: ${report.finalCounts.diagnostics}`,
        );
      }
      if (report.mode === "dry-run") {
        console.log("Dry run only. Re-run with --apply to write to the master database.");
      }
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = {
  applyMasterLabCatalog,
  buildNameCategoryKey,
  buildNameDeptKey,
  loadCatalog,
  parseArgs,
  resolveExistingDiagnostic,
  resolveExistingParameter,
  summarizeDiagnosticAction,
  summarizeParameterAction,
};
