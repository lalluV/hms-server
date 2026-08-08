const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const MasterParameter = require("../models/MasterParameter");
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "lab" });

/** Match hospitalId whether stored as ObjectId or string */
function hospitalIdFilter(hospitalId) {
  const key = String(hospitalId);
  return { $or: [{ hospitalId }, { hospitalId: key }] };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count hospital diagnostics that reference this Parameter id */
async function countTestsUsingParameter(Diagnostic, hospitalId, parameterId) {
  const idStr = String(parameterId);
  const ids = [idStr];
  if (mongoose.Types.ObjectId.isValid(idStr)) {
    ids.push(new mongoose.Types.ObjectId(idStr));
  }
  return Diagnostic.countDocuments({
    $and: [
      hospitalIdFilter(hospitalId),
      {
        $or: [
          { "parameters.parameterId": { $in: ids } },
          { "includedTests.parameters.parameterId": { $in: ids } },
        ],
      },
    ],
  });
}

// Get all parameters with pagination and search
router.get("/", async (req, res) => {
  try {
    const Parameter = req.tenantDb.model("Parameter");

    const { search, page = 1, limit } = req.query;

    // Use different limits based on whether search is active
    const defaultLimit = search ? 10 : 50;
    const actualLimit = limit ? parseInt(limit) : defaultLimit;

    // Build search query (flexible hospitalId for legacy docs)
    let searchQuery = hospitalIdFilter(req.hospitalId);
    if (search) {
      const safe = escapeRegex(String(search).trim());
      const orClauses = [
        { name: { $regex: safe, $options: "i" } },
        { category: { $regex: safe, $options: "i" } },
        { units: { $regex: safe, $options: "i" } },
        { "normal_range.adult_male": { $regex: safe, $options: "i" } },
        { "normal_range.adult_female": { $regex: safe, $options: "i" } },
        { "normal_range.child": { $regex: safe, $options: "i" } },
        { "critical_values.low": { $regex: safe, $options: "i" } },
        { "critical_values.high": { $regex: safe, $options: "i" } },
      ];
      // Allow lookup by hospital Parameter ObjectId
      if (/^[a-fA-F0-9]{24}$/.test(String(search).trim())) {
        orClauses.push({ _id: String(search).trim() });
      }
      searchQuery = {
        $and: [hospitalIdFilter(req.hospitalId), { $or: orClauses }],
      };
    }

    // Calculate skip value for pagination
    const skip = (parseInt(page) - 1) * actualLimit;

    // Get total count for pagination info
    const totalParameters = await Parameter.countDocuments(searchQuery);

    // Fetch parameters with pagination and search (no populate —
    // MasterParameter lives on the master DB, not the tenant connection)
    const parameters = await Parameter.find(searchQuery)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(actualLimit);

    // Calculate pagination info
    const pageNum = parseInt(page, 10) || 1;
    const totalPages = Math.ceil(totalParameters / actualLimit) || 0;
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    res.json({
      parameters,
      pagination: {
        currentPage: pageNum,
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

// How many tests reference this parameter
router.get("/:id/usage", async (req, res) => {
  try {
    const Parameter = req.tenantDb.model("Parameter");
    const Diagnostic = req.tenantDb.model("Diagnostic");

    const parameter = await Parameter.findOne({
      _id: req.params.id,
      ...hospitalIdFilter(req.hospitalId),
    }).select("_id");
    if (!parameter) {
      return res.status(404).json({ message: "Parameter not found" });
    }

    const testCount = await countTestsUsingParameter(
      Diagnostic,
      req.hospitalId,
      req.params.id,
    );
    res.json({ testCount });
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
      ...hospitalIdFilter(req.hospitalId),
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

    // Check if hospital already has this parameter (by master ref or name)
    const existing = await Parameter.findOne({
      ...hospitalIdFilter(req.hospitalId),
      parameterId: masterParameter._id,
    });

    if (existing) {
      return res.status(200).json(existing);
    }

    const existingByName = await Parameter.findOne({
      ...hospitalIdFilter(req.hospitalId),
      name: new RegExp(`^${escapeRegex(masterParameter.name)}$`, "i"),
    });
    if (existingByName) {
      // Link to master if not already linked
      if (!existingByName.parameterId) {
        existingByName.parameterId = masterParameter._id;
        existingByName.isCustom = false;
        await existingByName.save();
      }
      return res.status(200).json(existingByName);
    }

    // Create hospital parameter from master with defaults
    const hospitalParameter = new Parameter({
      hospitalId: req.hospitalId,
      parameterId: masterParameter._id,
      name: masterParameter.name,
      units: masterParameter.units || "-",
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

    const name = String(req.body.name || "").trim();
    if (!name) {
      return res.status(400).json({ message: "Parameter name is required" });
    }

    // Reuse existing hospital param with same name (case-insensitive)
    const existingByName = await Parameter.findOne({
      ...hospitalIdFilter(req.hospitalId),
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    });
    if (existingByName) {
      return res.status(200).json(existingByName);
    }

    const parameter = new Parameter({
      name,
      units: String(req.body.units || "").trim() || "-",
      normal_range: req.body.normal_range || {},
      critical_values: req.body.critical_values || {},
      category: req.body.category || "",
      parameterId: req.body.parameterId || undefined,
      hospitalId: req.hospitalId,
      isCustom: !req.body.parameterId,
      active: req.body.active !== false,
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
    const body = { ...req.body };
    if (body.units !== undefined && !String(body.units || "").trim()) {
      body.units = "-";
    }
    const parameter = await Parameter.findOneAndUpdate(
      {
        $and: [{ _id: req.params.id }, hospitalIdFilter(req.hospitalId)],
      },
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.units !== undefined ? { units: body.units } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.normal_range !== undefined
          ? { normal_range: body.normal_range }
          : {}),
        ...(body.critical_values !== undefined
          ? { critical_values: body.critical_values }
          : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
      { new: true },
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
    const Diagnostic = req.tenantDb.model("Diagnostic");

    const testCount = await countTestsUsingParameter(
      Diagnostic,
      req.hospitalId,
      req.params.id,
    );
    if (testCount > 0) {
      return res.status(409).json({
        message: "Parameter is used in tests and cannot be deleted",
        testCount,
      });
    }

    const parameter = await Parameter.findOneAndDelete({
      $and: [{ _id: req.params.id }, hospitalIdFilter(req.hospitalId)],
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
      ...hospitalIdFilter(req.hospitalId),
    });
    res.json(parameters);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
