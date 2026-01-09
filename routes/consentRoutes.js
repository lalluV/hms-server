const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);

// Consent routes
router.post("/", async (req, res) => {
  try {
    const Consent = req.tenantDb.model("Consent");
    const consent = new Consent({ ...req.body, hospitalId: req.hospitalId });
    await consent.save();
    res.status(201).json(consent);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const Consent = req.tenantDb.model("Consent");
    const consents = await Consent.find({ hospitalId: req.hospitalId });
    res.json(consents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const Consent = req.tenantDb.model("Consent");
    const consent = await Consent.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
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
    const Consent = req.tenantDb.model("Consent");
    const consents = await Consent.find({
      patientId: req.params.patientId,
      hospitalId: req.hospitalId,
    });
    res.json(consents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const Consent = req.tenantDb.model("Consent");
    const consent = await Consent.findOneAndUpdate(
      { _id: req.params.id, hospitalId: req.hospitalId },
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
    const Consent = req.tenantDb.model("Consent");
    const consent = await Consent.findOneAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!consent) {
      return res.status(404).json({ message: "Consent not found" });
    }
    res.json({ message: "Consent deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
