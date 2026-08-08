const fs = require("fs");
const path = require("path");

const DEFAULT_FILES = Object.freeze({
  parameters: "Book1.xlsx",
  formats: "Book2.xlsx",
  templates: "Book4.xlsx",
  samples: "Book5.xlsx",
  specimens: "Book6.xlsx",
});

const GROUPS = Object.freeze({
  BIO: { category: "Biochemistry", department: "Biochemistry" },
  MIC: { category: "Microbiology", department: "Microbiology" },
  PAT: { category: "Pathology", department: "Pathology", subdepartment: "Hematology" },
  HPT: { category: "Histopathology", department: "Histopathology" },
  CYT: { category: "Cytology", department: "Cytology" },
  MOB: { category: "Molecular Biology", department: "Molecular Biology" },
  BLD: { category: "Blood Bank", department: "Blood Bank" },
  CAR: { category: "Cardiology", department: "Cardiology" },
  CTS: { category: "CT Scan", department: "Radiology", subdepartment: "CT Scan" },
  ULS: { category: "Ultrasound", department: "Radiology", subdepartment: "Ultrasound" },
  XRY: { category: "X-Ray", department: "Radiology", subdepartment: "X-Ray" },
  MRI: { category: "MRI", department: "Radiology", subdepartment: "MRI" },
});

const NARRATIVE_GROUPS = new Set(["HPT", "CYT", "CAR", "CTS", "ULS", "XRY", "MRI"]);
const NARRATIVE_NAMES =
  /\b(impression|findings?|technique|description|clinical history|gross|microscopy|microscopic|diagnosis|comment|opinion|sections?|specimen|organ|cavity|tissue|head|brain|heart|lungs?|kidneys?|bladder|pancreas|spleen|adrenals?|genitalia|placenta|neck)\b/i;
const QUALITATIVE_NAMES =
  /\b(antibody|antigen|igg|igm|iga|hiv|hbsag|hcv|vdrl|widal|mantoux|ns1|occult blood|ketone|nitrite|leukocyte esterase|pregnancy test|culture|smear)\b/i;

const INDIAN_UNIT_ALIASES = new Map(
  [
    ["g/dl", "g/dL"],
    ["gm/dl", "g/dL"],
    ["g%", "g/dL"],
    ["mg/dl", "mg/dL"],
    ["meq/l", "mEq/L"],
    ["mmol/l", "mmol/L"],
    ["iu/l", "IU/L"],
    ["u/l", "IU/L"],
    ["cells/cumm", "cells/cumm"],
    ["cells/cu.mm", "cells/cumm"],
    ["/cumm", "cells/cumm"],
    ["lakhs/cumm", "lakhs/cumm"],
    ["lakh/cumm", "lakhs/cumm"],
    ["lakhs/cu.mm", "lakhs/cumm"],
    ["millions/cumm", "millions/cumm"],
    ["million/cumm", "millions/cumm"],
    ["µiu/ml", "µIU/mL"],
    ["uiu/ml", "µIU/mL"],
    ["miu/l", "µIU/mL"],
    ["ug/dl", "µg/dL"],
    ["mcg/dl", "µg/dL"],
    ["ng/ml", "ng/mL"],
    ["pg/ml", "pg/mL"],
    ["sec", "Sec"],
    ["seconds", "Sec"],
  ].map(([key, value]) => [key, value]),
);

const INDIAN_UNIT_RULES = [
  { pattern: /\b(platelet|plt)\b/i, units: "lakhs/cumm" },
  { pattern: /\b(wbc|leukocyte|leucocyte|tlc|white blood)\b/i, units: "cells/cumm" },
  { pattern: /\b(rbc|red blood cell|erythrocyte count)\b/i, units: "millions/cumm" },
  { pattern: /\b(sodium|serum sodium|\bna\b|na\+)\b/i, units: "mEq/L" },
  { pattern: /\b(potassium|serum potassium|\bk\b|k\+)\b/i, units: "mEq/L" },
  { pattern: /\b(chloride|serum chloride|\bcl\b|cl-)\b/i, units: "mEq/L" },
  { pattern: /\b(bicarbonate|hco3)\b/i, units: "mEq/L" },
  { pattern: /\b(ionized calcium|ionised calcium|ca\+\+)\b/i, units: "mmol/L" },
  {
    pattern:
      /\b(sgot|sgpt|ast|alt|alp|alkaline phosphatase|ggt|gamma|ldh|amylase|lipase|creatine kinase|\bck\b)\b/i,
    units: "IU/L",
  },
  {
    pattern:
      /\b(hemoglobin|haemoglobin|glucose|creatinine|urea|cholesterol|triglyceride|bilirubin|calcium|magnesium|phosphorus|uric acid|protein|albumin|globulin)\b/i,
    units: "mg/dL",
  },
  { pattern: /\b(tsh|thyroid stimulating)\b/i, units: "µIU/mL" },
  { pattern: /\b(hba1c|glycated|glycosylated)\b/i, units: "%" },
  { pattern: /\b(hematocrit|haematocrit|pcv|packed cell)\b/i, units: "%" },
  {
    pattern:
      /\b(neutrophil|lymphocyte|monocyte|eosinophil|basophil|transferrin saturation|oxygen saturation|rdw)\b/i,
    units: "%",
  },
  { pattern: /\b(mchc)\b/i, units: "g/dL" },
  { pattern: /\b(mch)\b/i, units: "pg" },
  { pattern: /\b(mcv)\b/i, units: "fL" },
  { pattern: /\b(esr|erythrocyte sedimentation)\b/i, units: "mm/hr" },
  { pattern: /\b(prothrombin|aptt|ptt|thrombin)\b.*\btime\b/i, units: "Sec" },
  { pattern: /\b(inr|a\s*\/\s*g|specific gravity)\b/i, units: "ratio" },
];

function normalizeIndianUnit(rawUnit) {
  const cleaned = normalizeWhitespace(rawUnit);
  if (!cleaned) return "";
  const key = cleaned.toLowerCase().replace(/\s+/g, "");
  return INDIAN_UNIT_ALIASES.get(key) || cleaned;
}

function inferIndianUnits(name) {
  for (const rule of INDIAN_UNIT_RULES) {
    if (rule.pattern.test(name)) return rule.units;
  }
  if (/\b(percent|percentage)\b/i.test(name)) return "%";
  if (/\b(prothrombin|aptt|ptt)\b/i.test(name)) return "Sec";
  if (/\bcount\b/i.test(name) && !/account/i.test(name)) return "cells/cumm";
  return "-";
}

function resolveParameterUnits(source, inferredUnits) {
  const fromSource = normalizeIndianUnit(source.UNITS);
  if (fromSource) return fromSource;
  return inferredUnits || "-";
}

const ACRONYMS = new Map(
  [
    "ABG",
    "ALT",
    "ANA",
    "APTT",
    "AST",
    "BUN",
    "CBC",
    "CK-MB",
    "CRP",
    "CSF",
    "DHEAS",
    "DNA",
    "ESR",
    "FSH",
    "FT3",
    "FT4",
    "GGT",
    "HBA1C",
    "HBV",
    "HCV",
    "HDL",
    "HIV",
    "HLA",
    "INR",
    "LDH",
    "LDL",
    "LFT",
    "LH",
    "MRI",
    "NS1",
    "PCR",
    "PSA",
    "PTH",
    "RBC",
    "RFT",
    "SGOT",
    "SGPT",
    "T3",
    "T4",
    "TIBC",
    "TSH",
    "VLDL",
    "WBC",
  ].map((value) => [normalizeLookup(value), value]),
);

const CODE_STOP_WORDS = new Set([
  "and",
  "the",
  "of",
  "for",
  "in",
  "with",
  "without",
  "serum",
  "blood",
  "plasma",
  "total",
  "test",
  "profile",
  "routine",
  "complete",
  "examination",
  "functional",
  "study",
  "levels",
  "level",
  "antibody",
  "antigen",
  "department",
  "inclusive",
  "analysis",
  "sample",
  "fluid",
  "guided",
  "screening",
]);

const KNOWN_SHORT_CODES = new Map(
  Object.entries({
    "complete blood count": "CBC",
    "complete blood picture": "CBP",
    "complete urine examination": "CUE",
    "renal function test": "RFT",
    "liver function test": "LFT",
    "liver function test with proteins": "LFT-P",
    "liver function test without proteins": "LFT-W",
    "lipid profile": "LIPID",
    "thyroid profile": "TFT",
    "iron profile": "IRON",
    "glycated hemoglobin": "HBA1C",
    "glycosylated haemoglobin": "HBA1C",
    "glycosylated hemoglobin": "HBA1C",
    "random plasma glucose": "RBS",
    "random blood sugar": "RBS",
    "g rbs": "RBS",
    "fasting plasma glucose": "FBS",
    "postprandial plasma glucose": "PPBS",
    "dengue ns1 antigen igm and igg": "DENGUE",
    "hemoglobin": "HB",
    "haemoglobin": "HB",
    "serum creatinine": "CREAT",
    "blood urea": "UREA",
    "total cholesterol": "CHOL",
    "thyroid stimulating hormone": "TSH",
    "mean corpuscular volume": "MCV",
    "mean corpuscular hemoglobin": "MCH",
    "mean corpuscular haemoglobin": "MCH",
    "mean corpuscular hemoglobin concentration": "MCHC",
    "mean corpuscular haemoglobin concentration": "MCHC",
    "red cell distribution width": "RDW",
    "aspartate aminotransferase": "AST",
    "alanine aminotransferase": "ALT",
    "high sensitivity c reactive protein": "HSCRP",
    "hs crp": "HSCRP",
    "prothrombin time": "PT",
    "international normalized ratio": "INR",
    "activated partial thromboplastin time": "APTT",
    "total leukocyte count": "TLC",
    "platelet count": "PLT",
    "red blood cell count": "RBC",
    "electrolyte panel": "LYTES",
    "arterial blood gas": "ABG",
    "coagulation profile": "COAG",
    "diabetes profile": "DM-P",
    "free thyroid profile": "FTFT",
    "dengue ns1 igg igm": "DENGUE",
    "homocysteine": "HOMOCYS",
    "growth hormone": "GH",
    "barium swallow": "BARSW",
    "barium meal follow through": "BMFT",
    "gastrograffin meal study": "GGMS",
    "urine protein creatinine ratio": "UPCR",
    "parathyroid hormone": "PTH",
    "vitamin b12": "B12",
    "serum osmolality": "OSMOL",
    "complete haemogram": "CBP",
    "haemogram": "CBP",
    "stool routine examination": "STOOL",
    "peripheral smear": "PSMEAR",
    "sickle cell preparation": "SICKLE",
  }).map(([key, value]) => [key, value]),
);

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLookup(value) {
  return normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function titleCaseClinical(value) {
  const cleaned = normalizeWhitespace(value)
    .replace(/\bHAEMOGLOBIN\b/gi, "Hemoglobin")
    .replace(/\bHAEMATOCRIT\b/gi, "Hematocrit");

  return cleaned
    .toLowerCase()
    .split(" ")
    .map((word, index) => {
      const punctuationFree = normalizeLookup(word);
      if (ACRONYMS.has(punctuationFree)) return ACRONYMS.get(punctuationFree);
      if (index > 0 && ["and", "of", "for", "in", "with", "without"].includes(word)) {
        return word;
      }
      if (/^\d/.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ")
    .replace(/\bIgg\b/g, "IgG")
    .replace(/\bIgm\b/g, "IgM")
    .replace(/\bIga\b/g, "IgA")
    .replace(/\bPh\b/g, "pH")
    .replace(/\bPco2\b/g, "pCO2")
    .replace(/\bPo2\b/g, "pO2");
}

function compactCodeFromName(name, maxLength = 10) {
  const normalized = normalizeLookup(name);
  const withoutParenthetical = normalizeLookup(String(name).replace(/\([^)]*\)/g, " "));

  for (const key of [normalized, withoutParenthetical]) {
    if (KNOWN_SHORT_CODES.has(key)) return KNOWN_SHORT_CODES.get(key);
  }

  const parenMatch = String(name).match(/\(([A-Za-z0-9][A-Za-z0-9+\-/ ]{1,12})\)/);
  if (parenMatch) {
    const paren = parenMatch[1].replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    if (paren.length >= 2 && paren.length <= maxLength) return paren;
  }

  const words = withoutParenthetical
    .split(" ")
    .filter((word) => word && !CODE_STOP_WORDS.has(word));

  if (!words.length) return "NA";

  if (words.length === 1) {
    const word = words[0];
    if (ACRONYMS.has(word)) return ACRONYMS.get(word);
    return word.slice(0, maxLength).toUpperCase();
  }

  if (words.length === 2) {
    const [first, second] = words;
    const compact = `${first.slice(0, 4)}${second.slice(0, 3)}`.toUpperCase();
    return compact.slice(0, maxLength);
  }

  const acronym = words
    .map((word) => {
      if (ACRONYMS.has(word)) return ACRONYMS.get(word);
      if (/^\d/.test(word)) return word.toUpperCase();
      return word[0].toUpperCase();
    })
    .join("")
    .slice(0, maxLength);

  return acronym || "NA";
}

function slugifyCode(value, maxLength = 42) {
  const slug = normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/µ/g, "U")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toUpperCase();
  return (slug || "UNNAMED").slice(0, maxLength).replace(/-+$/g, "");
}

function generateDeterministicCodes(items, { prefix, nameKey = "name", groupKey = "groupCode" }) {
  const sorted = [...items].sort((left, right) => {
    const leftKey = `${left[groupKey] || "GEN"}:${normalizeLookup(left[nameKey])}`;
    const rightKey = `${right[groupKey] || "GEN"}:${normalizeLookup(right[nameKey])}`;
    return leftKey.localeCompare(rightKey);
  });
  const used = new Map();

  for (const item of sorted) {
    const group = slugifyCode(item[groupKey] || "GEN", 3);
    const name = compactCodeFromName(item[nameKey], prefix === "T" ? 8 : 6);
    const base = `${prefix}-${group}-${name}`;
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    item.generatedCode = count === 1 ? base : `${base}-${count}`;
  }

  return items;
}

function cellToValue(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "result")) return cellToValue(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((entry) => entry.text || "").join("");
    if (Object.prototype.hasOwnProperty.call(value, "text")) return value.text;
  }
  return value;
}

async function readWithExcelJs(filePath) {
  // exceljs is the declared production dependency. The fallback below permits
  // generation in older local checkouts that already have SheetJS installed.
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const headers = [];
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
    headers[column - 1] = normalizeWhitespace(cellToValue(cell.value));
  });

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    headers.forEach((header, index) => {
      if (!header) return;
      record[header] = cellToValue(row.getCell(index + 1).value);
    });
    if (Object.values(record).some((value) => normalizeWhitespace(value))) rows.push(record);
  });
  return rows;
}

function readWithSheetJs(filePath) {
  const XLSX = require("xlsx");
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(firstSheet, { defval: "", raw: false });
}

async function readWorkbookRows(filePath, injectedReader) {
  if (injectedReader) return injectedReader(filePath);
  try {
    return await readWithExcelJs(filePath);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND" || !String(error.message).includes("exceljs")) throw error;
    return readWithSheetJs(filePath);
  }
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildCurationIndex(entries) {
  const index = new Map();
  for (const entry of entries) {
    for (const alias of [entry.name, ...(entry.aliases || [])]) {
      const key = normalizeLookup(alias);
      if (key && !index.has(key)) index.set(key, entry);
    }
  }
  return index;
}

function findCuration(name, index) {
  const normalized = normalizeLookup(name);
  const exact = index.get(normalized);
  if (exact) return exact;

  const withoutParenthetical = normalizeLookup(String(name).replace(/\([^)]*\)/g, " "));
  if (index.has(withoutParenthetical)) return index.get(withoutParenthetical);

  let bestMatch = null;
  for (const [aliasKey, entry] of index.entries()) {
    if (aliasKey.length < 3) continue;
    if (
      normalized.includes(aliasKey) ||
      withoutParenthetical.includes(aliasKey) ||
      aliasKey.includes(withoutParenthetical)
    ) {
      if (!bestMatch || aliasKey.length > bestMatch.aliasKey.length) {
        bestMatch = { aliasKey, entry };
      }
    }
  }
  return bestMatch?.entry || null;
}

function emptyRange() {
  return { adult_male: "", adult_female: "", child: "" };
}

function emptyCritical() {
  return { low: "", high: "" };
}

function inferUncuratedParameter(source) {
  const name = normalizeWhitespace(source.PARAMDESC);
  const narrative = NARRATIVE_NAMES.test(name) || NARRATIVE_GROUPS.has(source.TESTMAINGROUPCD);
  const qualitative = QUALITATIVE_NAMES.test(name);
  const expectsRange = String(source.NORMALRANGE).toUpperCase() === "Y";
  const warnings = [];

  if (narrative) {
    return {
      name: titleCaseClinical(name),
      units: "-",
      normalRange: emptyRange(),
      criticalValues: emptyCritical(),
      kind: "narrative",
      confidence: "medium",
      warnings,
    };
  }

  if (qualitative) {
    if (expectsRange) warnings.push("Generic qualitative normal value requires method-specific verification.");
    return {
      name: titleCaseClinical(name),
      units: "-",
      normalRange: expectsRange
        ? { adult_male: "Negative", adult_female: "Negative", child: "Negative" }
        : emptyRange(),
      criticalValues: emptyCritical(),
      kind: "qualitative",
      confidence: "low",
      warnings,
    };
  }

  let units = resolveParameterUnits(source, inferIndianUnits(name));

  if (expectsRange) {
    warnings.push("Reference range requested by source but no safe chat-curated match was found.");
  }
  if (String(source.CRITICALVALUES).toUpperCase() === "Y") {
    warnings.push("Critical values requested by source but no safe chat-curated match was found.");
  }

  return {
    name: titleCaseClinical(name),
    units,
    normalRange: emptyRange(),
    criticalValues: emptyCritical(),
    kind: "analyte",
    confidence: expectsRange ? "low" : "medium",
    warnings,
  };
}

function normalizeParameterRows(rows, parameterCuration) {
  const curationIndex = buildCurationIndex(parameterCuration);
  const candidates = rows
    .filter((row) => normalizeWhitespace(row.PARAMDESC))
    .map((source, rowIndex) => {
      const groupCode = normalizeWhitespace(source.TESTMAINGROUPCD).toUpperCase() || "GEN";
      const group = GROUPS[groupCode] || {
        category: titleCaseClinical(groupCode || "General"),
        department: titleCaseClinical(groupCode || "General"),
      };
      const curation = findCuration(source.PARAMDESC, curationIndex);
      const inferred = curation
        ? {
            name: curation.name,
            units: resolveParameterUnits(source, curation.units || "-"),
            normalRange: { ...emptyRange(), ...(curation.normalRange || {}) },
            criticalValues: { ...emptyCritical(), ...(curation.criticalValues || {}) },
            kind: "analyte",
            confidence: curation.confidence || "medium",
            warnings: curation.notes ? [curation.notes] : [],
          }
        : inferUncuratedParameter(source);

      return {
        ...inferred,
        groupCode,
        category: group.category,
        active: String(source.ISACTIVE).toUpperCase() !== "N",
        sourceRef: {
          workbook: DEFAULT_FILES.parameters,
          row: rowIndex + 2,
          sourceCode: normalizeWhitespace(source.PARAMCD),
          sourceName: normalizeWhitespace(source.PARAMDESC),
          method: normalizeWhitespace(source.METHOD),
          normalRangeFlag: normalizeWhitespace(source.NORMALRANGE),
          criticalValuesFlag: normalizeWhitespace(source.CRITICALVALUES),
        },
        aliases: curation ? [...new Set([curation.name, ...(curation.aliases || [])])] : [source.PARAMDESC],
      };
    });

  const deduped = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.groupCode}:${normalizeLookup(candidate.name)}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { ...candidate, sourceRefs: [candidate.sourceRef] });
      continue;
    }
    existing.sourceRefs.push(candidate.sourceRef);
    existing.active = existing.active || candidate.active;
    existing.aliases = [...new Set([...existing.aliases, ...candidate.aliases])];
    if (candidate.confidence === "low") existing.confidence = "low";
    existing.warnings = [...new Set([...existing.warnings, ...candidate.warnings])];
  }

  const items = [...deduped.values()];
  generateDeterministicCodes(items, { prefix: "P" });

  return items.map((item) => ({
    record: {
      parameter_code: item.generatedCode,
      name: item.name,
      units: item.units || "-",
      category: item.category,
      default_normal_range: item.normalRange,
      default_critical_values: item.criticalValues,
      active: item.active,
    },
    review: {
      kind: item.kind,
      confidence: item.confidence,
      warnings: item.warnings,
      aliases: item.aliases,
      sourceRefs: item.sourceRefs,
    },
    internal: {
      groupCode: item.groupCode,
    },
  }));
}

function scoreFormat(row, templateFormatCodes) {
  let score = 0;
  if (String(row.ISACTIVE).toUpperCase() !== "N") score += 20;
  if (String(row.DEFAULTFORMAT).toUpperCase() === "Y") score += 50;
  if (String(row.ISTEMPLET).toUpperCase() === "Y") score += 10;
  if (templateFormatCodes.has(normalizeWhitespace(row.FORMATCD))) score += 15;
  if (normalizeWhitespace(row.SPECIMEN)) score += 5;
  if (normalizeWhitespace(row.MAXTIME)) score += 3;
  return score;
}

function choosePreferredFormats(formatRows, templateRows) {
  const templateFormatCodes = new Set(
    templateRows.filter((row) => String(row.ISACTIVE).toUpperCase() !== "N").map((row) => normalizeWhitespace(row.FORMATCD)),
  );
  const byTest = new Map();

  formatRows.forEach((row, index) => {
    const sourceTestCode = normalizeWhitespace(row.TESTCD);
    if (!sourceTestCode) return;
    if (!byTest.has(sourceTestCode)) byTest.set(sourceTestCode, []);
    byTest.get(sourceTestCode).push({ ...row, __row: index + 2 });
  });

  return [...byTest.entries()].map(([sourceTestCode, rows]) => {
    const sorted = [...rows].sort((left, right) => {
      const scoreDiff = scoreFormat(right, templateFormatCodes) - scoreFormat(left, templateFormatCodes);
      if (scoreDiff) return scoreDiff;
      return normalizeWhitespace(right.CREATEDT).localeCompare(normalizeWhitespace(left.CREATEDT));
    });
    return { sourceTestCode, preferred: sorted[0], alternatives: sorted.slice(1) };
  });
}

function cleanDuration(value) {
  const raw = normalizeWhitespace(value);
  if (!raw) return "";
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*:\s*([a-z]+)$/i);
  if (!match) return raw.replace(/:/g, " ");
  const quantity = match[1];
  const unit = match[2].toLowerCase();
  const singular = Number(quantity) === 1;
  const label = unit.startsWith("min")
    ? singular
      ? "Minute"
      : "Minutes"
    : unit.startsWith("hour")
      ? singular
        ? "Hour"
        : "Hours"
      : unit.startsWith("day")
        ? singular
          ? "Day"
          : "Days"
        : titleCaseClinical(unit);
  return `${quantity} ${label}`;
}

function formatReportsIn(row) {
  const min = cleanDuration(row.MINTIME);
  const max = cleanDuration(row.MAXTIME);
  if (min && max && min !== max) return `${min} to ${max}`;
  return max || min || "Same Day";
}

function normalizeTestMatchName(value) {
  return normalizeLookup(value)
    .replace(/\btest\b/g, " ")
    .replace(/\bserum\b/g, " ")
    .replace(/\bblood\b/g, " ")
    .replace(/\bplasma\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findContainedDefinition(name, definitions) {
  const normalized = ` ${normalizeLookup(name)} `;
  const matches = [];
  for (const definition of definitions) {
    for (const alias of [definition.name, ...(definition.aliases || [])]) {
      const normalizedAlias = normalizeLookup(alias);
      if (
        normalizedAlias &&
        (normalizeLookup(name) === normalizedAlias || normalized.includes(` ${normalizedAlias} `))
      ) {
        matches.push({ definition, aliasLength: normalizedAlias.length });
      }
    }
  }
  matches.sort((left, right) => right.aliasLength - left.aliasLength);
  return matches[0]?.definition || null;
}

function buildParameterLookup(parameterEntries) {
  const lookup = new Map();
  for (const entry of parameterEntries) {
    for (const alias of [entry.record.name, ...(entry.review.aliases || [])]) {
      const keys = [normalizeLookup(alias), normalizeTestMatchName(alias)].filter(Boolean);
      for (const key of keys) {
        if (!lookup.has(key)) lookup.set(key, []);
        const existing = lookup.get(key);
        if (!existing.some((item) => item.record.parameter_code === entry.record.parameter_code)) {
          existing.push(entry);
        }
      }
    }
  }
  return lookup;
}

function resolveParameterByName(name, parameterLookup, preferredGroupCode = "") {
  const candidates =
    parameterLookup.get(normalizeLookup(name)) || parameterLookup.get(normalizeTestMatchName(name)) || [];
  if (preferredGroupCode) {
    const sameGroup = candidates.filter(
      (entry) => entry.internal?.groupCode === preferredGroupCode,
    );
    if (sameGroup.length === 1) return sameGroup[0];
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function createInstructions(test, sample) {
  const instructions = [];
  for (const instruction of test?.instructions || []) {
    if (normalizeWhitespace(instruction)) instructions.push(normalizeWhitespace(instruction));
  }
  const specimen = normalizeWhitespace(sample?.SPECIMENNAME || sample?.SPECIMEN);
  const container = normalizeWhitespace(sample?.VACUTAINER);
  const precautions = normalizeWhitespace(sample?.PRECAUTIONS);
  const clinicalHistory = normalizeWhitespace(sample?.CLINICALHISTORY);

  if (specimen) instructions.push(`Specimen: ${specimen}.`);
  if (container) instructions.push(`Collection container: ${container}.`);
  if (precautions) instructions.push(precautions);
  if (clinicalHistory) instructions.push(`Clinical history requirement: ${clinicalHistory}`);
  return [...new Set(instructions)];
}

function normalizeDiagnosticRows({
  formatRows,
  templateRows,
  sampleRows,
  specimenRows,
  parameterEntries,
  panelDefinitions,
  testCuration,
}) {
  const specimenByCode = new Map(
    specimenRows.map((row) => [normalizeWhitespace(row.SPECIMENCD), normalizeWhitespace(row.SPECIMENNAME)]),
  );
  const sampleByTest = new Map();
  for (const row of sampleRows) {
    const code = normalizeWhitespace(row.TESTCD);
    if (!code || sampleByTest.has(code)) continue;
    const specimenName =
      normalizeWhitespace(row.SPECIMENNAME) || specimenByCode.get(normalizeWhitespace(row.SPECIMENCD)) || "";
    sampleByTest.set(code, { ...row, SPECIMENNAME: specimenName });
  }

  const testCurationIndex = buildCurationIndex(
    testCuration.map((entry) => ({ ...entry, aliases: entry.aliases || [], name: entry.name })),
  );
  const parameterLookup = buildParameterLookup(parameterEntries);
  const preferredFormats = choosePreferredFormats(formatRows, templateRows);

  const candidates = preferredFormats.map(({ sourceTestCode, preferred, alternatives }) => {
    const groupCode = normalizeWhitespace(preferred.TESTMAINGROUPCD).toUpperCase() || "GEN";
    const group = GROUPS[groupCode] || {
      category: titleCaseClinical(groupCode || "General"),
      department: titleCaseClinical(groupCode || "General"),
      subdepartment: "",
    };
    const sourceName =
      normalizeWhitespace(preferred.FORMATDESC) ||
      normalizeWhitespace(preferred.LABEQUINAME) ||
      sourceTestCode;
    const testCurationEntry = findContainedDefinition(sourceName, testCuration) || findCuration(sourceName, testCurationIndex);
    const name = testCurationEntry?.name || titleCaseClinical(sourceName);
    const sample = sampleByTest.get(sourceTestCode);
    const narrative = NARRATIVE_GROUPS.has(groupCode);
    const warnings = [];
    const links = [];

    if (!narrative) {
      const panel = findContainedDefinition(sourceName, panelDefinitions);
      if (panel) {
        for (const parameterName of panel.parameters) {
          const parameter = resolveParameterByName(parameterName, parameterLookup, groupCode);
          if (parameter) {
            links.push({
              parameter_code: parameter.record.parameter_code,
              parameter_name: parameter.record.name,
              order: links.length,
            });
          } else {
            warnings.push(`Panel parameter not found in source catalog: ${parameterName}`);
          }
        }
        if (panel.notes) warnings.push(panel.notes);
      } else {
        const exact =
          resolveParameterByName(name, parameterLookup, groupCode) ||
          resolveParameterByName(sourceName, parameterLookup, groupCode);
        if (exact) {
          links.push({
            parameter_code: exact.record.parameter_code,
            parameter_name: exact.record.name,
            order: 0,
          });
        } else {
          warnings.push("No deterministic parameter link was found.");
        }
      }
    }

    if (alternatives.length > 0) {
      warnings.push(`${alternatives.length} alternate report format(s) were collapsed into the preferred format.`);
    }

    return {
      name,
      groupCode,
      deptname: group.department,
      subdeptname: group.subdepartment || "",
      description: normalizeWhitespace(preferred.REPORTTITLE),
      defaultFasting: testCurationEntry?.default_fasting || "Not Required",
      defaultReportsIn: formatReportsIn(preferred),
      instructions: createInstructions(testCurationEntry, sample),
      links,
      active: String(preferred.ISACTIVE).toUpperCase() !== "N",
      narrative,
      confidence: narrative ? "medium" : links.length ? "medium" : "low",
      warnings,
      sourceRefs: [
        {
          workbook: DEFAULT_FILES.formats,
          row: preferred.__row,
          sourceTestCode,
          sourceFormatCode: normalizeWhitespace(preferred.FORMATCD),
          sourceName,
        },
        ...alternatives.map((row) => ({
          workbook: DEFAULT_FILES.formats,
          row: row.__row,
          sourceTestCode,
          sourceFormatCode: normalizeWhitespace(row.FORMATCD),
          sourceName: normalizeWhitespace(row.FORMATDESC),
        })),
      ],
    };
  });

  const deduped = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.groupCode}:${normalizeLookup(candidate.name)}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, candidate);
      continue;
    }
    existing.sourceRefs.push(...candidate.sourceRefs);
    existing.active = existing.active || candidate.active;
    existing.warnings = [...new Set([...existing.warnings, ...candidate.warnings, "Duplicate canonical test names were merged."])];
    if (candidate.links.length > existing.links.length) existing.links = candidate.links;
    if (candidate.confidence === "low") existing.confidence = "low";
  }

  const items = [...deduped.values()];
  generateDeterministicCodes(items, { prefix: "T" });

  return items.map((item) => ({
    record: {
      test_code: item.generatedCode,
      name: item.name,
      deptname: item.deptname,
      subdeptname: item.subdeptname,
      description: item.description,
      default_fasting: item.defaultFasting,
      default_reportsIn: item.defaultReportsIn,
      default_testInstructions: item.instructions,
      active: item.active,
    },
    links: item.links,
    review: {
      reportMode: item.narrative ? "narrative" : "parameters",
      confidence: item.confidence,
      warnings: item.warnings,
      sourceRefs: item.sourceRefs,
    },
    internal: {
      groupCode: item.groupCode,
    },
  }));
}

async function buildMasterLabCatalog({
  sourceDir,
  files = DEFAULT_FILES,
  curationDir = path.resolve(__dirname, "../data/master-lab-catalog/curation"),
  reader,
}) {
  if (!sourceDir) throw new Error("sourceDir is required");

  const [parameterRows, formatRows, templateRows, sampleRows, specimenRows] = await Promise.all([
    readWorkbookRows(path.join(sourceDir, files.parameters), reader),
    readWorkbookRows(path.join(sourceDir, files.formats), reader),
    readWorkbookRows(path.join(sourceDir, files.templates), reader),
    readWorkbookRows(path.join(sourceDir, files.samples), reader),
    readWorkbookRows(path.join(sourceDir, files.specimens), reader),
  ]);

  const parameterCuration = loadJson(path.join(curationDir, "parameter-curation.json"));
  const panelDefinitions = loadJson(path.join(curationDir, "panel-definitions.json"));
  const testCuration = loadJson(path.join(curationDir, "test-curation.json"));

  const parameters = normalizeParameterRows(parameterRows, parameterCuration);
  const diagnostics = normalizeDiagnosticRows({
    formatRows,
    templateRows,
    sampleRows,
    specimenRows,
    parameterEntries: parameters,
    panelDefinitions,
    testCuration,
  });

  return {
    parameters,
    diagnostics,
    sourceCounts: {
      parameterRows: parameterRows.length,
      formatRows: formatRows.length,
      templateRows: templateRows.length,
      sampleRows: sampleRows.length,
      specimenRows: specimenRows.length,
    },
  };
}

module.exports = {
  DEFAULT_FILES,
  GROUPS,
  buildMasterLabCatalog,
  choosePreferredFormats,
  compactCodeFromName,
  generateDeterministicCodes,
  inferIndianUnits,
  normalizeIndianUnit,
  normalizeDiagnosticRows,
  normalizeLookup,
  normalizeParameterRows,
  readWorkbookRows,
  slugifyCode,
  titleCaseClinical,
};
