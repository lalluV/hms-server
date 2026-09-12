const express = require("express");
const router = express.Router();
const Certificate = require("../models/Certificate");
const Hospital = require("../models/Hospital");
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const {
  generateCertificateNumber,
  prefillIpdEssentialityData,
  sendCertificateWhatsApp,
} = require("../services/certificateService");

applyTenantEntitlements(router, { moduleKey: "core" });

/**
 * GET /api/certificates
 * List issued certificates with search & filter
 */
router.get("/", async (req, res) => {
  try {
    const hospitalId = req.hospitalId;
    const { type, search, status, page = 1, limit = 50 } = req.query;

    const filter = { hospitalId };
    if (type && type !== "all") filter.type = type;
    if (status && status !== "all") filter.status = status;

    if (search) {
      filter.$or = [
        { patientName: { $regex: search, $options: "i" } },
        { UMRNo: { $regex: search, $options: "i" } },
        { certificateNumber: { $regex: search, $options: "i" } },
        { doctorName: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [certificates, total] = await Promise.all([
      Certificate.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Certificate.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: certificates,
      pagination: {
        total,
        page: Number(page),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error("Error listing certificates:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch certificates",
    });
  }
});

/**
 * GET /api/certificates/prefill-ipd/:admissionId
 * Auto-extracts IP medications, labs, and stay details for Form B Essentiality Certificate
 */
router.get("/prefill-ipd/:admissionId", async (req, res) => {
  try {
    const hospitalId = req.hospitalId;
    const { admissionId } = req.params;

    const prefill = await prefillIpdEssentialityData(hospitalId, admissionId);
    res.json({
      success: true,
      data: prefill,
    });
  } catch (error) {
    console.error("Error prefilling IPD essentiality certificate:", error);
    res.status(500).json({
      message: error.message || "Failed to prefill IP admission data",
    });
  }
});

/**
 * GET /api/certificates/:id
 * Get single certificate details along with hospital letterhead metadata
 */
router.get("/:id", async (req, res) => {
  try {
    const hospitalId = req.hospitalId;
    const [certificate, hospital] = await Promise.all([
      Certificate.findOne({ _id: req.params.id, hospitalId }).lean(),
      Hospital.findById(hospitalId).lean(),
    ]);

    if (!certificate) {
      return res.status(404).json({ message: "Certificate not found" });
    }

    res.json({
      success: true,
      data: {
        ...certificate,
        hospitalInfo: {
          name: hospital?.name || "Hospital",
          phone: hospital?.phone || "",
          email: hospital?.email || "",
          address: hospital?.address || {},
          gstNumber: hospital?.settings?.gstNumber || "",
          drugLicenseNumber: hospital?.settings?.drugLicenseNumber || "",
        },
      },
    });
  } catch (error) {
    console.error("Error fetching certificate details:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch certificate",
    });
  }
});

/**
 * POST /api/certificates
 * Create and issue a new certificate
 */
router.post("/", async (req, res) => {
  try {
    const hospitalId = req.hospitalId;
    const certData = { ...req.body, hospitalId };

    if (!certData.type) {
      return res.status(400).json({ message: "Certificate type is required" });
    }
    if (!certData.patientName || !certData.UMRNo) {
      return res.status(400).json({ message: "Patient name and UMR number are required" });
    }
    if (!certData.doctorName) {
      return res.status(400).json({ message: "Doctor name is required" });
    }

    if (!certData.certificateNumber) {
      certData.certificateNumber = await generateCertificateNumber(hospitalId, certData.type);
    }

    if (!certData.issuedDate) {
      certData.issuedDate = new Date().toISOString().split("T")[0];
    }

    const certificate = await Certificate.create(certData);

    // If autoSendWhatsApp requested
    if (req.body.autoSendWhatsApp && certData.phone) {
      sendCertificateWhatsApp(certificate._id, hospitalId).catch((err) => {
        console.error("Background WhatsApp certificate dispatch error:", err.message);
      });
    }

    res.status(201).json({
      success: true,
      message: "Certificate issued successfully",
      data: certificate,
    });
  } catch (error) {
    console.error("Error issuing certificate:", error);
    res.status(500).json({
      message: error.message || "Failed to issue certificate",
    });
  }
});

/**
 * PUT /api/certificates/:id
 * Update an existing certificate
 */
router.put("/:id", async (req, res) => {
  try {
    const hospitalId = req.hospitalId;
    const certificate = await Certificate.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      { $set: req.body },
      { new: true }
    );

    if (!certificate) {
      return res.status(404).json({ message: "Certificate not found" });
    }

    res.json({
      success: true,
      message: "Certificate updated successfully",
      data: certificate,
    });
  } catch (error) {
    console.error("Error updating certificate:", error);
    res.status(500).json({
      message: error.message || "Failed to update certificate",
    });
  }
});

/**
 * DELETE /api/certificates/:id
 * Soft cancel a certificate
 */
router.delete("/:id", async (req, res) => {
  try {
    const hospitalId = req.hospitalId;
    const certificate = await Certificate.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      { $set: { status: "cancelled" } },
      { new: true }
    );

    if (!certificate) {
      return res.status(404).json({ message: "Certificate not found" });
    }

    res.json({
      success: true,
      message: "Certificate marked as cancelled",
      data: certificate,
    });
  } catch (error) {
    console.error("Error cancelling certificate:", error);
    res.status(500).json({
      message: error.message || "Failed to cancel certificate",
    });
  }
});

/**
 * POST /api/certificates/:id/send-whatsapp
 * Dispatches WhatsApp summary of certificate to patient
 */
router.post("/:id/send-whatsapp", async (req, res) => {
  try {
    const hospitalId = req.hospitalId;
    const result = await sendCertificateWhatsApp(req.params.id, hospitalId);

    res.json({
      success: true,
      message: "Certificate details sent to patient via WhatsApp",
      data: result,
    });
  } catch (error) {
    console.error("Error sending certificate via WhatsApp:", error);
    res.status(500).json({
      message: error.message || "Failed to dispatch certificate via WhatsApp",
    });
  }
});

module.exports = router;
