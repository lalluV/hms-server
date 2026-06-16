const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "hr" });

function generateShiftId() {
  return `shift_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function findShiftByIdentifier(Shift, identifier, hospitalId) {
  if (!identifier) return null;
  const idStr = String(identifier).trim();
  const or = [{ id: idStr }, { shiftName: idStr }];
  if (mongoose.Types.ObjectId.isValid(idStr) && String(new mongoose.Types.ObjectId(idStr)) === idStr) {
    or.push({ _id: new mongoose.Types.ObjectId(idStr) });
  }
  return Shift.findOne({ hospitalId, $or: or });
}

async function pullEmployeeFromAllShifts(Shift, employeeId, hospitalId) {
  await Shift.updateMany(
    { hospitalId, "employees.id": employeeId },
    { $pull: { employees: { id: employeeId } } },
  );
}

// Get all shifts
router.get("/", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const shifts = await Shift.find({ hospitalId: req.hospitalId });
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get shift by ID
router.get("/:id", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const shift = await Shift.findOne({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }
    res.json(shift);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new shift
router.post("/", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const id = req.body.id || generateShiftId();
    const shift = new Shift({
      ...req.body,
      id,
      hospitalId: req.hospitalId,
      employees: req.body.employees || [],
    });
    const newShift = await shift.save();
    res.status(201).json(newShift);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update shift
router.put("/:id", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const existing = await findShiftByIdentifier(
      Shift,
      req.params.id,
      req.hospitalId,
    );
    if (!existing) {
      return res.status(404).json({ message: "Shift not found" });
    }
    const shift = await Shift.findOneAndUpdate(
      { _id: existing._id, hospitalId: req.hospitalId },
      req.body,
      { new: true },
    );
    res.json(shift);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete shift
router.delete("/:id", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const shift = await Shift.findOneAndDelete({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }
    res.json({ message: "Shift deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get shifts by staff ID
router.get("/staff/:staffId", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const shifts = await Shift.find({
      staffId: req.params.staffId,
      hospitalId: req.hospitalId,
    });
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get shifts by type
router.get("/type/:type", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const shifts = await Shift.find({
      type: req.params.type,
      hospitalId: req.hospitalId,
    });
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get shifts by date range
router.get("/date-range", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const { startDate, endDate } = req.query;
    const shifts = await Shift.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      hospitalId: req.hospitalId,
    });
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Initialize default shifts
router.post("/initialize", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    // Check if shifts already exist
    const existingShifts = await Shift.find({ hospitalId: req.hospitalId });

    if (existingShifts.length > 0) {
      return res.json({
        message: "Shifts already initialized",
        shifts: existingShifts,
      });
    }

    // Create default shifts
    const defaultShifts = [
      {
        id: "1",
        shiftName: "EarlyShifts",
        startTime: "06:00",
        endTime: "14:00",
        employees: [],
      },
      {
        id: "2",
        shiftName: "NoonShifts",
        startTime: "14:00",
        endTime: "22:00",
        employees: [],
      },
      {
        id: "3",
        shiftName: "NightShifts",
        startTime: "22:00",
        endTime: "06:00",
        employees: [],
      },
    ];

    const createdShifts = await Shift.insertMany(
      defaultShifts.map((s) => ({ ...s, hospitalId: req.hospitalId }))
    );
    res
      .status(201)
      .json({ message: "Default shifts initialized", shifts: createdShifts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Assign employee to shift
router.post("/:shiftId/assign-employee", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const { shiftId } = req.params;
    const { employee } = req.body;

    if (!employee || !employee.id) {
      return res.status(400).json({ message: "Employee data is required" });
    }

    const target = await findShiftByIdentifier(Shift, shiftId, req.hospitalId);
    if (!target) {
      return res.status(404).json({ message: "Shift not found" });
    }

    await pullEmployeeFromAllShifts(Shift, employee.id, req.hospitalId);

    await Shift.findOneAndUpdate(
      { _id: target._id, hospitalId: req.hospitalId },
      { $addToSet: { employees: employee } },
      { new: true },
    );

    const allShifts = await Shift.find({ hospitalId: req.hospitalId });
    res.json(allShifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Remove employee from shift
router.delete("/:shiftId/remove-employee/:employeeId", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const { shiftId, employeeId } = req.params;

    const shift = await findShiftByIdentifier(
      Shift,
      shiftId,
      req.hospitalId,
    );
    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }

    await Shift.findOneAndUpdate(
      { _id: shift._id, hospitalId: req.hospitalId },
      { $pull: { employees: { id: employeeId } } },
      { new: true },
    );

    const allShifts = await Shift.find({ hospitalId: req.hospitalId });
    res.json(allShifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Move employee between shifts (fromShiftName optional when unassigned)
router.post("/move-employee", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const { employee, fromShiftName, toShiftName } = req.body;

    if (!employee?.id || !toShiftName) {
      return res.status(400).json({
        message: "Employee and toShiftName are required",
      });
    }

    if (fromShiftName && fromShiftName === toShiftName) {
      const allShifts = await Shift.find({ hospitalId: req.hospitalId });
      return res.json(allShifts);
    }

    await pullEmployeeFromAllShifts(Shift, employee.id, req.hospitalId);

    const target = await Shift.findOneAndUpdate(
      { shiftName: toShiftName, hospitalId: req.hospitalId },
      { $addToSet: { employees: employee } },
      { new: true },
    );

    if (!target) {
      return res.status(404).json({ message: "Target shift not found" });
    }

    const allShifts = await Shift.find({ hospitalId: req.hospitalId });
    res.json(allShifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
