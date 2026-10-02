const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "core" });

const DISCHARGE_FIELDS = [
  "patientId",
  "admissionId",
  "ipNumber",
  "admissionDate",
  "dischargeDate",
  "dischargeTime",
  "lengthOfStay",
  "dischargeCondition",
  "dischargeDestination",
  "dischargeTo",
  "finalDiagnosis",
  "hospitalCourse",
  "dischargeInstructions",
  "dangerSigns",
  "followUpPlan",
  "counselling",
  "summarySections",
  "dischargeMedications",
  "repeatLabs",
  "procedures",
  "summary",
  "summaryType",
  "dischargeSummaryStatus",
  "dischargeSummaryMeta",
  "savedBy",
];

const LEGACY_DRAFT_FIELDS = [
  "reviewDischargeFields",
  "chatHistory",
  "reviewMedicines",
  "reviewLabTests",
  "reviewProcedures",
  "reviewVitals",
  "reviewNoteText",
  "reviewEraManualExam",
  "reviewLabTestsToStop",
  "reviewMedicinesToRestart",
  "reviewMedicinesToStop",
  "chartCleared",
  "composeMode",
  "documentedLabTests",
  "documentedMedicines",
  "documentedProcedures",
  "extractedData",
  "inputText",
  "step1Text",
  "followUpMessages",
  "lastSavedChart",
  "mode",
  "noteFormat",
  "practiceSuggestion",
  "saveScope",
  "timestamp",
  "visitTextLoaded",
];

function clinicalDischargePayload(body = {}, { umrNo, hospitalId }) {
  const payload = {
    UMRNo: umrNo,
    hospitalId: hospitalId || undefined,
    lastSavedAt: new Date(),
  };
  for (const field of DISCHARGE_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  if (payload.patientId && !mongoose.Types.ObjectId.isValid(payload.patientId)) {
    delete payload.patientId;
  }
  if (
    payload.admissionId &&
    !mongoose.Types.ObjectId.isValid(payload.admissionId)
  ) {
    delete payload.admissionId;
  }
  return payload;
}

const DISCHARGE_STATUS_RANK = {
  draft: 0,
  changes_requested: 1,
  pending_approval: 2,
  approved: 3,
};

function dischargeStatusOf(record) {
  return (
    record?.dischargeSummaryMeta?.status ||
    record?.dischargeSummaryStatus ||
    ""
  );
}

function dischargeStatusRank(status) {
  return DISCHARGE_STATUS_RANK[status] ?? -1;
}

const ALLOWED_TRANSITIONS = {
  "": ["draft", "pending_approval", "approved"],
  draft: ["pending_approval", "approved"],
  changes_requested: ["draft", "pending_approval", "approved"],
  pending_approval: ["approved", "changes_requested", "draft"],
  approved: ["draft"],
};

/**
 * Pin a discharge summary to one admission. Uses the given id when it belongs
 * to this patient, otherwise the open stay, otherwise the most recent stay.
 * Returns null only when the patient has no admission at all.
 */
async function resolveAdmissionId(IPAdmission, { umrNo, hospitalId, admissionId }) {
  const base = { UMRNo: umrNo, ...(hospitalId ? { hospitalId } : {}) };
  if (mongoose.Types.ObjectId.isValid(admissionId)) {
    const own = await IPAdmission.exists({ ...base, _id: admissionId });
    return own ? String(own._id) : undefined;
  }
  const open = await IPAdmission.findOne({ ...base, patient_status: "Admitted" })
    .sort({ createdAt: -1 })
    .select("_id")
    .lean();
  if (open) return String(open._id);
  const latest = await IPAdmission.findOne(base)
    .sort({ createdAt: -1 })
    .select("_id")
    .lean();
  return latest ? String(latest._id) : null;
}

function getModels(req) {
  if (req.tenantDb) {
    return {
      DischargeSummary:
        req.tenantDb.models.DischargeSummary ||
        req.tenantDb.model("DischargeSummary"),
      IPAdmission: req.tenantDb.model("IPAdmission"),
      Patient: req.tenantDb.model("Patient"),
    };
  }
  return {
    DischargeSummary: require("../models/DischargeSummary"),
    IPAdmission: require("../models/IPAdmission"),
    Patient: require("../models/Patient"),
  };
}

/**
 * GET /api/discharge-draft/:umrNo
 * Fetch saved discharge summary / draft from database across any device.
 */
router.get("/:umrNo", async (req, res) => {
  try {
    const { DischargeSummary, IPAdmission, Patient } = getModels(req);
    const umrNo = req.params.umrNo;
    const hospitalId = req.hospitalId;
    const resolved = await resolveAdmissionId(IPAdmission, {
      umrNo,
      hospitalId,
      admissionId: String(req.query.admissionId || "").trim(),
    });
    if (resolved === undefined) {
      return res.status(404).json({ success: false, error: "Admission not found for this patient" });
    }
    const admissionId = resolved || "";
    const admissionScope = resolved ? { admissionId: resolved } : {};

    const query = { UMRNo: umrNo, ...admissionScope };
    if (hospitalId) {
      query.hospitalId = hospitalId;
    }

    const draft = await DischargeSummary.findOne(query).sort({ updatedAt: -1 });

    // Signed state only ever comes from this admission's own summaries.
    const signedCandidates = await DischargeSummary.find(query)
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean();

    const applySignedStatus = (draftData, patientRecord) => {
      const candidates = [...signedCandidates];
      // Legacy patient-level status is not tied to a stay; only trust it when unscoped.
      if (patientRecord && !resolved) candidates.push(patientRecord);
      let best = null;
      for (const candidate of candidates) {
        const rank = dischargeStatusRank(dischargeStatusOf(candidate));
        if (!best || rank > dischargeStatusRank(dischargeStatusOf(best))) {
          best = candidate;
        }
      }
      if (
        best &&
        dischargeStatusRank(dischargeStatusOf(best)) >
          dischargeStatusRank(dischargeStatusOf(draftData))
      ) {
        draftData.dischargeSummaryStatus = dischargeStatusOf(best);
        draftData.dischargeSummaryMeta =
          best.dischargeSummaryMeta || draftData.dischargeSummaryMeta || null;
        const signedSummary = best.summary || best.dischargeSummary || "";
        if (signedSummary) draftData.summary = signedSummary;
        if (best.summaryType || best.dischargeSummaryType) {
          draftData.summaryType =
            best.summaryType || best.dischargeSummaryType;
        }
      }
      return draftData;
    };

    if (!draft) {
      // Fallback: Check if there is an active or recent IPAdmission with existing discharge data
      const admission = await IPAdmission.findOne({
        UMRNo: umrNo,
        ...(mongoose.Types.ObjectId.isValid(admissionId)
          ? { _id: admissionId }
          : {}),
        ...(hospitalId ? { hospitalId } : {}),
      }).sort({ createdAt: -1 });

      if (admission) {
        const patientForStatus = await Patient.findOne({
          UMRNo: umrNo,
          ...(hospitalId ? { hospitalId } : {}),
        }).lean();
        return res.json({
          success: true,
          draft: applySignedStatus({
            UMRNo: umrNo,
            admissionId: admission._id,
            ipNumber: admission.ipNumber,
            admissionDate: admission.admissionDate,
            dischargeDate: admission.dischargeDate || null,
            dischargeTime: admission.dischargeTime || null,
            dischargeCondition: admission.dischargeCondition || "Stable",
            dischargeDestination: admission.dischargeDestination || "Home",
            finalDiagnosis: admission.finalDiagnosis || admission.provisionalDiagnosis || "",
            hospitalCourse: admission.hospitalCourse || "",
            dischargeInstructions: admission.dischargeInstructions || "",
            followUpPlan: admission.followUpPlan || "",
            summary: admission.dischargeSummary || null,
            dischargeSummaryStatus:
              admission.dischargeSummaryStatus || "draft",
            dischargeSummaryMeta: admission.dischargeSummaryMeta || null,
            isFromAdmission: true,
          }, patientForStatus),
        });
      }

      if (resolved) return res.json({ success: true, draft: null });

      // Check Patient record
      const patient = await Patient.findOne({
        UMRNo: umrNo,
        ...(hospitalId ? { hospitalId } : {}),
      });

      if (patient && (patient.dischargeSummary || patient.finalDiagnosis)) {
        return res.json({
          success: true,
          draft: applySignedStatus(
            {
              UMRNo: umrNo,
              finalDiagnosis: patient.finalDiagnosis || patient.provisionalDiagnosis || "",
              dischargeDate: patient.dischargeDate || null,
              dischargeCondition: patient.dischargeCondition || "Stable",
              dischargeDestination: patient.dischargeDestination || "Home",
              summary: patient.dischargeSummary || null,
              dischargeSummaryStatus: patient.dischargeSummaryStatus || "draft",
              dischargeSummaryMeta: patient.dischargeSummaryMeta || null,
              isFromPatient: true,
            },
            patient,
          ),
        });
      }

      return res.json({ success: true, draft: null });
    }

    const patient = await Patient.findOne({
      UMRNo: umrNo,
      ...(hospitalId ? { hospitalId } : {}),
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();
    const draftData = draft.toObject ? draft.toObject() : { ...draft };
    // Older saves stored the same orders again on the AI worksheet.
    // Promote those into the clinical lists when the clinical lists are empty.
    if (
      (!Array.isArray(draftData.dischargeMedications) ||
        draftData.dischargeMedications.length === 0) &&
      Array.isArray(draftData.reviewMedicines) &&
      draftData.reviewMedicines.length > 0
    ) {
      draftData.dischargeMedications = draftData.reviewMedicines;
    }
    if (
      (!Array.isArray(draftData.repeatLabs) ||
        draftData.repeatLabs.length === 0) &&
      Array.isArray(draftData.reviewLabTests) &&
      draftData.reviewLabTests.length > 0
    ) {
      draftData.repeatLabs = draftData.reviewLabTests;
    }
    applySignedStatus(draftData, patient);

    return res.json({ success: true, draft: draftData });
  } catch (error) {
    console.error("Error fetching discharge draft:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch discharge draft",
      details: error.message,
    });
  }
});

/**
 * POST /api/discharge-draft/:umrNo
 * Save/Autosave discharge draft to MongoDB so it persists across devices.
 */
router.post("/:umrNo", async (req, res) => {
  try {
    const { DischargeSummary, IPAdmission, Patient } = getModels(req);
    const umrNo = req.params.umrNo;
    const hospitalId = req.hospitalId;
    const resolved = await resolveAdmissionId(IPAdmission, {
      umrNo,
      hospitalId,
      admissionId: String(req.body.admissionId || "").trim(),
    });
    if (resolved === undefined) {
      return res.status(404).json({ success: false, error: "Admission not found for this patient" });
    }
    const admissionScope = resolved ? { admissionId: resolved } : {};

    const filter = { UMRNo: umrNo, ...admissionScope };
    if (hospitalId) {
      filter.hospitalId = hospitalId;
    }

    const payload = clinicalDischargePayload(req.body, { umrNo, hospitalId });
    if (resolved) payload.admissionId = resolved;
    const existing = await DischargeSummary.findOne(filter)
      .sort({ updatedAt: -1 })
      .lean();
    const fromStatus = dischargeStatusOf(existing);
    const requested = payload.dischargeSummaryStatus || fromStatus || "draft";
    const isTransition = Boolean(req.body.statusTransition) && requested !== fromStatus;

    if (isTransition) {
      if (!(ALLOWED_TRANSITIONS[fromStatus] || []).includes(requested)) {
        return res.status(409).json({
          success: false,
          error: `Cannot move discharge summary from ${fromStatus || "new"} to ${requested}`,
        });
      }
      if (requested === "approved") {
        const meta = { ...(payload.dischargeSummaryMeta || {}) };
        meta.status = "approved";
        meta.approvedBy = {
          ...(meta.approvedBy || {}),
          userId: String(req.user?.id || req.user?._id || ""),
          timestamp: new Date().toISOString(),
        };
        payload.dischargeSummaryMeta = meta;
      }
    } else if (fromStatus === "approved") {
      return res.status(409).json({
        success: false,
        code: "SUMMARY_SIGNED",
        error: "This discharge summary is signed. Revise (unlock) it before editing.",
      });
    } else if (existing) {
      // Plain saves never change approval state.
      payload.dischargeSummaryStatus = fromStatus || "draft";
      payload.dischargeSummaryMeta = existing.dischargeSummaryMeta ?? payload.dischargeSummaryMeta;
    } else {
      payload.dischargeSummaryStatus = "draft";
    }
    const unset = Object.fromEntries(
      LEGACY_DRAFT_FIELDS.map((field) => [field, ""]),
    );

    const update = { $set: payload, $unset: unset };
    const options = {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      sort: { updatedAt: -1 },
      // Legacy worksheet fields are no longer on the schema. strict:false
      // lets this update remove them from documents saved before the change.
      strict: false,
    };
    let draft;
    try {
      draft = await DischargeSummary.findOneAndUpdate(filter, update, options);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      // A concurrent save created the row first; update it instead.
      draft = await DischargeSummary.findOneAndUpdate(filter, update, {
        ...options,
        upsert: false,
      });
    }

    return res.json({ success: true, draft });
  } catch (error) {
    console.error("Error saving discharge draft:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to save discharge draft",
      details: error.message,
    });
  }
});

/**
 * DELETE /api/discharge-draft/:umrNo
 * Deletes the draft when the user clicks Reset.
 */
router.delete("/:umrNo", async (req, res) => {
  try {
    const { DischargeSummary, IPAdmission } = getModels(req);
    const umrNo = req.params.umrNo;
    const hospitalId = req.hospitalId;
    const resolved = await resolveAdmissionId(IPAdmission, {
      umrNo,
      hospitalId,
      admissionId: String(req.query.admissionId || "").trim(),
    });
    if (!resolved) {
      return res.status(404).json({ success: false, error: "Admission not found for this patient" });
    }

    const query = { UMRNo: umrNo, admissionId: resolved };
    if (hospitalId) {
      query.hospitalId = hospitalId;
    }

    const result = await DischargeSummary.deleteMany({
      ...query,
      dischargeSummaryStatus: { $ne: "approved" },
      "dischargeSummaryMeta.status": { $ne: "approved" },
    });
    const signedLeft = await DischargeSummary.exists(query);
    if (signedLeft && !result.deletedCount) {
      return res.status(409).json({
        success: false,
        code: "SUMMARY_SIGNED",
        error: "A signed discharge summary cannot be reset. Revise (unlock) it first.",
      });
    }

    return res.json({ success: true, message: "Draft cleared successfully" });
  } catch (error) {
    console.error("Error deleting discharge draft:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to delete discharge draft",
      details: error.message,
    });
  }
});

module.exports = router;
