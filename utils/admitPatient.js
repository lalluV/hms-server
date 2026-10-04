const mongoose = require("mongoose");
const {
  pickPerson,
  assignPersonEdits,
  presentPatient,
  normalizeName,
} = require("./patientFields");

const { claimBed, releaseBed } = require("./bedAllocation");
const { localYmd, localHm } = require("./localDate");

const isDuplicateKey = (error) => error?.code === 11000;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Exact ER note. Accepts ernote, or the form note field during the switch. */
function eraNoteFromBody(body) {
  if (!body || typeof body !== "object") return undefined;
  if (body.ernote !== undefined && body.ernote !== null) {
    return String(body.ernote);
  }
  if (body.chiefComplaintsPresentIllnessHistory !== undefined) {
    return String(body.chiefComplaintsPresentIllnessHistory || "");
  }
  return undefined;
}

const ERA_NOTE_UNSET = {
  chiefComplaintsPresentIllnessHistory: "",
  systemicExamination: "",
  provisionalDiagnosis: "",
};

function personalHistoryFromBody(body) {
  const source = body?.personalHistory || {};
  return {
    alcohol: Boolean(source.alcohol),
    smoking: Boolean(source.smoking),
    illicitDrugs: Boolean(source.illicitDrugs),
    habitsNil: Boolean(source.habitsNil),
    other: String(source.other || ""),
    maritalStatus: String(source.maritalStatus || ""),
    familyHistory: String(source.familyHistory || ""),
  };
}

/** Frozen copy of the treatment list written with this ERA save. */
function casualtyTreatmentFromBody(body) {
  const treatment = Array.isArray(body?.treatment) ? body.treatment : [];
  if (treatment.length) return cloneJson(treatment);
  return Array.isArray(body?.casualtyTreatment) ? body.casualtyTreatment : [];
}

/** Sequential per-hospital, per-year IP number from the tenant Counter. */
async function nextIpNumber(tenantDb, IPAdmission, hospitalId) {
  const Counter = tenantDb.model("Counter");
  const year = localYmd().slice(0, 4);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const counter = await Counter.findByIdAndUpdate(
      { _id: `IP-${hospitalId}-${year}` },
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );
    const ipNumber = `IP-${year}-${String(counter.seq).padStart(4, "0")}`;
    // Legacy random IP numbers share this range; skip any already taken.
    const exists = await IPAdmission.exists({ hospitalId, ipNumber });
    if (!exists) return ipNumber;
  }
  return `IP-${year}-${Date.now()}`;
}

function eraVitalFromBody(body) {
  const list = Array.isArray(body?.vitals) ? body.vitals : [];
  const entry = list.find((row) => row?.source === "era") || list[0];
  if (!entry || typeof entry !== "object") return null;
  const hasReading = [
    "temperature",
    "spo2",
    "heartRate",
    "respiratoryRate",
    "bloodPressure",
    "grbs",
    "urineOutput",
    "outputUrine",
  ].some((key) => String(entry[key] || "").trim());
  if (!hasReading) return null;
  return { ...entry, source: "era" };
}

function mergeEraVital(existing, entry) {
  if (!entry) return Array.isArray(existing) ? existing : [];
  const list = Array.isArray(existing) ? [...existing] : [];
  const index = list.findIndex((row) => row?.source === "era");
  if (index >= 0) list[index] = { ...list[index], ...entry, source: "era" };
  else list.unshift(entry);
  return list;
}

function stayPayload(body, patient, hospitalId, ipNumber) {
  const admissionDate = body.admissionDate || localYmd();
  const admissionTime = body.admissionTime || localHm();
  const status = body.patient_status || "Admitted";
  const wardId = body.wardId || "";
  const wardName = body.wardName || "";
  const transfers = Array.isArray(body.transfers)
    ? body.transfers
    : wardId || wardName
      ? [
          {
            wardId,
            wardName,
            price: Number(body.bedPrice || 0),
            transferDate: admissionDate,
          },
        ]
      : [];

  const doc = {
    ipNumber,
    hospitalId,
    patientId: patient._id,
    UMRNo: patient.UMRNo,
    patientName: patient.name,
    admissionDate,
    admissionTime,
    mlcNo: body.mlcNo || "",
    patient_status: status,
    consultantDoctor: String(body.consultantDoctor || "").trim(),
    doctorId: String(body.doctorId || "").trim(),
    medicalOfficerName: body.medicalOfficerName || "",
    medicalOfficerId: body.medicalOfficerId || "",
    patientRepresentiveOfficer: body.patientRepresentiveOfficer || "",
    consultantHistory: Array.isArray(body.consultantHistory)
      ? body.consultantHistory
      : [],
    wardName,
    wardId,
    selectedBed: body.selectedBed || "",
    transfers,
    ernote: eraNoteFromBody(body) || "",
    consciousness: body.consciousness || "",
    gcs: body.gcs || "",
    pupils: body.pupils || "",
    height: body.height || "",
    weight: body.weight || "",
    personalHistory: personalHistoryFromBody(body),
    vitals: Array.isArray(body.vitals) ? body.vitals : [],
    eraVitalEntry: eraVitalFromBody(body),
    doctorNotes: Array.isArray(body.doctorNotes) ? body.doctorNotes : [],
    nurseNotes: Array.isArray(body.nurseNotes) ? body.nurseNotes : [],
    insulinChart: Array.isArray(body.insulinChart) ? body.insulinChart : [],
    investigations: Array.isArray(body.investigations) ? body.investigations : [],
    procedures: Array.isArray(body.procedures) ? body.procedures : [],
    treatment: Array.isArray(body.treatment) ? body.treatment : [],
    casualtyTreatment: casualtyTreatmentFromBody(body),
    casualtyInvestigations: Array.isArray(body.investigations)
      ? body.investigations
      : [],
    counselling: body.counselling || "",
    dischargeOrders: body.dischargeOrders || "",
    paymentMethod: body.paymentMethod || "Personal",
    insurance_provider: body.insurance_provider || "",
    insurance_providerId: body.insurance_providerId || "",
    policy_number: body.policy_number || "",
    coPayPercentage: body.coPayPercentage ?? 0,
    coPayLimit: body.coPayLimit ?? 0,
    coPayType: body.coPayType || "percentage",
    coverage: body.coverage || "",
    expiry_date: body.expiry_date || "",
    claimNumber: body.claimNumber || "",
    preAuthAmount: body.preAuthAmount || 0,
    commissionEarnerType: body.commissionEarnerType,
    commissionEarnerId: body.commissionEarnerId,
    commissionEarnerName: body.commissionEarnerName,
    commissionRates: body.commissionRates,
  };

  if (status === "Refused Admission") {
    doc.dischargeTo = body.dischargeTo || "";
  }
  return doc;
}

async function findPatient(Patient, hospitalId, body) {
  const patientId = body.patientId;
  if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
    const byId = await Patient.findOne({ _id: patientId, hospitalId });
    if (byId) return byId;
  }
  const umr = String(body.UMRNo || body.sourceUmr || "").trim();
  if (umr) {
    return Patient.findOne({ UMRNo: umr, hospitalId });
  }
  return null;
}

async function findNamePhoneMatches(Patient, hospitalId, body) {
  const phone = String(body.phone || "").replace(/\D/g, "");
  const name = normalizeName(body.name);
  if (!phone || !name) return [];
  const rows = await Patient.find({ hospitalId, phone }).limit(25);
  return rows.filter((row) => normalizeName(row.name) === name);
}

/**
 * Admit an existing person, or create the person and the stay together.
 * A second patient is never created for someone already on file.
 * An open stay is returned instead of inserting another admission.
 */
async function admitPatient({ tenantDb, hospitalId, body }) {
  const Patient = tenantDb.model("Patient");
  const IPAdmission = tenantDb.model("IPAdmission");
  const payload = body || {};

  const doctorId = String(payload.doctorId || "").trim();
  const consultantDoctor = String(payload.consultantDoctor || "").trim();
  if (!doctorId || !consultantDoctor) {
    return {
      httpStatus: 400,
      payload: { message: "Consultant doctor is required" },
    };
  }

  let patient = await findPatient(Patient, hospitalId, payload);
  let createdPatient = false;

  if (!patient) {
    const matches = await findNamePhoneMatches(Patient, hospitalId, payload);
    if (matches.length && payload.confirmNew !== true) {
      return {
        httpStatus: 409,
        payload: {
          code: "MATCHING_PATIENT",
          message: "A patient with this name and phone is already on file",
          matches: matches.map((row) => ({
            _id: row._id,
            UMRNo: row.UMRNo,
            name: row.name,
            age: row.age,
            gender: row.gender,
            phone: row.phone,
          })),
        },
      };
    }
    patient = new Patient(
      pickPerson(payload, {
        hospitalId,
        registration_date:
          payload.registration_date || new Date().toISOString(),
      }),
    );
    await patient.save();
    createdPatient = true;
  } else {
    assignPersonEdits(patient, payload);
    patient.hospitalId = patient.hospitalId || hospitalId;
    await patient.save();
  }

  const findOpen = () =>
    IPAdmission.findOne({
      hospitalId,
      patientId: patient._id,
      patient_status: "Admitted",
    });
  const openResponse = async (open) => {
    if (patient.name && open.patientName !== patient.name) {
      open.patientName = patient.name;
      await open.save();
    }
    return {
      httpStatus: 200,
      payload: {
        message: "Patient already has an open admission",
        existingAdmission: true,
        createdPatient: false,
        admission: open,
        patient: presentPatient(patient, { admission: open }),
      },
    };
  };

  const open = await findOpen();
  if (open) return openResponse(open);

  const wantsBed =
    (payload.patient_status || "Admitted") === "Admitted" &&
    payload.wardId &&
    payload.selectedBed;
  let bedClaimed = false;
  if (wantsBed) {
    const claim = await claimBed(tenantDb, hospitalId, {
      wardId: payload.wardId,
      bed: payload.selectedBed,
      patient,
    });
    if (!claim.ok) {
      if (createdPatient) await Patient.deleteOne({ _id: patient._id, hospitalId });
      return {
        httpStatus: 409,
        payload: { code: "BED_UNAVAILABLE", message: claim.reason },
      };
    }
    bedClaimed = !claim.skipped;
  }

  try {
    let admission = null;
    for (let attempt = 0; attempt < 3 && !admission; attempt += 1) {
      const ipNumber = await nextIpNumber(tenantDb, IPAdmission, hospitalId);
      try {
        admission = await IPAdmission.create(
          stayPayload(payload, patient, hospitalId, ipNumber),
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // A concurrent request opened a stay for this patient first.
        const raced = await findOpen();
        if (raced) {
          if (
            bedClaimed &&
            (raced.wardId !== payload.wardId ||
              raced.selectedBed !== payload.selectedBed)
          ) {
            await releaseBed(tenantDb, hospitalId, {
              wardId: payload.wardId,
              bed: payload.selectedBed,
              umr: patient.UMRNo,
            });
          }
          return openResponse(raced);
        }
        // Otherwise the IP number collided; retry with the next one.
      }
    }
    if (!admission) throw new Error("Could not allocate a unique IP number");
    const presented = presentPatient(patient, {
      admission:
        admission.patient_status === "Admitted" ? admission : null,
    });
    return {
      httpStatus: 201,
      payload: {
        message: "Patient admitted",
        existingAdmission: false,
        createdPatient,
        admission,
        patient: presented,
        UMRNo: patient.UMRNo,
      },
    };
  } catch (error) {
    if (bedClaimed) {
      await releaseBed(tenantDb, hospitalId, {
        wardId: payload.wardId,
        bed: payload.selectedBed,
        umr: patient.UMRNo,
      }).catch(() => {});
    }
    if (createdPatient) {
      await Patient.deleteOne({ _id: patient._id, hospitalId });
    }
    throw error;
  }
}

const ERA_UPDATE_KEYS = [
  "mlcNo",
  "consultantDoctor",
  "doctorId",
  "medicalOfficerName",
  "medicalOfficerId",
  "ernote",
  "consciousness",
  "gcs",
  "pupils",
  "height",
  "weight",
  "personalHistory",
  "wardName",
  "wardId",
  "selectedBed",
  "patient_status",
  "dischargeTo",
  "counselling",
  "dischargeOrders",
  "consultantHistory",
];

const ERA_EDITABLE_STATUSES = ["Admitted", "Refused Admission"];

/**
 * Update the ER chart on an existing stay. Person fields go to the patient.
 * The live ward treatment and investigation lists are left in place.
 */
async function updateEraChart({ tenantDb, hospitalId, admissionId, body }) {
  const Patient = tenantDb.model("Patient");
  const IPAdmission = tenantDb.model("IPAdmission");
  const payload = body || {};
  const query = mongoose.Types.ObjectId.isValid(admissionId)
    ? { _id: admissionId, hospitalId }
    : { ipNumber: admissionId, hospitalId };
  const admission = await IPAdmission.findOne(query);
  if (!admission) {
    return { httpStatus: 404, payload: { message: "Admission record not found" } };
  }

  const patient = await Patient.findOne({
    _id: admission.patientId,
    hospitalId,
  });

  if (
    payload.patient_status !== undefined &&
    payload.patient_status !== admission.patient_status &&
    !ERA_EDITABLE_STATUSES.includes(payload.patient_status)
  ) {
    return {
      httpStatus: 400,
      payload: {
        message: `Status "${payload.patient_status}" must be set through the discharge flow`,
      },
    };
  }
  if (
    admission.patient_status !== "Admitted" &&
    admission.patient_status !== "Refused Admission" &&
    payload.patient_status !== undefined &&
    payload.patient_status !== admission.patient_status
  ) {
    return {
      httpStatus: 409,
      payload: { message: `Stay is already ${admission.patient_status}` },
    };
  }

  const prevStatus = admission.patient_status;
  const prevWardId = admission.wardId || "";
  const prevBed = admission.selectedBed || "";
  const nextStatus = payload.patient_status ?? prevStatus;
  const nextWardId = payload.wardId ?? prevWardId;
  const nextBed = payload.selectedBed ?? prevBed;
  const heldBefore = prevStatus === "Admitted" && prevWardId && prevBed;
  const holdsAfter = nextStatus === "Admitted" && nextWardId && nextBed;
  const bedMoved =
    !heldBefore || !holdsAfter || prevWardId !== nextWardId || prevBed !== nextBed;

  if (holdsAfter && bedMoved) {
    const claim = await claimBed(tenantDb, hospitalId, {
      wardId: nextWardId,
      bed: nextBed,
      patient: patient || { UMRNo: admission.UMRNo, name: admission.patientName },
    });
    if (!claim.ok) {
      return {
        httpStatus: 409,
        payload: { code: "BED_UNAVAILABLE", message: claim.reason },
      };
    }
  }

  if (patient) {
    assignPersonEdits(patient, payload);
    await patient.save();
    if (patient.name) admission.patientName = patient.name;
  }

  for (const key of ERA_UPDATE_KEYS) {
    if (payload[key] !== undefined) admission[key] = payload[key];
  }
  const rawNote = await IPAdmission.collection.findOne(
    { _id: admission._id },
    { projection: { ernote: 1, chiefComplaintsPresentIllnessHistory: 1 } },
  );
  const incomingNote = eraNoteFromBody(payload);
  if (incomingNote !== undefined) {
    admission.ernote = incomingNote;
  } else if (
    !String(admission.ernote || rawNote?.ernote || "").trim() &&
    String(rawNote?.chiefComplaintsPresentIllnessHistory || "").trim()
  ) {
    admission.ernote = String(rawNote.chiefComplaintsPresentIllnessHistory);
  }
  if (payload.personalHistory && typeof payload.personalHistory === "object") {
    admission.personalHistory = personalHistoryFromBody(payload);
    admission.markModified("personalHistory");
  }

  if (holdsAfter && heldBefore && prevWardId !== nextWardId) {
    admission.transfers.push({
      wardId: nextWardId,
      wardName: payload.wardName ?? admission.wardName,
      price: Number(
        payload.bedPrice ??
          (Array.isArray(payload.transfers)
            ? payload.transfers[payload.transfers.length - 1]?.price
            : 0) ??
          0,
      ) || 0,
      transferDate: localYmd(),
    });
  }
  if (Array.isArray(payload.treatment) && payload.treatment.length) {
    admission.casualtyTreatment = cloneJson(payload.treatment);
    admission.markModified("casualtyTreatment");
  } else if (Array.isArray(payload.casualtyTreatment)) {
    admission.casualtyTreatment = payload.casualtyTreatment;
    admission.markModified("casualtyTreatment");
  }
  if (Array.isArray(payload.investigations)) {
    admission.casualtyInvestigations = payload.investigations;
    admission.markModified("casualtyInvestigations");
  }

  const eraVitalEntry = eraVitalFromBody(payload);
  if (eraVitalEntry) {
    admission.eraVitalEntry = eraVitalEntry;
    admission.vitals = mergeEraVital(admission.vitals, eraVitalEntry);
    admission.markModified("eraVitalEntry");
    admission.markModified("vitals");
  }

  await admission.save();
  await IPAdmission.collection.updateOne(
    { _id: admission._id },
    { $unset: ERA_NOTE_UNSET },
  );
  if (heldBefore && bedMoved) {
    await releaseBed(tenantDb, hospitalId, {
      wardId: prevWardId,
      bed: prevBed,
      umr: admission.UMRNo,
    }).catch((error) => console.error("ERA bed release failed:", error));
  }
  const presented = patient
    ? presentPatient(patient, {
        admission:
          admission.patient_status === "Admitted" ? admission : null,
      })
    : null;
  return {
    httpStatus: 200,
    payload: {
      message: "ER assessment updated",
      admission,
      patient: presented,
    },
  };
}

module.exports = { admitPatient, updateEraChart };
