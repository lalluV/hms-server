const express = require("express");
const router = express.Router();
const LabInventory = require("../models/LabInventory");

// Get lab inventory items (supports optional pagination & search)
router.get("/", async (req, res) => {
  try {
    const { search, page, limit } = req.query;

    // If no pagination/search params, preserve legacy behaviour (return all items as array)
    if (!search && !page && !limit) {
      const items = await LabInventory.find();
      return res.json(items);
    }

    const pageNum = parseInt(page || 1, 10);

    // Use different limits based on whether search is active (similar to diagnostics)
    const defaultLimit = search ? 10 : 50;
    const actualLimit = parseInt(limit || defaultLimit, 10);

    // Build search query
    let searchQuery = {};
    if (search) {
      const regex = { $regex: search, $options: "i" };
      searchQuery = {
        $or: [
          { item_code: regex },
          { description: regex },
          { hsn_code: regex },
          { category: regex },
          { status: regex },
          { "batches.batch_no": regex },
        ],
      };
    }

    const skip = (pageNum - 1) * actualLimit;

    const totalItems = await LabInventory.countDocuments(searchQuery);

    const items = await LabInventory.find(searchQuery)
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

// Get lab inventory item by ID
router.get("/:id", async (req, res) => {
  try {
    const item = await LabInventory.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Lab inventory item not found" });
    }
    res.json(item);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create lab inventory item
router.post("/", async (req, res) => {
  const item = new LabInventory(req.body);
  try {
    const newItem = await item.save();
    res.status(201).json(newItem);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update lab inventory item
router.put("/:id", async (req, res) => {
  try {
    const item = await LabInventory.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!item) {
      return res.status(404).json({ message: "Lab inventory item not found" });
    }
    res.json(item);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete lab inventory item
router.delete("/:id", async (req, res) => {
  try {
    const item = await LabInventory.findByIdAndDelete(req.params.id);
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
    const items = await LabInventory.find({ category: req.params.category });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get lab inventory items by status
router.get("/status/:status", async (req, res) => {
  try {
    const items = await LabInventory.find({ status: req.params.status });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get low stock items
router.get("/stock/low", async (req, res) => {
  try {
    const items = await LabInventory.find({ stock: { $lt: 10 } });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
