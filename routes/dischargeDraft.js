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
    const admissionId = String(req.query.admissionId || "").trim();
    const admissionScope = mongoose.Types.ObjectId.isValid(admissionId)
      ? { admissionId }
      : {};

    const query = { UMRNo: umrNo, ...admissionScope };
    if (hospitalId) {
      query.hospitalId = hospitalId;
    }

    let draft = await DischargeSummary.findOne(query).sort({ updatedAt: -1 });
    if (!draft && admissionScope.admissionId) {
      const umrQuery = { UMRNo: umrNo };
      if (hospitalId) umrQuery.hospitalId = hospitalId;
      draft = await DischargeSummary.findOne(umrQuery).sort({ updatedAt: -1 });
    }

    let signedCandidates = await DischargeSummary.find({
      UMRNo: umrNo,
      ...(hospitalId ? { hospitalId } : {}),
    })
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean();
    if (
      hospitalId &&
      !signedCandidates.some(
        (candidate) => dischargeStatusRank(dischargeStatusOf(candidate)) > 0,
      )
    ) {
      signedCandidates = await DischargeSummary.find({ UMRNo: umrNo })
        .sort({ updatedAt: -1 })
        .limit(20)
        .lean();
    }

    const applySignedStatus = (draftData, patientRecord) => {
      const candidates = [...signedCandidates];
      if (patientRecord) candidates.push(patientRecord);
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
            counselling: admission.counselling || "",
            summarySections: admission.summarySections || [],
            dischargeMedications: admission.dischargeMedications || [],
            repeatLabs: admission.repeatLabs || [],
            summary: admission.dischargeSummary || null,
            dischargeSummaryStatus:
              admission.dischargeSummaryStatus || "draft",
            dischargeSummaryMeta: admission.dischargeSummaryMeta || null,
            isFromAdmission: true,
          }, patientForStatus),
        });
      }

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
              summarySections: patient.summarySections || [],
              dischargeMedications: patient.dischargeMedications || [],
              repeatLabs: patient.repeatLabs || [],
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

    // Older clients saved the patient record without updating the
    // DischargeSummary document. Backfill missing order arrays from the
    // admission/patient record so another device does not receive a stale
    // discharge workstation.
    const [admission, patient] = await Promise.all([
      IPAdmission.findOne({
        UMRNo: umrNo,
        ...(hospitalId ? { hospitalId } : {}),
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean(),
      Patient.findOne({
        UMRNo: umrNo,
        ...(hospitalId ? { hospitalId } : {}),
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean(),
    ]);
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
    for (const field of ["dischargeMedications", "repeatLabs"]) {
      const draftItems = Array.isArray(draftData[field])
        ? draftData[field]
        : [];
      const fallbackItems =
        (Array.isArray(admission?.[field]) && admission[field]) ||
        (Array.isArray(patient?.[field]) && patient[field]) ||
        [];
      if (draftItems.length === 0 && fallbackItems.length > 0) {
        draftData[field] = fallbackItems;
      }
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
    const hospitalId = req.hospitalId || req.body.hospitalId;
    const admissionId = String(req.body.admissionId || "").trim();
    const admissionScope = mongoose.Types.ObjectId.isValid(admissionId)
      ? { admissionId }
      : {};

    const filter = { UMRNo: umrNo, ...admissionScope };
    if (hospitalId) {
      filter.hospitalId = hospitalId;
    }

    const payload = clinicalDischargePayload(req.body, { umrNo, hospitalId });
    const existing = await DischargeSummary.findOne(filter).lean();
    const incomingRank = dischargeStatusRank(
      payload.dischargeSummaryStatus || "draft",
    );
    const existingRank = dischargeStatusRank(dischargeStatusOf(existing));
    const keepSignedRecord =
      existing && !req.body.statusTransition && incomingRank < existingRank;
    if (keepSignedRecord) {
      payload.dischargeSummaryStatus = dischargeStatusOf(existing);
      payload.dischargeSummaryMeta = existing.dischargeSummaryMeta || null;
      if (existing.summary) payload.summary = existing.summary;
      if (existing.summaryType) payload.summaryType = existing.summaryType;
    }
    const unset = Object.fromEntries(
      LEGACY_DRAFT_FIELDS.map((field) => [field, ""]),
    );

    const draft = await DischargeSummary.findOneAndUpdate(
      filter,
      { $set: payload, $unset: unset },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        // Legacy worksheet fields are no longer on the schema. strict:false
        // lets this update remove them from documents saved before the change.
        strict: false,
      },
    );

    // Simultaneously sync key clinical summary fields to the active IPAdmission or Patient
    const clinicalSync = {};
    if (req.body.dischargeDate !== undefined) clinicalSync.dischargeDate = req.body.dischargeDate;
    if (req.body.dischargeTime !== undefined) clinicalSync.dischargeTime = req.body.dischargeTime;
    if (req.body.lengthOfStay !== undefined) clinicalSync.lengthOfStay = req.body.lengthOfStay;
    if (req.body.dischargeCondition !== undefined) clinicalSync.dischargeCondition = req.body.dischargeCondition;
    if (req.body.dischargeDestination !== undefined) clinicalSync.dischargeDestination = req.body.dischargeDestination;
    if (req.body.finalDiagnosis !== undefined) clinicalSync.finalDiagnosis = req.body.finalDiagnosis;
    if (req.body.hospitalCourse !== undefined) clinicalSync.hospitalCourse = req.body.hospitalCourse;
    if (req.body.dischargeInstructions !== undefined) clinicalSync.dischargeInstructions = req.body.dischargeInstructions;
    if (req.body.followUpPlan !== undefined) clinicalSync.followUpPlan = req.body.followUpPlan;
    if (req.body.counselling !== undefined) clinicalSync.counselling = req.body.counselling;
    if (req.body.summarySections !== undefined) clinicalSync.summarySections = req.body.summarySections;
    if (req.body.dischargeMedications !== undefined) clinicalSync.dischargeMedications = req.body.dischargeMedications;
    if (req.body.repeatLabs !== undefined) clinicalSync.repeatLabs = req.body.repeatLabs;
    if (req.body.dangerSigns !== undefined) clinicalSync.dangerSigns = req.body.dangerSigns;
    if (req.body.hospitalCourse !== undefined) clinicalSync.hospitalCourse = req.body.hospitalCourse;
    if (payload.summary !== undefined) clinicalSync.dischargeSummary = payload.summary;
    else if (req.body.dischargeSummary !== undefined) clinicalSync.dischargeSummary = req.body.dischargeSummary;
    if (payload.summaryType !== undefined) clinicalSync.dischargeSummaryType = payload.summaryType;
    else if (req.body.summaryType !== undefined) clinicalSync.dischargeSummaryType = req.body.summaryType;
    if (req.body.dischargeSummaryTimestamp !== undefined) clinicalSync.dischargeSummaryTimestamp = req.body.dischargeSummaryTimestamp;
    if (payload.dischargeSummaryStatus !== undefined) {
      clinicalSync.dischargeSummaryStatus = payload.dischargeSummaryStatus;
    }
    if (payload.dischargeSummaryMeta !== undefined) {
      clinicalSync.dischargeSummaryMeta = payload.dischargeSummaryMeta;
    }

    if (Object.keys(clinicalSync).length > 0) {
      try {
        await IPAdmission.findOneAndUpdate(
          {
            UMRNo: umrNo,
            ...admissionScope,
            ...(hospitalId ? { hospitalId } : {}),
          },
          { $set: clinicalSync }
        );
        await Patient.findOneAndUpdate(
          { UMRNo: umrNo, ...(hospitalId ? { hospitalId } : {}) },
          { $set: clinicalSync }
        );
      } catch (syncErr) {
        console.warn("Non-fatal sync to IPAdmission/Patient warning:", syncErr.message);
      }
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
    const { DischargeSummary } = getModels(req);
    const umrNo = req.params.umrNo;
    const hospitalId = req.hospitalId;
    const admissionId = String(req.query.admissionId || "").trim();

    const query = { UMRNo: umrNo };
    if (mongoose.Types.ObjectId.isValid(admissionId)) {
      query.admissionId = admissionId;
    }
    if (hospitalId) {
      query.hospitalId = hospitalId;
    }

    await DischargeSummary.deleteMany(query);

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
