const { normalizeLookup } = require("./masterLabCatalogBuilder");

const PARAMETER_RECORD_FIELDS = new Set([
  "parameter_code",
  "name",
  "units",
  "category",
  "default_normal_range",
  "default_critical_values",
  "active",
]);

const DIAGNOSTIC_RECORD_FIELDS = new Set([
  "test_code",
  "name",
  "deptname",
  "subdeptname",
  "description",
  "default_fasting",
  "default_reportsIn",
  "default_testInstructions",
  "active",
]);

function addIssue(issues, severity, type, code, message) {
  issues.push({ severity, type, code, message });
}

function validateAllowedFields(record, allowed, issues, type, code) {
  const unsupported = Object.keys(record || {}).filter((key) => !allowed.has(key));
  if (unsupported.length) {
    addIssue(issues, "error", type, code, `Unsupported record fields: ${unsupported.join(", ")}`);
  }
}

function validateRange(range, issues, type, code, field) {
  if (!range || typeof range !== "object" || Array.isArray(range)) {
    addIssue(issues, "error", type, code, `${field} must be an object.`);
    return;
  }
  const expected = field === "default_normal_range"
    ? ["adult_male", "adult_female", "child"]
    : ["low", "high"];
  for (const key of expected) {
    if (typeof range[key] !== "string") {
      addIssue(issues, "error", type, code, `${field}.${key} must be a string.`);
    }
  }
}

function validateMasterLabCatalog({ parameters, diagnostics }) {
  const issues = [];
  const parameterCodes = new Set();
  const diagnosticCodes = new Set();
  const parameterNames = new Map();
  const diagnosticNames = new Map();

  if (!Array.isArray(parameters) || !Array.isArray(diagnostics)) {
    return {
      valid: false,
      issues: [
        {
          severity: "error",
          type: "catalog",
          code: "",
          message: "parameters and diagnostics must both be arrays.",
        },
      ],
    };
  }

  for (const entry of parameters) {
    const record = entry?.record || {};
    const code = record.parameter_code || "";
    validateAllowedFields(record, PARAMETER_RECORD_FIELDS, issues, "parameter", code);

    for (const field of ["parameter_code", "name", "units", "category"]) {
      if (typeof record[field] !== "string" || !record[field].trim()) {
        addIssue(issues, "error", "parameter", code, `${field} is required.`);
      }
    }
    if (parameterCodes.has(code)) {
      addIssue(issues, "error", "parameter", code, "Duplicate parameter_code.");
    }
    parameterCodes.add(code);

    const nameKey = `${normalizeLookup(record.category)}:${normalizeLookup(record.name)}`;
    if (parameterNames.has(nameKey)) {
      addIssue(
        issues,
        "error",
        "parameter",
        code,
        `Duplicate canonical parameter name; also used by ${parameterNames.get(nameKey)}.`,
      );
    }
    parameterNames.set(nameKey, code);

    validateRange(record.default_normal_range, issues, "parameter", code, "default_normal_range");
    validateRange(record.default_critical_values, issues, "parameter", code, "default_critical_values");

    if (entry.review?.confidence === "low") {
      addIssue(issues, "review", "parameter", code, "Low-confidence clinical enrichment.");
    }
    for (const warning of entry.review?.warnings || []) {
      addIssue(issues, "review", "parameter", code, warning);
    }
  }

  for (const entry of diagnostics) {
    const record = entry?.record || {};
    const code = record.test_code || "";
    validateAllowedFields(record, DIAGNOSTIC_RECORD_FIELDS, issues, "diagnostic", code);

    for (const field of ["test_code", "name", "deptname", "default_fasting", "default_reportsIn"]) {
      if (typeof record[field] !== "string" || !record[field].trim()) {
        addIssue(issues, "error", "diagnostic", code, `${field} is required.`);
      }
    }
    if (!Array.isArray(record.default_testInstructions)) {
      addIssue(issues, "error", "diagnostic", code, "default_testInstructions must be an array.");
    }
    if (diagnosticCodes.has(code)) {
      addIssue(issues, "error", "diagnostic", code, "Duplicate test_code.");
    }
    diagnosticCodes.add(code);

    const nameKey = `${normalizeLookup(record.deptname)}:${normalizeLookup(record.name)}`;
    if (diagnosticNames.has(nameKey)) {
      addIssue(
        issues,
        "error",
        "diagnostic",
        code,
        `Duplicate canonical test name; also used by ${diagnosticNames.get(nameKey)}.`,
      );
    }
    diagnosticNames.set(nameKey, code);

    const links = Array.isArray(entry.links) ? entry.links : [];
    const seenLinks = new Set();
    links.forEach((link, index) => {
      if (!parameterCodes.has(link.parameter_code)) {
        addIssue(
          issues,
          "error",
          "diagnostic",
          code,
          `Dangling parameter link: ${link.parameter_code || "(empty)"}.`,
        );
      }
      if (seenLinks.has(link.parameter_code)) {
        addIssue(issues, "error", "diagnostic", code, `Duplicate parameter link: ${link.parameter_code}.`);
      }
      seenLinks.add(link.parameter_code);
      if (link.order !== index) {
        addIssue(
          issues,
          "error",
          "diagnostic",
          code,
          `Parameter order must be contiguous from zero; found ${link.order} at index ${index}.`,
        );
      }
    });

    if (entry.review?.confidence === "low") {
      addIssue(issues, "review", "diagnostic", code, "Low-confidence test enrichment or linking.");
    }
    for (const warning of entry.review?.warnings || []) {
      addIssue(issues, "review", "diagnostic", code, warning);
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  return {
    valid: errors.length === 0,
    issues,
    counts: {
      parameters: parameters.length,
      diagnostics: diagnostics.length,
      linkedDiagnostics: diagnostics.filter((entry) => entry.links?.length).length,
      totalLinks: diagnostics.reduce((sum, entry) => sum + (entry.links?.length || 0), 0),
      errors: errors.length,
      reviewItems: issues.filter((issue) => issue.severity === "review").length,
      lowConfidenceParameters: parameters.filter((entry) => entry.review?.confidence === "low").length,
      lowConfidenceDiagnostics: diagnostics.filter((entry) => entry.review?.confidence === "low").length,
      narrativeDiagnostics: diagnostics.filter((entry) => entry.review?.reportMode === "narrative").length,
    },
  };
}

function buildReviewQueue(validation) {
  const grouped = new Map();
  for (const issue of validation.issues) {
    const key = `${issue.type}:${issue.code}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        type: issue.type,
        code: issue.code,
        highestSeverity: issue.severity,
        messages: [],
      });
    }
    const item = grouped.get(key);
    if (issue.severity === "error") item.highestSeverity = "error";
    item.messages.push(issue.message);
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    messages: [...new Set(item.messages)],
  }));
}

module.exports = {
  DIAGNOSTIC_RECORD_FIELDS,
  PARAMETER_RECORD_FIELDS,
  buildReviewQueue,
  validateMasterLabCatalog,
};
