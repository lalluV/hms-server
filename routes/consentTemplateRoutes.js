const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);

// Consent Template routes
router.post("/", async (req, res) => {
  try {
    const ConsentTemplate = req.tenantDb.model("ConsentTemplate");
    const template = new ConsentTemplate({
      ...req.body,
      hospitalId: req.hospitalId,
    });
    await template.save();
    res.status(201).json(template);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const ConsentTemplate = req.tenantDb.model("ConsentTemplate");
    const templates = await ConsentTemplate.find({
      hospitalId: req.hospitalId,
    });
    res.json(templates);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const ConsentTemplate = req.tenantDb.model("ConsentTemplate");
    const template = await ConsentTemplate.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
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
    const ConsentTemplate = req.tenantDb.model("ConsentTemplate");
    const template = await ConsentTemplate.findOneAndUpdate(
      { _id: req.params.id, hospitalId: req.hospitalId },
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
    const ConsentTemplate = req.tenantDb.model("ConsentTemplate");
    const template = await ConsentTemplate.findOneAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }
    res.json({ message: "Template deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
