const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);

// Get all stamps
router.get("/", async (req, res) => {
  try {
    const Stamp = req.tenantDb.model("Stamp");
    const stamps = await Stamp.find({ hospitalId: req.hospitalId }).sort({
      createdAt: -1,
    });
    res.json(stamps);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get stamp by ID
router.get("/:id", async (req, res) => {
  try {
    const Stamp = req.tenantDb.model("Stamp");
    const stamp = await Stamp.findOne({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!stamp) {
      return res.status(404).json({ message: "Stamp not found" });
    }
    res.json(stamp);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get stamps by department
router.get("/department/:department", async (req, res) => {
  try {
    const Stamp = req.tenantDb.model("Stamp");
    const stamps = await Stamp.find({
      department: req.params.department,
      isActive: true,
      hospitalId: req.hospitalId,
    }).sort({ createdAt: -1 });
    res.json(stamps);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get stamps by category
router.get("/category/:category", async (req, res) => {
  try {
    const Stamp = req.tenantDb.model("Stamp");
    const stamps = await Stamp.find({
      category: req.params.category,
      isActive: true,
      hospitalId: req.hospitalId,
    }).sort({ createdAt: -1 });
    res.json(stamps);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new stamp
router.post("/", async (req, res) => {
  try {
    const Stamp = req.tenantDb.model("Stamp");
    const stampId = "STAMP" + Math.random().toString().slice(2, 9);
    const stampData = {
      ...req.body,
      id: stampId,
      createdAt: new Date(),
      updatedAt: new Date(),
      hospitalId: req.hospitalId,
    };

    const stamp = new Stamp(stampData);
    const newStamp = await stamp.save();
    res.status(201).json(newStamp);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update stamp
router.put("/:id", async (req, res) => {
  try {
    const Stamp = req.tenantDb.model("Stamp");
    const stamp = await Stamp.findOneAndUpdate(
      { id: req.params.id, hospitalId: req.hospitalId },
      { ...req.body, updatedAt: new Date() },
      { new: true, runValidators: true }
    );

    if (!stamp) {
      return res.status(404).json({ message: "Stamp not found" });
    }

    res.json(stamp);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete stamp
router.delete("/:id", async (req, res) => {
  try {
    const Stamp = req.tenantDb.model("Stamp");
    const stamp = await Stamp.findOneAndDelete({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!stamp) {
      return res.status(404).json({ message: "Stamp not found" });
    }
    res.json({ message: "Stamp deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Toggle stamp active status
router.patch("/:id/toggle", async (req, res) => {
  try {
    const Stamp = req.tenantDb.model("Stamp");
    const stamp = await Stamp.findOne({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!stamp) {
      return res.status(404).json({ message: "Stamp not found" });
    }

    stamp.isActive = !stamp.isActive;
    stamp.updatedAt = new Date();
    await stamp.save();

    res.json(stamp);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
