const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildMasterLabCatalog } = require("../services/masterLabCatalogBuilder");
const {
  buildReviewQueue,
  validateMasterLabCatalog,
} = require("../services/masterLabCatalogValidator");

function parseArgs(argv) {
  const options = {
    sourceDir: path.join(os.homedir(), "Downloads"),
    outputDir: path.resolve(__dirname, "../data/master-lab-catalog/generated"),
    validateOnly: false,
  };
  for (const arg of argv) {
    if (arg === "--validate-only") options.validateOnly = true;
    else if (arg.startsWith("--source-dir=")) options.sourceDir = path.resolve(arg.slice(13));
    else if (arg.startsWith("--output-dir=")) options.outputDir = path.resolve(arg.slice(13));
  }
  return options;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function catalogHash(parameters, diagnostics) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ parameters, diagnostics }))
    .digest("hex");
}

function readPreview(outputDir) {
  return {
    parameters: JSON.parse(
      fs.readFileSync(path.join(outputDir, "master-parameters.preview.json"), "utf8"),
    ),
    diagnostics: JSON.parse(
      fs.readFileSync(path.join(outputDir, "master-diagnostics.preview.json"), "utf8"),
    ),
  };
}

async function run(options = parseArgs(process.argv.slice(2))) {
  let catalog;
  let sourceCounts = null;

  if (options.validateOnly) {
    catalog = readPreview(options.outputDir);
  } else {
    const built = await buildMasterLabCatalog({
      sourceDir: options.sourceDir,
      reader: options.reader,
    });
    sourceCounts = built.sourceCounts;
    catalog = {
      parameters: built.parameters.map(({ internal, ...entry }) => entry),
      diagnostics: built.diagnostics.map(({ internal, ...entry }) => entry),
    };
  }

  const validation = validateMasterLabCatalog(catalog);
  const hash = catalogHash(catalog.parameters, catalog.diagnostics);
  const generatedAt = new Date().toISOString();
  const reviewQueue = buildReviewQueue(validation);
  const summary = {
    generatedAt,
    catalogHash: hash,
    sourceCounts,
    validation: validation.counts,
    valid: validation.valid,
    clinicalReviewRequired: true,
    disclaimer:
      "Reference ranges, critical values and inferred links are best-effort candidates and must be approved by the laboratory director against local methods, instruments and population.",
  };

  if (!options.validateOnly) {
    fs.mkdirSync(options.outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(options.outputDir, "master-parameters.preview.json"),
      stableJson(catalog.parameters),
    );
    fs.writeFileSync(
      path.join(options.outputDir, "master-diagnostics.preview.json"),
      stableJson(catalog.diagnostics),
    );
  }
  fs.writeFileSync(path.join(options.outputDir, "review-queue.json"), stableJson(reviewQueue));
  fs.writeFileSync(path.join(options.outputDir, "summary.json"), stableJson(summary));

  console.log(`Catalog hash: ${hash}`);
  console.log(`Parameters: ${validation.counts.parameters}`);
  console.log(`Diagnostics: ${validation.counts.diagnostics}`);
  console.log(`Linked diagnostics: ${validation.counts.linkedDiagnostics}`);
  console.log(`Parameter links: ${validation.counts.totalLinks}`);
  console.log(`Validation errors: ${validation.counts.errors}`);
  console.log(`Review items: ${validation.counts.reviewItems}`);
  console.log(`Output: ${options.outputDir}`);

  if (!validation.valid) {
    const error = new Error("Catalog validation failed. Inspect review-queue.json.");
    error.validation = validation;
    throw error;
  }
  return { ...catalog, validation, summary, reviewQueue };
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  catalogHash,
  parseArgs,
  run,
};
