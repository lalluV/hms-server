const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);

// Get all leaves
router.get("/", async (req, res) => {
  try {
    const Leave = req.tenantDb.model("Leave");
    const leaves = await Leave.find({ hospitalId: req.hospitalId });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get leave by ID
router.get("/:id", async (req, res) => {
  try {
    const Leave = req.tenantDb.model("Leave");
    // Try to find by id first, then by _id
    let leave = await Leave.findOne({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });

    // If not found by id, try by _id
    if (!leave) {
      leave = await Leave.findOne({
        _id: req.params.id,
        hospitalId: req.hospitalId,
      });
    }

    if (!leave) {
      return res.status(404).json({ message: "Leave not found" });
    }
    res.json(leave);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new leave request
router.post("/", async (req, res) => {
  try {
    const Leave = req.tenantDb.model("Leave");
    const leave = new Leave({ ...req.body, hospitalId: req.hospitalId });
    const newLeave = await leave.save();
    res.status(201).json(newLeave);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update leave request
router.put("/:id", async (req, res) => {
  try {
    const Leave = req.tenantDb.model("Leave");
    // Try to find by id first, then by _id
    let leave = await Leave.findOneAndUpdate(
      { id: req.params.id, hospitalId: req.hospitalId },
      req.body,
      {
        new: true,
      }
    );

    // If not found by id, try by _id
    if (!leave) {
      leave = await Leave.findOneAndUpdate(
        { _id: req.params.id, hospitalId: req.hospitalId },
        req.body,
        {
          new: true,
        }
      );
    }

    if (!leave) {
      return res.status(404).json({ message: "Leave not found" });
    }
    res.json(leave);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete leave request
router.delete("/:id", async (req, res) => {
  try {
    const Leave = req.tenantDb.model("Leave");
    // Try to find by id first, then by _id
    let leave = await Leave.findOneAndDelete({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });

    // If not found by id, try by _id
    if (!leave) {
      leave = await Leave.findOneAndDelete({
        _id: req.params.id,
        hospitalId: req.hospitalId,
      });
    }

    if (!leave) {
      return res.status(404).json({ message: "Leave not found" });
    }
    res.json({ message: "Leave deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get leaves by staff ID
router.get("/staff/:staffId", async (req, res) => {
  try {
    const Leave = req.tenantDb.model("Leave");
    const leaves = await Leave.find({
      employeeId: req.params.staffId,
      hospitalId: req.hospitalId,
    });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get leaves by status
router.get("/status/:status", async (req, res) => {
  try {
    const Leave = req.tenantDb.model("Leave");
    const leaves = await Leave.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
    });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get leaves by date range
router.get("/date-range", async (req, res) => {
  try {
    const Leave = req.tenantDb.model("Leave");
    const { startDate, endDate } = req.query;
    const leaves = await Leave.find({
      startDate: { $lte: new Date(endDate) },
      endDate: { $gte: new Date(startDate) },
      hospitalId: req.hospitalId,
    });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
