// routes/masterLabItems.js
const express = require("express");
const router = express.Router();
const MasterLabItem = require("../models/MasterLabItem");
const LabInventory = require("../models/LabInventory");
const adminAuth = require("../middleware/adminAuth");
const {
  indexMasterLabItem,
  deleteMasterLabItem,
  searchMasterLabItems,
} = require("../utils/meilisearch");

// Apply admin auth to all routes except search
router.use((req, res, next) => {
  if (req.path === "/search/autocomplete") {
    return next(); // Public endpoint - no auth required
  }
  adminAuth(req, res, next);
});

// Get all master lab items with pagination and search
router.get("/", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search = "",
      active,
      type,
      category,
      manufacturer,
    } = req.query;

    const query = {};

    // Search filter
    if (search) {
      query.$or = [
        { item_code: { $regex: search, $options: "i" } },
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { manufacturer: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
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

    // Category filter
    if (category) {
      query.category = { $regex: category, $options: "i" };
    }

    // Manufacturer filter
    if (manufacturer) {
      query.manufacturer = { $regex: manufacturer, $options: "i" };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);

    const [items, total] = await Promise.all([
      MasterLabItem.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      MasterLabItem.countDocuments(query),
    ]);

    res.json({
      items,
      pagination: {
        page: parseInt(page),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Error fetching master lab items:", error);
    res.status(500).json({ error: "Failed to fetch master lab items" });
  }
});

// Get master lab item by ID
router.get("/:id", async (req, res) => {
  try {
    const item = await MasterLabItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Master lab item not found" });
    }

    // Get count of hospitals using this item
    const hospitalCount = await LabInventory.countDocuments({
      labItemId: item._id,
    });

    res.json({
      ...item.toObject(),
      hospitalCount,
    });
  } catch (error) {
    console.error("Error fetching master lab item:", error);
    res.status(500).json({ error: "Failed to fetch master lab item" });
  }
});

// Create new master lab item
router.post("/", async (req, res) => {
  try {
    // Check if item_code already exists
    const existing = await MasterLabItem.findOne({
      item_code: req.body.item_code,
    });
    if (existing) {
      return res
        .status(400)
        .json({ error: "Lab item with this item_code already exists" });
    }

    const newItem = new MasterLabItem({
      ...req.body,
      createdBy: req.adminUser.id || req.adminUser._id,
    });

    const savedItem = await newItem.save();

    // Index in Meilisearch
    try {
      await indexMasterLabItem(savedItem);
    } catch (error) {
      console.error(
        "⚠️  Failed to index master lab item in Meilisearch:",
        error.message
      );
      // Don't fail the request if indexing fails
    }

    res.status(201).json(savedItem);
  } catch (error) {
    console.error("Error creating master lab item:", error);
    if (error.code === 11000) {
      return res.status(400).json({ error: "Duplicate item_code" });
    }
    res.status(500).json({ error: "Failed to create master lab item" });
  }
});

// Update master lab item
router.put("/:id", async (req, res) => {
  try {
    const item = await MasterLabItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Master lab item not found" });
    }

    // Prevent updating item_code if it's being changed and already exists
    if (req.body.item_code && req.body.item_code !== item.item_code) {
      const existing = await MasterLabItem.findOne({
        item_code: req.body.item_code,
      });
      if (existing) {
        return res
          .status(400)
          .json({ error: "Lab item with this item_code already exists" });
      }
    }

    // Add to modifiedBy array
    const modifiedBy = item.modifiedBy || [];
    modifiedBy.push({
      user: req.adminUser.id || req.adminUser._id,
      type: "update",
      modifiedTime: new Date().toISOString(),
    });

    const updatedItem = await MasterLabItem.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        modifiedBy,
      },
      { new: true, runValidators: true }
    );

    // Update in Meilisearch
    try {
      await indexMasterLabItem(updatedItem);
    } catch (error) {
      console.error(
        "⚠️  Failed to update master lab item in Meilisearch:",
        error.message
      );
      // Don't fail the request if indexing fails
    }

    res.json(updatedItem);
  } catch (error) {
    console.error("Error updating master lab item:", error);
    if (error.code === 11000) {
      return res.status(400).json({ error: "Duplicate item_code" });
    }
    res.status(500).json({ error: "Failed to update master lab item" });
  }
});

// Delete master lab item (soft delete - set active to false)
router.delete("/:id", async (req, res) => {
  try {
    const item = await MasterLabItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Master lab item not found" });
    }

    // Check if any hospital is using this item
    const hospitalCount = await LabInventory.countDocuments({
      labItemId: item._id,
      active: true,
    });

    if (hospitalCount > 0) {
      // Soft delete - just set active to false
      const modifiedBy = item.modifiedBy || [];
      modifiedBy.push({
        user: req.adminUser.id || req.adminUser._id,
        type: "delete",
        modifiedTime: new Date().toISOString(),
      });

      const updatedItem = await MasterLabItem.findByIdAndUpdate(
        req.params.id,
        {
          active: false,
          modifiedBy,
        },
        { new: true }
      );

      // Update in Meilisearch (mark as inactive)
      try {
        await indexMasterLabItem(updatedItem);
      } catch (error) {
        console.error(
          "⚠️  Failed to update master lab item in Meilisearch:",
          error.message
        );
      }

      return res.json({
        message: "Master lab item deactivated (soft delete)",
        item: updatedItem,
        hospitalCount,
      });
    }

    // Hard delete if no hospitals are using it
    const itemId = item._id.toString();
    await MasterLabItem.findByIdAndDelete(req.params.id);

    // Delete from Meilisearch
    try {
      await deleteMasterLabItem(itemId);
    } catch (error) {
      console.error(
        "⚠️  Failed to delete master lab item from Meilisearch:",
        error.message
      );
    }

    res.json({ message: "Master lab item deleted successfully" });
  } catch (error) {
    console.error("Error deleting master lab item:", error);
    res.status(500).json({ error: "Failed to delete master lab item" });
  }
});

// Get statistics
router.get("/stats/overview", async (req, res) => {
  try {
    const [total, active, inactive, withInventory] = await Promise.all([
      MasterLabItem.countDocuments({}),
      MasterLabItem.countDocuments({ active: true }),
      MasterLabItem.countDocuments({ active: false }),
      LabInventory.distinct("labItemId").then((ids) => ids.length),
    ]);

    res.json({
      total,
      active,
      inactive,
      withInventory, // Items that have at least one hospital inventory
      withoutInventory: active - withInventory,
    });
  } catch (error) {
    console.error("Error fetching statistics:", error);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

// Search master lab items (for autocomplete/search)
// This endpoint is public for hospitals to search items
// Uses Meilisearch with MongoDB fallback
router.get("/search/autocomplete", async (req, res) => {
  try {
    const {
      q,
      limit = 20,
      type,
      category,
      manufacturer,
      active = true,
    } = req.query;

    if (!q || q.length < 2) {
      return res.json({ results: [] });
    }

    try {
      // Try Meilisearch first
      const searchResults = await searchMasterLabItems(q, parseInt(limit), {
        active: active === "true" || active === true,
        type: type,
        category: category,
        manufacturer: manufacturer,
      });

      if (searchResults.length > 0) {
        // Fetch full documents from MongoDB
        const ids = searchResults.map((hit) => hit.id);
        const items = await MasterLabItem.find({
          _id: { $in: ids },
          active: active === "true" || active === true,
        })
          .select(
            "item_code name category manufacturer type unit description hsn_code _id"
          )
          .lean();

        // Map back to search order
        const idToDoc = {};
        items.forEach((doc) => {
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
        { name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { manufacturer: { $regex: q, $options: "i" } },
        { category: { $regex: q, $options: "i" } },
      ],
    };

    if (type) {
      query.type = type;
    }
    if (category) {
      query.category = { $regex: category, $options: "i" };
    }
    if (manufacturer) {
      query.manufacturer = { $regex: manufacturer, $options: "i" };
    }

    const items = await MasterLabItem.find(query)
      .limit(parseInt(limit))
      .select(
        "item_code name category manufacturer type unit description hsn_code _id"
      )
      .sort({ name: 1 })
      .lean();

    res.json({
      results: items.map((item) => ({ ...item, _id: item._id.toString() })),
    });
  } catch (error) {
    console.error("Error searching master lab items:", error);
    res.status(500).json({ error: "Failed to search master lab items" });
  }
});

module.exports = router;
