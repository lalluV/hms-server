/**
 * Grounded LLM suggestions — only when doctor memory / packages are unavailable.
 * Never invent clinical facts; prefer exact memory hint phrases.
 */

const {
  aiCompletionWithFallback,
} = require("./aiCompletionWithFallback");

const PARSE_NOTE_MODEL =
  process.env.GEMINI_PARSE_MODEL ||
  process.env.GEMINI_TRANSCRIBE_MODEL ||
  "gemini-3.1-flash-lite";
const OPENAI_MODEL =
  process.env.OPENAI_FALLBACK_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4.1-mini";
const SUGGEST_TIMEOUT_MS =
  Number(process.env.GEMINI_SUGGEST_TIMEOUT_MS) || 25000;
const SUGGEST_MAX_TOKENS =
  Number(process.env.GEMINI_SUGGEST_MAX_TOKENS) || 3072;

async function callSuggestJsonCompletion(
  messages,
  maxTokens = SUGGEST_MAX_TOKENS,
) {
  const result = await aiCompletionWithFallback(messages, {
    geminiModel: PARSE_NOTE_MODEL,
    openAiModel: OPENAI_MODEL,
    timeoutMs: SUGGEST_TIMEOUT_MS,
    maxTokens,
    responseJson: true,
  });

  const content = String(
    result?.data?.choices?.[0]?.message?.content || "",
  ).trim();
  if (!content) throw new Error("Empty LLM suggest response");
  return JSON.parse(content);
}

function normalizeBulletKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  const normalized = normalizeBulletKey(text);
  if (!normalized) return [];
  return normalized.split(" ").filter((w) => w.length >= 3);
}

function noteSectionTexts(noteContext = {}, section) {
  const items = noteContext[section];
  return Array.isArray(items) ? items : [];
}

function bulletAlreadyInNote(text, noteContext = {}) {
  const key = normalizeBulletKey(text);
  if (!key) return true;
  for (const section of ["complaints", "examination", "diagnosis", "advice"]) {
    for (const bullet of noteSectionTexts(noteContext, section)) {
      if (normalizeBulletKey(bullet) === key) return true;
    }
  }
  return false;
}

function buildGroundingCorpus(extractedClinical = {}, memoryHints = {}) {
  const parts = [
    extractedClinical.clinicalNote,
    extractedClinical.symptoms,
    extractedClinical.pastMedicalHistory,
    extractedClinical.provisionalDiagnosis,
  ];
  for (const section of ["complaints", "examination", "diagnosis", "advice"]) {
    parts.push(...(memoryHints.note?.[section] || []));
  }
  parts.push(...(memoryHints.medicines || []));
  parts.push(...(memoryHints.labs || []));
  parts.push(...(memoryHints.procedures || []));
  return parts.filter(Boolean).join("\n");
}

function isGroundedSuggestion(text, groundingCorpus) {
  const corpus = normalizeBulletKey(groundingCorpus);
  const tokens = tokenize(text);
  if (!tokens.length) return false;
  let hits = 0;
  for (const token of tokens) {
    if (corpus.includes(token)) hits += 1;
  }
  return hits >= Math.min(2, tokens.length);
}

function sectionAlreadyFilled(noteContext = {}, section) {
  return (noteContext[section] || []).filter(Boolean).length >= 2;
}

function toNotePill(text, noteContext, source = "llm") {
  const clean = String(text || "").trim();
  return {
    text: clean,
    frequencyInCases: 0,
    usedInCases: 0,
    alreadyInNote: bulletAlreadyInNote(clean, noteContext),
    source,
  };
}

function normalizeLlmNotePills(
  raw = {},
  noteContext = {},
  { groundingCorpus = "", maxPerSection = 5 } = {},
) {
  const sections = ["complaints", "examination", "diagnosis", "advice"];
  const used = new Set();
  const result = {};

  for (const section of sections) {
    if (sectionAlreadyFilled(noteContext, section)) {
      result[section] = [];
      continue;
    }

    const pills = [];
    const items = Array.isArray(raw[section]) ? raw[section] : [];
    for (const item of items) {
      const text = String(
        typeof item === "string" ? item : item?.text || "",
      ).trim();
      if (!text || text.length < 3) continue;
      const key = normalizeBulletKey(text);
      if (!key || used.has(key)) continue;
      if (!isGroundedSuggestion(text, groundingCorpus)) continue;
      used.add(key);
      pills.push(toNotePill(text, noteContext));
      if (pills.length >= maxPerSection) break;
    }
    result[section] = pills;
  }
  return result;
}

function normalizeLlmMedicinePills(
  raw = [],
  currentReview = {},
  { groundingCorpus = "", allowedNames = [] } = {},
) {
  const allowed = new Set(
    allowedNames.map((n) => normalizeBulletKey(n)).filter(Boolean),
  );
  const strictHints = allowed.size > 0;

  const currentMeds = new Set(
    (currentReview.medicines || [])
      .map((m) =>
        String(m?.name || m?.description || "")
          .toLowerCase()
          .trim(),
      )
      .filter(Boolean),
  );

  const pills = [];
  const seen = new Set();
  for (const item of raw) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase().replace(/^(tab|cap|syp|inj)\.?\s+/i, "").trim();
    if (seen.has(key)) continue;
    if (strictHints) {
      const nameKey = normalizeBulletKey(name);
      const allowedHit = [...allowed].some(
        (hint) => nameKey.includes(hint) || hint.includes(nameKey),
      );
      if (!allowedHit) continue;
    }
    seen.add(key);
    pills.push({
      name,
      dosage: String(item?.dosage || "").trim(),
      frequency:
        item?.frequency && Number(item.frequency.value) > 0
          ? item.frequency
          : { value: 1, unit: "/Day" },
      duration: item?.duration || { value: 5, unit: "Days" },
      directions: String(
        item?.directions || item?.patientDirections || "After food",
      ).trim(),
      type: String(item?.type || "Tablet").trim(),
      dosages: Array.isArray(item?.dosages) ? item.dosages : [],
      frequencyInCases: 0,
      usedInCases: 0,
      alreadyInReview: currentMeds.has(key),
      source: "llm",
    });
    if (pills.length >= 12) break;
  }
  return pills;
}

function normalizeLlmNamePills(
  raw = [],
  currentNames = [],
  { groundingCorpus = "", allowedNames = [], field = "name" } = {},
) {
  const allowed = new Set(
    allowedNames.map((n) => normalizeBulletKey(n)).filter(Boolean),
  );
  const strictHints = allowed.size > 0;

  const current = new Set(
    currentNames
      .map((n) =>
        normalizeBulletKey(typeof n === "string" ? n : n?.[field] || n?.name),
      )
      .filter(Boolean),
  );
  const pills = [];
  const seen = new Set();
  for (const item of raw) {
    const name = String(
      typeof item === "string" ? item : item?.[field] || item?.name || "",
    ).trim();
    if (!name) continue;
    const key = normalizeBulletKey(name);
    if (!key || seen.has(key)) continue;
    if (strictHints) {
      const allowedHit = [...allowed].some(
        (hint) => key.includes(hint) || hint.includes(key),
      );
      if (!allowedHit) continue;
    }
    seen.add(key);
    pills.push({
      name,
      frequencyInCases: 0,
      usedInCases: 0,
      alreadyInReview: current.has(key),
      source: "llm",
    });
    if (pills.length >= 10) break;
  }
  return pills;
}

const NOTE_SYSTEM_PROMPT = `You help an Indian OPD doctor by suggesting tap-to-add note bullets ONLY when their own practice memory is unavailable.

Return JSON only:
{
  "complaints": ["..."],
  "examination": ["..."],
  "diagnosis": ["..."],
  "advice": ["..."]
}

STRICT ACCURACY RULES:
- complaints = patient-reported symptoms, phrased cleanly.
- examination = physical exam findings (e.g. throat congested, chest clear, tenderness) relevant to complaints.
- diagnosis = working diagnoses supported by extracted complaints/exam.
- advice = plan/follow-up/lifestyle/hydration advice.
- Max 3 bullets per non-empty section. Prefer concise bullet points.`;

const ORDER_SYSTEM_PROMPT = `You are an expert Indian Outpatient (OPD) Physician AI. Suggest relevant, safe, standard tap-to-add OPD medicines, labs, and procedures matching the patient's complaints and provisional diagnosis when past doctor memory is unavailable.

Return JSON only:
{
  "medicinePills": [
    {
      "name": "Dolo 650mg",
      "dosage": "650mg",
      "frequency": {"value": 2, "unit": "/Day"},
      "duration": {"value": 5, "unit": "Days"},
      "directions": "After food (BD)",
      "type": "Tablet"
    }
  ],
  "labPills": [
    {"name": "Complete Blood Picture (CBP)"}
  ],
  "procedurePills": [
    {"name": "Steam Inhalation"}
  ]
}

CLINICAL RULES:
1. Suggest frontline standard Indian OPD medications appropriate for the diagnosis (e.g. Paracetamol/Dolo for fever/body pain, PPIs like Pantoprazole for GERD/gastritis, Levocetirizine for allergic URTI, ORS for gastroenteritis).
2. If practiceMemoryHints has specific medicines/labs, prioritize those exact names.
3. Do NOT invent dangerous or heavy specialty inpatient drugs.
4. Do NOT duplicate medicines or labs already present in currentReview.
5. Max 8 medicines, 6 labs, 4 procedures. Return clean, standard Indian brand/generic names.`;

function buildNotePillsFromHints(memoryHints = {}, noteContext = {}) {
  const sections = ["complaints", "examination", "diagnosis", "advice"];
  const used = new Set();
  const result = {};

  for (const section of sections) {
    const pills = [];
    for (const text of memoryHints.note?.[section] || []) {
      const clean = String(text || "").trim();
      if (!clean || bulletAlreadyInNote(clean, noteContext)) continue;
      const key = normalizeBulletKey(clean);
      if (!key || used.has(key)) continue;
      used.add(key);
      pills.push(toNotePill(clean, noteContext, "memory"));
      if (pills.length >= 6) break;
    }
    result[section] = pills;
  }
  return result;
}

function countNotePills(notePills = {}) {
  return ["complaints", "examination", "diagnosis", "advice"].reduce(
    (sum, section) => sum + (notePills[section] || []).length,
    0,
  );
}

function mergeNotePills(primary = {}, secondary = {}) {
  const sections = ["complaints", "examination", "diagnosis", "advice"];
  const used = new Set();
  const merged = {};

  for (const section of sections) {
    const pills = [];
    for (const pill of [
      ...(primary[section] || []),
      ...(secondary[section] || []),
    ]) {
      const key = normalizeBulletKey(pill.text);
      if (!key || used.has(key)) continue;
      used.add(key);
      pills.push(pill);
    }
    merged[section] = pills;
  }
  return merged;
}

async function suggestNotePillsWithLlm({
  extractedClinical = {},
  noteContext = {},
  memoryHints = {},
}) {
  const groundingCorpus = buildGroundingCorpus(extractedClinical, memoryHints);
  const hasHints = Object.values(memoryHints.note || {}).some(
    (items) => (items || []).length > 0,
  );

  if (hasHints) {
    return buildNotePillsFromHints(memoryHints, noteContext);
  }

  const userPayload = {
    extractedClinical,
    currentNoteSections: {
      complaints: noteContext.complaints || [],
      examination: noteContext.examination || [],
      diagnosis: noteContext.diagnosis || [],
      advice: noteContext.advice || [],
    },
    practiceMemoryHints: memoryHints.note || {},
  };

  const parsed = await callSuggestJsonCompletion([
    { role: "system", content: NOTE_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(userPayload) },
  ]);

  return normalizeLlmNotePills(parsed, noteContext, { groundingCorpus });
}

async function suggestOrderPillsWithLlm({
  extractedClinical = {},
  currentReview = {},
  memoryHints = {},
}) {
  const groundingCorpus = buildGroundingCorpus(extractedClinical, memoryHints);
  const hasOrderHints =
    (memoryHints.medicines || []).length > 0 ||
    (memoryHints.labs || []).length > 0 ||
    (memoryHints.procedures || []).length > 0;

  if (hasOrderHints) {
    return {
      medicinePills: normalizeLlmMedicinePills(
        (memoryHints.medicines || []).map((name) => ({ name })),
        currentReview,
        { allowedNames: memoryHints.medicines || [] },
      ),
      labPills: normalizeLlmNamePills(
        memoryHints.labs || [],
        currentReview.labTests || [],
        { allowedNames: memoryHints.labs || [] },
      ),
      procedurePills: normalizeLlmNamePills(
        memoryHints.procedures || [],
        [
          ...(currentReview.procedures || []),
          ...(currentReview.procedureNames || []),
        ],
        { allowedNames: memoryHints.procedures || [] },
      ),
    };
  }

  const userPayload = {
    extractedClinical,
    currentReview: {
      medicines: (currentReview.medicines || []).map((m) => m?.name || m),
      labTests: currentReview.labTests || [],
      procedures: currentReview.procedures || [],
    },
    practiceMemoryHints: {
      medicines: memoryHints.medicines || [],
      labs: memoryHints.labs || [],
      procedures: memoryHints.procedures || [],
      packages: memoryHints.packageNames || [],
    },
  };

  const parsed = await callSuggestJsonCompletion([
    { role: "system", content: ORDER_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(userPayload) },
  ]);

  return {
    medicinePills: normalizeLlmMedicinePills(
      parsed.medicinePills || parsed.medicines || [],
      currentReview,
      { groundingCorpus },
    ),
    labPills: normalizeLlmNamePills(
      parsed.labPills || parsed.labs || [],
      currentReview.labTests || [],
      {
        groundingCorpus,
      },
    ),
    procedurePills: normalizeLlmNamePills(
      parsed.procedurePills || parsed.procedures || [],
      [
        ...(currentReview.procedures || []),
        ...(currentReview.procedureNames || []),
      ],
      { groundingCorpus },
    ),
  };
}

module.exports = {
  suggestNotePillsWithLlm,
  suggestOrderPillsWithLlm,
  buildNotePillsFromHints,
  mergeNotePills,
  countNotePills,
  normalizeLlmNotePills,
  bulletAlreadyInNote,
};
