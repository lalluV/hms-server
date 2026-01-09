// routes/masterDiagnostics.js
const express = require("express");
const router = express.Router();
const MasterDiagnostic = require("../models/MasterDiagnostic");
const Diagnostic = require("../models/Diagnostic");
const adminAuth = require("../middleware/adminAuth");
const {
  indexMasterDiagnostic,
  deleteMasterDiagnostic,
  searchMasterDiagnostics,
} = require("../utils/meilisearch");

// Apply admin auth to all routes except search
router.use((req, res, next) => {
  if (req.path === '/search/autocomplete') {
    return next(); // Public endpoint - no auth required
  }
  adminAuth(req, res, next);
});

// Get all master diagnostics with pagination and search
router.get("/", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search = "",
      active,
      deptname,
    } = req.query;

    const query = {};

    // Search filter
    if (search) {
      query.$or = [
        { test_code: { $regex: search, $options: "i" } },
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { deptname: { $regex: search, $options: "i" } },
        { subdeptname: { $regex: search, $options: "i" } },
      ];
    }

    // Active filter
    if (active !== undefined) {
      query.active = active === "true";
    }

    // Department filter
    if (deptname) {
      query.deptname = { $regex: deptname, $options: "i" };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);

    const [diagnostics, total] = await Promise.all([
      MasterDiagnostic.find(query)
        .populate("suggested_parameters.parameterId", "name units category default_normal_range")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      MasterDiagnostic.countDocuments(query),
    ]);

    res.json({
      diagnostics,
      pagination: {
        page: parseInt(page),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Error fetching master diagnostics:", error);
    res.status(500).json({ error: "Failed to fetch master diagnostics" });
  }
});

// Get master diagnostic by ID
router.get("/:id", async (req, res) => {
  try {
    const diagnostic = await MasterDiagnostic.findById(req.params.id)
      .populate("suggested_parameters.parameterId", "name units category default_normal_range default_critical_values");
    
    if (!diagnostic) {
      return res.status(404).json({ error: "Master diagnostic not found" });
    }

    // Get count of hospitals using this diagnostic
    const hospitalCount = await Diagnostic.countDocuments({
      diagnosticId: diagnostic._id,
    });

    res.json({
      ...diagnostic.toObject(),
      hospitalCount,
    });
  } catch (error) {
    console.error("Error fetching master diagnostic:", error);
    res.status(500).json({ error: "Failed to fetch master diagnostic" });
  }
});

// Create new master diagnostic
router.post("/", async (req, res) => {
  try {
    // Check if test_code already exists
    const existing = await MasterDiagnostic.findOne({
      test_code: req.body.test_code,
    });
    if (existing) {
      return res
        .status(400)
        .json({ error: "Diagnostic with this test_code already exists" });
    }

    const newDiagnostic = new MasterDiagnostic({
      ...req.body,
      createdBy: req.adminUser.id || req.adminUser._id,
    });

    const savedDiagnostic = await newDiagnostic.save();
    const populated = await MasterDiagnostic.findById(savedDiagnostic._id)
      .populate("suggested_parameters.parameterId", "name units category");
    
    // Index in Meilisearch
    try {
      await indexMasterDiagnostic(savedDiagnostic);
    } catch (error) {
      console.error("⚠️  Failed to index master diagnostic in Meilisearch:", error.message);
      // Don't fail the request if indexing fails
    }
    
    res.status(201).json(populated);
  } catch (error) {
    console.error("Error creating master diagnostic:", error);
    if (error.code === 11000) {
      return res.status(400).json({ error: "Duplicate test_code" });
    }
    res.status(500).json({ error: "Failed to create master diagnostic" });
  }
});

// Update master diagnostic
router.put("/:id", async (req, res) => {
  try {
    const diagnostic = await MasterDiagnostic.findById(req.params.id);
    if (!diagnostic) {
      return res.status(404).json({ error: "Master diagnostic not found" });
    }

    // Prevent updating test_code if it's being changed and already exists
    if (req.body.test_code && req.body.test_code !== diagnostic.test_code) {
      const existing = await MasterDiagnostic.findOne({
        test_code: req.body.test_code,
      });
      if (existing) {
        return res
          .status(400)
          .json({ error: "Diagnostic with this test_code already exists" });
      }
    }

    // Add to modifiedBy array
    const modifiedBy = diagnostic.modifiedBy || [];
    modifiedBy.push({
      user: req.adminUser.id || req.adminUser._id,
      type: "update",
      modifiedTime: new Date().toISOString(),
    });

    const updatedDiagnostic = await MasterDiagnostic.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        modifiedBy,
      },
      { new: true, runValidators: true }
    )
      .populate("suggested_parameters.parameterId", "name units category");

    // Update in Meilisearch
    try {
      await indexMasterDiagnostic(updatedDiagnostic);
    } catch (error) {
      console.error("⚠️  Failed to update master diagnostic in Meilisearch:", error.message);
      // Don't fail the request if indexing fails
    }

    res.json(updatedDiagnostic);
  } catch (error) {
    console.error("Error updating master diagnostic:", error);
    if (error.code === 11000) {
      return res.status(400).json({ error: "Duplicate test_code" });
    }
    res.status(500).json({ error: "Failed to update master diagnostic" });
  }
});

// Delete master diagnostic (soft delete - set active to false)
router.delete("/:id", async (req, res) => {
  try {
    const diagnostic = await MasterDiagnostic.findById(req.params.id);
    if (!diagnostic) {
      return res.status(404).json({ error: "Master diagnostic not found" });
    }

    // Check if any hospital is using this diagnostic
    const hospitalCount = await Diagnostic.countDocuments({
      diagnosticId: diagnostic._id,
      active: true,
    });

    if (hospitalCount > 0) {
      // Soft delete - just set active to false
      const modifiedBy = diagnostic.modifiedBy || [];
      modifiedBy.push({
        user: req.adminUser.id || req.adminUser._id,
        type: "delete",
        modifiedTime: new Date().toISOString(),
      });

      const updatedDiagnostic = await MasterDiagnostic.findByIdAndUpdate(
        req.params.id,
        {
          active: false,
          modifiedBy,
        },
        { new: true }
      );

      // Update in Meilisearch (mark as inactive)
      try {
        await indexMasterDiagnostic(updatedDiagnostic);
      } catch (error) {
        console.error("⚠️  Failed to update master diagnostic in Meilisearch:", error.message);
      }

      return res.json({
        message: "Master diagnostic deactivated (soft delete)",
        diagnostic: updatedDiagnostic,
        hospitalCount,
      });
    }

    // Hard delete if no hospitals are using it
    const diagnosticId = diagnostic._id.toString();
    await MasterDiagnostic.findByIdAndDelete(req.params.id);
    
    // Delete from Meilisearch
    try {
      await deleteMasterDiagnostic(diagnosticId);
    } catch (error) {
      console.error("⚠️  Failed to delete master diagnostic from Meilisearch:", error.message);
    }
    
    res.json({ message: "Master diagnostic deleted successfully" });
  } catch (error) {
    console.error("Error deleting master diagnostic:", error);
    res.status(500).json({ error: "Failed to delete master diagnostic" });
  }
});

// Get statistics
router.get("/stats/overview", async (req, res) => {
  try {
    const [total, active, inactive, withHospitalDiagnostics] = await Promise.all([
      MasterDiagnostic.countDocuments({}),
      MasterDiagnostic.countDocuments({ active: true }),
      MasterDiagnostic.countDocuments({ active: false }),
      Diagnostic.distinct("diagnosticId").then((ids) => ids.length),
    ]);

    res.json({
      total,
      active,
      inactive,
      withHospitalDiagnostics, // Diagnostics that have at least one hospital diagnostic
      withoutHospitalDiagnostics: active - withHospitalDiagnostics,
    });
  } catch (error) {
    console.error("Error fetching statistics:", error);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

// Search master diagnostics (for autocomplete/search)
// This endpoint is public for hospitals to search diagnostics
// Uses Meilisearch with MongoDB fallback
router.get("/search/autocomplete", async (req, res) => {
  try {
    const { q, limit = 20, deptname, active = true } = req.query;

    if (!q || q.length < 2) {
      return res.json({ results: [] });
    }

    try {
      // Try Meilisearch first
      const searchResults = await searchMasterDiagnostics(q, parseInt(limit), {
        active: active === "true" || active === true,
        deptname: deptname,
        subdeptname: req.query.subdeptname,
      });

      if (searchResults.length > 0) {
        // Fetch full documents from MongoDB with populated fields
        const ids = searchResults.map((hit) => hit.id);
        const diagnostics = await MasterDiagnostic.find({
          _id: { $in: ids },
          active: active === "true" || active === true,
        })
          .populate("suggested_parameters.parameterId", "name units category default_normal_range")
          .select("test_code name deptname subdeptname description default_fasting default_reportsIn suggested_parameters _id")
          .lean();

        // Map back to search order
        const idToDoc = {};
        diagnostics.forEach((doc) => {
          idToDoc[doc._id.toString()] = doc;
        });

        const orderedResults = searchResults
          .map((hit) => {
            const doc = idToDoc[hit.id];
            return doc ? { ...doc, _id: doc._id.toString() } : null;
          })
          .filter(Boolean);

        return res.json({ results: orderedResults });
      }
    } catch (meilisearchError) {
      console.warn("⚠️  Meilisearch error, falling back to MongoDB:", meilisearchError.message);
    }

    // Fallback to MongoDB if Meilisearch fails or returns no results
    const query = {
      active: active === "true" || active === true,
      $or: [
        { test_code: { $regex: q, $options: "i" } },
        { name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { deptname: { $regex: q, $options: "i" } },
        { subdeptname: { $regex: q, $options: "i" } },
      ],
    };

    if (deptname) {
      query.deptname = { $regex: deptname, $options: "i" };
    }

    const diagnostics = await MasterDiagnostic.find(query)
      .populate("suggested_parameters.parameterId", "name units category")
      .limit(parseInt(limit))
      .select("test_code name deptname subdeptname description default_fasting default_reportsIn suggested_parameters _id")
      .sort({ name: 1 })
      .lean();

    res.json({ results: diagnostics.map((d) => ({ ...d, _id: d._id.toString() })) });
  } catch (error) {
    console.error("Error searching master diagnostics:", error);
    res.status(500).json({ error: "Failed to search master diagnostics" });
  }
});

module.exports = router;

