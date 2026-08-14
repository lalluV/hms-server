const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const { getTenantConnection } = require("../utils/tenantDb");
const Hospital = require("../models/Hospital");
const {
  sendLabReportWhatsApp,
  mapWhatsAppHttpError,
} = require("../utils/whatsappCloud");
const {
  createLabReportToken,
  verifyLabReportToken,
} = require("../utils/labReportToken");
const {
  hydrateReceipts,
  normalizeReceiptItemsForStorage,
} = require("../utils/hydrateDiagnosticParameters");

async function resolveReceiptPatientPhone(req, receipt) {
  if (!receipt) return null;

  // Live patient record is source of truth (same as prescription WhatsApp).
  if (receipt.patientId) {
    try {
      const Patient = req.tenantDb.model("Patient");
      const patient = await Patient.findOne({
        UMRNo: receipt.patientId,
        hospitalId: req.hospitalId,
      })
        .select("phone")
        .lean();
      if (patient?.phone) {
        return patient.phone;
      }
    } catch (err) {
      console.warn("Could not load patient phone for lab WhatsApp:", err);
    }
  }

  if (receipt.patientPhone) {
    return receipt.patientPhone;
  }

  if (receipt.patientData?.phone) {
    return receipt.patientData.phone;
  }

  return null;
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

function hasResultValue(value) {
  if (value == null) return false;
  if (typeof value === "string" && !value.trim()) return false;
  return true;
}

function buildPublicReceipt(receipt) {
  if (!receipt) return null;

  const items = (Array.isArray(receipt.items) ? receipt.items : [])
    .filter((item) => item.deptname !== "Radiology")
    .map((item) => ({
      name: item.name,
      code: item.code,
      deptname: item.deptname,
      resultStatus: item.resultStatus,
      completedAt: item.completedAt,
      parameters: (item.parameters || [])
        .filter((param) => hasResultValue(param.result))
        .map((param) => ({
          name: param.name,
          result: param.result,
          units: param.units,
          normal_range: param.normal_range,
          isAbnormal: param.isAbnormal,
          remarks: param.remarks,
        })),
    }))
    .filter((item) => item.parameters.length > 0);

  return {
    receiptId: receipt.receiptId,
    patientName: receipt.patientName,
    patientPhone: receipt.patientPhone,
    createdAt: receipt.createdAt,
    items,
  };
}

/**
 * PUBLIC (no auth): view a lab report via a signed token.
 * GET /api/diagnostics-receipts/public/:token
 */
router.get("/public/:token", async (req, res) => {
  try {
    let decoded;
    try {
      decoded = verifyLabReportToken(req.params.token);
    } catch {
      return res.status(400).json({ message: "Invalid or expired link." });
    }

    const { hospitalId, receiptId } = decoded;
    if (!mongoose.Types.ObjectId.isValid(hospitalId)) {
      return res.status(400).json({ message: "Invalid or expired link." });
    }

    const hospitalObjectId = new mongoose.Types.ObjectId(hospitalId);
    const connection = await getTenantConnection(hospitalId);
    if (!connection) {
      return res.status(500).json({ message: "Unable to load lab report." });
    }

    const DiagnosticsReceipt = connection.model("DiagnosticsReceipt");
    const Parameter = connection.model("Parameter");

    let receipt = null;
    if (mongoose.Types.ObjectId.isValid(String(receiptId))) {
      receipt = await DiagnosticsReceipt.findOne({
        _id: receiptId,
        hospitalId: hospitalObjectId,
      }).lean();
    }
    if (!receipt) {
      receipt = await DiagnosticsReceipt.findOne({
        receiptId: String(receiptId),
        hospitalId: hospitalObjectId,
      }).lean();
    }

    if (!receipt) {
      return res.status(404).json({ message: "Lab report not found." });
    }

    const [hydrated] = await hydrateReceipts(
      Parameter,
      hospitalObjectId,
      [receipt],
    );
    const publicReceipt = buildPublicReceipt(hydrated);
    if (!publicReceipt?.items?.length) {
      return res
        .status(404)
        .json({ message: "No lab results are available for this report yet." });
    }

    const hospitalPromise = Hospital.findById(hospitalId)
      .select("name address city state zipCode phone logoUrl")
      .lean();

    const Stamp = connection.model("Stamp");
    const Staff = connection.model("Staff");

    const stampsPromise = Stamp.find({ isActive: true }).lean().catch(() => []);

    const doctorSearch =
      receipt.verifiedBy ||
      receipt.completedBy ||
      receipt.doctorName ||
      receipt.doctor?.name ||
      (typeof receipt.doctor === "string" ? receipt.doctor : null);

    const staffPromise = (async () => {
      try {
        if (doctorSearch) {
          const direct = await Staff.findOne(
            {
              $or: [
                { name: doctorSearch },
                { id: doctorSearch },
                { userId: doctorSearch },
              ],
              active: { $ne: false },
            },
            { name: 1, signatureUrl: 1, qualification: 1, specialization: 1 }
          ).lean();
          if (direct?.signatureUrl) return direct;
        }

        // Look for staff with Lab type/department and active signature
        let labIncharge = await Staff.findOne(
          {
            $or: [
              { type: { $in: ["LabTechnician", "Lab Incharge", "LabIncharge", "Pathologist", "Laboratory"] } },
              { department: "Laboratory" },
              { position: /lab|patholog/i },
            ],
            active: { $ne: false },
            signatureUrl: { $exists: true, $ne: null, $ne: "" },
          },
          { name: 1, signatureUrl: 1, qualification: 1, specialization: 1 }
        ).lean();

        // Fallback: any active staff with signature
        if (!labIncharge?.signatureUrl) {
          labIncharge = await Staff.findOne(
            {
              active: { $ne: false },
              signatureUrl: { $exists: true, $ne: null, $ne: "" },
            },
            { name: 1, signatureUrl: 1, qualification: 1, specialization: 1 }
          ).lean();
        }

        return labIncharge;
      } catch (err) {
        console.error("Error fetching lab incharge signature:", err);
        return null;
      }
    })();

    const [hospital, stamps, staffDoc] = await Promise.all([
      hospitalPromise,
      stampsPromise,
      staffPromise,
    ]);

    const departmentStamp =
      (stamps || []).find((s) => s.department === "Laboratory" && s.isDefault) ||
      (stamps || []).find((s) => s.department === "Laboratory") ||
      null;

    const hospitalStamp =
      (stamps || []).find((s) => s.category === "hospital" && s.isDefault) ||
      (stamps || []).find((s) => s.category === "hospital") ||
      null;

    return res.json({
      hospital: buildPublicHospital(hospital),
      receipt: publicReceipt,
      departmentStamp: departmentStamp
        ? { imageUrl: departmentStamp.imageUrl, name: departmentStamp.name }
        : null,
      hospitalStamp: hospitalStamp
        ? { imageUrl: hospitalStamp.imageUrl, name: hospitalStamp.name }
        : null,
      signatureUrl: staffDoc?.signatureUrl || null,
      signerName: staffDoc?.name || (typeof doctorSearch === "string" ? doctorSearch : ""),
      signatureLabel: "Lab Incharge",
    });
  } catch (error) {
    console.error("Public lab report view error:", error);
    return res.status(500).json({ message: "Unable to load lab report." });
  }
});

applyTenantEntitlements(router, { moduleKey: "lab" });

async function withLiveParameters(req, receipts) {
  const Parameter = req.tenantDb.model("Parameter");
  return hydrateReceipts(Parameter, req.hospitalId, receipts);
}

async function findReceiptByIdOrNumber(DiagnosticsReceipt, hospitalId, id) {
  if (id && mongoose.Types.ObjectId.isValid(String(id))) {
    const byOid = await DiagnosticsReceipt.findOne({
      _id: id,
      hospitalId,
    });
    if (byOid) return byOid;
  }
  return DiagnosticsReceipt.findOne({ receiptId: id, hospitalId });
}

// Get all diagnostics receipts with pagination support
router.get("/", async (req, res) => {
  try {
    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");

    const {
      page = 1,
      limit = 20,
      search = "",
      type = "",
      status = "",
      patientId = "",
      startDate = "",
      endDate = "",
      visitType = "",
    } = req.query;

    const andConditions = [{ hospitalId: req.hospitalId }];

    if (type) {
      if (type.includes(",")) {
        andConditions.push({
          type: { $in: type.split(",").map((t) => t.trim()) },
        });
      } else {
        andConditions.push({ type });
      }
    }

    if (status) {
      andConditions.push({
        $or: [{ overallStatus: status }, { status: status }],
      });
    }

    if (patientId) {
      andConditions.push({
        $or: [
          { patientId: patientId },
          { UMRNo: patientId },
          { "patientData.UMRNo": patientId },
        ],
      });
    }

    if (visitType === "IP") {
      andConditions.push({
        $or: [
          { visitType: { $regex: /^IP$/i } },
          { admissionId: { $exists: true, $nin: [null, ""] } },
          { "patientData.patient_type": { $in: ["IP", "OPtoIP", "OPTOIP"] } },
        ],
      });
    } else if (visitType === "OP") {
      andConditions.push({
        $or: [
          { visitType: { $regex: /^OP$/i } },
          { visitType: null },
          { visitType: "" },
          { visitType: { $exists: false } },
          {
            visitType: {
              $in: ["Center", "Home Visit", "Direct", "OP", "op"],
            },
          },
        ],
        admissionId: { $in: [null, ""] },
        "patientData.patient_type": { $nin: ["IP", "OPtoIP", "OPTOIP"] },
      });
    }

    if (startDate && endDate) {
      andConditions.push({
        createdAt: {
          $gte: new Date(startDate),
          $lte: new Date(endDate),
        },
      });
    } else if (startDate) {
      andConditions.push({ createdAt: { $gte: new Date(startDate) } });
    } else if (endDate) {
      andConditions.push({ createdAt: { $lte: new Date(endDate) } });
    }

    if (search && search.trim()) {
      const s = search.trim();
      andConditions.push({
        $or: [
          { receiptId: { $regex: s, $options: "i" } },
          { patientId: { $regex: s, $options: "i" } },
          { UMRNo: { $regex: s, $options: "i" } },
          { patientName: { $regex: s, $options: "i" } },
          { patientPhone: { $regex: s, $options: "i" } },
          { "patientData.name": { $regex: s, $options: "i" } },
          { "patientData.phone": { $regex: s, $options: "i" } },
          { "patientData.UMRNo": { $regex: s, $options: "i" } },
          { "doctorData.name": { $regex: s, $options: "i" } },
          { "items.name": { $regex: s, $options: "i" } },
          { "items.code": { $regex: s, $options: "i" } },
        ],
      });
    }

    const query =
      andConditions.length > 1 ? { $and: andConditions } : andConditions[0];

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const total = await DiagnosticsReceipt.countDocuments(query);

    const receipts = await DiagnosticsReceipt.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    const hydrated = await withLiveParameters(req, receipts);

    res.json({
      receipts: hydrated,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(total / limitNum),
        totalItems: total,
        itemsPerPage: limitNum,
        hasNextPage: pageNum < Math.ceil(total / limitNum),
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics receipt by ID
router.get("/:id", async (req, res) => {
  try {
    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
    const receipt = await findReceiptByIdOrNumber(
      DiagnosticsReceipt,
      req.hospitalId,
      req.params.id,
    );
    if (!receipt) {
      return res.status(404).json({ message: "Diagnostics receipt not found" });
    }
    const hydrated = await withLiveParameters(req, receipt);
    res.json(hydrated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new diagnostics receipt
router.post("/", async (req, res) => {
  try {
    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
    const body = { ...req.body };
    if (Array.isArray(body.items)) {
      body.items = normalizeReceiptItemsForStorage(body.items);
    }
    const receipt = new DiagnosticsReceipt({
      ...body,
      hospitalId: req.hospitalId,
    });
    const newReceipt = await receipt.save();
    const hydrated = await withLiveParameters(req, newReceipt);
    res.status(201).json(hydrated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update diagnostics receipt
router.put("/:id", async (req, res) => {
  try {
    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
    const body = { ...req.body };
    if (Array.isArray(body.items)) {
      body.items = normalizeReceiptItemsForStorage(body.items);
    }
    const receipt = await DiagnosticsReceipt.findOneAndUpdate(
      { _id: req.params.id, hospitalId: req.hospitalId },
      body,
      { new: true },
    );
    if (!receipt) {
      return res.status(404).json({ message: "Diagnostics receipt not found" });
    }
    const hydrated = await withLiveParameters(req, receipt);
    res.json(hydrated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

/**
 * AUTHENTICATED: notify patient that lab reports are ready via WhatsApp.
 * POST /api/diagnostics-receipts/:id/send-whatsapp
 * Body: { viewBaseUrl: string }
 */
router.post("/:id/send-whatsapp", async (req, res) => {
  try {
    const { viewBaseUrl } = req.body || {};
    if (!viewBaseUrl) {
      return res
        .status(400)
        .json({ message: "viewBaseUrl is required to build the view link." });
    }

    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
    const receipt = await DiagnosticsReceipt.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    }).lean();

    if (!receipt) {
      return res.status(404).json({ message: "Diagnostics receipt not found" });
    }

    const phone = await resolveReceiptPatientPhone(req, receipt);
    if (!phone) {
      return res
        .status(400)
        .json({ message: "Patient does not have a mobile number on file." });
    }

    const items = Array.isArray(receipt.items) ? receipt.items : [];
    const testsSummary =
      items
        .map((item) => item.testName || item.name || item.description)
        .filter(Boolean)
        .slice(0, 5)
        .join(", ") || "your lab tests";

    const hospital = await Hospital.findById(req.hospitalId).lean();
    const hospitalName = hospital?.name || "Your Clinic";

    const token = createLabReportToken({
      hospitalId: String(req.hospitalId),
      receiptId: String(receipt._id),
    });

    const cleanBase = String(viewBaseUrl).replace(/\/+$/, "");
    const viewUrl = `${cleanBase}/view/report/${token}`;

    const result = await sendLabReportWhatsApp({
      phone,
      patientName: receipt.patientName,
      hospitalName,
      testsSummary,
      token,
    });

    return res.json({
      success: true,
      viewUrl,
      destination: result.destination,
      testsSummary,
    });
  } catch (error) {
    console.error("Send lab report WhatsApp error:", error);
    const mapped = mapWhatsAppHttpError(error, res);
    if (mapped) return mapped;
    return res
      .status(500)
      .json({ message: "Failed to send lab report WhatsApp message." });
  }
});

// Delete diagnostics receipt
router.delete("/:id", async (req, res) => {
  try {
    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
    const receipt = await DiagnosticsReceipt.findOneAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!receipt) {
      return res.status(404).json({ message: "Diagnostics receipt not found" });
    }
    res.json({ message: "Diagnostics receipt deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics receipts by patient
router.get("/patient/:patientId", async (req, res) => {
  try {
    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
    const receipts = await DiagnosticsReceipt.find({
      patientId: req.params.patientId,
      hospitalId: req.hospitalId,
    });
    const hydrated = await withLiveParameters(req, receipts);
    res.json(hydrated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics receipts by type
router.get("/type/:type", async (req, res) => {
  try {
    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
    const receipts = await DiagnosticsReceipt.find({
      type: req.params.type,
      hospitalId: req.hospitalId,
    });
    const hydrated = await withLiveParameters(req, receipts);
    res.json(hydrated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics receipts by status
router.get("/status/:status", async (req, res) => {
  try {
    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
    const receipts = await DiagnosticsReceipt.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
    });
    const hydrated = await withLiveParameters(req, receipts);
    res.json(hydrated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics receipts by account phone (for mobile app)
router.get("/account/:accountPhone", async (req, res) => {
  try {
    const DiagnosticsReceipt = req.tenantDb.model("DiagnosticsReceipt");
    const Patient = req.tenantDb.model("Patient");
    const accountPhone = req.params.accountPhone;

    const patients = await Patient.find({
      phone: accountPhone,
      hospitalId: req.hospitalId,
    });
    const patientIds = patients
      .map((p) => p.UMRNo || p.patientId)
      .filter(Boolean);

    const query = {
      hospitalId: req.hospitalId,
      $or: [{ patientPhone: accountPhone }],
    };
    if (patientIds.length > 0) {
      query.$or.push({ patientId: { $in: patientIds } });
    }

    const receipts = await DiagnosticsReceipt.find(query).sort({
      createdAt: -1,
    });
    const hydrated = await withLiveParameters(req, receipts);
    res.json(hydrated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
