const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);

// Get all wards
router.get("/", async (req, res) => {
  try {
    const Ward = req.tenantDb.model("Ward");
    const wards = await Ward.find({ hospitalId: req.hospitalId });
    res.json(wards);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get ward by ID
router.get("/:id", async (req, res) => {
  try {
    const Ward = req.tenantDb.model("Ward");
    const ward = await Ward.findOne({
      wardId: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!ward) {
      return res.status(404).json({ message: "Ward not found" });
    }
    res.json(ward);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new ward
router.post("/", async (req, res) => {
  try {
    const Ward = req.tenantDb.model("Ward");
    const ward = new Ward({
      ...req.body,
      hospitalId: req.hospitalId,
    });
    const newWard = await ward.save();
    res.status(201).json(newWard);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update ward
router.put("/:id", async (req, res) => {
  try {
    const Ward = req.tenantDb.model("Ward");
    const ward = await Ward.findOneAndUpdate(
      { wardId: req.params.id, hospitalId: req.hospitalId },
      req.body,
      {
        new: true,
      }
    );
    if (!ward) {
      return res.status(404).json({ message: "Ward not found" });
    }
    res.json(ward);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete ward
router.delete("/:id", async (req, res) => {
  try {
    const Ward = req.tenantDb.model("Ward");
    const ward = await Ward.findOneAndDelete({
      wardId: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!ward) {
      return res.status(404).json({ message: "Ward not found" });
    }
    res.json({ message: "Ward deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get ward by type
router.get("/type/:type", async (req, res) => {
  try {
    const Ward = req.tenantDb.model("Ward");
    const wards = await Ward.find({
      type: req.params.type,
      hospitalId: req.hospitalId,
    });
    res.json(wards);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get ward by status
router.get("/status/:status", async (req, res) => {
  try {
    const Ward = req.tenantDb.model("Ward");
    const wards = await Ward.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
    });
    res.json(wards);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
