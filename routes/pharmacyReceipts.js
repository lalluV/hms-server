const express = require("express");
const router = express.Router();
const PharmacyReceipt = require("../models/PharmacyReceipt");

// Get all pharmacy receipts with pagination support
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

    // Filter by type
    if (type) {
      query.type = type;
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
        { "items.item_code": { $regex: search, $options: "i" } },
        { "items.generic_name": { $regex: search, $options: "i" } },
      ];
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count
    const total = await PharmacyReceipt.countDocuments(query);

    // Get paginated receipts
    const receipts = await PharmacyReceipt.find(query)
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

// Get pharmacy receipt by ID
router.get("/:id", async (req, res) => {
  try {
    const receipt = await PharmacyReceipt.findById({
      receiptId: req.params.id,
    });
    if (!receipt) {
      return res.status(404).json({ message: "Pharmacy receipt not found" });
    }
    res.json(receipt);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new pharmacy receipt
router.post("/", async (req, res) => {
  const receipt = new PharmacyReceipt(req.body);
  try {
    const newReceipt = await receipt.save();
    res.status(201).json(newReceipt);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update pharmacy receipt
router.put("/:id", async (req, res) => {
  try {
    const receipt = await PharmacyReceipt.findByIdAndUpdate(
      { receiptId: req.params.id },
      req.body,
      { new: true }
    );
    if (!receipt) {
      return res.status(404).json({ message: "Pharmacy receipt not found" });
    }
    res.json(receipt);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete pharmacy receipt
router.delete("/:id", async (req, res) => {
  try {
    const receipt = await PharmacyReceipt.findByIdAndDelete({
      receiptId: req.params.id,
    });
    if (!receipt) {
      return res.status(404).json({ message: "Pharmacy receipt not found" });
    }
    res.json({ message: "Pharmacy receipt deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get pharmacy receipts by type
router.get("/type/:type", async (req, res) => {
  try {
    const receipts = await PharmacyReceipt.find({ type: req.params.type });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get pharmacy receipts by patient
router.get("/patient/:patientId", async (req, res) => {
  try {
    const receipts = await PharmacyReceipt.find({
      patientId: req.params.patientId,
    });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get pharmacy receipts by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const receipts = await PharmacyReceipt.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get pharmacy receipts by status
router.get("/status/:status", async (req, res) => {
  try {
    const receipts = await PharmacyReceipt.find({ status: req.params.status });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update pharmacy receipt status
router.patch("/:id/status", async (req, res) => {
  try {
    const receipt = await PharmacyReceipt.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    if (!receipt) {
      return res.status(404).json({ message: "Pharmacy receipt not found" });
    }
    res.json(receipt);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;
