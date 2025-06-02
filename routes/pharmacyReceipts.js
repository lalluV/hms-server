const express = require("express");
const router = express.Router();
const PharmacyReceipt = require("../models/PharmacyReceipt");

// Get all pharmacy receipts
router.get("/", async (req, res) => {
  try {
    const receipts = await PharmacyReceipt.find()
      .populate("patientId", "name")
      .populate("items.medicineId", "name");
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get pharmacy receipt by ID
router.get("/:id", async (req, res) => {
  try {
    const receipt = await PharmacyReceipt.findById(req.params.id)
      .populate("patientId", "name")
      .populate("items.medicineId", "name");
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
      req.params.id,
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
    const receipt = await PharmacyReceipt.findByIdAndDelete(req.params.id);
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
    const receipts = await PharmacyReceipt.find({ type: req.params.type })
      .populate("patientId", "name")
      .populate("items.medicineId", "name");
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
    })
      .populate("patientId", "name")
      .populate("items.medicineId", "name");
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
    })
      .populate("patientId", "name")
      .populate("items.medicineId", "name");
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get pharmacy receipts by status
router.get("/status/:status", async (req, res) => {
  try {
    const receipts = await PharmacyReceipt.find({ status: req.params.status })
      .populate("patientId", "name")
      .populate("items.medicineId", "name");
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
