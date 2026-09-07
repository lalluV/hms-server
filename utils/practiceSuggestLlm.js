/**
 * Practice suggestions: memory first, then LLM to generate (if empty) or clean duplicates.
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

function normalizeNoteIdeaKey(text) {
  return normalizeBulletKey(text)
    .replace(/\b(c|h)\s+o\b/g, " ")
    .replace(
      /\b(c\/o|h\/o|since|for|with|associated|and|the|of|in|on|to|a|an|days?|weeks?|months?|years?|history|complaints?|mild|moderate|severe|high|grade|low|ago)\b/g,
      " ",
    )
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pillIdeaKey(text) {
  return normalizeNoteIdeaKey(text) || normalizeBulletKey(text);
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
  const key = pillIdeaKey(text);
  if (!key) return true;
  for (const section of ["complaints", "examination", "diagnosis", "advice"]) {
    for (const bullet of noteSectionTexts(noteContext, section)) {
      if (pillIdeaKey(bullet) === key) return true;
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
      const key = pillIdeaKey(text);
      if (!key || used.has(key)) continue;
      if (!isGroundedSuggestion(text, groundingCorpus)) continue;
      used.add(key);
      pills.push(toNotePill(text, noteContext));
      if (pills.length >= 2) break;
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
    if (pills.length >= 20) break;
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
    if (pills.length >= 15) break;
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
- Max 2 bullets per non-empty section. Prefer concise bullet points.`;

const ORDER_SYSTEM_PROMPT = `You are an expert Indian Outpatient (OPD) Physician AI. Suggest relevant, safe, standard tap-to-add OPD medicines, labs, and procedures matching the patient's complaints and provisional diagnosis when past doctor memory is unavailable.

Return JSON only:
{
  "medicinePills": [
    {
      "name": "Dolo 650",
      "dosage": "650mg",
      "frequency": {"value": 2, "unit": "/Day"},
      "duration": {"value": 5, "unit": "Days"},
      "quantity": 10,
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

CLINICAL & PRESCRIBING RULES:
1. SUGGEST COMPLETE INDIAN OPD REGIMEN (PRIMARY + ADD-ON MEDS):
   - In addition to frontline primary medications, include standard supportive add-on medications that Indian OPD doctors routinely co-prescribe:
     * Gastroprotective PPIs (e.g. "Pantop 40") alongside NSAIDs, antibiotics, or steroids.
     * Symptomatic relief (e.g. "Dolo 650" SOS for fever/pain; "Vomistop" for nausea; "Ascoril-LS" or antiallergics for respiratory symptoms; ORS for diarrhea).
     * Nutrient / gut support (e.g. B-complex, Probiotics) with antibiotic courses.
2. NO FORMULATION TYPE IN MEDICINE NAME:
   - Strip prefixes like "Tab", "Syp", "Inj", "Cap" from medicine.name. Put the formulation type into "type" ("Tablet", "Capsules", "Syrup", "Injection", "Ointment", "Drops", "Inhaler").
3. KEEP STRENGTH IN MEDICINE NAME:
   - Include standard strength in name (e.g. "Dolo 650", "Augmentin 625", "Pantop 40", "Azithro 500").
4. ACCURATE DEFAULT QUANTITIES:
   - Tablets/Capsules: daily doses × days (e.g. 10 for 5 days BD). Syrups/Topicals/Drops/Inhalers/Insulin: 1.
5. FORMULATION DIVERSITY:
   - Suggest up to 4-5 medicines per type (tablets, syrups, injections, topicals, drops) matching the clinical picture.`;

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
      if (pills.length >= 2) break;
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
      const key = pillIdeaKey(pill.text);
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

const CLEAN_SYSTEM_PROMPT = `You are a senior Indian OPD Consultant AI polishing an outpatient doctor's tap-to-add suggestion list.

You receive the patient's complaints/diagnosis AND raw suggestion pills gathered from this doctor's past practice history.

Return JSON only:
{
  "medicines": [
    {
      "name": "Dolo 650",
      "type": "Tablet",
      "quantity": 10,
      "match": "exact or closest name from the input list"
    }
  ],
  "labs": ["exact name from the input list"],
  "procedures": ["exact name from the input list"],
  "notes": {
    "complaints": ["exact text from the input list"],
    "examination": ["exact text from the input list"],
    "diagnosis": ["exact text from the input list"],
    "advice": ["exact text from the input list"]
  }
}

RULES:
1. MIRROR THIS DOCTOR'S PRESCRIBING MINDSET:
   - Your primary job is to show what THIS doctor actually prescribes in their mind for this condition based on their past Rx history.
   - Retain the doctor's preferred authentic brand names (e.g. "Augmentin 625", "Pantop 40", "Dolo 650", "Ascoril-LS", "Wysolone 20mg", "Azithro 500") rather than substituting generic names.

2. ALWAYS PRESERVE ADD-ON & SUPPORTIVE MEDICATIONS:
   - Indian OPD doctors routinely co-prescribe supportive, prophylactic, or symptom-relief add-on medications alongside primary therapy:
     * Gastroprotective PPIs / antacids (e.g. Pantoprazole, Rabeprazole) when prescribing NSAIDs, antibiotics, or steroids.
     * Gut & nutrient support (e.g. B-complex, Becosules, Probiotics / Sporlac, Vitamin C / Limcee, Zinc) with antibiotics or infections.
     * Symptom-relief & SOS drugs (e.g. Paracetamol / Dolo for fever or body ache, Ondansetron / Domperidone for nausea/vomiting, cough syrups / antihistamines for cough/cold, ORS for gastroenteritis / dehydration).
     * Topical / soothing add-ons (e.g. lubricating eye drops with antibiotic eye drops; moisturizers with topical corticosteroids).
   - If the doctor prescribed these add-on medications in past similar cases, NEVER drop them as "unrelated"! Keep them so the doctor sees their complete clinical regimen.

3. NO FORMULATION TYPE IN MEDICINE NAME:
   - The formulation type belongs strictly in the "type" field ("Tablet", "Capsules", "Injection", "Syrup", "Ointment", "Gel", "Sachet", "Drops", "Inhaler", "Spray").
   - Strip prefixes like "Tab", "Tablet", "Cap", "Capsule", "Syp", "Syrup", "Inj", "Injection", "Oint", "Drops" from medicine.name (e.g. "Tab Dolo 650" -> name: "Dolo 650", type: "Tablet"; "Inj Lantus" -> name: "Lantus", type: "Injection"; "Syp Ascoril" -> name: "Ascoril", type: "Syrup").

4. KEEP STRENGTH IN MEDICINE NAME & FIX TYPOS:
   - Keep the strength in the name (e.g. "Wysolone 20mg", "Dolo 650", "Augmentin 625", "Pantop 40", "Azithro 500").
   - Correct obvious spelling errors and transcription typos in drug names without changing the intended drug or brand.

5. ACCURATE DEFAULT QUANTITY:
   - Populate an accurate integer "quantity" for each medicine:
     * Tablets/Capsules/Sachets: total units based on standard course (e.g. BD for 5 days = 10; BD for 7 days = 14; SOS default = 10).
     * Syrups/Ointments/Creams/Gels/Drops/Inhalers/Sprays: quantity = 1 (1 container/bottle/tube).
     * Injections: exact count of ampoules/vials (e.g. 1 vial for multi-dose insulin pens/vials like Lantus; 1 or 2 for stat doses).

6. FORMULATION DIVERSITY:
   - Keep ALL formulation types that appear in the doctor's past practice for this case (tablets, syrups, drops, ointments, sachets, inhalers, injections). Do not collapse everything into only tablets. Keep up to 4-5 items per formulation type when present.

7. DROP ONLY TRUE DUPLICATES AND BLATANTLY UNRELATED ITEMS:
   - Merge duplicates of the same drug.
   - Drop items that belong to completely unrelated specialties or conditions (e.g. do not suggest glaucoma drops for acute gastroenteritis, or antiepileptics for simple fungal skin infection), but KEEP all plausible primary and add-on medications for this case.`;

function medicineFormCategory(pill) {
  const type = String(pill?.type || "").toLowerCase();
  const name = String(pill?.name || "").toLowerCase();
  const blob = `${type} ${name}`;
  if (/\b(inj|injection)\b/.test(blob) || name.startsWith("inj")) return "Injections";
  if (/\b(iv|infusion)\b/.test(blob) || name.startsWith("iv ")) return "IV Fluids";
  if (/\b(syp|syrup|susp|suspension|liquid)\b/.test(blob) || name.startsWith("syp")) {
    return "Syrups & Liquids";
  }
  if (/\b(drop|drops)\b/.test(blob)) return "Drops";
  if (/\b(oint|ointment|cream|gel|lotion)\b/.test(blob)) return "Ointments & Topicals";
  if (/\b(sachet|powder)\b/.test(blob)) return "Sachets & Powders";
  if (/\b(spray|inhaler|rotacap|respule)\b/.test(blob)) return "Inhalers & Sprays";
  if (/\b(tab|tablet|cap|capsule)\b/.test(blob) || name.startsWith("tab") || name.startsWith("cap")) {
    return "Tablets & Capsules";
  }
  return "Other Medicines";
}

function stripFormulationPrefix(name = "") {
  return String(name || "")
    .replace(
      /^(?:tab|tablet|tablets|cap|capsule|capsules|syp|syrup|inj|injection|injections|oint|ointment|cream|gel|sachet|sachets|drops?|spray|inhaler)\.?\s+/i,
      "",
    )
    .trim();
}

function fillMissingMedCategories(cleaned = [], original = [], perCat = 5) {
  if (!original.length) return cleaned;
  const out = [...cleaned];
  const used = new Set(
    out.map((p) => `${medicineFormCategory(p)}::${pillIdeaKey(pillNameOf(p))}`),
  );
  const originalByCat = new Map();
  for (const pill of original) {
    const cat = medicineFormCategory(pill);
    if (!originalByCat.has(cat)) originalByCat.set(cat, []);
    originalByCat.get(cat).push(pill);
  }
  for (const [cat, pills] of originalByCat.entries()) {
    const have = out.filter((p) => medicineFormCategory(p) === cat).length;
    if (have > 0) continue;
    for (const pill of pills) {
      if (out.filter((p) => medicineFormCategory(p) === cat).length >= perCat) {
        break;
      }
      const id = `${cat}::${pillIdeaKey(pillNameOf(pill))}`;
      if (used.has(id)) continue;
      used.add(id);
      out.push({
        ...pill,
        name: stripFormulationPrefix(pill.name) || pill.name,
      });
    }
  }
  return out;
}

function pillNameOf(pill) {
  return String(pill?.name || pill?.text || "").trim();
}

function matchOriginalPill(original = [], keepName) {
  const key = normalizeBulletKey(keepName);
  if (!key) return null;
  let best = null;
  let bestScore = 0;
  for (const pill of original) {
    const n = normalizeBulletKey(pillNameOf(pill));
    if (!n) continue;
    if (n === key) return pill;
    if (n.includes(key) || key.includes(n)) {
      const score =
        Math.min(n.length, key.length) / Math.max(n.length, key.length);
      if (score > bestScore) {
        best = pill;
        bestScore = score;
      }
    }
  }
  return bestScore >= 0.45 ? best : null;
}

function selectKeptPills(original = [], keptItems = []) {
  if (!Array.isArray(keptItems) || !keptItems.length) return [];
  const used = new Set();
  const out = [];
  for (const item of keptItems) {
    const keepName =
      typeof item === "string" ? item : item?.match || item?.name || "";
    const hit = matchOriginalPill(original, keepName);
    if (!hit) continue;
    const id = pillIdeaKey(pillNameOf(hit));
    if (!id || used.has(id)) continue;
    used.add(id);

    let cleanName = hit.name;
    let cleanType = hit.type;
    let cleanQuantity = hit.quantity;

    if (typeof item === "object" && item !== null) {
      if (item.name && typeof item.name === "string" && item.name.trim()) {
        cleanName = stripFormulationPrefix(item.name);
      }
      if (item.type && typeof item.type === "string" && item.type.trim()) {
        cleanType = item.type.trim();
      }
      if (item.quantity != null) {
        cleanQuantity = item.quantity;
      }
    } else if (typeof item === "string" && item.trim()) {
      cleanName = stripFormulationPrefix(item);
    } else {
      cleanName = stripFormulationPrefix(hit.name);
    }

    out.push({
      ...hit,
      name: cleanName || hit.name,
      type: cleanType || hit.type,
      ...(cleanQuantity != null ? { quantity: cleanQuantity } : {}),
    });
  }
  return out;
}

function selectKeptNotePills(original = {}, kept = {}) {
  const sections = ["complaints", "examination", "diagnosis", "advice"];
  const result = {};
  for (const section of sections) {
    const source = original[section] || [];
    const names = Array.isArray(kept?.[section])
      ? kept[section]
      : source.map((p) => p.text);
    const selected = selectKeptPills(
      source.map((p) => ({ ...p, name: p.text })),
      names,
    ).map((p) => ({
      ...p,
      text: p.text || p.name,
    }));
    result[section] = selected.length ? selected : source;
  }
  return result;
}

async function cleanPracticeSuggestionsWithLlm({
  extractedClinical = {},
  noteContext = {},
  medicinePills = [],
  labPills = [],
  procedurePills = [],
  notePills = {},
}) {
  const hasWork =
    medicinePills.length > 1 ||
    labPills.length > 1 ||
    procedurePills.length > 1 ||
    ["complaints", "examination", "diagnosis", "advice"].some(
      (section) => (notePills[section] || []).length > 1,
    );
  if (!hasWork) {
    return { medicinePills, labPills, procedurePills, notePills };
  }

  const parsed = await callSuggestJsonCompletion(
    [
      { role: "system", content: CLEAN_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          patient: {
            complaints: noteContext.complaints || [],
            diagnosis: noteContext.diagnosis || [],
            examination: noteContext.examination || [],
            clinicalNote: extractedClinical.clinicalNote || "",
          },
          rawSuggestions: {
            medicines: medicinePills.map((p) => ({
              name: p.name,
              type: p.type || "",
              category: medicineFormCategory(p),
              dosage: p.dosage || "",
            })),
            labs: labPills.map((p) => ({ name: p.name })),
            procedures: procedurePills.map((p) => ({ name: p.name })),
            notes: {
              complaints: (notePills.complaints || []).map((p) => p.text),
              examination: (notePills.examination || []).map((p) => p.text),
              diagnosis: (notePills.diagnosis || []).map((p) => p.text),
              advice: (notePills.advice || []).map((p) => p.text),
            },
          },
        }),
      },
    ],
    2048,
  );

  const cleanedMeds = fillMissingMedCategories(
    selectKeptPills(
      medicinePills,
      parsed.medicines || parsed.medicinePills || [],
    ),
    medicinePills,
    5,
  );
  const cleanedLabs = selectKeptPills(labPills, parsed.labs || parsed.labPills || []);
  const cleanedProcs = selectKeptPills(
    procedurePills,
    parsed.procedures || parsed.procedurePills || [],
  );

  return {
    medicinePills: cleanedMeds.length ? cleanedMeds : medicinePills,
    labPills: cleanedLabs.length ? cleanedLabs : labPills,
    procedurePills: cleanedProcs.length ? cleanedProcs : procedurePills,
    notePills: selectKeptNotePills(notePills, parsed.notes || {}),
  };
}

module.exports = {
  suggestNotePillsWithLlm,
  suggestOrderPillsWithLlm,
  cleanPracticeSuggestionsWithLlm,
  buildNotePillsFromHints,
  mergeNotePills,
  countNotePills,
  normalizeLlmNotePills,
  bulletAlreadyInNote,
};
