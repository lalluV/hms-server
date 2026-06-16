const MEDICINE_ALIASES = {
  pcm: "paracetamol",
  para: "paracetamol",
  paracetmol: "paracetamol",
  paracitamol: "paracetamol",
  dolo: "paracetamol",
  crocin: "paracetamol",
  azithro: "azithromycin",
  azithromicin: "azithromycin",
  amox: "amoxicillin",
  amoxicilin: "amoxicillin",
  cetirizin: "cetirizine",
  cetrizine: "cetirizine",
  pantop: "pantoprazole",
  pantoprazol: "pantoprazole",
  omeprazol: "omeprazole",
  metform: "metformin",
  atorva: "atorvastatin",
  telma: "telmisartan",
  amlodepine: "amlodipine",
  amlodipin: "amlodipine",
  montair: "montelukast",
  cipro: "ciprofloxacin",
  levoflox: "levofloxacin",
  ornidazol: "ornidazole",
  metronidazol: "metronidazole",
  domperidon: "domperidone",
  emeset: "ondansetron",
  brufen: "ibuprofen",
  voveran: "diclofenac",
  asthalin: "salbutamol",
  lasix: "furosemide",
  thyronorm: "levothyroxine",
};

const LAB_TEST_ALIASES = {
  cbc: "complete blood count",
  "cb c": "complete blood count",
  hemogram: "complete blood count",
  haemogram: "complete blood count",
  lft: "liver function test",
  "liver function": "liver function test",
  kft: "kidney function test",
  rft: "renal function test",
  tsh: "thyroid stimulating hormone",
  hba1c: "hba1c",
  "hb a1c": "hba1c",
  "urine rm": "urine routine",
  "urine r/m": "urine routine",
  urinalysis: "urine routine",
  cxr: "x-ray chest",
  "xray chest": "x-ray chest",
  "x ray chest": "x-ray chest",
  usg: "ultrasound",
  sonography: "ultrasound",
  ekg: "ecg",
  lipid: "lipid profile",
  rbs: "random blood sugar",
  fbs: "fasting blood sugar",
  ppbs: "post prandial blood sugar",
  grbs: "random blood sugar",
  "blood sugar": "random blood sugar",
  "vit d": "vitamin d",
  b12: "vitamin b12",
  upt: "pregnancy test",
};

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s/+.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

function similarityScore(a, b) {
  const left = normalizeSearchText(a);
  const right = normalizeSearchText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.92;
  const distance = levenshtein(left, right);
  const maxLen = Math.max(left.length, right.length);
  return maxLen ? 1 - distance / maxLen : 0;
}

function resolveAlias(query, aliasMap) {
  const normalized = normalizeSearchText(query);
  if (aliasMap[normalized]) return aliasMap[normalized];
  for (const [alias, canonical] of Object.entries(aliasMap)) {
    if (normalized.includes(alias) || alias.includes(normalized)) {
      return canonical;
    }
  }
  return normalized;
}

function findBestCatalogMatch(query, catalog, fields, minScore = 0.58) {
  if (!query || !Array.isArray(catalog) || !catalog.length) return null;

  const aliasResolved = resolveAlias(
    query,
    fields.includes("name") && fields.includes("description")
      ? LAB_TEST_ALIASES
      : MEDICINE_ALIASES
  );

  let best = null;
  let bestScore = 0;

  for (const item of catalog) {
    for (const field of fields) {
      const candidate = item[field];
      if (!candidate) continue;
      const score = Math.max(
        similarityScore(query, candidate),
        similarityScore(aliasResolved, candidate)
      );
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
  }

  return bestScore >= minScore ? best : null;
}

function matchMedicineToCatalog(medicine, pharmacyCatalog) {
  const query =
    medicine.inventoryMatch ||
    medicine.correctedName ||
    medicine.name;
  const match = findBestCatalogMatch(query, pharmacyCatalog, [
    "generic_name",
    "description",
  ]);
  if (!match) return medicine;

  return {
    ...medicine,
    correctedName: match.generic_name || match.description || medicine.name,
    inventoryMatch: match.description || match.generic_name || medicine.name,
  };
}

function matchLabTestToCatalog(testName, labCatalog) {
  const match = findBestCatalogMatch(testName, labCatalog, [
    "name",
    "description",
  ]);
  if (!match) {
    return {
      original: testName,
      standardized: testName,
      inventoryMatch: null,
    };
  }

  return {
    original: testName,
    standardized: match.name || match.description || testName,
    inventoryMatch: match.name || match.description || testName,
  };
}

function matchProcedureToCatalog(procedure, procedureCatalog) {
  const query =
    procedure.inventoryMatch ||
    procedure.correctedName ||
    procedure.name;
  const match = findBestCatalogMatch(query, procedureCatalog, [
    "name",
    "service_name",
    "description",
  ]);
  if (!match) return procedure;

  return {
    ...procedure,
    name: match.name || match.service_name || procedure.name,
    correctedName: match.name || match.service_name || procedure.name,
    inventoryMatch: match.name || match.service_name || procedure.name,
    service_code: match.service_code || procedure.service_code || "",
    category: match.category || procedure.category || "",
    rate: match.rate ?? procedure.rate,
  };
}

module.exports = {
  matchMedicineToCatalog,
  matchLabTestToCatalog,
  matchProcedureToCatalog,
};
