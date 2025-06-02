const express = require("express");
const router = express.Router();
const InsuranceCompany = require("../models/InsuranceCompany");

// Get all insurance companies
router.get("/", async (req, res) => {
  try {
    const companies = await InsuranceCompany.find();
    res.json(companies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get insurance company by ID
router.get("/:id", async (req, res) => {
  try {
    const company = await InsuranceCompany.findById(req.params.id);
    if (!company) {
      return res.status(404).json({ message: "Insurance company not found" });
    }
    res.json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create insurance company
router.post("/", async (req, res) => {
  const company = new InsuranceCompany(req.body);
  try {
    const newCompany = await company.save();
    res.status(201).json(newCompany);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update insurance company
router.put("/:id", async (req, res) => {
  try {
    const company = await InsuranceCompany.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!company) {
      return res.status(404).json({ message: "Insurance company not found" });
    }
    res.json(company);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete insurance company
router.delete("/:id", async (req, res) => {
  try {
    const company = await InsuranceCompany.findByIdAndDelete(req.params.id);
    if (!company) {
      return res.status(404).json({ message: "Insurance company not found" });
    }
    res.json({ message: "Insurance company deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get insurance companies by status
router.get("/status/:status", async (req, res) => {
  try {
    const companies = await InsuranceCompany.find({
      status: req.params.status,
    });
    res.json(companies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get insurance companies by type
router.get("/type/:type", async (req, res) => {
  try {
    const companies = await InsuranceCompany.find({ type: req.params.type });
    res.json(companies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
