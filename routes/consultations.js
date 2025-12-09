const express = require("express");
const router = express.Router();
const Consultation = require("../models/Consultation");

// Get all consultations with pagination support
router.get("/", async (req, res) => {
  try {
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
    const query = {};

    // Filter by doctor ID
    if (doctorId) {
      query.doctorId = doctorId;
    }

    // Filter by patient ID
    if (patientId) {
      query.patientId = patientId;
    }

    // Filter by status
    if (status) {
      query.status = status;
    }

    // Filter by date range
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (startDate) {
      query.createdAt = { $gte: new Date(startDate) };
    } else if (endDate) {
      query.createdAt = { $lte: new Date(endDate) };
    }

    // Search filter
    if (search && search.length >= 2) {
      query.$or = [
        { receiptId: { $regex: search, $options: "i" } },
        { patientId: { $regex: search, $options: "i" } },
        { patientName: { $regex: search, $options: "i" } },
        { doctorName: { $regex: search, $options: "i" } },
      ];
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
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

// Get consultation by ID
router.get("/:id", async (req, res) => {
  try {
    const consultation = await Consultation.findOne({ id: req.params.id });
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
    const consultation = new Consultation(req.body);
    const newConsultation = await consultation.save();
    res.status(201).json(newConsultation);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update consultation
router.put("/:id", async (req, res) => {
  try {
    const consultation = await Consultation.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
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
    const consultation = await Consultation.findOneAndDelete({
      id: req.params.id,
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
    const consultations = await Consultation.find({
      patientId: req.params.patientId,
    });
    res.json(consultations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get consultations by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const consultations = await Consultation.find({
      doctorId: req.params.doctorId,
    });
    res.json(consultations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get consultations by status
router.get("/status/:status", async (req, res) => {
  try {
    const consultations = await Consultation.find({
      status: req.params.status,
    });
    res.json(consultations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get consultations by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const consultations = await Consultation.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    });
    res.json(consultations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
