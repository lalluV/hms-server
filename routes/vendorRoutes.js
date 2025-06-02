const express = require("express");
const router = express.Router();
const Vendor = require("../models/Vendor");

// Get all vendors
router.get("/", async (req, res) => {
  try {
    const vendors = await Vendor.find();
    res.json(vendors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get vendor by ID
router.get("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }
    res.json(vendor);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create vendor
router.post("/", async (req, res) => {
  const vendor = new Vendor(req.body);
  try {
    const newVendor = await vendor.save();
    res.status(201).json(newVendor);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update vendor
router.put("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }
    res.json(vendor);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete vendor
router.delete("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findByIdAndDelete(req.params.id);
    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }
    res.json({ message: "Vendor deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get vendors by type
router.get("/type/:type", async (req, res) => {
  try {
    const vendors = await Vendor.find({ type: req.params.type });
    res.json(vendors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get vendors by status
router.get("/status/:status", async (req, res) => {
  try {
    const vendors = await Vendor.find({ status: req.params.status });
    res.json(vendors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
