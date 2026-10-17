const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "clinical" });

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const byId = (raw) =>
  mongoose.Types.ObjectId.isValid(raw) ? { _id: raw } : { receiptId: raw };
const toIso = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

// Get all consultations with pagination support
router.get("/", async (req, res) => {
  try {
    const Consultation = req.tenantDb.model("Consultation");

    const {
      page = 1,
      limit = 20,
      search = "",
      doctorId = "",
      patientId = "",
      status = "",
      startDate = "",
      endDate = "",
    } = req.query;

    // Build query
    const query = { hospitalId: req.hospitalId };
    const andConditions = [];

    // Filter by doctor ID (legacy top-level doctorId + doctorData nested ids)
    if (doctorId) {
      const id = String(doctorId);
      andConditions.push({
        $or: [
          { doctorId: id },
          { "doctorData.id": id },
          { "doctorData._id": id },
        ],
      });
    }

    // Filter by patient ID
    if (patientId) {
      query.patientId = patientId;
    }

    // Filter by payment status (Paid, Due, Pending Insurance Payment)
    if (status) {
      query.paymentStatus = status;
    }

    // createdAt is stored as an ISO string; compare as ISO strings.
    // For date-only endDate, include the full local calendar day (end of day UTC+buffer).
    const fromIso = startDate ? toIso(startDate) : null;
    let toIsoValue = endDate ? toIso(endDate) : null;
    if (toIsoValue && /^\d{4}-\d{2}-\d{2}$/.test(String(endDate).trim())) {
      const endOfDay = new Date(toIsoValue);
      endOfDay.setUTCHours(23, 59, 59, 999);
      toIsoValue = endOfDay.toISOString();
    }
    if (fromIso || toIsoValue) {
      query.createdAt = {};
      if (fromIso) query.createdAt.$gte = fromIso;
      if (toIsoValue) query.createdAt.$lte = toIsoValue;
    }

    // Search filter
    if (search && search.length >= 2) {
      const pattern = escapeRegex(search);
      andConditions.push({
        $or: [
          { receiptId: { $regex: pattern, $options: "i" } },
          { patientId: { $regex: pattern, $options: "i" } },
          { patientName: { $regex: pattern, $options: "i" } },
          { doctorName: { $regex: pattern, $options: "i" } },
        ],
      });
    }

    if (andConditions.length === 1) {
      Object.assign(query, andConditions[0]);
    } else if (andConditions.length > 1) {
      query.$and = andConditions;
    }

    // Calculate pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    // Get total count
    const total = await Consultation.countDocuments(query);

    // Get paginated consultations
    const consultations = await Consultation.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      consultations: consultations,
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

// Get consultations by date range
router.get("/date-range", async (req, res) => {
  try {
    const Consultation = req.tenantDb.model("Consultation");
    const { startDate, endDate } = req.query;
    const createdAt = {};
    if (toIso(startDate)) createdAt.$gte = toIso(startDate);
    if (toIso(endDate)) createdAt.$lte = toIso(endDate);
    const consultations = await Consultation.find({
      ...(Object.keys(createdAt).length ? { createdAt } : {}),
      hospitalId: req.hospitalId,
    });
    res.json(consultations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get consultation by ID
router.get("/:id", async (req, res) => {
  try {
    const Consultation = req.tenantDb.model("Consultation");
    const consultation = await Consultation.findOne({
      ...byId(req.params.id),
      hospitalId: req.hospitalId,
    });
    if (!consultation) {
      return res.status(404).json({ message: "Consultation not found" });
    }
    res.json(consultation);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new consultation
router.post("/", async (req, res) => {
  try {
    const Consultation = req.tenantDb.model("Consultation");
    const consultation = new Consultation({
      ...req.body,
      hospitalId: req.hospitalId,
    });
    const newConsultation = await consultation.save();
    res.status(201).json(newConsultation);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update consultation
router.put("/:id", async (req, res) => {
  try {
    const Consultation = req.tenantDb.model("Consultation");
    const consultation = await Consultation.findOneAndUpdate(
      { ...byId(req.params.id), hospitalId: req.hospitalId },
      { $set: (({ _id, hospitalId, ...rest }) => rest)(req.body || {}) },
      { new: true },
    );
    if (!consultation) {
      return res.status(404).json({ message: "Consultation not found" });
    }
    res.json(consultation);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete consultation
router.delete("/:id", async (req, res) => {
  try {
    const Consultation = req.tenantDb.model("Consultation");
    const consultation = await Consultation.findOneAndDelete({
      ...byId(req.params.id),
      hospitalId: req.hospitalId,
    });
    if (!consultation) {
      return res.status(404).json({ message: "Consultation not found" });
    }
    res.json({ message: "Consultation deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get consultations by patient ID
router.get("/patient/:patientId", async (req, res) => {
  try {
    const Consultation = req.tenantDb.model("Consultation");
    const consultations = await Consultation.find({
      patientId: req.params.patientId,
      hospitalId: req.hospitalId,
    });
    res.json(consultations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get consultations by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const Consultation = req.tenantDb.model("Consultation");
    const id = String(req.params.doctorId);
    const consultations = await Consultation.find({
      hospitalId: req.hospitalId,
      $or: [
        { doctorId: id },
        { "doctorData.id": id },
        { "doctorData._id": id },
      ],
    });
    res.json(consultations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get consultations by status
router.get("/status/:status", async (req, res) => {
  try {
    const Consultation = req.tenantDb.model("Consultation");
    const consultations = await Consultation.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
    });
    res.json(consultations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
