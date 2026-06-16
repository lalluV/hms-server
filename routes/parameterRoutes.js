const express = require("express");
const router = express.Router();
const MasterParameter = require("../models/MasterParameter");
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "lab" });

// Get all parameters with pagination and search
router.get("/", async (req, res) => {
  try {
    const Parameter = req.tenantDb.model("Parameter");
    
    const { search, page = 1, limit } = req.query;

    // Use different limits based on whether search is active
    const defaultLimit = search ? 10 : 50;
    const actualLimit = limit ? parseInt(limit) : defaultLimit;

    // Build search query
    let searchQuery = { hospitalId: req.hospitalId };
    if (search) {
      searchQuery.$or = [
        { name: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
        { units: { $regex: search, $options: "i" } },
        { id: { $regex: search, $options: "i" } },
        { "normal_range.adult_male": { $regex: search, $options: "i" } },
        { "normal_range.adult_female": { $regex: search, $options: "i" } },
        { "normal_range.child": { $regex: search, $options: "i" } },
        { "critical_values.low": { $regex: search, $options: "i" } },
        { "critical_values.high": { $regex: search, $options: "i" } },
      ];
    }

    // Calculate skip value for pagination
    const skip = (parseInt(page) - 1) * actualLimit;

    // Get total count for pagination info
    const totalParameters = await Parameter.countDocuments(searchQuery);

    // Fetch parameters with pagination and search, populate master parameter if exists
    const parameters = await Parameter.find(searchQuery)
      .populate("parameterId", "parameter_code name units category default_normal_range default_critical_values")
      .sort({ updatedAt: -1 }) // Sort by most recently updated
      .skip(skip)
      .limit(actualLimit);

    // Calculate pagination info
    const totalPages = Math.ceil(totalParameters / actualLimit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    res.json({
      parameters,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalParameters,
        hasNextPage,
        hasPrevPage,
        limit: actualLimit,
        isSearchActive: !!search,
        searchTerm: search || null,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get parameter by ID
router.get("/:id", async (req, res) => {
  try {
    const Parameter = req.tenantDb.model("Parameter");
    const parameter = await Parameter.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!parameter) {
      return res.status(404).json({ message: "Parameter not found" });
    }
    res.json(parameter);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create parameter from master parameter
router.post("/from-master/:masterId", async (req, res) => {
  try {
    const Parameter = req.tenantDb.model("Parameter");
    
    const masterParameter = await MasterParameter.findById(req.params.masterId);
    if (!masterParameter) {
      return res.status(404).json({ message: "Master parameter not found" });
    }

    // Check if hospital already has this parameter
    const existing = await Parameter.findOne({
      hospitalId: req.hospitalId,
      parameterId: masterParameter._id,
    });

    if (existing) {
      return res.status(400).json({
        message: "Parameter already exists from this master",
        parameter: existing,
      });
    }

    // Create hospital parameter from master with defaults
    const hospitalParameter = new Parameter({
      hospitalId: req.hospitalId,
      parameterId: masterParameter._id,
      name: masterParameter.name,
      units: masterParameter.units,
      normal_range: masterParameter.default_normal_range || {},
      critical_values: masterParameter.default_critical_values || {},
      category: masterParameter.category,
      isCustom: false, // Created from master
      active: true,
    });

    // Allow overriding defaults from request body
    if (req.body.normal_range) {
      hospitalParameter.normal_range = req.body.normal_range;
    }
    if (req.body.critical_values) {
      hospitalParameter.critical_values = req.body.critical_values;
    }
    if (req.body.category) {
      hospitalParameter.category = req.body.category;
    }

    const newParameter = await hospitalParameter.save();
    res.status(201).json(newParameter);
  } catch (error) {
    console.error("Error creating parameter from master:", error);
    res.status(400).json({ message: error.message });
  }
});

// Create parameter (supports both custom and from master)
router.post("/", async (req, res) => {
  try {
    const Parameter = req.tenantDb.model("Parameter");
    
    // If parameterId is provided, verify it exists
    if (req.body.parameterId) {
      const masterParam = await MasterParameter.findById(req.body.parameterId);
      if (!masterParam) {
        return res.status(404).json({ message: "Master parameter not found" });
      }
    }

    const parameter = new Parameter({
      ...req.body,
      hospitalId: req.hospitalId,
      isCustom: !req.body.parameterId, // Custom if no master reference
    });

    const newParameter = await parameter.save();
    res.status(201).json(newParameter);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update parameter
router.put("/:id", async (req, res) => {
  try {
    const Parameter = req.tenantDb.model("Parameter");
    const parameter = await Parameter.findOneAndUpdate(
      { _id: req.params.id, hospitalId: req.hospitalId },
      req.body,
      { new: true }
    );
    if (!parameter) {
      return res.status(404).json({ message: "Parameter not found" });
    }
    res.json(parameter);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete parameter
router.delete("/:id", async (req, res) => {
  try {
    const Parameter = req.tenantDb.model("Parameter");
    const parameter = await Parameter.findOneAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!parameter) {
      return res.status(404).json({ message: "Parameter not found" });
    }
    res.json({ message: "Parameter deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get parameters by category
router.get("/category/:category", async (req, res) => {
  try {
    const Parameter = req.tenantDb.model("Parameter");
    const parameters = await Parameter.find({
      category: req.params.category,
      hospitalId: req.hospitalId,
    });
    res.json(parameters);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
