const express = require("express");
const router = express.Router();
const LabInventory = require("../models/LabInventory");

// Get all lab inventory items
router.get("/", async (req, res) => {
  try {
    const items = await LabInventory.find();
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get lab inventory item by ID
router.get("/:id", async (req, res) => {
  try {
    const item = await LabInventory.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Lab inventory item not found" });
    }
    res.json(item);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create lab inventory item
router.post("/", async (req, res) => {
  const item = new LabInventory(req.body);
  try {
    const newItem = await item.save();
    res.status(201).json(newItem);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update lab inventory item
router.put("/:id", async (req, res) => {
  try {
    const item = await LabInventory.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!item) {
      return res.status(404).json({ message: "Lab inventory item not found" });
    }
    res.json(item);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete lab inventory item
router.delete("/:id", async (req, res) => {
  try {
    const item = await LabInventory.findByIdAndDelete(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Lab inventory item not found" });
    }
    res.json({ message: "Lab inventory item deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get lab inventory items by category
router.get("/category/:category", async (req, res) => {
  try {
    const items = await LabInventory.find({ category: req.params.category });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get lab inventory items by status
router.get("/status/:status", async (req, res) => {
  try {
    const items = await LabInventory.find({ status: req.params.status });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get low stock items
router.get("/stock/low", async (req, res) => {
  try {
    const items = await LabInventory.find({ stock: { $lt: 10 } });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
