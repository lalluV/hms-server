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

function buildPublicPrescription(prescription) {
  if (!prescription || typeof prescription !== "object") return null;

  // Drop bulky nested blobs patients don't need (keeps mobile payload small).
  const medicineData = Array.isArray(prescription.medicineData)
    ? prescription.medicineData.map((med) => {
        if (!med || typeof med !== "object") return med;
        const {
          selectedMedicineData,
          masterMedicineId,
          inventoryMatch,
          sourceText,
          ...rest
        } = med;
        return rest;
      })
    : [];

  return {
    prescriptionId: prescription.prescriptionId,
    date: prescription.date,
    symptoms: prescription.symptoms,
    doctorNotes: prescription.doctorNotes || [],
    vitals: prescription.vitals || [],
    weight: prescription.weight,
    height: prescription.height,
    medicineData,
    diagnosticData: prescription.diagnosticData || [],
    pastMedicalHistory: prescription.pastMedicalHistory,
    provisionalDiagnosis: prescription.provisionalDiagnosis,
    doctorId: prescription.doctorId,
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
    const Staff = connection.model("Staff");

    // Use findOne (not aggregate $match) so Mongoose casts hospitalId the same
    // way authenticated routes do — aggregate string≠ObjectId was returning 404.
    const [patient, hospital] = await Promise.all([
      Patient.findOne(
        { UMRNo: patientId, hospitalId },
        {
          name: 1,
          age: 1,
          gender: 1,
          UMRNo: 1,
          phone: 1,
          street_address: 1,
          prescriptions: 1,
        },
      ).lean(),
      Hospital.findById(hospitalId)
        .select("name address city state zipCode phone email logoUrl")
        .lean(),
    ]);

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
        const doctorDoc = await Staff.findOne(
          { id: prescription.doctorId },
          { name: 1, qualification: 1, specialization: 1 },
        ).lean();
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

    return res.json({
      hospital: buildPublicHospital(hospital),
      doctor,
      patient: buildPublicPatient(patient),
      prescription: buildPublicPrescription(prescription),
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
