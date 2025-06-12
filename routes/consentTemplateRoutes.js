const express = require("express");
const router = express.Router();
const ConsentTemplate = require("../models/ConsentTemplate");

// Consent Template routes
router.post("/", async (req, res) => {
  try {
    const template = new ConsentTemplate(req.body);
    await template.save();
    res.status(201).json(template);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const templates = await ConsentTemplate.find({});
    res.json(templates);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const template = await ConsentTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }
    res.json(template);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const template = await ConsentTemplate.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    );
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }
    res.json(template);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const template = await ConsentTemplate.findByIdAndDelete(req.params.id);
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }
    res.json({ message: "Template deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
