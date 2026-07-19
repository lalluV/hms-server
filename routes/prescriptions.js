const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const { getTenantConnection } = require("../utils/tenantDb");
const Hospital = require("../models/Hospital");
const {
  createPrescriptionToken,
  verifyPrescriptionToken,
} = require("../utils/prescriptionToken");
const { sendPrescriptionWhatsApp } = require("../utils/aisensy");

function findPrescription(patient, prescriptionId) {
  if (!patient || !Array.isArray(patient.prescriptions)) return null;
  return (
    patient.prescriptions.find(
      (p) => String(p.prescriptionId) === String(prescriptionId),
    ) || null
  );
}

function getVisitNumber(patient, prescriptionId) {
  const prescriptions = Array.isArray(patient?.prescriptions)
    ? patient.prescriptions
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
    street_address: patient.street_address,
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
    email: hospital.email,
    logoUrl: hospital.logoUrl,
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
    const patient = await Patient.findOne({
      UMRNo: patientId,
      hospitalId,
    }).lean();

    if (!patient) {
      return res.status(404).json({ message: "Prescription not found." });
    }

    const prescription = findPrescription(patient, prescriptionId);
    if (!prescription) {
      return res.status(404).json({ message: "Prescription not found." });
    }

    let doctor = null;
    if (prescription.doctorId) {
      try {
        const Staff = connection.model("Staff");
        const doctorDoc = await Staff.findOne({
          id: prescription.doctorId,
        }).lean();
        if (doctorDoc) {
          doctor = {
            name: doctorDoc.name,
            qualification: doctorDoc.qualification,
            specialization: doctorDoc.specialization,
          };
        }
      } catch (err) {
        // doctor lookup is best-effort; ignore failures
      }
    }

    const hospital = await Hospital.findById(hospitalId).lean();

    return res.json({
      hospital: buildPublicHospital(hospital),
      doctor,
      patient: buildPublicPatient(patient),
      prescription,
      visitNumber: getVisitNumber(patient, prescriptionId),
      totalVisits: Array.isArray(patient.prescriptions)
        ? patient.prescriptions.length
        : 0,
    });
  } catch (error) {
    console.error("Public prescription view error:", error);
    return res.status(500).json({ message: "Unable to load prescription." });
  }
});

// Everything below requires authentication + active subscription + tenant DB
applyTenantEntitlements(router, { moduleKey: "core" });

/**
 * AUTHENTICATED: send the prescription to the patient via WhatsApp (AiSensy).
 * POST /api/prescriptions/:patientId/:prescriptionId/send-whatsapp
 * Body: { viewBaseUrl: string }  (e.g. https://hs-xxxx.healeka.com)
 */
router.post(
  "/:patientId/:prescriptionId/send-whatsapp",
  async (req, res) => {
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
        viewUrl,
        doctorName,
      });

      return res.json({
        success: true,
        viewUrl,
        destination: result.destination,
      });
    } catch (error) {
      console.error("Send prescription WhatsApp error:", error);

      if (error.code === "AISENSY_NOT_CONFIGURED") {
        return res.status(503).json({
          message:
            "WhatsApp sending is not configured. Please contact the administrator.",
        });
      }
      if (error.code === "INVALID_DESTINATION") {
        return res.status(400).json({ message: error.message });
      }
      if (error.code === "AISENSY_SEND_FAILED") {
        return res.status(502).json({
          message: error.message || "Failed to send WhatsApp message.",
        });
      }

      return res
        .status(500)
        .json({ message: "Failed to send prescription to patient." });
    }
  },
);

module.exports = router;
