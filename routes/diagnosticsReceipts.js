const express = require("express");
const router = express.Router();
const DiagnosticsReceipt = require("../models/DiagnosticsReceipt");

// Get all diagnostics receipts
router.get("/", async (req, res) => {
  try {
    const receipts = await DiagnosticsReceipt.find();
    res.json(receipts);
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
    const receipt = await DiagnosticsReceipt.findOneAndUpdate(
      { receiptId: req.params.id },
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

module.exports = router;
