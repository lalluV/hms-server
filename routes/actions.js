const express = require("express");
const router = express.Router();
const Action = require("../models/Action");

// Get all actions with pagination support
router.get("/", async (req, res) => {
  try {
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
    const query = {};

    // Filter by type
    if (type) {
      query.type = type;
    }

    // Filter by status
    if (status) {
      query.status = status;
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
    const action = await Action.findOne({ id: req.params.id });
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
    const action = new Action(req.body);
    const newAction = await action.save();
    res.status(201).json(newAction);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update action
router.put("/:id", async (req, res) => {
  try {
    const action = await Action.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
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
    const action = await Action.findOneAndDelete({ id: req.params.id });
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
    const actions = await Action.find({
      patientId: req.params.patientId,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const actions = await Action.find({
      doctorId: req.params.doctorId,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by type
router.get("/type/:type", async (req, res) => {
  try {
    const actions = await Action.find({
      type: req.params.type,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by status
router.get("/status/:status", async (req, res) => {
  try {
    const actions = await Action.find({
      status: req.params.status,
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get actions by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const actions = await Action.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    });
    res.json(actions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
