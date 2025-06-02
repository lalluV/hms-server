const express = require("express");
const router = express.Router();
const Inventory = require("../models/Inventory");

// Get all inventory items
router.get("/", async (req, res) => {
  try {
    const inventory = await Inventory.find({});
    res.json(inventory);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get inventory item by ID
router.get("/:id", async (req, res) => {
  try {
    const item = await Inventory.findOne({ id: req.params.id });
    if (!item) {
      return res.status(404).json({ message: "Inventory item not found" });
    }
    res.json(item);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new inventory item
router.post("/", async (req, res) => {
  try {
    const item = new Inventory(req.body);
    const newItem = await item.save();
    res.status(201).json(newItem);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update inventory item
router.put("/:id", async (req, res) => {
  try {
    const item = await Inventory.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
    );
    if (!item) {
      return res.status(404).json({ message: "Inventory item not found" });
    }
    res.json(item);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete inventory item
router.delete("/:id", async (req, res) => {
  try {
    const item = await Inventory.findOneAndDelete({ id: req.params.id });
    if (!item) {
      return res.status(404).json({ message: "Inventory item not found" });
    }
    res.json({ message: "Inventory item deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get low stock items
router.get("/low-stock", async (req, res) => {
  try {
    const items = await Inventory.find({
      $expr: { $lte: ["$quantity", "$minimumStock"] },
    });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get items by category
router.get("/category/:category", async (req, res) => {
  try {
    const items = await Inventory.find({ category: req.params.category });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
