const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const { getTenantConnection } = require("../utils/tenantDb");
const Hospital = require("../models/Hospital");
const {
  createPrescriptionToken,
  verifyPrescriptionToken,
} = require("../utils/prescriptionToken");
const {
  sendPrescriptionWhatsApp,
  mapWhatsAppHttpError,
} = require("../utils/whatsappCloud");

function findPrescription(patient, prescriptionId) {
  if (!patient || !Array.isArray(patient.prescriptions)) return null;
  return (
    patient.prescriptions.find(
      (p) => String(p.prescriptionId) === String(prescriptionId),
    ) || null
  );
}

function getVisitNumber(prescriptionsMeta, prescriptionId) {
  const prescriptions = Array.isArray(prescriptionsMeta)
    ? prescriptionsMeta
    : [];
  if (!prescriptions.length) return null;

  const chronological = [...prescriptions].sort(
    (a, b) => new Date(a.date || 0) - new Date(b.date || 0),
  );
  const index = chronological.findIndex(
    (p) => String(p.prescriptionId) === String(prescriptionId),
  );
  return index >= 0 ? index + 1 : null;
}

function buildPublicPatient(patient) {
  return {
    name: patient.name,
    age: patient.age,
    gender: patient.gender,
    UMRNo: patient.UMRNo,
    phone: patient.phone,
  };
}

function buildPublicHospital(hospital) {
  if (!hospital) return null;
  return {
    name: hospital.name,
    address: hospital.address,
    city: hospital.city,
    state: hospital.state,
    zipCode: hospital.zipCode,
    phone: hospital.phone,
    logoUrl: hospital.logoUrl,
  };
}

function slimDosage(dose = {}) {
  return {
    time: dose.time || "",
    amount: dose.amount,
    unit: dose.unit || "",
    beforeFood: Boolean(dose.beforeFood),
  };
}

function slimMedicine(med = {}) {
  return {
    lineId: med.lineId,
    item_code: med.item_code,
    name: med.name,
    description: med.description,
    correctedName: med.correctedName,
    type: med.type,
    generic_name: med.generic_name,
    quantity: med.quantity,
    duration: med.duration,
    durationText: med.durationText,
    dosages: Array.isArray(med.dosages) ? med.dosages.map(slimDosage) : [],
    patientDirections: med.patientDirections,
    directions: med.directions,
    instructions: med.instructions,
    sequenceGroup: med.sequenceGroup,
    sequenceIndex: med.sequenceIndex,
    sequenceLabel: med.sequenceLabel,
  };
}

function buildPublicPrescription(prescription) {
  if (!prescription) return null;
  const vitals = Array.isArray(prescription.vitals)
    ? prescription.vitals.map((v) => ({
        time: v.time,
        temperature: v.temperature,
        heartRate: v.heartRate,
        bloodPressure: v.bloodPressure,
        spo2: v.spo2,
      }))
    : [];
  const doctorNotes = Array.isArray(prescription.doctorNotes)
    ? prescription.doctorNotes.map((n) => ({ content: n?.content || "" }))
    : [];
  const diagnosticData = Array.isArray(prescription.diagnosticData)
    ? prescription.diagnosticData.map((t) => ({ name: t?.name || "" }))
    : [];
  const medicineData = Array.isArray(prescription.medicineData)
    ? prescription.medicineData.map(slimMedicine)
    : [];

  return {
    prescriptionId: prescription.prescriptionId,
    date: prescription.date,
    doctorId: prescription.doctorId,
    symptoms: prescription.symptoms || "",
    pastMedicalHistory: prescription.pastMedicalHistory || "",
    provisionalDiagnosis: prescription.provisionalDiagnosis || "",
    weight: prescription.weight,
    height: prescription.height,
    vitals,
    doctorNotes,
    diagnosticData,
    medicineData,
  };
}

/**
 * PUBLIC (no auth): view a prescription via a signed token.
 * Defined BEFORE applyTenantEntitlements so the auth middleware does not apply.
 * GET /api/prescriptions/public/:token
 */
router.get("/public/:token", async (req, res) => {
  try {
    let decoded;
    try {
      decoded = verifyPrescriptionToken(req.params.token);
    } catch (err) {
      return res.status(400).json({ message: "Invalid or expired link." });
    }

    const { hospitalId, patientId, prescriptionId } = decoded;

    const connection = await getTenantConnection(hospitalId);
    if (!connection) {
      return res.status(500).json({ message: "Unable to load prescription." });
    }

    const Patient = connection.model("Patient");
    const rxId = String(prescriptionId);
    // Load patient demographics + only the matched Rx (plus date/id meta for visit #).
    const [patientRow] = await Patient.aggregate([
      { $match: { UMRNo: patientId, hospitalId } },
      {
        $project: {
          name: 1,
          age: 1,
          gender: 1,
          UMRNo: 1,
          phone: 1,
          prescriptionsMeta: {
            $map: {
              input: { $ifNull: ["$prescriptions", []] },
              as: "p",
              in: {
                prescriptionId: "$$p.prescriptionId",
                date: "$$p.date",
              },
            },
          },
          prescription: {
            $first: {
              $filter: {
                input: { $ifNull: ["$prescriptions", []] },
                as: "p",
                cond: {
                  $eq: [{ $toString: "$$p.prescriptionId" }, rxId],
                },
              },
            },
          },
        },
      },
    ]);

    if (!patientRow) {
      return res.status(404).json({ message: "Prescription not found." });
    }

    const prescription = patientRow.prescription;
    if (!prescription) {
      return res.status(404).json({ message: "Prescription not found." });
    }

    const patient = {
      name: patientRow.name,
      age: patientRow.age,
      gender: patientRow.gender,
      UMRNo: patientRow.UMRNo,
      phone: patientRow.phone,
      prescriptions: patientRow.prescriptionsMeta || [],
    };

    const Staff = connection.model("Staff");
    const doctorPromise = prescription.doctorId
      ? Staff.findOne(
          { id: prescription.doctorId },
          { name: 1, qualification: 1, specialization: 1, id: 1 },
        )
          .lean()
          .catch(() => null)
      : Promise.resolve(null);

    const hospitalPromise = Hospital.findById(hospitalId)
      .select("name address city state zipCode phone logoUrl")
      .lean();

    const [doctorDoc, hospital] = await Promise.all([
      doctorPromise,
      hospitalPromise,
    ]);

    const doctor = doctorDoc
      ? {
          name: doctorDoc.name,
          qualification: doctorDoc.qualification,
          specialization: doctorDoc.specialization,
        }
      : null;

    return res.json({
      hospital: buildPublicHospital(hospital),
      doctor,
      patient: buildPublicPatient(patient),
      prescription: buildPublicPrescription(prescription),
      visitNumber: getVisitNumber(patient.prescriptions, prescriptionId),
    });
  } catch (error) {
    console.error("Public prescription view error:", error);
    return res.status(500).json({ message: "Unable to load prescription." });
  }
});

// Everything below requires authentication + active subscription + tenant DB
applyTenantEntitlements(router, { moduleKey: "core" });

/**
 * AUTHENTICATED: send the prescription to the patient via WhatsApp
 * (Meta Cloud API).
 * POST /api/prescriptions/:patientId/:prescriptionId/send-whatsapp
 * Body: { viewBaseUrl: string }  (e.g. https://hs-xxxx.healeka.com)
 */
router.post("/:patientId/:prescriptionId/send-whatsapp", async (req, res) => {
  try {
    const { patientId, prescriptionId } = req.params;
    const { viewBaseUrl } = req.body || {};

    if (!viewBaseUrl) {
      return res
        .status(400)
        .json({ message: "viewBaseUrl is required to build the view link." });
    }

    const Patient = req.tenantDb.model("Patient");
    const patient = await Patient.findOne({
      UMRNo: patientId,
      hospitalId: req.hospitalId,
    }).lean();

    if (!patient) {
      return res.status(404).json({ message: "Patient not found." });
    }

    const prescription = findPrescription(patient, prescriptionId);
    if (!prescription) {
      return res.status(404).json({ message: "Prescription not found." });
    }

    if (!patient.phone) {
      return res
        .status(400)
        .json({ message: "Patient does not have a mobile number on file." });
    }

    let doctorName = patient.consultantDoctor || "";
    if (prescription.doctorId) {
      try {
        const Staff = req.tenantDb.model("Staff");
        const doctorDoc = await Staff.findOne({
          id: prescription.doctorId,
        }).lean();
        if (doctorDoc?.name) doctorName = doctorDoc.name;
      } catch (err) {
        // best-effort
      }
    }

    const hospital = await Hospital.findById(req.hospitalId).lean();
    const hospitalName = hospital?.name || "Your Clinic";

    const token = createPrescriptionToken({
      hospitalId: String(req.hospitalId),
      patientId: patient.UMRNo,
      prescriptionId,
    });

    const cleanBase = String(viewBaseUrl).replace(/\/+$/, "");
    const viewUrl = `${cleanBase}/view/prescription/${token}`;

    const result = await sendPrescriptionWhatsApp({
      phone: patient.phone,
      patientName: patient.name,
      hospitalName,
      doctorName,
      token,
      viewUrl,
    });

    return res.json({
      success: true,
      viewUrl,
      destination: result.destination,
    });
  } catch (error) {
    console.error("Send prescription WhatsApp error:", error);

    const mapped = mapWhatsAppHttpError(error, res);
    if (mapped) return mapped;

    return res
      .status(500)
      .json({ message: "Failed to send prescription to patient." });
  }
});

module.exports = router;
