/**
 * AI Write visit agent — conversational tool loop over an in-session draft.
 * Clinical structuring ALWAYS uses the AI Write extract pipeline (same rules as
 * /parse-clinical-note): brand/generic, tapers, dosages grid, note sections, etc.
 * Draft only — never writes to DB (Save stays on the client).
 */

const axios = require("axios");
const { medicineLabel } = require("./healekaPrescriptionHelpers");

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_AI_WRITE_MODEL || "gpt-4o-mini";
const MAX_TOOL_ITERATIONS = 6;
const MAX_HISTORY_MESSAGES = 24;

const openaiApi = axios.create({
  baseURL: OPENAI_API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  },
  timeout: 120000,
});

const EMPTY_VITALS = {
  weight: "",
  height: "",
  temperature: "",
  spo2: "",
  heartRate: "",
  respiratoryRate: "",
  bloodPressure: "",
};

const NOTE_SECTION_LABELS = [
  ["Complaints", "complaints"],
  ["History", "history"],
  ["Examination", "examination"],
  ["Diagnosis", "diagnosis"],
  ["Advice", "advice"],
];

function normalizeMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: String(m?.content || m?.text || "").trim(),
    }))
    .filter((m) => m.content)
    .slice(-MAX_HISTORY_MESSAGES);
}

function normalizeNameKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s/+.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(a, b) {
  const left = normalizeNameKey(a);
  const right = normalizeNameKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  const leftCore = left.replace(/\d+/g, "").trim();
  const rightCore = right.replace(/\d+/g, "").trim();
  return Boolean(
    leftCore &&
    rightCore &&
    (leftCore === rightCore ||
      leftCore.includes(rightCore) ||
      rightCore.includes(leftCore)),
  );
}

function medIdentity(med) {
  return normalizeNameKey(
    medicineLabel(med) ||
      med?.correctedName ||
      med?.description ||
      med?.name ||
      "",
  );
}

function cloneDraft(currentDraft = {}) {
  const medicines = Array.isArray(currentDraft.medicines)
    ? currentDraft.medicines.map((m) => ({ ...m, action: m.action || "add" }))
    : [];
  const labTests = Array.isArray(currentDraft.labTests)
    ? currentDraft.labTests.map((lab) =>
        typeof lab === "string"
          ? { name: lab, action: "add" }
          : { ...lab, name: lab?.name || "", action: lab?.action || "add" },
      )
    : [];
  const procedures = Array.isArray(currentDraft.procedures)
    ? currentDraft.procedures.map((p) => ({ ...p }))
    : [];
  const medicinesToStop = Array.isArray(currentDraft.medicinesToStop)
    ? currentDraft.medicinesToStop.map((m) => ({ ...m }))
    : [];
  const vitals = {
    ...EMPTY_VITALS,
    ...(currentDraft.vitals && typeof currentDraft.vitals === "object"
      ? currentDraft.vitals
      : {}),
  };
  return {
    doctorNotes: String(currentDraft.doctorNotes || "").trim(),
    medicines,
    labTests,
    procedures,
    medicinesToStop,
    vitals,
    noteOperations: Array.isArray(currentDraft.noteOperations)
      ? [...currentDraft.noteOperations]
      : [],
  };
}

function summarizeDraft(draft) {
  const meds = (draft.medicines || [])
    .filter((m) => String(m?.action || "add").toLowerCase() !== "stop")
    .map((m) => {
      const label = medicineLabel(m) || m.name;
      const bits = [label];
      if (m.dosage) bits.push(m.dosage);
      if (m.frequency) {
        bits.push(
          typeof m.frequency === "object"
            ? `${m.frequency.value || ""}${m.frequency.unit || ""}`
            : String(m.frequency),
        );
      }
      if (m.duration) {
        bits.push(
          typeof m.duration === "object"
            ? `${m.duration.value} ${m.duration.unit || "days"}`
            : String(m.duration),
        );
      }
      return bits.filter(Boolean).join(" · ");
    });
  const labs = (draft.labTests || [])
    .map((lab) => (typeof lab === "string" ? lab : lab?.name))
    .filter(Boolean);
  const stops = (draft.medicinesToStop || [])
    .map((m) => medicineLabel(m) || m.name)
    .filter(Boolean);
  const procedures = (draft.procedures || [])
    .map((p) => p?.name || p?.description || "")
    .filter(Boolean);
  const vitalBits = Object.entries(draft.vitals || {})
    .filter(([, v]) => String(v || "").trim())
    .map(([k, v]) => `${k}: ${v}`);

  return {
    doctorNotes: draft.doctorNotes || "",
    medicines: meds,
    labs,
    medicinesToStop: stops,
    procedures,
    vitals: vitalBits,
    empty:
      !draft.doctorNotes &&
      !meds.length &&
      !labs.length &&
      !stops.length &&
      !procedures.length &&
      !vitalBits.length,
  };
}

function draftToResult(draft, assistantReply = "") {
  const medicines = Array.isArray(draft.medicines) ? draft.medicines : [];
  const labTests = Array.isArray(draft.labTests) ? draft.labTests : [];
  const procedures = Array.isArray(draft.procedures) ? draft.procedures : [];
  const medicinesToStop = Array.isArray(draft.medicinesToStop)
    ? draft.medicinesToStop
    : [];

  return {
    noteFormat: "labeled",
    assistantReply: String(assistantReply || "").trim(),
    symptoms: "",
    pastMedicalHistory: "",
    provisionalDiagnosis: "",
    medicines,
    labTests,
    procedures,
    vitals: draft.vitals || { ...EMPTY_VITALS },
    medicinesToApply: medicines.filter(
      (med) => String(med?.action || "add").toLowerCase() === "add",
    ),
    medicinesToStop,
    labTestsToApply: labTests
      .filter((test) => String(test?.action || "add").toLowerCase() === "add")
      .map((test) => (typeof test === "string" ? test : test.name)),
    proceduresToApply: procedures.filter(
      (proc) => String(proc?.action || "add").toLowerCase() === "add",
    ),
    noteOperations: Array.isArray(draft.noteOperations)
      ? draft.noteOperations
      : [],
    doctorNotes: String(draft.doctorNotes || "").trim(),
  };
}

function parseLabeledNoteSections(noteText) {
  const text = String(noteText || "").trim();
  const sections = {
    complaints: [],
    history: [],
    examination: [],
    diagnosis: [],
    advice: [],
  };
  if (!text) return sections;

  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const header = line.match(
      /^\s*(Complaints|History|Examination|Diagnosis|Advice)\s*:\s*$/i,
    );
    if (header) {
      const key = header[1].toLowerCase();
      current = key;
      continue;
    }
    const bullet = line.replace(/^[\s\-*•]+/, "").trim();
    if (!bullet || !current || !sections[current]) continue;
    if (
      !sections[current].some((b) => b.toLowerCase() === bullet.toLowerCase())
    ) {
      sections[current].push(bullet);
    }
  }
  return sections;
}

function composeLabeledNote(sections) {
  const blocks = [];
  for (const [label, key] of NOTE_SECTION_LABELS) {
    const items = sections[key] || [];
    if (!items.length) continue;
    blocks.push(`${label}:\n${items.map((item) => `• ${item}`).join("\n")}`);
  }
  return blocks.join("\n\n").trim();
}

function mergeNotes(existingNote, extractedNote, noteOperations = []) {
  const base = parseLabeledNoteSections(existingNote);
  const incoming = parseLabeledNoteSections(extractedNote);

  // Apply removes from extract against current draft bullets
  for (const op of noteOperations || []) {
    if (String(op?.action || "").toLowerCase() !== "remove") continue;
    const section = String(op.section || "").toLowerCase();
    const target = String(op.target || "")
      .trim()
      .toLowerCase();
    if (!base[section] || !target) continue;
    base[section] = base[section].filter((b) => b.toLowerCase() !== target);
  }

  for (const [, key] of NOTE_SECTION_LABELS) {
    for (const bullet of incoming[key] || []) {
      if (!base[key].some((b) => b.toLowerCase() === bullet.toLowerCase())) {
        base[key].push(bullet);
      }
    }
  }

  const composed = composeLabeledNote(base);
  if (composed) return composed;

  // Fallback: free-text merge when not labeled
  const existing = String(existingNote || "").trim();
  const next = String(extractedNote || "").trim();
  if (!existing) return next;
  if (!next) return existing;
  if (existing.toLowerCase().includes(next.toLowerCase())) return existing;
  return `${existing}\n\n${next}`.trim();
}

function buildExtractExistingContext(draft, existingContext = {}) {
  const draftSections = parseLabeledNoteSections(draft.doctorNotes);
  return {
    ...existingContext,
    doctorNotes: draft.doctorNotes || existingContext.doctorNotes || "",
    noteFormat: existingContext.noteFormat || "labeled",
    noteSections: {
      complaints: draftSections.complaints.length
        ? draftSections.complaints
        : existingContext.noteSections?.complaints || [],
      history: draftSections.history.length
        ? draftSections.history
        : existingContext.noteSections?.history || [],
      examination: draftSections.examination.length
        ? draftSections.examination
        : existingContext.noteSections?.examination || [],
      diagnosis: draftSections.diagnosis.length
        ? draftSections.diagnosis
        : existingContext.noteSections?.diagnosis || [],
      advice: draftSections.advice.length
        ? draftSections.advice
        : existingContext.noteSections?.advice || [],
    },
    medicines: [
      ...(Array.isArray(existingContext.medicines)
        ? existingContext.medicines
        : []),
      ...(draft.medicines || []),
    ],
    labTests: [
      ...(Array.isArray(existingContext.labTests)
        ? existingContext.labTests
        : []),
      ...(draft.labTests || []),
    ],
    procedures: [
      ...(Array.isArray(existingContext.procedures)
        ? existingContext.procedures
        : []),
      ...(draft.procedures || []),
    ],
  };
}

function mergeExtractIntoDraft(draft, extracted, { isOpd }) {
  const changed = {
    notes: false,
    medicines: [],
    stopped: [],
    labs: [],
    procedures: [],
    vitals: [],
  };

  if (extracted?.doctorNotes || (extracted?.noteOperations || []).length) {
    const nextNote = mergeNotes(
      draft.doctorNotes,
      extracted.doctorNotes || "",
      extracted.noteOperations || [],
    );
    if (nextNote !== draft.doctorNotes) {
      draft.doctorNotes = nextNote;
      changed.notes = true;
    }
  }

  if (
    Array.isArray(extracted?.noteOperations) &&
    extracted.noteOperations.length
  ) {
    draft.noteOperations = [
      ...(draft.noteOperations || []),
      ...extracted.noteOperations,
    ];
  }

  const adds = Array.isArray(extracted?.medicinesToApply)
    ? extracted.medicinesToApply
    : (extracted?.medicines || []).filter(
        (m) => String(m?.action || "add").toLowerCase() === "add",
      );

  for (const med of adds) {
    const key = medIdentity(med);
    if (!key) continue;
    const idx = draft.medicines.findIndex((m) => medIdentity(m) === key);
    const row = { ...med, action: "add" };
    if (idx >= 0) {
      draft.medicines[idx] = { ...draft.medicines[idx], ...row };
    } else {
      draft.medicines.push(row);
    }
    changed.medicines.push(medicineLabel(row) || row.name);
    // Re-prescribe clears stop
    draft.medicinesToStop = (draft.medicinesToStop || []).filter(
      (m) => !namesMatch(medicineLabel(m) || m.name, medicineLabel(row)),
    );
  }

  const stops = Array.isArray(extracted?.medicinesToStop)
    ? extracted.medicinesToStop
    : (extracted?.medicines || []).filter(
        (m) => String(m?.action || "").toLowerCase() === "stop",
      );

  for (const med of stops) {
    const label = medicineLabel(med) || med?.name || "";
    if (!label) continue;
    draft.medicines = draft.medicines.filter(
      (m) => !namesMatch(medicineLabel(m) || m.name, label),
    );
    const already = draft.medicinesToStop.some((m) =>
      namesMatch(medicineLabel(m) || m.name, label),
    );
    if (!already) {
      draft.medicinesToStop.push({
        ...med,
        name: label,
        correctedName: label,
        description: label,
        action: "stop",
        directions: med.directions || "Stop this medicine",
      });
    }
    changed.stopped.push(label);
  }

  const labs = Array.isArray(extracted?.labTestsToApply)
    ? extracted.labTestsToApply
    : (extracted?.labTests || [])
        .filter(
          (t) =>
            typeof t === "string" ||
            String(t?.action || "add").toLowerCase() === "add",
        )
        .map((t) => (typeof t === "string" ? t : t.name));

  for (const lab of labs) {
    const labName = String(lab || "").trim();
    if (!labName) continue;
    const exists = draft.labTests.some((item) =>
      namesMatch(typeof item === "string" ? item : item?.name, labName),
    );
    if (!exists) {
      draft.labTests.push({ name: labName, action: "add" });
      changed.labs.push(labName);
    }
  }

  if (!isOpd) {
    const procs = Array.isArray(extracted?.proceduresToApply)
      ? extracted.proceduresToApply
      : (extracted?.procedures || []).filter(
          (p) => String(p?.action || "add").toLowerCase() === "add",
        );
    for (const proc of procs) {
      const procName = String(proc?.name || proc?.correctedName || "").trim();
      if (!procName) continue;
      const exists = draft.procedures.some((p) =>
        namesMatch(p?.name || p?.description, procName),
      );
      if (!exists) {
        draft.procedures.push({ ...proc, name: procName, action: "add" });
        changed.procedures.push(procName);
      }
    }
  }

  if (extracted?.vitals && typeof extracted.vitals === "object") {
    for (const [key, value] of Object.entries(extracted.vitals)) {
      if (value == null || value === "") continue;
      if (!(key in draft.vitals) && !(key in EMPTY_VITALS)) continue;
      draft.vitals[key] = String(value).trim();
      changed.vitals.push(key);
    }
  }

  return changed;
}

function getTools() {
  return [
    {
      type: "function",
      function: {
        name: "get_draft_summary",
        description:
          "Read the current working chart draft. Use for questions like what we have / summarize / recap.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "apply_clinical_turn",
        description:
          "REQUIRED for any clinical change: notes, medicines (add/change/stop), labs, procedures, vitals. Pass the doctor's clinical content (preserve facts, shorthand OK). Uses the AI Write medical extract engine (brand/generic, tapers, dosages M/A/E/N, labeled note sections, stop vs course-then-stop). Do NOT invent structured meds yourself — this tool does it.",
        parameters: {
          type: "object",
          properties: {
            utterance: {
              type: "string",
              description:
                "Clinical content to apply this turn. Prefer the doctor's words; you may lightly clarify but never invent doses, diagnoses, or orders.",
            },
          },
          required: ["utterance"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "remove_medicines_from_draft",
        description:
          "Undo / remove medicines from the unsaved draft list only (not a therapy stop). Use when the doctor says remove from the list / undo add before Save.",
        parameters: {
          type: "object",
          properties: {
            names: { type: "array", items: { type: "string" } },
          },
          required: ["names"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "remove_labs",
        description: "Remove lab orders from the unsaved draft by name.",
        parameters: {
          type: "object",
          properties: {
            labs: { type: "array", items: { type: "string" } },
          },
          required: ["labs"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "clear_draft_section",
        description:
          "Clear part of the draft. section=all clears everything; otherwise notes|medicines|labs|procedures|vitals|stops.",
        parameters: {
          type: "object",
          properties: {
            section: {
              type: "string",
              enum: [
                "all",
                "notes",
                "medicines",
                "labs",
                "procedures",
                "vitals",
                "stops",
              ],
            },
          },
          required: ["section"],
          additionalProperties: false,
        },
      },
    },
  ];
}

async function executeDraftTool(name, args, draft, ctx) {
  const {
    clinicalSetting,
    age,
    gender,
    allergies,
    existingContext,
    parseClinicalNote,
  } = ctx;
  const isOpd = String(clinicalSetting || "opd").toLowerCase() !== "ipd";

  switch (name) {
    case "get_draft_summary": {
      const summary = summarizeDraft(draft);
      return {
        ok: true,
        empty: summary.empty,
        summary,
        tip: summary.empty
          ? "Draft is empty — ask for clinical details."
          : "Answer from this summary only. Do not invent items.",
      };
    }
    case "apply_clinical_turn": {
      const utterance = String(args?.utterance || "").trim();
      if (!utterance) return { ok: false, error: "utterance is required" };
      if (typeof parseClinicalNote !== "function") {
        return { ok: false, error: "AI Write extract is not configured" };
      }

      const extractContext = buildExtractExistingContext(
        draft,
        existingContext || {},
      );

      let extracted;
      try {
        extracted = await parseClinicalNote({
          clinicalNote: utterance,
          age,
          gender,
          allergies,
          existingContext: extractContext,
          mode: "add",
          clinicalSetting,
        });
      } catch (err) {
        return {
          ok: false,
          error: err?.message || "AI Write extract failed",
        };
      }

      const changed = mergeExtractIntoDraft(draft, extracted, { isOpd });
      return {
        ok: true,
        engine: "ai_write_extract",
        changed,
        preview: summarizeDraft(draft),
      };
    }
    case "remove_medicines_from_draft": {
      const names = Array.isArray(args?.names) ? args.names : [];
      const removed = [];
      for (const name of names) {
        const before = draft.medicines.length;
        draft.medicines = draft.medicines.filter(
          (m) => !namesMatch(medicineLabel(m) || m.name, name),
        );
        if (draft.medicines.length < before) removed.push(String(name));
      }
      return { ok: true, removed };
    }
    case "remove_labs": {
      const labs = Array.isArray(args?.labs) ? args.labs : [];
      const removed = [];
      for (const lab of labs) {
        const before = draft.labTests.length;
        draft.labTests = draft.labTests.filter(
          (item) =>
            !namesMatch(typeof item === "string" ? item : item?.name, lab),
        );
        if (draft.labTests.length < before) removed.push(String(lab));
      }
      return { ok: true, removed };
    }
    case "clear_draft_section": {
      const section = String(args?.section || "").toLowerCase();
      if (section === "all") {
        draft.doctorNotes = "";
        draft.medicines = [];
        draft.labTests = [];
        draft.procedures = [];
        draft.medicinesToStop = [];
        draft.vitals = { ...EMPTY_VITALS };
        draft.noteOperations = [];
      } else if (section === "notes") {
        draft.doctorNotes = "";
        draft.noteOperations = [];
      } else if (section === "medicines") draft.medicines = [];
      else if (section === "labs") draft.labTests = [];
      else if (section === "procedures") draft.procedures = [];
      else if (section === "stops") draft.medicinesToStop = [];
      else if (section === "vitals") draft.vitals = { ...EMPTY_VITALS };
      else return { ok: false, error: `Unknown section: ${section}` };
      return { ok: true, cleared: section };
    }
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

function buildSystemPrompt({
  clinicalSetting,
  age,
  gender,
  allergies,
  existingContext,
}) {
  const isOpd = String(clinicalSetting || "opd").toLowerCase() !== "ipd";
  const patientBits = [];
  if (age) patientBits.push(`age ${age}`);
  if (gender) patientBits.push(String(gender));
  if (allergies) patientBits.push(`allergies: ${allergies}`);
  const existingBits = [];
  if (existingContext?.medicineNames?.length) {
    existingBits.push(
      `chart meds: ${existingContext.medicineNames.slice(0, 12).join(", ")}`,
    );
  }
  if (existingContext?.labNames?.length) {
    existingBits.push(
      `chart labs: ${existingContext.labNames.slice(0, 8).join(", ")}`,
    );
  }

  return `You are AI Write in Healeka HMS — a sharp clinical coworker for Indian hospitals (Telugu/English). Talk short, clear, natural.

SCOPE
- Edit only this visit's WORKING DRAFT. Never claim saved — doctor presses Save.
- No appointments, registration, census, inventory, or other patients.
- Setting: ${isOpd ? "OPD prescription" : "IPD clinical note"}.

PATIENT
${patientBits.length ? patientBits.join(" · ") : "not provided"}
${existingBits.length ? `Existing chart (reference): ${existingBits.join("; ")}` : ""}

HOW TO ACT (critical)
1. Questions ("what do we have?", summarize) → get_draft_summary, then answer from it.
2. ANY clinical change (complaints, advice, add/change/stop meds, labs, vitals, procedures) → apply_clinical_turn with the doctor's clinical utterance.
3. Do NOT invent medicine rows, dosages, note sections, or labs yourself. apply_clinical_turn runs the AI Write extract engine which enforces:
   - Brand name in name; generic_name always "" (never guess salts)
   - Tapers = multiple medicine rows (never one packed taper)
   - Stop only when doctor explicitly stops/holds/discontinues a named drug; "5 days then stop" is add, not stop
   - directions = morning/afternoon/evening/night patient English (no BD/OD/TDS as patient text)
   - dosages[] M/A/E/N grid; Tablet/Capsule unit ""; puff/inhaler → unit "puffs"
   - Fixed daily add with no duration → "5 days"; SOS/PRN/continue → no duration
   - Complaints ≠ diagnosis; labeled note sections; split labs; no invented facts
4. Undo unsaved draft rows → remove_medicines_from_draft / remove_labs (not stop).
5. Clear → clear_draft_section.
6. After tools, reply with ONE short spoken sentence confirming what changed. Never "Updated note · 2 meds".
7. Remind Save sparingly.

LANGUAGE
- Doctor may mix Telugu and English. Reply in clear English.
- Pass clinical content to apply_clinical_turn largely as spoken; do not strip facts.`;
}

/**
 * Run visit-scoped AI Write agent.
 */
async function runAiWriteVisitAgent({
  messages,
  currentDraft,
  age,
  gender,
  allergies,
  existingContext,
  clinicalSetting = "opd",
  deltaText,
  parseClinicalNote,
}) {
  if (!OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.status = 503;
    throw err;
  }
  if (typeof parseClinicalNote !== "function") {
    const err = new Error("AI Write extract is not configured");
    err.status = 500;
    throw err;
  }

  let history = normalizeMessages(messages);
  if (!history.length && typeof deltaText === "string" && deltaText.trim()) {
    history = [{ role: "user", content: deltaText.trim() }];
  }
  if (!history.length) {
    const err = new Error("A doctor message is required");
    err.status = 400;
    throw err;
  }

  const draft = cloneDraft(currentDraft);
  const tools = getTools();
  const systemPrompt = buildSystemPrompt({
    clinicalSetting,
    age,
    gender,
    allergies,
    existingContext,
  });

  const toolCtx = {
    clinicalSetting,
    age,
    gender,
    allergies,
    existingContext,
    parseClinicalNote,
  };

  const openaiMessages = [
    { role: "system", content: systemPrompt },
    {
      role: "system",
      content: `Current draft snapshot:\n${JSON.stringify(summarizeDraft(draft))}`,
    },
    ...history,
  ];

  const toolsUsed = [];
  let reply = "";

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let response;
    try {
      response = await openaiApi.post("/chat/completions", {
        model: OPENAI_MODEL,
        messages: openaiMessages,
        temperature: 0.2,
        tools,
        tool_choice: "auto",
      });
    } catch (error) {
      console.error(
        "[AiWriteVisitAgent] OpenAI error:",
        error.response?.data || error.message,
      );
      const err = new Error("Failed to contact OpenAI API");
      err.status = 502;
      throw err;
    }

    const choice = response.data?.choices?.[0]?.message;
    if (!choice) {
      const err = new Error("Invalid response from OpenAI API");
      err.status = 502;
      throw err;
    }

    const toolCalls = choice.tool_calls;
    if (!toolCalls?.length) {
      reply = String(choice.content || "").trim();
      break;
    }

    openaiMessages.push({
      role: "assistant",
      content: choice.content || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const toolName = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }
      toolsUsed.push(toolName);
      console.log(`[AiWriteVisitAgent] tool=${toolName}`);
      const result = await executeDraftTool(toolName, args, draft, toolCtx);
      openaiMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  if (!reply) {
    try {
      const final = await openaiApi.post("/chat/completions", {
        model: OPENAI_MODEL,
        messages: [
          ...openaiMessages,
          {
            role: "user",
            content:
              "Give your final short spoken confirmation from the tool results. One or two sentences. Do not call more tools.",
          },
        ],
        temperature: 0.3,
      });
      reply = String(final.data?.choices?.[0]?.message?.content || "").trim();
    } catch {
      reply = "Updated the draft — Save when you're ready.";
    }
  }

  const result = draftToResult(
    draft,
    reply || "Got it — Save when you're ready.",
  );
  result._toolsUsed = [...new Set(toolsUsed)];
  return result;
}

module.exports = {
  runAiWriteVisitAgent,
  draftToResult,
  cloneDraft,
  mergeExtractIntoDraft,
  mergeNotes,
};
