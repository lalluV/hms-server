const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "clinical" });

function normalizeServiceCode(code) {
  return String(code ?? "").trim().toLowerCase();
}

async function markPatientProceduresPaid(Patient, hospitalId, patientId, items) {
  if (!patientId || !Array.isArray(items) || items.length === 0) {
    return false;
  }

  const patient = await Patient.findOne({ UMRNo: patientId, hospitalId });
  if (!patient || !Array.isArray(patient.procedures) || !patient.procedures.length) {
    return false;
  }

  let updated = false;
  const updatedProcedures = patient.procedures.map((proc) => {
    const procCode = normalizeServiceCode(proc?.service_code);
    const match = items.find(
      (item) =>
        procCode &&
        procCode === normalizeServiceCode(item?.service_code),
    );

    if (
      match &&
      proc?.status !== "Paid" &&
      proc?.status !== "Completed"
    ) {
      updated = true;
      return {
        ...(proc?.toObject?.() ?? proc),
        status: "Paid",
        paidAt: new Date().toISOString(),
      };
    }

    return proc?.toObject?.() ?? proc;
  });

  if (!updated) return false;

  patient.procedures = updatedProcedures;
  await patient.save();
  return true;
}

// Get all actions with pagination support
router.get("/", async (req, res) => {
  try {
    const Action = req.tenantDb.model("Action");

    const {
      page = 1,
      limit = 20,
      search = "",
      type = "",
      status = "",
      patientId = "",
      doctorId = "",
      startDate = "",
      endDate = "",
    } = req.query;

    // Build query
    const query = { hospitalId: req.hospitalId };

    // Filter by type
    if (type) {
      query.type = type;
    }

    if (status) {
      query.paymentStatus = status;
    }

    // Filter by patient ID
    if (patientId) {
      query.patientId = patientId;
    }

    // Filter by doctor ID
    if (doctorId) {
      query.doctorId = doctorId;
    }

    // Filter by date range
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (startDate) {
      query.createdAt = { $gte: new Date(startDate) };
    } else if (endDate) {
      query.createdAt = { $lte: new Date(endDate) };
    }

    // Search filter
    if (search && search.length >= 2) {
      query.$or = [
        { receiptId: { $regex: search, $options: "i" } },
        { patientId: { $regex: search, $options: "i" } },
        { patientName: { $regex: search, $options: "i" } },
        { "items.name": { $regex: search, $options: "i" } },
      ];
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count
    const total = await Action.countDocuments(query);

    // Get paginated actions
    const actions = await Action.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      actions: actions,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(total / limitNum),
        totalItems: total,
        itemsPerPage: limitNum,
        hasNextPage: pageNum < Math.ceil(total / limitNum),
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get action by ID
router.get("/:id", async (req, res) => {
  try {
    const Action = req.tenantDb.model("Action");
    const action = await Action.findOne({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!action) {
      return res.status(404).json({ message: "Action not found" });
    }
    res.json(action);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new action
router.post("/", async (req, res) => {
  try {
    const Action = req.tenantDb.model("Action");
    const Patient = req.tenantDb.model("Patient");
    const action = new Action({ ...req.body, hospitalId: req.hospitalId });
    const newAction = await action.save();

    await markPatientProceduresPaid(
      Patient,
      req.hospitalId,
      req.body?.patientId,
      req.body?.items,
    );

    res.status(201).json(newAction);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update action
router.put("/:id", async (req, res) => {
  try {
    const Action = req.tenantDb.model("Action");
    const action = await Action.findOneAndUpdate(
      { id: req.params.id, hospitalId: req.hospitalId },
      req.body,
      { new: true },
    );
    if (!action) {
      return res.status(404).json({ message: "Action not found" });
    }
    res.json(action);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete action
router.delete("/:id", async (req, res) => {
  try {
    const Action = req.tenantDb.model("Action");
    const action = await Action.findOneAndDelete({
      id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!action) {
      return res.status(404).json({ message: "Action not found" });
    }
    res.json({ message: "Action deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by patient ID
router.get("/patient/:patientId", async (req, res) => {
  try {
    const Action = req.tenantDb.model("Action");
    const actions = await Action.find({
      patientId: req.params.patientId,
      hospitalId: req.hospitalId,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const Action = req.tenantDb.model("Action");
    const actions = await Action.find({
      doctorId: req.params.doctorId,
      hospitalId: req.hospitalId,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by type
router.get("/type/:type", async (req, res) => {
  try {
    const Action = req.tenantDb.model("Action");
    const actions = await Action.find({
      type: req.params.type,
      hospitalId: req.hospitalId,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by status
router.get("/status/:status", async (req, res) => {
  try {
    const Action = req.tenantDb.model("Action");
    const actions = await Action.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by date range
router.get("/date-range", async (req, res) => {
  try {
    const Action = req.tenantDb.model("Action");
    const { startDate, endDate } = req.query;
    const actions = await Action.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      hospitalId: req.hospitalId,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
