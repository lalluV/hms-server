const express = require("express");
const router = express.Router();
const AdvanceReceipt = require("../models/AdvanceReceipt");

// Get all advance receipts
router.get("/", async (req, res) => {
  try {
    const receipts = await AdvanceReceipt.find({});
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get advance receipt by ID
router.get("/:id", async (req, res) => {
  try {
    const receipt = await AdvanceReceipt.findOne({ id: req.params.id });
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
    const receipt = new AdvanceReceipt(req.body);
    const newReceipt = await receipt.save();
    res.status(201).json(newReceipt);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update advance receipt
router.put("/:id", async (req, res) => {
  try {
    const receipt = await AdvanceReceipt.findOneAndUpdate(
      { id: req.params.id },
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
    const receipt = await AdvanceReceipt.findOneAndDelete({
      id: req.params.id,
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
    const receipts = await AdvanceReceipt.find({
      patientId: req.params.patientId,
    });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get advance receipts by status
router.get("/status/:status", async (req, res) => {
  try {
    const receipts = await AdvanceReceipt.find({
      status: req.params.status,
    });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get advance receipts by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const receipts = await AdvanceReceipt.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    });
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
