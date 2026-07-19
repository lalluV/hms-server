/**
 * Healeka AI agent — OpenAI tool-calling loop with deep reads + confirm-gated writes.
 */

const axios = require("axios");
const { getToolsForRole, executeTool } = require("./healekaAgentTools");
const {
  getByActionId,
  clearDraft,
  toClientPending,
  getDraft,
} = require("./healekaAgentPending");
const {
  executeReadyAction,
  actorId,
} = require("./healekaAgentActions");
const { buildGapComposeDraft } = require("./healekaPrescriptionHelpers");

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-mini";
const MAX_TOOL_ITERATIONS = 8;
const MAX_HISTORY_MESSAGES = 24;

const openaiApi = axios.create({
  baseURL: OPENAI_API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  },
  timeout: 90000,
});

const rateBuckets = new Map();
const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(userKey) {
  const now = Date.now();
  let bucket = rateBuckets.get(userKey);
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(userKey, bucket);
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT;
}

function looksDataRelated(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  return /(patient|umr|stock|inventory|appointment|census|ward|expense|doctor|nurse|register|book|cancel|note|prescription|rx|visit|sale|receipt|insurance|staff|op\b|ip\b|pharmacy|lab|today|find|search|how many|list|lookup|look up)/i.test(
    t,
  );
}

function isAffirmative(text) {
  return /^(yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|sure|haan|ha)\b/i.test(
    String(text || "").trim(),
  );
}

function buildSystemPrompt({ userName, role, hospitalId, pageContext }) {
  const pageBits = [];
  if (pageContext?.label || pageContext?.path) {
    pageBits.push(
      `viewing ${pageContext.label || ""} (${pageContext.path || ""})`,
    );
  }
  if (pageContext?.umr) pageBits.push(`patient UMR ${pageContext.umr}`);
  if (pageContext?.prescriptionId) {
    pageBits.push(`open prescriptionId ${pageContext.prescriptionId}`);
  }
  const pageLine = pageBits.length
    ? `The user is currently ${pageBits.join(", ")}.`
    : "Page context not provided.";
  const firstName = (userName || "there").split(/\s+/)[0];

  return `You are Healeka AI — a sharp hospital assistant in Healeka HMS (Indian hospitals). Talk like a helpful clinical coworker: short, clear, natural.

WHO YOU'RE HELPING
- Name: ${userName || "Staff"} (use "${firstName}" sparingly)
- Role: ${role}
- Hospital ID: ${hospitalId}
- ${pageLine}

DATA RULES (critical)
1. For ANY hospital-data question (patients, stock, appointments, census, bills, staff), you MUST call tools. Never invent numbers, UMR, stock, or appointments.
2. Chain tools when useful: search_patients → get_patient_summary; find_doctor_by_name before booking; count_patients / get_opd_ipd_census for overview.
3. If tools return empty, say what you searched and suggest a better query (full UMR, phone digits).
4. Answer with Markdown: **bold** IDs/numbers, bullets or small tables. Lead with the answer.
5. Patient summaries include recentPrescriptions with prescriptionId + medicineData — use those when deciding create vs update.

WRITE ACTIONS (critical)
6. Writes supported: register patient, book/cancel appointment, add doctor/nurse NOTE, create visit PRESCRIPTION, UPDATE existing visit prescription (medicines/labs/notes).
7. Prescription vs chart note:
   - Chart note only ("add a note that…") → prepare_add_note
   - Prescribe / write Rx / add meds / stop meds / change dose / add labs → prescription tools below
8. NATURAL PRESCRIBING (treat like talking to a person):
   - First resolve the patient (UMR). If pageContext has umr/prescriptionId, use them.
   - If they already have today's visit (or an open prescriptionId), ALWAYS use prepare_update_prescription — NEVER create a second visit.
   - If prepare_create_prescription returns status "reuse_available", switch to prepare_update_prescription with that prescriptionId (pass along medicines/labs/note). Only use forceNew:true when the user explicitly asks for a separate new visit.
   - No visit yet → prepare_create_prescription (you MAY include medicines/labs/doctorNote on create so one Confirm writes the full Rx).
   - Phrases → tool mapping examples:
     · "add azithro 500 od 5 days" → update, medicines action add
     · "stop metformin" / "hold pantop" → update, medicines action stop (or medicinesToStop)
     · "change PCM to 650" → update, medicines action add (same drug, new dose)
     · "continue all, add azithro, send CBC" → update with azithro add + CBC lab add
     · "remove azithro from the list" → update, stop
     · "new visit / separate prescription today" → create with forceNew:true
9. Doctor role: consultant = logged-in doctor (no doctorId needed). Nurse/Admin: collect doctorId or doctorName first.
10. Expand common abbreviations into tool args (Azithro→Azithromycin, PCM/Dolo→Paracetamol, Pantop→Pantoprazole, CBC/LFT/KFT, etc.). Include frequency (OD/BD/TDS), duration, dosage when the doctor said them.
11. If prepare returns status "incomplete", ask ONLY for missing fields. Do NOT show Confirm yet. Do NOT call execute_*.
12. If prepare returns status "ready", summarize the plan (adds/stops/labs/vitals) and tell them to press **Confirm**. Never claim saved until execute succeeds.
13. Call execute_* only after user Confirm (or affirmative yes when a ready draft exists).
14. AFTER a prescription create/update succeeds: check what's still missing (weight, height, vitals BP/pulse/temp/SpO2, medicines, diagnosis, note). Briefly list what's incomplete and invite the doctor to dictate those values next. Use prepare_update_prescription with weight/height/vitals when they reply (e.g. "weight 68, BP 120/80, pulse 78").

PATIENT PICKING (Doctor/Nurse)
- When the user starts an Rx/vitals action without a UMR, call list_todays_op and ask them to pick (or accept a typed UMR/name). Doctors get their OP list by default; nurses get the hospital OP list.
- Action-first is normal: they may say the action first, then the patient.

SUGGESTED NEXT STEPS
- After answers, briefly suggest 1–3 natural follow-ups the user can take (the UI also shows action chips). Prefer completing missing Rx fields when a visit was just saved.

VOICE
- Conversational coworker, not a ticket bot. Skip "As an AI…" / "Certainly!".
- Match length to the question. End with a useful next step when helpful.`;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim(),
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.trim() }));
}

function extractPendingFromToolResults(toolResults) {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (r && r.status === "ready" && r.pendingAction) return r.pendingAction;
  }
  return undefined;
}

function extractMissingFromToolResults(toolResults) {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (r && r.status === "incomplete" && Array.isArray(r.missing)) {
      // Only surface real field names (not internal routing hints)
      const fields = r.missing.filter((m) =>
        /^(patientRef|doctorId|doctorName|name|gender|age|phone|date|time|prescriptionId|note)$/i.test(
          String(m),
        ),
      );
      if (fields.length) return fields;
    }
  }
  return undefined;
}

/**
 * Context-only next-step chips. No generic filler.
 * Confirm card already has Confirm/Cancel — never duplicate those as chips.
 */
function buildSuggestedActions(role, { pendingAction, missingFields, actionsTaken, toolResults }) {
  const suggestions = [];
  const push = (label, prompt, extra = {}) => {
    if (!label || suggestions.some((s) => s.label === label)) return;
    const { prompt: _ignored, ...rest } = extra || {};
    suggestions.push({
      label,
      prompt: prompt || label,
      ...rest,
    });
  };

  // Draft ready → use the Confirm card only
  if (pendingAction) {
    return [];
  }

  const results = toolResults || [];

  // Need consultant (Nurse/Admin)
  const needsDoctor =
    missingFields?.includes("doctorId") ||
    missingFields?.includes("doctorName");
  if (needsDoctor) {
    for (const r of results) {
      const doctors = r?.activeDoctors || r?.doctorMatches || [];
      for (const d of doctors.slice(0, 3)) {
        if (!d?.name) continue;
        push(
          `Dr. ${d.name}`,
          `Use doctor ${d.name}${d.doctorId ? ` (doctorId ${d.doctorId})` : ""} for the prescription`,
        );
      }
      if (doctors.length) break;
    }
    if (!suggestions.length) {
      push("List doctors", "List active doctors I can assign as consultant");
    }
    return suggestions.slice(0, 4);
  }

  // Just saved Rx → open + compose drafts for gaps (doctor finishes value in input)
  const lastSuccess = actionsTaken?.find(
    (a) => a.type === "execute" && a.result?.success,
  );
  if (lastSuccess?.result?.prescription?.openPath) {
    const rx = lastSuccess.result.prescription;
    push("Open visit", `Open prescription ${rx.prescriptionId}`, {
      href: rx.openPath,
    });

    const gaps = rx.completionGaps || [];
    for (const gap of gaps.slice(0, 3)) {
      const draft = buildGapComposeDraft(gap, {
        UMRNo: rx.UMRNo,
        prescriptionId: rx.prescriptionId,
        patientName: rx.patientName,
      });
      push(gap.chip || gap.label, draft, { compose: true });
    }

    if (!gaps.some((g) => g.key === "medicines")) {
      push(
        "Add another med",
        buildGapComposeDraft(
          { key: "medicines", label: "Medicines" },
          {
            UMRNo: rx.UMRNo,
            prescriptionId: rx.prescriptionId,
            patientName: rx.patientName,
          },
        ),
        { compose: true },
      );
    }
    return suggestions.slice(0, 4);
  }

  // Today's visit already exists → update (compose) or open
  for (const r of results) {
    if (r?.status === "reuse_available" && r?.existingVisit?.prescriptionId) {
      const v = r.existingVisit;
      push(
        "Update visit",
        `Update visit prescription ${v.prescriptionId}: add medicines `,
        { compose: true },
      );
      if (r.openPath) {
        push("Open visit", `Open prescription ${v.prescriptionId}`, {
          href: r.openPath,
        });
      }
      return suggestions.slice(0, 4);
    }
  }

  // Just listed today's OP → patient chips to continue
  for (const r of results) {
    const patients = r?.patients;
    if (!Array.isArray(patients) || !patients.length) continue;
    // list_todays_op shape: { date, count, patients }
    if (r.date || r.mineOnly !== undefined || r.count !== undefined) {
      for (const p of patients.slice(0, 5)) {
        if (!p?.UMRNo) continue;
        const shortName = String(p.name || "Patient").split(/\s+/)[0];
        push(
          `${shortName} · ${p.UMRNo}`,
          `For UMR ${p.UMRNo} (${p.name}): write or update the prescription — I'll dictate next`,
        );
      }
      return suggestions.slice(0, 5);
    }
  }

  // Ambiguous / need patient
  const needsPatient = missingFields?.includes("patientRef");
  if (needsPatient || results.some((r) => r?.matches?.length || r?.ambiguous?.length)) {
    if (role === "Doctor" || role === "Nurse") {
      push("Today's OP", "List today's OP patients I can work with");
      push("Search patient", "I need to find a patient — ask me for UMR, name, or phone");
    }
    for (const r of results) {
      const matches = r?.matches || r?.ambiguous || [];
      for (const p of matches.slice(0, 3)) {
        if (!p?.UMRNo) continue;
        push(
          `${String(p.name || "Patient").split(/\s+/)[0]} · ${p.UMRNo}`,
          `Use patient UMR ${p.UMRNo} (${p.name})`,
        );
      }
    }
    return suggestions.slice(0, 4);
  }

  // Receptionist: only when their write flows are relevant (missing fields)
  if (role === "Receptionist" && missingFields?.length) {
    if (missingFields.some((f) => ["name", "gender", "age", "phone"].includes(f))) {
      push("Register OP", "Register a new OP patient");
    }
    if (missingFields.some((f) => ["doctorName", "date", "time"].includes(f))) {
      push("Book appointment", "Book an appointment");
    }
  }

  return suggestions.slice(0, 4);
}

async function runConfirmOrCancel({
  tenantDb,
  hospitalId,
  user,
  confirmActionId,
  cancelActionId,
}) {
  const ctx = {
    tenantDb,
    hospitalId,
    role: user?.type || "Staff",
    userId: user?.userId || user?.id,
    staffMongoId: user?.id,
  };
  const uid = actorId(ctx);
  const role = ctx.role;

  if (cancelActionId) {
    const pending = getByActionId(cancelActionId, hospitalId, uid);
    clearDraft(hospitalId, uid);
    return {
      reply: pending
        ? `Cancelled — I discarded the draft (**${pending.summary || pending.type}**). Nothing was saved.`
        : "Cancelled. There was no open draft (it may have expired).",
      pendingAction: undefined,
      actionsTaken: [{ type: "cancel", actionId: cancelActionId }],
      suggestedActions: buildSuggestedActions(role, {}),
    };
  }

  if (confirmActionId) {
    const result = await executeReadyAction(ctx, confirmActionId);
    if (result.error) {
      const suggestions = buildSuggestedActions(role, {
        toolResults: result.existingVisit
          ? [
              {
                status: "reuse_available",
                existingVisit: result.existingVisit,
                openPath: result.openPath,
              },
            ]
          : [],
      });
      return {
        reply: result.openPath
          ? `${result.error}\n\nExisting visit: \`${result.openPath}\``
          : `Could not complete that action: ${result.error}`,
        pendingAction: undefined,
        suggestedActions: suggestions,
      };
    }
    let reply = "Done.";
    const actionsTaken = [
      { type: "execute", actionId: confirmActionId, result },
    ];
    if (result.prescription?.prescriptionId && result.updated) {
      const rx = result.prescription;
      const medLine = rx.medicines?.length
        ? `\n\n**Medicines now:** ${rx.medicines.join("; ")}`
        : "";
      const labLine = rx.labs?.length
        ? `\n**Labs:** ${rx.labs.join(", ")}`
        : "";
      const anthro = [
        rx.weight && `weight ${rx.weight}`,
        rx.height && `height ${rx.height}`,
      ]
        .filter(Boolean)
        .join(", ");
      const anthroLine = anthro ? `\n**Recorded:** ${anthro}` : "";
      reply = `Updated visit **${rx.prescriptionId}** for **${rx.UMRNo}** (${rx.patientName}).${medLine}${labLine}${anthroLine}\n\nOpen: \`${rx.openPath}\`${rx.completionNudge || ""}`;
    } else if (result.prescription?.prescriptionId) {
      const rx = result.prescription;
      const medLine = rx.medicines?.length
        ? `\n\n**Medicines:** ${rx.medicines.join("; ")}`
        : "\n\nYou can add medicines here in chat or open the visit.";
      const labLine = rx.labs?.length
        ? `\n**Labs:** ${rx.labs.join(", ")}`
        : "";
      reply = `Created visit prescription **${rx.prescriptionId}** for **${rx.UMRNo}** (${rx.patientName}) · consultant **${rx.consultantDoctor}**.${medLine}${labLine}\n\nOpen: \`${rx.openPath}\`${rx.completionNudge || ""}`;
    } else if (result.noteType) {
      reply = `Saved ${result.noteType} note on **${result.patient.UMRNo}** (${result.patient.name}).`;
    } else if (result.appointment?.id && result.appointment?.status === "cancelled") {
      reply = `Cancelled appointment for **${result.appointment.name}** on **${result.appointment.date}**.`;
    } else if (result.appointment) {
      reply = `Booked **${result.appointment.name}** with **${result.appointment.doctor}** on **${result.appointment.date}** at **${result.appointment.time}**.`;
    } else if (result.patient?.UMRNo && result.patient?.phone) {
      reply = `Registered **${result.patient.name}** as OP · UMR **${result.patient.UMRNo}** · ${result.patient.phone}.`;
    }
    return {
      reply,
      pendingAction: undefined,
      actionsTaken,
      citations: [{ tool: "execute_confirmed_action" }],
      suggestedActions: buildSuggestedActions(role, { actionsTaken }),
    };
  }

  return null;
}

/**
 * @param {object} params
 */
async function runHealekaAgent({
  tenantDb,
  hospitalId,
  user,
  userName,
  messages,
  pageContext,
  confirmActionId,
  cancelActionId,
}) {
  if (!OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.status = 503;
    throw err;
  }

  const role = user?.type || "Staff";
  const userKey = `${hospitalId}:${user?.id || user?.userId || "anon"}`;
  if (!checkRateLimit(userKey)) {
    const err = new Error(
      "Too many Healeka AI requests. Please wait a few minutes and try again.",
    );
    err.status = 429;
    throw err;
  }

  // Direct confirm / cancel path (no LLM)
  if (confirmActionId || cancelActionId) {
    const direct = await runConfirmOrCancel({
      tenantDb,
      hospitalId,
      user,
      confirmActionId,
      cancelActionId,
    });
    if (direct) return direct;
  }

  const history = normalizeMessages(messages);
  if (!history.length) {
    const err = new Error("At least one user message is required");
    err.status = 400;
    throw err;
  }

  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const ctx = {
    tenantDb,
    hospitalId,
    role,
    userId: user?.userId || user?.id,
    staffMongoId: user?.id,
    userName: userName || user?.name || user?.userId,
    pageContext: pageContext || {},
  };

  // Natural-language confirm when a ready pending exists
  if (lastUser && isAffirmative(lastUser.content)) {
    const draft = getDraft(hospitalId, actorId(ctx));
    if (draft && draft.status === "ready") {
      const direct = await runConfirmOrCancel({
        tenantDb,
        hospitalId,
        user,
        confirmActionId: draft.id,
      });
      if (direct) return direct;
    }
  }

  const tools = getToolsForRole(role);
  const systemPrompt = buildSystemPrompt({
    userName: userName || user?.name || user?.userId,
    role,
    hospitalId,
    pageContext,
  });

  const openaiMessages = [
    { role: "system", content: systemPrompt },
    ...history,
  ];

  const toolsUsed = [];
  const toolResultPayloads = [];
  let reply = "";
  let pendingAction;
  let missingFields;
  const requireToolsFirst = looksDataRelated(lastUser?.content);

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const payload = {
      model: OPENAI_MODEL,
      messages: openaiMessages,
      temperature: 0.3,
    };
    if (tools.length) {
      payload.tools = tools;
      payload.tool_choice =
        i === 0 && requireToolsFirst ? "required" : "auto";
    }

    let response;
    try {
      response = await openaiApi.post("/chat/completions", payload);
    } catch (error) {
      console.error(
        "[HealekaAgent] OpenAI error:",
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
    if (!toolCalls || !toolCalls.length) {
      reply = (choice.content || "").trim();
      break;
    }

    openaiMessages.push({
      role: "assistant",
      content: choice.content || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }

      // Block execute_* unless this is somehow already confirmed (should use API confirm)
      if (String(name).startsWith("execute_")) {
        const result = {
          error:
            "Execute is only allowed after the user presses Confirm. Tell them to use the Confirm button (or reply yes once the draft is ready).",
        };
        toolsUsed.push(name);
        toolResultPayloads.push(result);
        openaiMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
        continue;
      }

      toolsUsed.push(name);
      console.log(
        `[HealekaAgent] hospital=${hospitalId} role=${role} tool=${name}`,
      );

      const result = await executeTool(name, args, ctx);
      toolResultPayloads.push(result);
      openaiMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  pendingAction = extractPendingFromToolResults(toolResultPayloads);
  missingFields = extractMissingFromToolResults(toolResultPayloads);

  // Prefer live draft from store for client card
  const live = getDraft(hospitalId, actorId(ctx));
  if (live?.status === "ready") {
    pendingAction = toClientPending(live);
  } else if (live?.status === "draft") {
    pendingAction = undefined;
    if (!missingFields && live.collected) {
      missingFields = undefined;
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
              "Give your final answer now from the tool results only. If a draft is ready, summarize it and ask them to Confirm. If fields are missing, ask only for those. Do not call more tools.",
          },
        ],
        temperature: 0.3,
      });
      reply = (final.data?.choices?.[0]?.message?.content || "").trim();
    } catch {
      reply =
        "I gathered some data but could not finish the answer. Please try again.";
    }
  }

  return {
    reply:
      reply ||
      "I could not generate a response. Please rephrase your question.",
    citations: toolsUsed.length
      ? [...new Set(toolsUsed)].map((t) => ({ tool: t }))
      : undefined,
    pendingAction,
    missingFields,
    suggestedActions: buildSuggestedActions(role, {
      pendingAction,
      missingFields,
      toolResults: toolResultPayloads,
    }),
  };
}

module.exports = {
  runHealekaAgent,
  checkRateLimit,
};
