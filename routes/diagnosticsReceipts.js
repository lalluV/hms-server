const express = require("express");
const router = express.Router();
const DiagnosticsReceipt = require("../models/DiagnosticsReceipt");

// Get all diagnostics receipts with pagination support
router.get("/", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = "",
      type = "",
      status = "",
      patientId = "",
      startDate = "",
      endDate = "",
    } = req.query;

    // Build query
    const query = {};

    // Filter by type (supports single type or comma-separated multiple types)
    if (type) {
      if (type.includes(",")) {
        // Multiple types - use $in operator
        query.type = { $in: type.split(",").map((t) => t.trim()) };
      } else {
        // Single type
        query.type = type;
      }
    }

    // Filter by status
    if (status) {
      query.status = status;
    }

    // Filter by patient ID
    if (patientId) {
      query.patientId = patientId;
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
        { "items.name": { $regex: search, $options: "i" } },
        { "items.code": { $regex: search, $options: "i" } },
      ];
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count
    const total = await DiagnosticsReceipt.countDocuments(query);

    // Get paginated receipts
    const receipts = await DiagnosticsReceipt.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      receipts: receipts,
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
    const receipt = await DiagnosticsReceipt.findById(req.params.id);
    if (!receipt) {
      return res.status(404).json({ message: "Diagnostics receipt not found" });
    }
    res.json(receipt);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new diagnostics receipt
router.post("/", async (req, res) => {
  const receipt = new DiagnosticsReceipt(req.body);
  try {
    const newReceipt = await receipt.save();
    res.status(201).json(newReceipt);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update diagnostics receipt
router.put("/:id", async (req, res) => {
  try {
    const receipt = await DiagnosticsReceipt.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!receipt) {
      return res.status(404).json({ message: "Diagnostics receipt not found" });
    }
    res.json(receipt);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete diagnostics receipt
router.delete("/:id", async (req, res) => {
  try {
    const receipt = await DiagnosticsReceipt.findByIdAndDelete(req.params.id);
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
    const receipts = await DiagnosticsReceipt.find({
      patientId: req.params.patientId,
    });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics receipts by type
router.get("/type/:type", async (req, res) => {
  try {
    const receipts = await DiagnosticsReceipt.find({ type: req.params.type });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics receipts by status
router.get("/status/:status", async (req, res) => {
  try {
    const receipts = await DiagnosticsReceipt.find({
      status: req.params.status,
    });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics receipts by account phone (for mobile app)
router.get("/account/:accountPhone", async (req, res) => {
  try {
    const receipts = await DiagnosticsReceipt.find({
      accountPhone: req.params.accountPhone,
    });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
