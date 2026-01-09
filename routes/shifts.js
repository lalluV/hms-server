const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);

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
    const shift = new Shift({ ...req.body, hospitalId: req.hospitalId });
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
    const shift = await Shift.findOneAndUpdate(
      { id: req.params.id, hospitalId: req.hospitalId },
      req.body,
      { new: true }
    );
    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }
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

    // Remove employee from all other shifts first
    await Shift.updateMany(
      { "employees.id": employee.id, hospitalId: req.hospitalId },
      { $pull: { employees: { id: employee.id } } }
    );

    // Add employee to the specified shift
    const shift = await Shift.findOneAndUpdate(
      { id: shiftId, hospitalId: req.hospitalId },
      { $addToSet: { employees: employee } },
      { new: true }
    );

    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }

    res.json(shift);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Remove employee from shift
router.delete("/:shiftId/remove-employee/:employeeId", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const { shiftId, employeeId } = req.params;

    const shift = await Shift.findOneAndUpdate(
      { id: shiftId, hospitalId: req.hospitalId },
      { $pull: { employees: { id: employeeId } } },
      { new: true }
    );

    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }

    res.json(shift);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Move employee between shifts
router.post("/move-employee", async (req, res) => {
  try {
    const Shift = req.tenantDb.model("Shift");
    const { employee, fromShiftName, toShiftName } = req.body;

    if (!employee || !fromShiftName || !toShiftName) {
      return res.status(400).json({
        message: "Employee, fromShiftName, and toShiftName are required",
      });
    }

    // Remove employee from current shift
    await Shift.updateOne(
      { shiftName: fromShiftName, hospitalId: req.hospitalId },
      { $pull: { employees: { id: employee.id } } }
    );

    // Add employee to new shift
    const updatedShift = await Shift.findOneAndUpdate(
      { shiftName: toShiftName, hospitalId: req.hospitalId },
      { $addToSet: { employees: employee } },
      { new: true }
    );

    if (!updatedShift) {
      return res.status(404).json({ message: "Target shift not found" });
    }

    // Get all shifts to return complete data
    const allShifts = await Shift.find({ hospitalId: req.hospitalId });
    res.json(allShifts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
