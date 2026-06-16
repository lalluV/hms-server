const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const { enrichLeavePayload } = require("../utils/enrichLeave");

applyTenantEntitlements(router, { moduleKey: "hr" });

function buildLeaveQuery(req) {
  const query = { hospitalId: req.hospitalId };
  const { status, shiftName, department, employeeId } = req.query;

  if (status) query.status = status;
  if (shiftName) query.shiftName = shiftName;
  if (department) query.department = department;
  if (employeeId) query.employeeId = employeeId;

  return query;
}

// Get leaves by staff ID (before /:id)
router.get("/staff/:staffId", async (req, res) => {
  try {
    const Leave = req.tenantDb.model("Leave");
    const Staff = req.tenantDb.model("Staff");
    const { staffId } = req.params;

    const staff = await Staff.findOne({
      hospitalId: req.hospitalId,
      $or: [{ id: staffId }, { employeeId: staffId }],
    });

    const orConditions = [{ employeeId: staffId }];
    if (staff) {
      if (staff.id) orConditions.push({ employeeId: staff.id });
      if (staff.employeeId && staff.employeeId !== staff.id) {
        orConditions.push({ employeeId: staff.employeeId });
      }
      if (staff.name) {
        orConditions.push({ employeeName: staff.name });
      }
    }

    const leaves = await Leave.find({
      hospitalId: req.hospitalId,
      $or: orConditions,
    }).sort({ createdAt: -1 });

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

// Get all leaves (optional query filters)
router.get("/", async (req, res) => {
  try {
    const Leave = req.tenantDb.model("Leave");
    const leaves = await Leave.find(buildLeaveQuery(req)).sort({
      createdAt: -1,
    });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get leave by ID
router.get("/:id", async (req, res) => {
  try {
    const Leave = req.tenantDb.model("Leave");
    let leave = await Leave.findOne({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });

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
    const payload = await enrichLeavePayload(req, req.body);
    const leave = new Leave({ ...payload, hospitalId: req.hospitalId });
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
    const payload = await enrichLeavePayload(req, req.body);

    let leave = await Leave.findOneAndUpdate(
      { id: req.params.id, hospitalId: req.hospitalId },
      payload,
      { new: true },
    );

    if (!leave) {
      leave = await Leave.findOneAndUpdate(
        { _id: req.params.id, hospitalId: req.hospitalId },
        payload,
        { new: true },
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
    let leave = await Leave.findOneAndDelete({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });

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

module.exports = router;
