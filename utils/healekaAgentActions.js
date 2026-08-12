/**
 * Field-gated prepare / execute write tools for Healeka AI.
 * Confirm UI only when status === "ready". execute_* only with ready pending.
 */

const {
  getDraft,
  setDraft,
  clearDraft,
  getByActionId,
} = require("./healekaAgentPending");
const {
  findReusableVisit,
  findTargetVisit,
  summarizeVisit,
  processMedicinesForRx,
  processLabsForRx,
  applyStopMedicines,
  mergeMedicines,
  mergeTests,
  mergeNoteText,
  formatMedicinePreview,
  sortVisitsNewestFirst,
  analyzePrescriptionGaps,
  formatCompletionNudge,
  buildVitalsEntry,
} = require("./healekaPrescriptionHelpers");

const APPOINTMENT_ROLES = [
  "Receptionist",
  "Admin",
  "SuperAdmin",
  "Doctor",
];
const REGISTER_ROLES = ["Receptionist", "Admin", "SuperAdmin"];
const NOTE_ROLES = ["Doctor", "Nurse", "Admin", "SuperAdmin"];
const PRESCRIPTION_ROLES = ["Doctor", "Nurse", "Admin", "SuperAdmin"];

const ACTION_ROLE_ACCESS = {
  prepare_create_appointment: APPOINTMENT_ROLES,
  execute_create_appointment: APPOINTMENT_ROLES,
  prepare_cancel_appointment: APPOINTMENT_ROLES,
  execute_cancel_appointment: APPOINTMENT_ROLES,
  prepare_register_patient: REGISTER_ROLES,
  execute_register_patient: REGISTER_ROLES,
  prepare_add_note: NOTE_ROLES,
  execute_add_note: NOTE_ROLES,
  prepare_create_prescription: PRESCRIPTION_ROLES,
  execute_create_prescription: PRESCRIPTION_ROLES,
  prepare_update_prescription: PRESCRIPTION_ROLES,
  execute_update_prescription: PRESCRIPTION_ROLES,
};

const PATIENT_REQUIRED = ["name", "gender", "age", "phone"];
const APPOINTMENT_REQUIRED = [
  "name",
  "phone",
  "doctorName",
  "date",
  "time",
];
const NOTE_REQUIRED = ["patientRef", "note"];
const PRESCRIPTION_REQUIRED = ["patientRef"];

const ACTION_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "prepare_register_patient",
      description:
        "Collect/validate OP patient registration fields. Returns incomplete+missing OR ready pendingAction. Never writes to DB. Required: name, gender, age, phone.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          gender: { type: "string" },
          age: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          city: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_register_patient",
      description:
        "Execute a READY pending register_patient action after user confirmation. Requires actionId from pendingAction.",
      parameters: {
        type: "object",
        properties: {
          actionId: { type: "string" },
        },
        required: ["actionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_create_appointment",
      description:
        "Collect/validate appointment fields. Required: name, phone, doctorName (or doctorId), date (YYYY-MM-DD), time. Resolves doctor via name when possible. Never writes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { type: "string" },
          doctorName: { type: "string" },
          doctorId: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" },
          time: { type: "string" },
          treatment: { type: "string" },
          notes: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_create_appointment",
      description:
        "Execute READY pending create_appointment after user confirmation.",
      parameters: {
        type: "object",
        properties: { actionId: { type: "string" } },
        required: ["actionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_cancel_appointment",
      description:
        "Prepare cancel for an appointment by id or patient name+date. Never writes until execute.",
      parameters: {
        type: "object",
        properties: {
          appointmentId: { type: "string" },
          patientName: { type: "string" },
          date: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_cancel_appointment",
      description: "Execute READY pending cancel_appointment after confirm.",
      parameters: {
        type: "object",
        properties: { actionId: { type: "string" } },
        required: ["actionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_add_note",
      description:
        "Prepare adding a doctor or nurse NOTE (clinical chart note text). NOT for prescriptions — use prepare_update_prescription to change medicines/labs on a visit, or prepare_create_prescription for a new visit. Required: patientRef (UMR or id) and note text. Never writes.",
      parameters: {
        type: "object",
        properties: {
          patientRef: { type: "string" },
          note: { type: "string" },
          noteType: {
            type: "string",
            enum: ["doctor", "nurse"],
            description: "Defaults by role",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_add_note",
      description: "Execute READY pending add_note after confirm.",
      parameters: {
        type: "object",
        properties: { actionId: { type: "string" } },
        required: ["actionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_create_prescription",
      description:
        "Prepare a NEW visit prescription for a patient. Prefer prepare_update_prescription when the patient already has today's visit (or user wants to add/change/stop medicines on an existing Rx). If a same-day visit exists and forceNew is not true, returns reuse_available — do NOT create another visit; offer update existing or forceNew. Optional medicines/labs/note can be included on create. Required: patientRef (UMR). Doctor role auto-fills consultant; Nurse/Admin must supply doctorId or doctorName.",
      parameters: {
        type: "object",
        properties: {
          patientRef: {
            type: "string",
            description: "Patient UMR or Mongo id",
          },
          doctorId: {
            type: "string",
            description: "Staff custom id of consultant (required for Nurse)",
          },
          doctorName: {
            type: "string",
            description: "Consultant name to resolve if doctorId unknown",
          },
          symptoms: { type: "string" },
          provisionalDiagnosis: { type: "string" },
          doctorNote: {
            type: "string",
            description: "Optional clinical note to store on the new visit",
          },
          forceNew: {
            type: "boolean",
            description:
              "Set true only when user explicitly wants a brand-new visit despite today's existing Rx",
          },
          medicines: {
            type: "array",
            description:
              "Optional medicines to include on create. Each: name, dosage, frequency (OD/BD/TDS), duration, instructions, action=add",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                dosage: { type: "string" },
                frequency: { type: "string" },
                duration: { type: "string" },
                instructions: { type: "string" },
                action: {
                  type: "string",
                  enum: ["add", "continue", "note_only", "stop"],
                },
              },
            },
          },
          labTests: {
            type: "array",
            description: "Optional lab tests to order on create",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                action: {
                  type: "string",
                  enum: ["add", "continue", "note_only"],
                },
              },
            },
          },
        },
        required: ["patientRef"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_create_prescription",
      description:
        "Execute READY pending create_prescription after user Confirm. Creates a Prescription visit document.",
      parameters: {
        type: "object",
        properties: { actionId: { type: "string" } },
        required: ["actionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_update_prescription",
      description:
        "Prepare updates to an EXISTING visit prescription: add/change/stop medicines, labs, doctor note, symptoms/diagnosis, weight, height, and vitals (BP, pulse, temp, SpO2, RR). Use for natural phrases like 'add azithro', 'stop metformin', 'weight 68 height 165', 'BP 120/80 pulse 78'. Resolves target visit from prescriptionId, page context, or today's/latest visit. Prefer over create when a visit already exists. Never writes until execute.",
      parameters: {
        type: "object",
        properties: {
          patientRef: {
            type: "string",
            description: "Patient UMR or Mongo id",
          },
          prescriptionId: {
            type: "string",
            description:
              "Target visit id. Optional if page context or today's visit is clear.",
          },
          doctorId: { type: "string" },
          doctorName: { type: "string" },
          applyMode: {
            type: "string",
            enum: ["add", "replace"],
            description:
              "add = merge onto existing (default). replace = replace medicines/labs/note with provided lists.",
          },
          doctorNote: {
            type: "string",
            description: "Clinical note text to merge or replace",
          },
          symptoms: { type: "string" },
          provisionalDiagnosis: { type: "string" },
          weight: {
            type: "string",
            description: "Patient weight for this visit (e.g. 68 or 68 kg)",
          },
          height: {
            type: "string",
            description: "Patient height for this visit (e.g. 165 or 165 cm)",
          },
          vitals: {
            type: "object",
            description:
              "Vitals to record on this visit. Accepts bloodPressure/bp, heartRate/pulse, temperature, spo2, respiratoryRate/rr, and optional weight/height.",
            properties: {
              bloodPressure: { type: "string" },
              bp: { type: "string" },
              heartRate: { type: "string" },
              pulse: { type: "string" },
              temperature: { type: "string" },
              spo2: { type: "string" },
              respiratoryRate: { type: "string" },
              rr: { type: "string" },
              weight: { type: "string" },
              height: { type: "string" },
            },
          },
          medicines: {
            type: "array",
            description:
              "Medicines with action add|continue|note_only|stop. Dose changes = action add with same drug name.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                dosage: { type: "string" },
                frequency: { type: "string" },
                duration: { type: "string" },
                instructions: { type: "string" },
                action: {
                  type: "string",
                  enum: ["add", "continue", "note_only", "stop"],
                },
              },
            },
          },
          medicinesToStop: {
            type: "array",
            description: "Shortcut list of medicine names to stop/hold",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
          labTests: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                action: {
                  type: "string",
                  enum: ["add", "continue", "note_only"],
                },
              },
            },
          },
        },
        required: ["patientRef"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_update_prescription",
      description:
        "Execute READY pending update_prescription after user Confirm. Updates medicines/labs/notes/weight/height/vitals.",
      parameters: {
        type: "object",
        properties: { actionId: { type: "string" } },
        required: ["actionId"],
      },
    },
  },
];

function missingOf(required, collected) {
  return required.filter((k) => {
    const v = collected[k];
    return v == null || String(v).trim() === "";
  });
}

function mergeCollected(prev, next) {
  const out = { ...(prev || {}) };
  for (const [k, v] of Object.entries(next || {})) {
    if (v != null && String(v).trim() !== "") out[k] = String(v).trim();
  }
  return out;
}

function actorId(ctx) {
  return String(ctx.staffMongoId || ctx.userId || "unknown");
}

async function resolveDoctor(ctx, collected) {
  if (collected.doctorId && collected.doctorName) return collected;
  const Staff = ctx.tenantDb.model("Staff");
  if (collected.doctorId) {
    const doc = await Staff.findOne({
      hospitalId: ctx.hospitalId,
      type: "Doctor",
      $or: [{ _id: collected.doctorId }, { id: collected.doctorId }],
    }).lean();
    if (doc) {
      collected.doctorId = String(doc._id);
      collected.doctorName = doc.name;
      collected.doctor = doc.name;
    }
    return collected;
  }
  if (collected.doctorName) {
    const rx = new RegExp(
      String(collected.doctorName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
    const docs = await Staff.find({
      hospitalId: ctx.hospitalId,
      type: "Doctor",
      name: rx,
      active: { $ne: false },
    })
      .limit(5)
      .lean();
    if (docs.length === 1) {
      collected.doctorId = String(docs[0]._id);
      collected.doctorName = docs[0].name;
      collected.doctor = docs[0].name;
    } else if (docs.length > 1) {
      collected._doctorMatches = docs.map((d) => ({
        id: String(d._id),
        name: d.name,
        specialization: d.specialization,
      }));
    }
  }
  return collected;
}

async function resolvePatientRef(ctx, ref) {
  const Patient = ctx.tenantDb.model("Patient");
  const q = String(ref || "").trim();
  if (!q) return null;
  let patient = await Patient.findOne({
    hospitalId: ctx.hospitalId,
    UMRNo: q,
  }).lean();
  if (!patient && /^[a-f0-9]{24}$/i.test(q)) {
    patient = await Patient.findOne({
      _id: q,
      hospitalId: ctx.hospitalId,
    }).lean();
  }
  if (!patient) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const list = await Patient.find({
      hospitalId: ctx.hospitalId,
      name: rx,
    })
      .limit(5)
      .lean();
    if (list.length === 1) patient = list[0];
    else if (list.length > 1) return { ambiguous: list.map((p) => ({ id: p._id, UMRNo: p.UMRNo, name: p.name })) };
  }
  if (!patient) return null;

  const Prescription = ctx.tenantDb.model("Prescription");
  const prescriptions = await Prescription.find({
    hospitalId: ctx.hospitalId,
    $or: [{ patientId: patient._id }, { UMRNo: patient.UMRNo }],
  })
    .sort({ createdAt: -1 })
    .lean();

  return { ...patient, prescriptions };
}

async function prepare_register_patient(ctx, args) {
  const prev = getDraft(ctx.hospitalId, actorId(ctx));
  const base =
    prev && prev.type === "register_patient" ? prev.collected || {} : {};
  const collected = mergeCollected(base, {
    name: args.name,
    gender: args.gender,
    age: args.age,
    phone: args.phone,
    email: args.email,
    city: args.city,
  });
  const missing = missingOf(PATIENT_REQUIRED, collected);
  if (missing.length) {
    setDraft(ctx.hospitalId, actorId(ctx), {
      type: "register_patient",
      status: "draft",
      collected,
      summary: "OP patient registration (incomplete)",
    });
    return {
      status: "incomplete",
      missing,
      collected,
      message: `Need these required fields before Confirm: ${missing.join(", ")}. Ask the user for them. Do NOT show registration as complete.`,
    };
  }

  const payload = {
    name: collected.name,
    gender: collected.gender,
    age: collected.age,
    phone: collected.phone,
    email: collected.email || "",
    city: collected.city || "",
    patient_type: "OP",
    active: true,
    registered_by: ctx.userId || actorId(ctx),
    registration_date: new Date().toISOString().slice(0, 10),
  };
  const summary = `Register OP patient **${payload.name}** (${payload.gender}, ${payload.age}) · ${payload.phone}`;
  const entry = setDraft(ctx.hospitalId, actorId(ctx), {
    type: "register_patient",
    status: "ready",
    collected,
    payload,
    summary,
    payloadPreview: payload,
  });
  return {
    status: "ready",
    pendingAction: {
      id: entry.id,
      type: entry.type,
      summary,
      payloadPreview: payload,
    },
    message:
      "Draft is complete. Summarize for the user and wait for Confirm — do not claim the patient is registered yet.",
  };
}

async function execute_register_patient(ctx, args) {
  const actionId = args.actionId;
  const pending = getByActionId(actionId, ctx.hospitalId, actorId(ctx));
  if (!pending || pending.type !== "register_patient" || pending.status !== "ready") {
    return {
      error:
        "No ready registration to execute. Collect all fields and prepare again, then wait for user Confirm.",
    };
  }
  const Patient = ctx.tenantDb.model("Patient");
  const patient = new Patient({
    ...pending.payload,
    hospitalId: ctx.hospitalId,
  });
  const saved = await patient.save();
  clearDraft(ctx.hospitalId, actorId(ctx));
  return {
    success: true,
    patient: {
      id: saved._id,
      UMRNo: saved.UMRNo,
      name: saved.name,
      phone: saved.phone,
      gender: saved.gender,
      age: saved.age,
      patient_type: saved.patient_type,
    },
  };
}

async function prepare_create_appointment(ctx, args) {
  const prev = getDraft(ctx.hospitalId, actorId(ctx));
  const base =
    prev && prev.type === "create_appointment" ? prev.collected || {} : {};
  let collected = mergeCollected(base, {
    name: args.name,
    phone: args.phone,
    doctorName: args.doctorName,
    doctorId: args.doctorId,
    date: args.date,
    time: args.time,
    treatment: args.treatment,
    notes: args.notes,
  });
  collected = await resolveDoctor(ctx, collected);

  if (collected._doctorMatches?.length) {
    setDraft(ctx.hospitalId, actorId(ctx), {
      type: "create_appointment",
      status: "draft",
      collected: { ...collected, _doctorMatches: undefined },
      summary: "Appointment (pick doctor)",
    });
    return {
      status: "incomplete",
      missing: ["doctorName"],
      collected,
      doctorMatches: collected._doctorMatches,
      message:
        "Multiple doctors matched. Ask the user which doctor (by name), then call prepare again with doctorId or exact doctorName.",
    };
  }

  const forMissing = {
    name: collected.name,
    phone: collected.phone,
    doctorName: collected.doctorName || collected.doctor,
    date: collected.date,
    time: collected.time,
  };
  const missing = missingOf(APPOINTMENT_REQUIRED, forMissing);
  if (missing.length || !collected.doctorId) {
    const miss = [...missing];
    if (!collected.doctorId && !miss.includes("doctorName")) {
      miss.push("doctorName");
    }
    setDraft(ctx.hospitalId, actorId(ctx), {
      type: "create_appointment",
      status: "draft",
      collected,
      summary: "Appointment (incomplete)",
    });
    return {
      status: "incomplete",
      missing: [...new Set(miss)],
      collected: forMissing,
      message: `Need required fields: ${[...new Set(miss)].join(", ")}. Ask the user. Do not show Confirm yet.`,
    };
  }

  const payload = {
    name: collected.name,
    fullName: collected.name,
    phone: collected.phone,
    mobile: collected.phone,
    doctor: collected.doctorName,
    doctorName: collected.doctorName,
    doctorId: collected.doctorId,
    appointmentDate: collected.date,
    slotDate: collected.date,
    time: collected.time,
    slotTime: collected.time,
    treatment: collected.treatment || "",
    notes: collected.notes || "",
    status: "scheduled",
    registered_by: ctx.userId || actorId(ctx),
  };
  const summary = `Book **${payload.name}** with **${payload.doctorName}** on **${payload.appointmentDate}** at **${payload.time}** · ${payload.phone}`;
  const entry = setDraft(ctx.hospitalId, actorId(ctx), {
    type: "create_appointment",
    status: "ready",
    collected,
    payload,
    summary,
    payloadPreview: payload,
  });
  return {
    status: "ready",
    pendingAction: {
      id: entry.id,
      type: entry.type,
      summary,
      payloadPreview: payload,
    },
    message:
      "Draft ready. Summarize and wait for user Confirm before saying it's booked.",
  };
}

async function execute_create_appointment(ctx, args) {
  const pending = getByActionId(
    args.actionId,
    ctx.hospitalId,
    actorId(ctx),
  );
  if (
    !pending ||
    pending.type !== "create_appointment" ||
    pending.status !== "ready"
  ) {
    return { error: "No ready appointment draft to execute." };
  }
  const Appointment = ctx.tenantDb.model("Appointment");
  const appt = new Appointment({
    ...pending.payload,
    hospitalId: ctx.hospitalId,
  });
  const saved = await appt.save();
  clearDraft(ctx.hospitalId, actorId(ctx));
  return {
    success: true,
    appointment: {
      id: saved._id,
      name: saved.name,
      phone: saved.phone || saved.mobile,
      doctor: saved.doctorName || saved.doctor,
      date: saved.appointmentDate || saved.slotDate,
      time: saved.time || saved.slotTime,
      status: saved.status,
    },
  };
}

async function prepare_cancel_appointment(ctx, args) {
  const Appointment = ctx.tenantDb.model("Appointment");
  let appt = null;
  if (args.appointmentId) {
    appt = await Appointment.findOne({
      _id: args.appointmentId,
      hospitalId: ctx.hospitalId,
    }).lean();
  } else if (args.patientName) {
    const rx = new RegExp(
      String(args.patientName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
    const filter = {
      hospitalId: ctx.hospitalId,
      name: rx,
      status: { $nin: ["cancelled", "Cancelled", "canceled"] },
    };
    if (args.date) {
      filter.$or = [
        { appointmentDate: args.date },
        { slotDate: args.date },
      ];
    }
    const list = await Appointment.find(filter).limit(5).lean();
    if (list.length === 1) appt = list[0];
    else if (list.length > 1) {
      return {
        status: "incomplete",
        missing: ["appointmentId"],
        matches: list.map((a) => ({
          id: a._id,
          name: a.name,
          date: a.appointmentDate || a.slotDate,
          time: a.time || a.slotTime,
          doctor: a.doctorName || a.doctor,
        })),
        message: "Multiple appointments found. Ask which id to cancel.",
      };
    }
  }

  if (!appt) {
    return {
      status: "incomplete",
      missing: ["appointmentId"],
      message: "Could not find appointment. Ask for appointment id or name+date.",
    };
  }

  const payload = { appointmentId: String(appt._id) };
  const summary = `Cancel appointment for **${appt.name}** with **${appt.doctorName || appt.doctor}** on **${appt.appointmentDate || appt.slotDate}** ${appt.time || appt.slotTime || ""}`;
  const entry = setDraft(ctx.hospitalId, actorId(ctx), {
    type: "cancel_appointment",
    status: "ready",
    collected: payload,
    payload,
    summary,
    payloadPreview: {
      ...payload,
      name: appt.name,
      date: appt.appointmentDate || appt.slotDate,
    },
  });
  return {
    status: "ready",
    pendingAction: {
      id: entry.id,
      type: entry.type,
      summary,
      payloadPreview: entry.payloadPreview,
    },
    message: "Ready to cancel after user Confirm.",
  };
}

async function execute_cancel_appointment(ctx, args) {
  const pending = getByActionId(
    args.actionId,
    ctx.hospitalId,
    actorId(ctx),
  );
  if (
    !pending ||
    pending.type !== "cancel_appointment" ||
    pending.status !== "ready"
  ) {
    return { error: "No ready cancel draft to execute." };
  }
  const Appointment = ctx.tenantDb.model("Appointment");
  const updated = await Appointment.findOneAndUpdate(
    { _id: pending.payload.appointmentId, hospitalId: ctx.hospitalId },
    { status: "cancelled" },
    { new: true },
  ).lean();
  clearDraft(ctx.hospitalId, actorId(ctx));
  if (!updated) return { error: "Appointment not found" };
  return {
    success: true,
    appointment: {
      id: updated._id,
      name: updated.name,
      status: updated.status,
      date: updated.appointmentDate || updated.slotDate,
    },
  };
}

async function prepare_add_note(ctx, args) {
  const prev = getDraft(ctx.hospitalId, actorId(ctx));
  const base = prev && prev.type === "add_note" ? prev.collected || {} : {};
  const collected = mergeCollected(base, {
    patientRef: args.patientRef,
    note: args.note,
    noteType:
      args.noteType ||
      (ctx.role === "Nurse" ? "nurse" : "doctor"),
  });
  const missing = missingOf(NOTE_REQUIRED, collected);
  if (missing.length) {
    setDraft(ctx.hospitalId, actorId(ctx), {
      type: "add_note",
      status: "draft",
      collected,
      summary: "Add note (incomplete)",
    });
    return {
      status: "incomplete",
      missing,
      collected,
      message: `Need: ${missing.join(", ")}. Ask the user.`,
    };
  }

  const resolved = await resolvePatientRef(ctx, collected.patientRef);
  if (!resolved) {
    return {
      status: "incomplete",
      missing: ["patientRef"],
      message: "Patient not found. Ask for a valid UMR.",
    };
  }
  if (resolved.ambiguous) {
    return {
      status: "incomplete",
      missing: ["patientRef"],
      matches: resolved.ambiguous,
      message: "Multiple patients. Ask which UMR.",
    };
  }

  const noteType =
    collected.noteType === "nurse" && NOTE_ROLES.includes(ctx.role)
      ? "nurse"
      : "doctor";
  if (noteType === "nurse" && ctx.role === "Doctor") {
    // doctors write doctor notes by default
  }

  const payload = {
    patientId: String(resolved._id),
    UMRNo: resolved.UMRNo,
    patientName: resolved.name,
    note: collected.note,
    noteType: ctx.role === "Nurse" ? "nurse" : noteType,
    author: ctx.userId || actorId(ctx),
  };
  const summary = `Add ${payload.noteType} note on **${payload.UMRNo}** (${payload.patientName})`;
  const entry = setDraft(ctx.hospitalId, actorId(ctx), {
    type: "add_note",
    status: "ready",
    collected,
    payload,
    summary,
    payloadPreview: {
      UMRNo: payload.UMRNo,
      patientName: payload.patientName,
      noteType: payload.noteType,
      note: payload.note,
    },
  });
  return {
    status: "ready",
    pendingAction: {
      id: entry.id,
      type: entry.type,
      summary,
      payloadPreview: entry.payloadPreview,
    },
    message: "Note draft ready. Wait for Confirm before saying it was saved.",
  };
}

async function execute_add_note(ctx, args) {
  const pending = getByActionId(
    args.actionId,
    ctx.hospitalId,
    actorId(ctx),
  );
  if (!pending || pending.type !== "add_note" || pending.status !== "ready") {
    return { error: "No ready note draft to execute." };
  }
  const Patient = ctx.tenantDb.model("Patient");
  const entry = {
    note: pending.payload.note,
    text: pending.payload.note,
    date: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    doctor: pending.payload.author,
    author: pending.payload.author,
  };
  const field =
    pending.payload.noteType === "nurse" ? "nurseNotes" : "doctorNotes";
  const updated = await Patient.findOneAndUpdate(
    { _id: pending.payload.patientId, hospitalId: ctx.hospitalId },
    { $push: { [field]: entry } },
    { new: true },
  )
    .select("UMRNo name")
    .lean();
  clearDraft(ctx.hospitalId, actorId(ctx));
  if (!updated) return { error: "Patient not found" };
  return {
    success: true,
    patient: { UMRNo: updated.UMRNo, name: updated.name },
    noteType: pending.payload.noteType,
  };
}

/** Load Staff doc for JWT mongo id; prescriptions use staff.custom `id`. */
async function getStaffByMongoId(ctx, mongoId) {
  const Staff = ctx.tenantDb.model("Staff");
  if (!mongoId) return null;
  return Staff.findById(mongoId).select("-password").lean();
}

async function listActiveDoctors(ctx) {
  const Staff = ctx.tenantDb.model("Staff");
  return Staff.find({
    hospitalId: ctx.hospitalId,
    type: "Doctor",
    active: { $ne: false },
  })
    .select("id name specialization department")
    .limit(30)
    .lean();
}

async function resolveConsultantForPrescription(ctx, collected) {
  // Logged-in Doctor → use their staff custom id
  if (ctx.role === "Doctor") {
    const me = await getStaffByMongoId(ctx, ctx.staffMongoId);
    if (!me || !me.id) {
      return {
        error:
          "Could not resolve your doctor staff id. Re-login and try again.",
      };
    }
    return {
      doctorId: me.id,
      doctorName: me.name,
      consultantDoctor: me.name,
    };
  }

  // Nurse / Admin / SuperAdmin → must pick an active doctor
  let doctorId = collected.doctorId;
  let doctorName = collected.doctorName;
  const Staff = ctx.tenantDb.model("Staff");

  if (doctorId) {
    const doc = await Staff.findOne({
      hospitalId: ctx.hospitalId,
      type: "Doctor",
      active: { $ne: false },
      $or: [{ id: doctorId }, { _id: doctorId }],
    })
      .select("id name")
      .lean();
    if (doc) {
      return {
        doctorId: doc.id,
        doctorName: doc.name,
        consultantDoctor: doc.name,
      };
    }
  }

  if (doctorName) {
    const rx = new RegExp(
      String(doctorName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
    const docs = await Staff.find({
      hospitalId: ctx.hospitalId,
      type: "Doctor",
      active: { $ne: false },
      name: rx,
    })
      .select("id name specialization department")
      .limit(8)
      .lean();
    if (docs.length === 1) {
      return {
        doctorId: docs[0].id,
        doctorName: docs[0].name,
        consultantDoctor: docs[0].name,
      };
    }
    if (docs.length > 1) {
      return {
        ambiguous: docs.map((d) => ({
          doctorId: d.id,
          name: d.name,
          specialization: d.specialization,
          department: d.department,
        })),
      };
    }
  }

  const active = await listActiveDoctors(ctx);
  return {
    missingDoctor: true,
    activeDoctors: active.map((d) => ({
      doctorId: d.id,
      name: d.name,
      specialization: d.specialization,
      department: d.department,
    })),
  };
}

async function loadPharmacyCatalog(ctx, limit = 400) {
  try {
    const PharmacyInventory = ctx.tenantDb.model("PharmacyInventory");
    return await PharmacyInventory.find({ hospitalId: ctx.hospitalId })
      .select("description generic_name type item_code name")
      .limit(limit)
      .lean();
  } catch {
    return [];
  }
}

async function loadLabCatalog(ctx, limit = 300) {
  try {
    const LabInventory = ctx.tenantDb.model("LabInventory");
    return await LabInventory.find({ hospitalId: ctx.hospitalId })
      .select("name description test_name code")
      .limit(limit)
      .lean();
  } catch {
    return [];
  }
}

function actorDisplayName(ctx, consultant) {
  return consultant?.consultantDoctor || consultant?.doctorName || ctx.userName || "Doctor";
}

function buildDoctorNotesArray(ctx, consultant, noteText) {
  if (!noteText?.trim()) return [];
  return [
    {
      content: noteText.trim(),
      time: new Date().toISOString(),
      id: ctx.userId || ctx.staffMongoId,
      doctorId: consultant.doctorId,
      doctorName: consultant.consultantDoctor,
    },
  ];
}

async function prepare_create_prescription(ctx, args) {
  const prev = getDraft(ctx.hospitalId, actorId(ctx));
  const base =
    prev && prev.type === "create_prescription" ? prev.collected || {} : {};
  const forceNew =
    args.forceNew === true ||
    String(args.forceNew || "").toLowerCase() === "true" ||
    base.forceNew === true ||
    String(base.forceNew || "").toLowerCase() === "true";

  const collected = mergeCollected(base, {
    patientRef: args.patientRef,
    doctorId: args.doctorId,
    doctorName: args.doctorName,
    symptoms: args.symptoms,
    provisionalDiagnosis: args.provisionalDiagnosis,
    doctorNote: args.doctorNote,
    forceNew: forceNew ? "true" : "",
  });
  if (Array.isArray(args.medicines)) collected._medicines = args.medicines;
  if (Array.isArray(args.labTests)) collected._labTests = args.labTests;

  const missing = missingOf(PRESCRIPTION_REQUIRED, collected);
  if (missing.length) {
    setDraft(ctx.hospitalId, actorId(ctx), {
      type: "create_prescription",
      status: "draft",
      collected,
      summary: "Visit prescription (incomplete)",
    });
    return {
      status: "incomplete",
      missing,
      collected,
      message:
        "Need patient UMR (patientRef). Ask the user. Prefer prepare_update_prescription if they already have today's visit.",
    };
  }

  const resolved = await resolvePatientRef(ctx, collected.patientRef);
  if (!resolved) {
    return {
      status: "incomplete",
      missing: ["patientRef"],
      message: "Patient not found. Ask for a valid UMR.",
    };
  }
  if (resolved.ambiguous) {
    return {
      status: "incomplete",
      missing: ["patientRef"],
      matches: resolved.ambiguous,
      message: "Multiple patients. Ask which UMR.",
    };
  }

  const consultant = await resolveConsultantForPrescription(ctx, collected);
  if (consultant.error) {
    return { status: "incomplete", missing: ["doctorId"], message: consultant.error };
  }
  if (consultant.ambiguous) {
    setDraft(ctx.hospitalId, actorId(ctx), {
      type: "create_prescription",
      status: "draft",
      collected,
      summary: "Visit prescription (pick doctor)",
    });
    return {
      status: "incomplete",
      missing: ["doctorId"],
      doctorMatches: consultant.ambiguous,
      message:
        "Multiple doctors matched. Ask which consultant (name or doctorId), then prepare again.",
    };
  }
  if (consultant.missingDoctor) {
    setDraft(ctx.hospitalId, actorId(ctx), {
      type: "create_prescription",
      status: "draft",
      collected,
      summary: "Visit prescription (need doctor)",
    });
    return {
      status: "incomplete",
      missing: ["doctorId", "doctorName"],
      activeDoctors: consultant.activeDoctors,
      message:
        "You are not logged in as a Doctor. Ask the user to pick a consultant from activeDoctors (doctorId or exact name), then call prepare_create_prescription again.",
    };
  }

  const pageRxId = ctx.pageContext?.prescriptionId;
  const reusable = findReusableVisit(resolved.prescriptions || [], {
    doctorId: consultant.doctorId,
    consultantDoctor: consultant.consultantDoctor,
    prescriptionId: pageRxId,
  });

  if (reusable && !forceNew) {
    const existingSummary = summarizeVisit({
      ...reusable,
      UMRNo: resolved.UMRNo,
    });
    const hasContent =
      (collected._medicines || args.medicines || []).length > 0 ||
      (collected._labTests || args.labTests || []).length > 0 ||
      !!(collected.doctorNote || args.doctorNote)?.trim() ||
      !!(collected.symptoms || args.symptoms)?.trim() ||
      !!(collected.provisionalDiagnosis || args.provisionalDiagnosis)?.trim();

    // Doctor already dictated meds/labs — seamlessly update today's visit
    if (hasContent) {
      return prepare_update_prescription(ctx, {
        patientRef: resolved.UMRNo,
        prescriptionId: reusable.prescriptionId,
        doctorId: consultant.doctorId,
        doctorName: consultant.doctorName,
        doctorNote: collected.doctorNote || args.doctorNote,
        symptoms: collected.symptoms || args.symptoms,
        provisionalDiagnosis:
          collected.provisionalDiagnosis || args.provisionalDiagnosis,
        medicines: collected._medicines || args.medicines,
        labTests: collected._labTests || args.labTests,
        applyMode: "add",
      });
    }

    setDraft(ctx.hospitalId, actorId(ctx), {
      type: "create_prescription",
      status: "draft",
      collected,
      summary: "Visit already exists today — reuse or force new",
    });
    return {
      status: "reuse_available",
      existingVisit: existingSummary,
      openPath: `/consultation/${resolved.UMRNo}/prescription/${reusable.prescriptionId}`,
      message:
        "Patient already has a visit prescription today. Do NOT create another. Tell the user briefly what exists, then either: (1) call prepare_update_prescription with this prescriptionId and their medicines/labs/note, or (2) if they explicitly want a separate new visit, call prepare_create_prescription again with forceNew:true.",
      suggestedNext: [
        {
          tool: "prepare_update_prescription",
          prescriptionId: reusable.prescriptionId,
          patientRef: resolved.UMRNo,
        },
      ],
    };
  }

  const latest =
    sortVisitsNewestFirst(resolved.prescriptions || [])[0] || null;

  const [pharmacyData, labData] = await Promise.all([
    loadPharmacyCatalog(ctx),
    loadLabCatalog(ctx),
  ]);
  const actorName = actorDisplayName(ctx, consultant);
  const { toAdd, toStop } = processMedicinesForRx(
    collected._medicines || args.medicines || [],
    pharmacyData,
    actorName,
  );
  // stops on brand-new visit are no-ops; ignore
  void toStop;
  const labs = processLabsForRx(
    collected._labTests || args.labTests || [],
    labData,
  );
  const doctorNotes = buildDoctorNotesArray(
    ctx,
    consultant,
    collected.doctorNote || args.doctorNote,
  );

  const prescriptionId = Math.random().toString().slice(2, 14);
  const prescription = {
    doctorId: consultant.doctorId,
    consultantDoctor: consultant.consultantDoctor,
    symptoms: collected.symptoms || "",
    doctorNotes,
    nurseNotes: [],
    vitals: [],
    weight: latest?.weight || "",
    height: latest?.height || "",
    pastMedicalHistory: "",
    provisionalDiagnosis: collected.provisionalDiagnosis || "",
    prescriptionId,
    UMRNo: resolved.UMRNo,
    medicineData: toAdd,
    diagnosticData: labs,
    date: new Date().toISOString(),
  };

  const payload = {
    patientId: String(resolved._id),
    UMRNo: resolved.UMRNo,
    patientName: resolved.name,
    prescription,
  };

  const medPreview = formatMedicinePreview(toAdd);
  const labPreview = labs
    .map((t) => t.name || t.description || t.test_name)
    .filter(Boolean)
    .slice(0, 8);
  const summaryParts = [
    `Create visit prescription for **${resolved.UMRNo}** (${resolved.name}) · consultant **${consultant.consultantDoctor}**`,
  ];
  if (medPreview.length) summaryParts.push(`Medicines: ${medPreview.join("; ")}`);
  if (labPreview.length) summaryParts.push(`Labs: ${labPreview.join(", ")}`);
  if (forceNew && reusable) {
    summaryParts.push("(forced new visit — existing today visit kept)");
  }
  const summary = summaryParts.join(" · ");

  const entry = setDraft(ctx.hospitalId, actorId(ctx), {
    type: "create_prescription",
    status: "ready",
    collected: {
      ...collected,
      doctorId: consultant.doctorId,
      doctorName: consultant.doctorName,
      forceNew: forceNew ? "true" : "",
    },
    payload,
    summary,
    payloadPreview: {
      UMRNo: resolved.UMRNo,
      patientName: resolved.name,
      consultantDoctor: consultant.consultantDoctor,
      doctorId: consultant.doctorId,
      prescriptionId,
      medicines: medPreview,
      labs: labPreview,
      forceNew: !!forceNew,
    },
  });

  return {
    status: "ready",
    pendingAction: {
      id: entry.id,
      type: entry.type,
      summary,
      payloadPreview: entry.payloadPreview,
    },
    message:
      "Draft ready. Summarize medicines/labs and wait for Confirm. After create, offer to open the prescription.",
  };
}

async function execute_create_prescription(ctx, args) {
  const pending = getByActionId(
    args.actionId,
    ctx.hospitalId,
    actorId(ctx),
  );
  if (
    !pending ||
    pending.type !== "create_prescription" ||
    pending.status !== "ready"
  ) {
    return { error: "No ready prescription draft to execute." };
  }

  const Patient = ctx.tenantDb.model("Patient");
  const Prescription = ctx.tenantDb.model("Prescription");
  const patient = await Patient.findOne({
    _id: pending.payload.patientId,
    hospitalId: ctx.hospitalId,
  });
  if (!patient) {
    return { error: "Patient not found" };
  }

  const newRx = pending.payload.prescription;
  const existingList = await Prescription.find({
    hospitalId: ctx.hospitalId,
    $or: [{ patientId: patient._id }, { UMRNo: patient.UMRNo }],
  })
    .sort({ createdAt: -1 })
    .lean();

  const already = existingList.find(
    (rx) => String(rx.prescriptionId) === String(newRx.prescriptionId),
  );
  if (already) {
    clearDraft(ctx.hospitalId, actorId(ctx));
    const path = `/consultation/${patient.UMRNo}/prescription/${already.prescriptionId}`;
    const completionGaps = analyzePrescriptionGaps({
      ...already,
      UMRNo: patient.UMRNo,
    });
    return {
      success: true,
      alreadyExisted: true,
      prescription: {
        prescriptionId: already.prescriptionId,
        UMRNo: patient.UMRNo,
        patientName: patient.name,
        consultantDoctor: already.consultantDoctor,
        doctorId: already.doctorId,
        date: already.date,
        openPath: path,
        medicineCount: (already.medicineData || []).length,
        labCount: (already.diagnosticData || []).length,
        completionGaps,
        completionNudge: formatCompletionNudge(completionGaps).text,
      },
    };
  }

  // Re-check same-day reuse unless forceNew was set on the draft
  const forceNew =
    pending.collected?.forceNew === true ||
    String(pending.collected?.forceNew || "").toLowerCase() === "true";
  if (!forceNew) {
    const reusable = findReusableVisit(existingList, {
      doctorId: newRx.doctorId,
      consultantDoctor: newRx.consultantDoctor,
    });
    if (reusable) {
      clearDraft(ctx.hospitalId, actorId(ctx));
      return {
        error:
          "A visit prescription already exists for today. Open/update that visit instead of creating another.",
        existingVisit: summarizeVisit({ ...reusable, UMRNo: patient.UMRNo }),
        openPath: `/consultation/${patient.UMRNo}/prescription/${reusable.prescriptionId}`,
      };
    }
  }

  await Prescription.create({
    ...newRx,
    hospitalId: ctx.hospitalId,
    patientId: patient._id,
    UMRNo: patient.UMRNo,
    doctorName: newRx.doctorName || newRx.consultantDoctor || "",
    consultantDoctor: newRx.consultantDoctor || newRx.doctorName || "",
    pharmacyStatus: newRx.pharmacyStatus || "pending",
  });
  clearDraft(ctx.hospitalId, actorId(ctx));

  const path = `/consultation/${patient.UMRNo}/prescription/${newRx.prescriptionId}`;
  const completionGaps = analyzePrescriptionGaps({
    ...newRx,
    UMRNo: patient.UMRNo,
  });
  const nudge = formatCompletionNudge(completionGaps);
  return {
    success: true,
    prescription: {
      prescriptionId: newRx.prescriptionId,
      UMRNo: patient.UMRNo,
      patientName: patient.name,
      consultantDoctor: newRx.consultantDoctor,
      doctorId: newRx.doctorId,
      date: newRx.date,
      openPath: path,
      medicineCount: (newRx.medicineData || []).length,
      labCount: (newRx.diagnosticData || []).length,
      medicines: formatMedicinePreview(newRx.medicineData || []),
      labs: (newRx.diagnosticData || [])
        .map((t) => t.name || t.description)
        .filter(Boolean)
        .slice(0, 8),
      completionGaps,
      completionNudge: nudge.text,
    },
  };
}

async function prepare_update_prescription(ctx, args) {
  const prev = getDraft(ctx.hospitalId, actorId(ctx));
  const base =
    prev && prev.type === "update_prescription" ? prev.collected || {} : {};
  const collected = mergeCollected(base, {
    patientRef: args.patientRef || ctx.pageContext?.umr,
    prescriptionId: args.prescriptionId || ctx.pageContext?.prescriptionId,
    doctorId: args.doctorId,
    doctorName: args.doctorName,
    doctorNote: args.doctorNote,
    symptoms: args.symptoms,
    provisionalDiagnosis: args.provisionalDiagnosis,
    weight: args.weight,
    height: args.height,
    applyMode: args.applyMode || base.applyMode || "add",
  });
  if (Array.isArray(args.medicines)) collected._medicines = args.medicines;
  if (Array.isArray(args.medicinesToStop)) {
    collected._medicinesToStop = args.medicinesToStop;
  }
  if (Array.isArray(args.labTests)) collected._labTests = args.labTests;
  if (args.vitals && typeof args.vitals === "object") {
    collected._vitals = args.vitals;
  }

  if (!collected.patientRef) {
    setDraft(ctx.hospitalId, actorId(ctx), {
      type: "update_prescription",
      status: "draft",
      collected,
      summary: "Update prescription (need patient)",
    });
    return {
      status: "incomplete",
      missing: ["patientRef"],
      message:
        "Need patient UMR. If the user is already on a prescription page, pageContext may supply umr/prescriptionId — ask for UMR if still missing.",
    };
  }

  const resolved = await resolvePatientRef(ctx, collected.patientRef);
  if (!resolved) {
    return {
      status: "incomplete",
      missing: ["patientRef"],
      message: "Patient not found. Ask for a valid UMR.",
    };
  }
  if (resolved.ambiguous) {
    return {
      status: "incomplete",
      missing: ["patientRef"],
      matches: resolved.ambiguous,
      message: "Multiple patients. Ask which UMR.",
    };
  }

  const consultant = await resolveConsultantForPrescription(ctx, collected);
  if (consultant.error) {
    return { status: "incomplete", missing: ["doctorId"], message: consultant.error };
  }
  if (consultant.ambiguous) {
    return {
      status: "incomplete",
      missing: ["doctorId"],
      doctorMatches: consultant.ambiguous,
      message: "Multiple doctors matched. Ask which consultant.",
    };
  }
  if (consultant.missingDoctor) {
    return {
      status: "incomplete",
      missing: ["doctorId", "doctorName"],
      activeDoctors: consultant.activeDoctors,
      message: "Pick a consultant (doctorId or name), then prepare_update_prescription again.",
    };
  }

  const visits = resolved.prescriptions || [];
  if (!visits.length) {
    return {
      status: "incomplete",
      missing: ["create_first"],
      message:
        "No visit prescription exists yet. Call prepare_create_prescription with the same medicines/labs/note (and patientRef) instead.",
      redirectToCreate: true,
    };
  }

  const { visit, reason, wantedId } = findTargetVisit(visits, {
    prescriptionId: collected.prescriptionId,
    doctorId: consultant.doctorId,
    consultantDoctor: consultant.consultantDoctor,
    pagePrescriptionId: ctx.pageContext?.prescriptionId,
  });

  if (!visit) {
    return {
      status: "incomplete",
      missing: ["prescriptionId"],
      wantedId,
      recentVisits: sortVisitsNewestFirst(visits)
        .slice(0, 5)
        .map((rx) => summarizeVisit({ ...rx, UMRNo: resolved.UMRNo })),
      message:
        "Could not find that prescriptionId. Ask which visit to update, or create a new one.",
    };
  }

  const medicinesIn = [
    ...(collected._medicines || args.medicines || []),
    ...((collected._medicinesToStop || args.medicinesToStop || []).map((m) => ({
      name: typeof m === "string" ? m : m.name,
      action: "stop",
    }))),
  ];
  const labsIn = collected._labTests || args.labTests || [];
  const vitalsIn = collected._vitals || args.vitals || null;
  const hasMeds = medicinesIn.length > 0;
  const hasLabs = labsIn.length > 0;
  const hasNote = !!(collected.doctorNote || args.doctorNote)?.trim();
  const hasSymptoms = !!(collected.symptoms || args.symptoms)?.trim();
  const hasDx = !!(collected.provisionalDiagnosis || args.provisionalDiagnosis)?.trim();
  const hasWeight = !!(collected.weight || args.weight)?.trim();
  const hasHeight = !!(collected.height || args.height)?.trim();
  const hasVitals = !!(vitalsIn && typeof vitalsIn === "object");

  if (
    !hasMeds &&
    !hasLabs &&
    !hasNote &&
    !hasSymptoms &&
    !hasDx &&
    !hasWeight &&
    !hasHeight &&
    !hasVitals
  ) {
    const gaps = analyzePrescriptionGaps({ ...visit, UMRNo: resolved.UMRNo });
    setDraft(ctx.hospitalId, actorId(ctx), {
      type: "update_prescription",
      status: "draft",
      collected: {
        ...collected,
        prescriptionId: visit.prescriptionId,
        doctorId: consultant.doctorId,
        doctorName: consultant.doctorName,
      },
      summary: "Update prescription (need changes)",
    });
    return {
      status: "incomplete",
      missing: ["medicines_or_labs_or_note_or_vitals"],
      targetVisit: summarizeVisit({ ...visit, UMRNo: resolved.UMRNo }),
      completionGaps: gaps,
      openPath: `/consultation/${resolved.UMRNo}/prescription/${visit.prescriptionId}`,
      message:
        `Target visit **${visit.prescriptionId}** selected (${reason}). Ask what to complete — medicines, labs, note, weight/height, or vitals — then call prepare_update_prescription again.`,
    };
  }

  const [pharmacyData, labData] = await Promise.all([
    loadPharmacyCatalog(ctx),
    loadLabCatalog(ctx),
  ]);
  const actorName = actorDisplayName(ctx, consultant);
  const applyMode =
    String(collected.applyMode || args.applyMode || "add").toLowerCase() ===
    "replace"
      ? "replace"
      : "add";

  const { toAdd, toStop } = processMedicinesForRx(
    medicinesIn,
    pharmacyData,
    actorName,
  );
  const labs = processLabsForRx(labsIn, labData);

  let nextMedicines = visit.medicineData || [];
  if (toStop.length) {
    nextMedicines = applyStopMedicines(nextMedicines, toStop, actorName);
  }
  if (toAdd.length || applyMode === "replace") {
    nextMedicines = mergeMedicines(nextMedicines, toAdd, applyMode);
  }

  let nextLabs = visit.diagnosticData || [];
  if (labs.length || applyMode === "replace") {
    nextLabs = mergeTests(nextLabs, labs, applyMode);
  }

  let nextDoctorNotes = [...(visit.doctorNotes || [])];
  const noteText = (collected.doctorNote || args.doctorNote || "").trim();
  if (noteText) {
    const existingIdx = nextDoctorNotes.findIndex(
      (n) =>
        String(n.doctorId || n.id) === String(consultant.doctorId) ||
        String(n.id) === String(ctx.userId),
    );
    if (existingIdx >= 0) {
      const prevContent = nextDoctorNotes[existingIdx].content || "";
      nextDoctorNotes[existingIdx] = {
        ...nextDoctorNotes[existingIdx],
        content: mergeNoteText(prevContent, noteText, applyMode),
        time: new Date().toISOString(),
        doctorId: consultant.doctorId,
        doctorName: consultant.consultantDoctor,
      };
    } else {
      nextDoctorNotes.push({
        content: noteText,
        time: new Date().toISOString(),
        id: ctx.userId || ctx.staffMongoId,
        doctorId: consultant.doctorId,
        doctorName: consultant.consultantDoctor,
      });
    }
  }

  const nextSymptoms =
    collected.symptoms || args.symptoms
      ? String(collected.symptoms || args.symptoms)
      : visit.symptoms || "";
  const nextDx =
    collected.provisionalDiagnosis || args.provisionalDiagnosis
      ? String(collected.provisionalDiagnosis || args.provisionalDiagnosis)
      : visit.provisionalDiagnosis || "";

  const vitalsEntry = buildVitalsEntry(vitalsIn, actorName);
  let nextVitals = [...(visit.vitals || [])];
  if (vitalsEntry) nextVitals = [...nextVitals, vitalsEntry];

  const nextWeight =
    String(collected.weight || args.weight || vitalsEntry?.weight || "").trim() ||
    visit.weight ||
    "";
  const nextHeight =
    String(collected.height || args.height || vitalsEntry?.height || "").trim() ||
    visit.height ||
    "";

  const stoppedNames = toStop.map((m) => m.name || m.correctedName).filter(Boolean);
  const addedPreview = formatMedicinePreview(toAdd);
  const labPreview = labs
    .map((t) => t.name || t.description || t.test_name)
    .filter(Boolean);

  const projectedRx = {
    ...visit,
    UMRNo: resolved.UMRNo,
    medicineData: nextMedicines,
    diagnosticData: nextLabs,
    doctorNotes: nextDoctorNotes,
    symptoms: nextSymptoms,
    provisionalDiagnosis: nextDx,
    vitals: nextVitals,
    weight: nextWeight,
    height: nextHeight,
  };

  const payload = {
    patientId: String(resolved._id),
    UMRNo: resolved.UMRNo,
    patientName: resolved.name,
    prescriptionId: visit.prescriptionId,
    patch: {
      medicineData: nextMedicines,
      diagnosticData: nextLabs,
      doctorNotes: nextDoctorNotes,
      symptoms: nextSymptoms,
      provisionalDiagnosis: nextDx,
      vitals: nextVitals,
      weight: nextWeight,
      height: nextHeight,
    },
  };

  const summaryBits = [
    `Update visit **${visit.prescriptionId}** for **${resolved.UMRNo}** (${resolved.name})`,
  ];
  if (addedPreview.length) {
    summaryBits.push(
      `${applyMode === "replace" ? "Set medicines" : "Add"}: ${addedPreview.join("; ")}`,
    );
  }
  if (stoppedNames.length) {
    summaryBits.push(`Stop: ${stoppedNames.join(", ")}`);
  }
  if (labPreview.length) {
    summaryBits.push(
      `${applyMode === "replace" ? "Set labs" : "Add labs"}: ${labPreview.join(", ")}`,
    );
  }
  if (noteText) summaryBits.push("Update doctor note");
  if (hasWeight || vitalsEntry?.weight) {
    summaryBits.push(`Weight: ${nextWeight}`);
  }
  if (hasHeight || vitalsEntry?.height) {
    summaryBits.push(`Height: ${nextHeight}`);
  }
  if (vitalsEntry) {
    const vBits = [
      vitalsEntry.bloodPressure && `BP ${vitalsEntry.bloodPressure}`,
      vitalsEntry.heartRate && `pulse ${vitalsEntry.heartRate}`,
      vitalsEntry.temperature && `temp ${vitalsEntry.temperature}`,
      vitalsEntry.spo2 && `SpO2 ${vitalsEntry.spo2}`,
      vitalsEntry.respiratoryRate && `RR ${vitalsEntry.respiratoryRate}`,
    ].filter(Boolean);
    if (vBits.length) summaryBits.push(`Vitals: ${vBits.join(", ")}`);
  }
  if (reason === "latest_same_doctor" || reason === "latest_any") {
    summaryBits.push(`(using ${reason.replace(/_/g, " ")} visit)`);
  }
  const summary = summaryBits.join(" · ");

  const entry = setDraft(ctx.hospitalId, actorId(ctx), {
    type: "update_prescription",
    status: "ready",
    collected: {
      ...collected,
      prescriptionId: visit.prescriptionId,
      doctorId: consultant.doctorId,
      doctorName: consultant.doctorName,
      applyMode,
    },
    payload,
    summary,
    payloadPreview: {
      UMRNo: resolved.UMRNo,
      patientName: resolved.name,
      prescriptionId: visit.prescriptionId,
      applyMode,
      addMedicines: addedPreview,
      stopMedicines: stoppedNames,
      labs: labPreview,
      doctorNote: noteText ? noteText.slice(0, 200) : undefined,
      weight: nextWeight || undefined,
      height: nextHeight || undefined,
      vitals: vitalsEntry
        ? {
            bloodPressure: vitalsEntry.bloodPressure || undefined,
            heartRate: vitalsEntry.heartRate || undefined,
            temperature: vitalsEntry.temperature || undefined,
            spo2: vitalsEntry.spo2 || undefined,
            respiratoryRate: vitalsEntry.respiratoryRate || undefined,
          }
        : undefined,
      medicineCountAfter: nextMedicines.filter((m) => m.isActive !== false)
        .length,
      labCountAfter: nextLabs.length,
      openPath: `/consultation/${resolved.UMRNo}/prescription/${visit.prescriptionId}`,
      targetReason: reason,
      stillMissingAfter: analyzePrescriptionGaps(projectedRx).map((g) => g.label),
    },
  });

  return {
    status: "ready",
    pendingAction: {
      id: entry.id,
      type: entry.type,
      summary,
      payloadPreview: entry.payloadPreview,
    },
    message:
      "Draft ready. Summarize the planned changes and wait for Confirm. Do not claim saved yet.",
  };
}

async function execute_update_prescription(ctx, args) {
  const pending = getByActionId(
    args.actionId,
    ctx.hospitalId,
    actorId(ctx),
  );
  if (
    !pending ||
    pending.type !== "update_prescription" ||
    pending.status !== "ready"
  ) {
    return { error: "No ready prescription update draft to execute." };
  }

  const Patient = ctx.tenantDb.model("Patient");
  const Prescription = ctx.tenantDb.model("Prescription");
  const patient = await Patient.findOne({
    _id: pending.payload.patientId,
    hospitalId: ctx.hospitalId,
  });
  if (!patient) return { error: "Patient not found" };

  const rxId = pending.payload.prescriptionId;
  const current = await Prescription.findOne({
    hospitalId: ctx.hospitalId,
    prescriptionId: rxId,
  });
  if (!current) {
    return {
      error: "Visit prescription no longer exists. Create a new visit first.",
    };
  }

  const patch = pending.payload.patch || {};
  const updated = await Prescription.findOneAndUpdate(
    { _id: current._id },
    {
      $set: {
        medicineData: patch.medicineData ?? current.medicineData,
        diagnosticData: patch.diagnosticData ?? current.diagnosticData,
        doctorNotes: patch.doctorNotes ?? current.doctorNotes,
        symptoms:
          patch.symptoms !== undefined ? patch.symptoms : current.symptoms,
        provisionalDiagnosis:
          patch.provisionalDiagnosis !== undefined
            ? patch.provisionalDiagnosis
            : current.provisionalDiagnosis,
        vitals: patch.vitals ?? current.vitals,
        weight: patch.weight !== undefined ? patch.weight : current.weight,
        height: patch.height !== undefined ? patch.height : current.height,
      },
    },
    { new: true },
  ).lean();
  clearDraft(ctx.hospitalId, actorId(ctx));

  const path = `/consultation/${patient.UMRNo}/prescription/${rxId}`;
  const completionGaps = analyzePrescriptionGaps({
    ...updated,
    UMRNo: patient.UMRNo,
  });
  const nudge = formatCompletionNudge(completionGaps);
  return {
    success: true,
    updated: true,
    prescription: {
      prescriptionId: rxId,
      UMRNo: patient.UMRNo,
      patientName: patient.name,
      consultantDoctor: updated.consultantDoctor,
      doctorId: updated.doctorId,
      date: updated.date,
      openPath: path,
      medicineCount: (updated.medicineData || []).filter(
        (m) => m.isActive !== false,
      ).length,
      labCount: (updated.diagnosticData || []).length,
      medicines: formatMedicinePreview(
        (updated.medicineData || []).filter((m) => m.isActive !== false),
      ),
      labs: (updated.diagnosticData || [])
        .map((t) => t.name || t.description)
        .filter(Boolean)
        .slice(0, 8),
      weight: updated.weight || "",
      height: updated.height || "",
      preview: pending.payloadPreview,
      completionGaps,
      completionNudge: nudge.text,
    },
  };
}

async function executeReadyAction(ctx, actionId) {
  const pending = getByActionId(actionId, ctx.hospitalId, actorId(ctx));
  if (!pending || pending.status !== "ready") {
    return {
      error: "Pending action missing, expired, or not ready.",
    };
  }
  const map = {
    register_patient: execute_register_patient,
    create_appointment: execute_create_appointment,
    cancel_appointment: execute_cancel_appointment,
    add_note: execute_add_note,
    create_prescription: execute_create_prescription,
    update_prescription: execute_update_prescription,
  };
  const fn = map[pending.type];
  if (!fn) return { error: `Unknown action type ${pending.type}` };
  return fn(ctx, { actionId });
}

const ACTION_HANDLERS = {
  prepare_register_patient,
  execute_register_patient,
  prepare_create_appointment,
  execute_create_appointment,
  prepare_cancel_appointment,
  execute_cancel_appointment,
  prepare_add_note,
  execute_add_note,
  prepare_create_prescription,
  execute_create_prescription,
  prepare_update_prescription,
  execute_update_prescription,
};

module.exports = {
  ACTION_ROLE_ACCESS,
  ACTION_TOOL_DEFINITIONS,
  ACTION_HANDLERS,
  executeReadyAction,
  actorId,
};
