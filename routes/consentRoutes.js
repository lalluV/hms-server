const express = require("express");
const router = express.Router();
const Consent = require("../models/Consent");

// Consent routes
router.post("/", async (req, res) => {
  try {
    const consent = new Consent(req.body);
    await consent.save();
    res.status(201).json(consent);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const consents = await Consent.find({});
    res.json(consents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const consent = await Consent.findById(req.params.id);
    if (!consent) {
      return res.status(404).json({ message: "Consent not found" });
    }
    res.json(consent);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/patient/:patientId", async (req, res) => {
  try {
    const consents = await Consent.find({ patientId: req.params.patientId });
    res.json(consents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const consent = await Consent.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    );
    if (!consent) {
      return res.status(404).json({ message: "Consent not found" });
    }
    res.json(consent);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const consent = await Consent.findByIdAndDelete(req.params.id);
    if (!consent) {
      return res.status(404).json({ message: "Consent not found" });
    }
    res.json({ message: "Consent deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
