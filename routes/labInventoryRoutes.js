const express = require("express");
const router = express.Router();
const MasterLabItem = require("../models/MasterLabItem");
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);

// Get lab inventory items (supports optional pagination & search)
router.get("/", async (req, res) => {
  try {
    const LabInventory = req.tenantDb.model("LabInventory");

    const { search, page, limit } = req.query;

    // If no pagination/search params, preserve legacy behaviour (return all items as array)
    if (!search && !page && !limit) {
      const items = await LabInventory.find({ hospitalId: req.hospitalId });
      return res.json(items);
    }

    const pageNum = parseInt(page || 1, 10);

    // Use different limits based on whether search is active (similar to diagnostics)
    const defaultLimit = search ? 10 : 50;
    const actualLimit = parseInt(limit || defaultLimit, 10);

    // Build search query
    let searchQuery = { hospitalId: req.hospitalId };
    if (search) {
      const regex = { $regex: search, $options: "i" };
      searchQuery.$or = [
        { item_code: regex },
        { description: regex },
        { hsn_code: regex },
        { category: regex },
        { status: regex },
        { "batches.batch_no": regex },
      ];
    }

    const skip = (pageNum - 1) * actualLimit;

    const totalItems = await LabInventory.countDocuments(searchQuery);

    // Populate master lab item if exists
    const items = await LabInventory.find(searchQuery)
      .populate(
        "labItemId",
        "item_code name category manufacturer type unit description hsn_code"
      )
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(actualLimit);

    const totalPages = Math.ceil(totalItems / actualLimit) || 1;
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    return res.json({
      items,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalItems,
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

// Get lab inventory item by ID (supports both _id and item_code)
router.get("/:id", async (req, res) => {
  try {
    const LabInventory = req.tenantDb.model("LabInventory");
    const mongoose = require("mongoose");
    let query = { hospitalId: req.hospitalId };

    // Check if it's a valid ObjectId
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      // If valid ObjectId, try both _id and item_code
      query.$or = [{ _id: req.params.id }, { item_code: req.params.id }];
    } else {
      // If not valid ObjectId, it must be an item_code
      query.item_code = req.params.id;
    }

    const item = await LabInventory.findOne(query).populate(
      "labItemId",
      "item_code name category manufacturer type unit description hsn_code"
    );

    if (!item) {
      return res.status(404).json({ message: "Lab inventory item not found" });
    }
    res.json(item);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create lab inventory item from master lab item
router.post("/from-master/:masterId", async (req, res) => {
  try {
    const LabInventory = req.tenantDb.model("LabInventory");
    const masterLabItem = await MasterLabItem.findById(req.params.masterId);
    if (!masterLabItem) {
      return res.status(404).json({ message: "Master lab item not found" });
    }

    // Check if hospital already has this item
    const existing = await LabInventory.findOne({
      hospitalId: req.hospitalId,
      labItemId: masterLabItem._id,
    });

    if (existing) {
      return res.status(400).json({
        message: "Lab item already exists from this master",
        item: existing,
      });
    }

    // Create hospital lab inventory from master with defaults
    const inventoryData = {
      hospitalId: req.hospitalId,
      labItemId: masterLabItem._id,
      // Populate legacy fields from master if not provided
      item_code: req.body.item_code || masterLabItem.item_code,
      name: req.body.name || masterLabItem.name,
      category: req.body.category || masterLabItem.category,
      manufacturer: req.body.manufacturer || masterLabItem.manufacturer,
      type: req.body.type || masterLabItem.type,
      unit: req.body.unit || masterLabItem.unit,
      description: req.body.description || masterLabItem.description,
      // Hospital-specific inventory data
      active: true,
      batches: req.body.batches || [], // mrp and rate should be in batches, not here
    };

    const newItem = new LabInventory(inventoryData);
    const savedItem = await newItem.save();

    // Populate master lab item before returning
    await savedItem.populate(
      "labItemId",
      "item_code name category manufacturer type unit description hsn_code"
    );

    res.status(201).json(savedItem);
  } catch (error) {
    console.error("Error creating lab inventory from master:", error);
    res.status(400).json({ message: error.message });
  }
});

// Create lab inventory item (supports both custom and from master)
router.post("/", async (req, res) => {
  try {
    const LabInventory = req.tenantDb.model("LabInventory");
    // If labItemId is provided, verify it exists and populate legacy fields
    let inventoryData = { ...req.body, hospitalId: req.hospitalId };

    if (req.body.labItemId) {
      const masterItem = await MasterLabItem.findById(req.body.labItemId);
      if (!masterItem) {
        return res.status(404).json({ message: "Master lab item not found" });
      }

      // Populate legacy fields from master if not provided
      if (!inventoryData.item_code)
        inventoryData.item_code = masterItem.item_code;
      if (!inventoryData.name) inventoryData.name = masterItem.name;
      if (!inventoryData.category) inventoryData.category = masterItem.category;
      if (!inventoryData.manufacturer)
        inventoryData.manufacturer = masterItem.manufacturer;
      if (!inventoryData.type) inventoryData.type = masterItem.type;
      if (!inventoryData.unit) inventoryData.unit = masterItem.unit;
      if (!inventoryData.description)
        inventoryData.description = masterItem.description;
    }

    const item = new LabInventory(inventoryData);
    const newItem = await item.save();

    // Populate master lab item if exists
    if (newItem.labItemId) {
      await newItem.populate(
        "labItemId",
        "item_code name category manufacturer type unit description hsn_code"
      );
    }

    res.status(201).json(newItem);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update lab inventory item (supports both _id and item_code)
router.put("/:id", async (req, res) => {
  try {
    const LabInventory = req.tenantDb.model("LabInventory");
    const mongoose = require("mongoose");
    let query = { hospitalId: req.hospitalId };

    // Check if it's a valid ObjectId
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      // If valid ObjectId, try both _id and item_code
      query.$or = [{ _id: req.params.id }, { item_code: req.params.id }];
    } else {
      // If not valid ObjectId, it must be an item_code
      query.item_code = req.params.id;
    }

    const item = await LabInventory.findOneAndUpdate(query, req.body, {
      new: true,
    }).populate(
      "labItemId",
      "item_code name category manufacturer type unit description hsn_code"
    );

    if (!item) {
      return res.status(404).json({ message: "Lab inventory item not found" });
    }
    res.json(item);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete lab inventory item (supports both _id and item_code)
router.delete("/:id", async (req, res) => {
  try {
    const LabInventory = req.tenantDb.model("LabInventory");
    const mongoose = require("mongoose");
    let query = { hospitalId: req.hospitalId };

    // Check if it's a valid ObjectId
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      // If valid ObjectId, try both _id and item_code
      query.$or = [{ _id: req.params.id }, { item_code: req.params.id }];
    } else {
      // If not valid ObjectId, it must be an item_code
      query.item_code = req.params.id;
    }

    const item = await LabInventory.findOneAndDelete(query);
    if (!item) {
      return res.status(404).json({ message: "Lab inventory item not found" });
    }
    res.json({ message: "Lab inventory item deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get lab inventory items by category
router.get("/category/:category", async (req, res) => {
  try {
    const LabInventory = req.tenantDb.model("LabInventory");
    const items = await LabInventory.find({
      category: req.params.category,
      hospitalId: req.hospitalId,
    });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get lab inventory items by status
router.get("/status/:status", async (req, res) => {
  try {
    const LabInventory = req.tenantDb.model("LabInventory");
    const items = await LabInventory.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
    });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get low stock items
router.get("/stock/low", async (req, res) => {
  try {
    const LabInventory = req.tenantDb.model("LabInventory");
    const items = await LabInventory.find({
      stock: { $lt: 10 },
      hospitalId: req.hospitalId,
    });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
