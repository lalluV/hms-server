const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);

// Get all advance receipts with pagination support
router.get("/", async (req, res) => {
  try {
    const AdvanceReceipt = req.tenantDb.model("AdvanceReceipt");
    
    const {
      page = 1,
      limit = 20,
      search = "",
      status = "",
      patientId = "",
      startDate = "",
      endDate = "",
    } = req.query;

    // Build query
    const query = { hospitalId: req.hospitalId };

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
      query.date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (startDate) {
      query.date = { $gte: new Date(startDate) };
    } else if (endDate) {
      query.date = { $lte: new Date(endDate) };
    }

    // Search filter
    if (search && search.length >= 2) {
      query.$or = [
        { receiptId: { $regex: search, $options: "i" } },
        { patientId: { $regex: search, $options: "i" } },
        { patientName: { $regex: search, $options: "i" } },
      ];
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count
    const total = await AdvanceReceipt.countDocuments(query);

    // Get paginated receipts
    const receipts = await AdvanceReceipt.find(query)
      .sort({ date: -1 })
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

// Get advance receipt by ID
router.get("/:id", async (req, res) => {
  try {
    const AdvanceReceipt = req.tenantDb.model("AdvanceReceipt");
    const receipt = await AdvanceReceipt.findOne({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!receipt) {
      return res.status(404).json({ message: "Advance receipt not found" });
    }
    res.json(receipt);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new advance receipt
router.post("/", async (req, res) => {
  try {
    const AdvanceReceipt = req.tenantDb.model("AdvanceReceipt");
    const receipt = new AdvanceReceipt({
      ...req.body,
      hospitalId: req.hospitalId,
    });
    const newReceipt = await receipt.save();
    res.status(201).json(newReceipt);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update advance receipt
router.put("/:id", async (req, res) => {
  try {
    const AdvanceReceipt = req.tenantDb.model("AdvanceReceipt");
    const receipt = await AdvanceReceipt.findOneAndUpdate(
      { id: req.params.id, hospitalId: req.hospitalId },
      req.body,
      { new: true }
    );
    if (!receipt) {
      return res.status(404).json({ message: "Advance receipt not found" });
    }
    res.json(receipt);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete advance receipt
router.delete("/:id", async (req, res) => {
  try {
    const AdvanceReceipt = req.tenantDb.model("AdvanceReceipt");
    const receipt = await AdvanceReceipt.findOneAndDelete({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!receipt) {
      return res.status(404).json({ message: "Advance receipt not found" });
    }
    res.json({ message: "Advance receipt deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get advance receipts by patient ID
router.get("/patient/:patientId", async (req, res) => {
  try {
    const AdvanceReceipt = req.tenantDb.model("AdvanceReceipt");
    const receipts = await AdvanceReceipt.find({
      patientId: req.params.patientId,
      hospitalId: req.hospitalId,
    });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get advance receipts by status
router.get("/status/:status", async (req, res) => {
  try {
    const AdvanceReceipt = req.tenantDb.model("AdvanceReceipt");
    const receipts = await AdvanceReceipt.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
    });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get advance receipts by date range
router.get("/date-range", async (req, res) => {
  try {
    const AdvanceReceipt = req.tenantDb.model("AdvanceReceipt");
    const { startDate, endDate } = req.query;
    const receipts = await AdvanceReceipt.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      hospitalId: req.hospitalId,
    });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
