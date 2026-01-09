// routes/masterMedicines.js
const express = require("express");
const router = express.Router();
const MasterMedicine = require("../models/MasterMedicine");
const PharmacyInventory = require("../models/PharmacyInventory");
const adminAuth = require("../middleware/adminAuth");
const {
  indexMasterMedicine,
  deleteMasterMedicine,
  searchMasterMedicines,
} = require("../utils/meilisearch");

// Search endpoint is public for hospitals (no auth required)
// All other routes require admin authentication

// Apply admin auth to all routes except search
router.use((req, res, next) => {
  if (req.path === "/search/autocomplete") {
    return next(); // Public endpoint - no auth required
  }
  adminAuth(req, res, next);
});

// Get all master medicines with pagination and search
router.get("/", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search = "",
      active,
      type,
      manufacturer,
    } = req.query;

    const query = {};

    // Search filter
    if (search) {
      query.$or = [
        { item_code: { $regex: search, $options: "i" } },
        { generic_name: { $regex: search, $options: "i" } },
        { generic_name2: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { manufacturer: { $regex: search, $options: "i" } },
      ];
    }

    // Active filter
    if (active !== undefined) {
      query.active = active === "true";
    }

    // Type filter
    if (type) {
      query.type = type;
    }

    // Manufacturer filter
    if (manufacturer) {
      query.manufacturer = { $regex: manufacturer, $options: "i" };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);

    const [medicines, total] = await Promise.all([
      MasterMedicine.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      MasterMedicine.countDocuments(query),
    ]);

    res.json({
      medicines,
      pagination: {
        page: parseInt(page),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Error fetching master medicines:", error);
    res.status(500).json({ error: "Failed to fetch master medicines" });
  }
});

// Get master medicine by ID
router.get("/:id", async (req, res) => {
  try {
    const medicine = await MasterMedicine.findById(req.params.id);
    if (!medicine) {
      return res.status(404).json({ error: "Master medicine not found" });
    }

    // Get count of hospitals using this medicine
    const hospitalCount = await PharmacyInventory.countDocuments({
      medicineId: medicine._id,
    });

    res.json({
      ...medicine.toObject(),
      hospitalCount,
    });
  } catch (error) {
    console.error("Error fetching master medicine:", error);
    res.status(500).json({ error: "Failed to fetch master medicine" });
  }
});

// Create new master medicine
router.post("/", async (req, res) => {
  try {
    // Check if item_code already exists
    const existing = await MasterMedicine.findOne({
      item_code: req.body.item_code,
    });
    if (existing) {
      return res
        .status(400)
        .json({ error: "Medicine with this item_code already exists" });
    }

    const newMedicine = new MasterMedicine({
      ...req.body,
      createdBy: req.adminUser.id || req.adminUser._id,
    });

    const savedMedicine = await newMedicine.save();

    // Index in Meilisearch
    try {
      await indexMasterMedicine(savedMedicine);
    } catch (error) {
      console.error(
        "⚠️  Failed to index master medicine in Meilisearch:",
        error.message
      );
      // Don't fail the request if indexing fails
    }

    res.status(201).json(savedMedicine);
  } catch (error) {
    console.error("Error creating master medicine:", error);
    if (error.code === 11000) {
      return res.status(400).json({ error: "Duplicate item_code" });
    }
    res.status(500).json({ error: "Failed to create master medicine" });
  }
});

// Update master medicine
router.put("/:id", async (req, res) => {
  try {
    const medicine = await MasterMedicine.findById(req.params.id);
    if (!medicine) {
      return res.status(404).json({ error: "Master medicine not found" });
    }

    // Prevent updating item_code if it's being changed and already exists
    if (req.body.item_code && req.body.item_code !== medicine.item_code) {
      const existing = await MasterMedicine.findOne({
        item_code: req.body.item_code,
      });
      if (existing) {
        return res
          .status(400)
          .json({ error: "Medicine with this item_code already exists" });
      }
    }

    // Add to modifiedBy array
    const modifiedBy = medicine.modifiedBy || [];
    modifiedBy.push({
      user: req.adminUser.id || req.adminUser._id,
      type: "update",
      modifiedTime: new Date().toISOString(),
    });

    const updatedMedicine = await MasterMedicine.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        modifiedBy,
      },
      { new: true, runValidators: true }
    );

    // Update in Meilisearch
    try {
      await indexMasterMedicine(updatedMedicine);
    } catch (error) {
      console.error(
        "⚠️  Failed to update master medicine in Meilisearch:",
        error.message
      );
      // Don't fail the request if indexing fails
    }

    res.json(updatedMedicine);
  } catch (error) {
    console.error("Error updating master medicine:", error);
    if (error.code === 11000) {
      return res.status(400).json({ error: "Duplicate item_code" });
    }
    res.status(500).json({ error: "Failed to update master medicine" });
  }
});

// Delete master medicine (soft delete - set active to false)
router.delete("/:id", async (req, res) => {
  try {
    const medicine = await MasterMedicine.findById(req.params.id);
    if (!medicine) {
      return res.status(404).json({ error: "Master medicine not found" });
    }

    // Check if any hospital is using this medicine
    const hospitalCount = await PharmacyInventory.countDocuments({
      medicineId: medicine._id,
      active: true,
    });

    if (hospitalCount > 0) {
      // Soft delete - just set active to false
      const modifiedBy = medicine.modifiedBy || [];
      modifiedBy.push({
        user: req.adminUser.id || req.adminUser._id,
        type: "delete",
        modifiedTime: new Date().toISOString(),
      });

      const updatedMedicine = await MasterMedicine.findByIdAndUpdate(
        req.params.id,
        {
          active: false,
          modifiedBy,
        },
        { new: true }
      );

      // Update in Meilisearch (mark as inactive)
      try {
        await indexMasterMedicine(updatedMedicine);
      } catch (error) {
        console.error(
          "⚠️  Failed to update master medicine in Meilisearch:",
          error.message
        );
      }

      return res.json({
        message: "Master medicine deactivated (soft delete)",
        medicine: updatedMedicine,
        hospitalCount,
      });
    }

    // Hard delete if no hospitals are using it
    const medicineId = medicine._id.toString();
    await MasterMedicine.findByIdAndDelete(req.params.id);

    // Delete from Meilisearch
    try {
      await deleteMasterMedicine(medicineId);
    } catch (error) {
      console.error(
        "⚠️  Failed to delete master medicine from Meilisearch:",
        error.message
      );
    }

    res.json({ message: "Master medicine deleted successfully" });
  } catch (error) {
    console.error("Error deleting master medicine:", error);
    res.status(500).json({ error: "Failed to delete master medicine" });
  }
});

// Get statistics
router.get("/stats/overview", async (req, res) => {
  try {
    const [total, active, inactive, withInventory] = await Promise.all([
      MasterMedicine.countDocuments({}),
      MasterMedicine.countDocuments({ active: true }),
      MasterMedicine.countDocuments({ active: false }),
      PharmacyInventory.distinct("medicineId").then((ids) => ids.length),
    ]);

    res.json({
      total,
      active,
      inactive,
      withInventory, // Medicines that have at least one hospital inventory
      withoutInventory: active - withInventory,
    });
  } catch (error) {
    console.error("Error fetching statistics:", error);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

// Search master medicines (for autocomplete/search)
// This endpoint is public for hospitals to search medicines
// Uses Meilisearch with MongoDB fallback
router.get("/search/autocomplete", async (req, res) => {
  try {
    const { q, limit = 20, type, active = true } = req.query;

    if (!q || q.length < 2) {
      return res.json({ results: [] });
    }

    try {
      // Try Meilisearch first
      const searchResults = await searchMasterMedicines(q, parseInt(limit), {
        active: active === "true" || active === true,
        type: type,
      });

      if (searchResults.length > 0) {
        // Fetch full documents from MongoDB to maintain consistency
        const ids = searchResults.map((hit) => hit.id);
        const medicines = await MasterMedicine.find({
          _id: { $in: ids },
          active: active === "true" || active === true,
        })
          .select(
            "item_code generic_name generic_name2 manufacturer pack type description hsn_code _id"
          )
          .lean();

        // Map back to search order
        const idToDoc = {};
        medicines.forEach((doc) => {
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
      console.warn(
        "⚠️  Meilisearch error, falling back to MongoDB:",
        meilisearchError.message
      );
    }

    // Fallback to MongoDB if Meilisearch fails or returns no results
    const query = {
      active: active === "true" || active === true,
      $or: [
        { item_code: { $regex: q, $options: "i" } },
        { generic_name: { $regex: q, $options: "i" } },
        { generic_name2: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { manufacturer: { $regex: q, $options: "i" } },
      ],
    };

    if (type) {
      query.type = type;
    }

    const medicines = await MasterMedicine.find(query)
      .limit(parseInt(limit))
      .select(
        "item_code generic_name generic_name2 manufacturer pack type description hsn_code _id"
      )
      .sort({ generic_name: 1 })
      .lean();

    res.json({
      results: medicines.map((m) => ({ ...m, _id: m._id.toString() })),
    });
  } catch (error) {
    console.error("Error searching master medicines:", error);
    res.status(500).json({ error: "Failed to search master medicines" });
  }
});

module.exports = router;
