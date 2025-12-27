// routes/masterParameters.js
const express = require("express");
const router = express.Router();
const MasterParameter = require("../models/MasterParameter");
const Parameter = require("../models/Parameter");
const adminAuth = require("../middleware/adminAuth");

// Apply admin auth to all routes except search
router.use((req, res, next) => {
  if (req.path === '/search/autocomplete') {
    return next(); // Public endpoint - no auth required
  }
  adminAuth(req, res, next);
});

// Get all master parameters with pagination and search
router.get("/", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search = "",
      active,
      category,
    } = req.query;

    const query = {};

    // Search filter
    if (search) {
      query.$or = [
        { parameter_code: { $regex: search, $options: "i" } },
        { name: { $regex: search, $options: "i" } },
        { units: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
    }

    // Active filter
    if (active !== undefined) {
      query.active = active === "true";
    }

    // Category filter
    if (category) {
      query.category = { $regex: category, $options: "i" };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);

    const [parameters, total] = await Promise.all([
      MasterParameter.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      MasterParameter.countDocuments(query),
    ]);

    res.json({
      parameters,
      pagination: {
        page: parseInt(page),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Error fetching master parameters:", error);
    res.status(500).json({ error: "Failed to fetch master parameters" });
  }
});

// Get master parameter by ID
router.get("/:id", async (req, res) => {
  try {
    const parameter = await MasterParameter.findById(req.params.id);
    if (!parameter) {
      return res.status(404).json({ error: "Master parameter not found" });
    }

    // Get count of hospitals using this parameter
    const hospitalCount = await Parameter.countDocuments({
      parameterId: parameter._id,
    });

    res.json({
      ...parameter.toObject(),
      hospitalCount,
    });
  } catch (error) {
    console.error("Error fetching master parameter:", error);
    res.status(500).json({ error: "Failed to fetch master parameter" });
  }
});

// Create new master parameter
router.post("/", async (req, res) => {
  try {
    // Check if parameter_code already exists
    const existing = await MasterParameter.findOne({
      parameter_code: req.body.parameter_code,
    });
    if (existing) {
      return res
        .status(400)
        .json({ error: "Parameter with this parameter_code already exists" });
    }

    const newParameter = new MasterParameter({
      ...req.body,
      createdBy: req.adminUser.id || req.adminUser._id,
    });

    const savedParameter = await newParameter.save();
    res.status(201).json(savedParameter);
  } catch (error) {
    console.error("Error creating master parameter:", error);
    if (error.code === 11000) {
      return res.status(400).json({ error: "Duplicate parameter_code" });
    }
    res.status(500).json({ error: "Failed to create master parameter" });
  }
});

// Update master parameter
router.put("/:id", async (req, res) => {
  try {
    const parameter = await MasterParameter.findById(req.params.id);
    if (!parameter) {
      return res.status(404).json({ error: "Master parameter not found" });
    }

    // Prevent updating parameter_code if it's being changed and already exists
    if (req.body.parameter_code && req.body.parameter_code !== parameter.parameter_code) {
      const existing = await MasterParameter.findOne({
        parameter_code: req.body.parameter_code,
      });
      if (existing) {
        return res
          .status(400)
          .json({ error: "Parameter with this parameter_code already exists" });
      }
    }

    // Add to modifiedBy array
    const modifiedBy = parameter.modifiedBy || [];
    modifiedBy.push({
      user: req.adminUser.id || req.adminUser._id,
      type: "update",
      modifiedTime: new Date().toISOString(),
    });

    const updatedParameter = await MasterParameter.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        modifiedBy,
      },
      { new: true, runValidators: true }
    );

    res.json(updatedParameter);
  } catch (error) {
    console.error("Error updating master parameter:", error);
    if (error.code === 11000) {
      return res.status(400).json({ error: "Duplicate parameter_code" });
    }
    res.status(500).json({ error: "Failed to update master parameter" });
  }
});

// Delete master parameter (soft delete - set active to false)
router.delete("/:id", async (req, res) => {
  try {
    const parameter = await MasterParameter.findById(req.params.id);
    if (!parameter) {
      return res.status(404).json({ error: "Master parameter not found" });
    }

    // Check if any hospital is using this parameter
    const hospitalCount = await Parameter.countDocuments({
      parameterId: parameter._id,
      active: true,
    });

    if (hospitalCount > 0) {
      // Soft delete - just set active to false
      const modifiedBy = parameter.modifiedBy || [];
      modifiedBy.push({
        user: req.adminUser.id || req.adminUser._id,
        type: "delete",
        modifiedTime: new Date().toISOString(),
      });

      const updatedParameter = await MasterParameter.findByIdAndUpdate(
        req.params.id,
        {
          active: false,
          modifiedBy,
        },
        { new: true }
      );

      return res.json({
        message: "Master parameter deactivated (soft delete)",
        parameter: updatedParameter,
        hospitalCount,
      });
    }

    // Hard delete if no hospitals are using it
    await MasterParameter.findByIdAndDelete(req.params.id);
    res.json({ message: "Master parameter deleted successfully" });
  } catch (error) {
    console.error("Error deleting master parameter:", error);
    res.status(500).json({ error: "Failed to delete master parameter" });
  }
});

// Get statistics
router.get("/stats/overview", async (req, res) => {
  try {
    const [total, active, inactive, withHospitalParams] = await Promise.all([
      MasterParameter.countDocuments({}),
      MasterParameter.countDocuments({ active: true }),
      MasterParameter.countDocuments({ active: false }),
      Parameter.distinct("parameterId").then((ids) => ids.length),
    ]);

    res.json({
      total,
      active,
      inactive,
      withHospitalParams, // Parameters that have at least one hospital parameter
      withoutHospitalParams: active - withHospitalParams,
    });
  } catch (error) {
    console.error("Error fetching statistics:", error);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

// Search master parameters (for autocomplete/search)
// This endpoint is public for hospitals to search parameters
router.get("/search/autocomplete", async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;

    if (!q || q.length < 2) {
      return res.json({ results: [] });
    }

    const query = {
      active: true,
      $or: [
        { parameter_code: { $regex: q, $options: "i" } },
        { name: { $regex: q, $options: "i" } },
        { units: { $regex: q, $options: "i" } },
        { category: { $regex: q, $options: "i" } },
      ],
    };

    const parameters = await MasterParameter.find(query)
      .limit(parseInt(limit))
      .select("parameter_code name units category default_normal_range default_critical_values _id")
      .sort({ name: 1 });

    res.json({ results: parameters });
  } catch (error) {
    console.error("Error searching master parameters:", error);
    res.status(500).json({ error: "Failed to search master parameters" });
  }
});

module.exports = router;

