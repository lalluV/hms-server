// routes/pharmacy.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const PharmacyInventory = require("../models/PharmacyInventory");
const MasterMedicine = require("../models/MasterMedicine");
const auth = require("../middleware/auth");

router.use(auth);
const multer = require("multer");
const path = require("path");
const axios = require("axios");
const {
  searchMedicines,
  initializeMeilisearch,
  indexAllData,
  indexDocument,
  deleteDocument,
  getIndexStats,
} = require("../utils/meilisearch");

// Get popular medicines
router.get("/popular", async (req, res) => {
  try {
    const popularMedicines = await PharmacyInventory.find({
      hospitalId: req.hospitalId,
      active: true,
    })
      .populate(
        "medicineId",
        "item_code generic_name generic_name2 manufacturer pack type description hsn_code"
      )
      .sort({ orderingNumber: -1 })
      .limit(5);
    res.json(popularMedicines);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch popular medicines" });
  }
});

// Search medicines (Meilisearch) - Optimized for speed
router.get("/search", async (req, res) => {
  const { q, limit = 10 } = req.query;

  if (!q) {
    return res
      .status(400)
      .json({ error: 'Missing search query parameter "q"' });
  }

  try {
    const startTime = Date.now();
    const results = await searchMedicines(q, req.hospitalId, parseInt(limit));
    const searchTime = Date.now() - startTime;

    res.json({
      results,
      searchTime: `${searchTime}ms`,
      totalResults: results.length,
      query: q,
      success: true,
    });
  } catch (err) {
    res.json({
      results: [],
      searchTime: "0ms",
      totalResults: 0,
      query: q,
      success: false,
      error: "Search temporarily unavailable",
    });
  }
});

// Get all pharmacy inventory items
router.get("/", async (req, res) => {
  try {
    const items = await PharmacyInventory.find({
      hospitalId: req.hospitalId,
      active: true,
    })
      .populate(
        "medicineId",
        "item_code generic_name generic_name2 manufacturer pack type description hsn_code"
      )
      .sort({ orderingNumber: -1 });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch pharmacy inventory" });
  }
});

// Get pharmacy inventory item by ID
router.get("/:id", async (req, res) => {
  try {
    // Check if id is a valid ObjectId
    const isValidObjectId = mongoose.Types.ObjectId.isValid(req.params.id);

    // Build query - only use _id if it's a valid ObjectId
    const query = {
      hospitalId: req.hospitalId,
    };

    if (isValidObjectId) {
      // If valid ObjectId, try both _id and item_code
      query.$or = [{ _id: req.params.id }, { item_code: req.params.id }];
    } else {
      // If not valid ObjectId, it must be an item_code
      query.item_code = req.params.id;
    }

    const item = await PharmacyInventory.findOne(query).populate(
      "medicineId",
      "item_code generic_name generic_name2 manufacturer pack type description hsn_code"
    );
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch item" });
  }
});

// Create new pharmacy inventory item
router.post("/", async (req, res) => {
  try {
    let medicineId = req.body.medicineId;
    let masterMedicine = null;

    // If medicineId is provided, fetch master medicine and populate legacy fields
    if (medicineId) {
      masterMedicine = await MasterMedicine.findById(medicineId);
      if (!masterMedicine) {
        return res.status(404).json({ error: "Master medicine not found" });
      }
      if (!masterMedicine.active) {
        return res.status(400).json({ error: "Master medicine is inactive" });
      }
    } else if (req.body.item_code) {
      // Try to find master medicine by item_code
      masterMedicine = await MasterMedicine.findOne({
        item_code: req.body.item_code,
        active: true,
      });
      if (masterMedicine) {
        medicineId = masterMedicine._id;
      }
    }

    // Check if inventory already exists for this medicine
    if (medicineId) {
      const existing = await PharmacyInventory.findOne({
        hospitalId: req.hospitalId,
        medicineId: medicineId,
      });
      if (existing) {
        return res.status(400).json({
          error: "Inventory already exists for this medicine",
          existingItem: existing,
        });
      }
    }

    // Create inventory item
    const inventoryData = {
      ...req.body,
      hospitalId: req.hospitalId,
    };

    // If master medicine found, populate legacy fields and set medicineId
    if (masterMedicine) {
      inventoryData.medicineId = masterMedicine._id;
      // Populate legacy fields from master medicine if not provided
      if (!inventoryData.item_code)
        inventoryData.item_code = masterMedicine.item_code;
      if (!inventoryData.generic_name)
        inventoryData.generic_name = masterMedicine.generic_name;
      if (!inventoryData.generic_name2)
        inventoryData.generic_name2 = masterMedicine.generic_name2;
      if (!inventoryData.pack) inventoryData.pack = masterMedicine.pack;
      if (!inventoryData.manufacturer)
        inventoryData.manufacturer = masterMedicine.manufacturer;
      if (!inventoryData.type) inventoryData.type = masterMedicine.type;
      if (!inventoryData.description)
        inventoryData.description = masterMedicine.description;
    }

    const newItem = new PharmacyInventory(inventoryData);
    const savedItem = await newItem.save();

    // Populate master medicine before returning
    await savedItem.populate(
      "medicineId",
      "item_code generic_name generic_name2 manufacturer pack type description hsn_code"
    );

    // Index the new item in Meilisearch
    await indexDocument(savedItem);

    res.status(201).json(savedItem);
  } catch (error) {
    console.error("Error creating pharmacy inventory:", error);
    res
      .status(500)
      .json({ error: "Failed to create item", details: error.message });
  }
});

// Update pharmacy inventory item
router.put("/:id", async (req, res) => {
  try {
    // Check if id is a valid ObjectId
    const isValidObjectId = mongoose.Types.ObjectId.isValid(req.params.id);

    // Build query - only use _id if it's a valid ObjectId
    const query = {
      hospitalId: req.hospitalId,
    };

    if (isValidObjectId) {
      // If valid ObjectId, try both _id and item_code
      query.$or = [{ _id: req.params.id }, { item_code: req.params.id }];
    } else {
      // If not valid ObjectId, it must be an item_code
      query.item_code = req.params.id;
    }

    // Don't allow updating medicineId directly - it should be set during creation
    const updateData = { ...req.body };
    delete updateData.medicineId;

    const updatedItem = await PharmacyInventory.findOneAndUpdate(
      query,
      updateData,
      { new: true }
    ).populate(
      "medicineId",
      "item_code generic_name generic_name2 manufacturer pack type description hsn_code"
    );

    if (!updatedItem) {
      return res.status(404).json({ error: "Item not found" });
    }

    // Update the item in Meilisearch
    await indexDocument(updatedItem);

    res.json(updatedItem);
  } catch (error) {
    console.error("Update error:", error);
    res
      .status(500)
      .json({ error: "Failed to update item", details: error.message });
  }
});

// Delete pharmacy inventory item
router.delete("/:id", async (req, res) => {
  try {
    const deletedItem = await PharmacyInventory.findByIdAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!deletedItem) {
      return res.status(404).json({ error: "Item not found" });
    }

    // Remove from Meilisearch
    await deleteDocument(deletedItem._id.toString());

    res.json({ message: "Item deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// Get items by category
router.get("/category/:category", async (req, res) => {
  try {
    const items = await PharmacyInventory.find({
      category: req.params.category,
      hospitalId: req.hospitalId,
      active: true,
    }).populate(
      "medicineId",
      "item_code generic_name generic_name2 manufacturer pack type description hsn_code"
    );
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch items by category" });
  }
});

// Get items by status
router.get("/status/:status", async (req, res) => {
  try {
    const items = await PharmacyInventory.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
      active: true,
    }).populate(
      "medicineId",
      "item_code generic_name generic_name2 manufacturer pack type description hsn_code"
    );
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch items by status" });
  }
});

// Get low stock items
router.get("/low-stock", async (req, res) => {
  try {
    const lowStockItems = await PharmacyInventory.find({
      hospitalId: req.hospitalId,
      active: true,
      $expr: {
        $lt: [
          {
            $reduce: {
              input: "$batches",
              initialValue: 0,
              in: { $add: ["$$value", { $ifNull: ["$$this.quantity", 0] }] },
            },
          },
          10,
        ],
      },
    }).populate(
      "medicineId",
      "item_code generic_name generic_name2 manufacturer pack type description hsn_code"
    );
    res.json(lowStockItems);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch low stock items" });
  }
});

// Update item quantity
router.put("/:id/quantity", async (req, res) => {
  try {
    const { quantity } = req.body;
    const updatedItem = await PharmacyInventory.findByIdAndUpdate(
      { _id: req.params.id, hospitalId: req.hospitalId },
      { quantity },
      { new: true }
    );
    if (!updatedItem) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json(updatedItem);
  } catch (error) {
    res.status(500).json({ error: "Failed to update quantity" });
  }
});

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage: storage });

// Process invoice image using DeepSeek API
router.post("/process-invoice", upload.single("invoice"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded" });
    }

    // Call DeepSeek API to process the invoice
    const deepseekResponse = await axios.post(
      "https://api.deepseek.com/v1/vision/invoice",
      {
        image: req.file.path,
        // Add any additional parameters required by DeepSeek API
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Process the response from DeepSeek API
    const extractedData = deepseekResponse.data;

    // Format the response
    const response = {
      success: true,
      vendorName: extractedData.vendor_name,
      gst: extractedData.gst_number,
      invoiceNo: extractedData.invoice_number,
      invoiceDate: extractedData.invoice_date,
      invoiceValue: extractedData.total_amount,
      items: extractedData.items.map((item) => ({
        itemId: item.id || Math.random().toString(36).substr(2, 9),
        itemDesc: item.description,
        hsnCode: item.hsn_code,
        batchNo: item.batch_number,
        expiryDate: item.expiry_date,
        quantityApproved: Number(item.quantity),
        packSize: Number(item.pack_size || 1),
        totalQty: Number(item.quantity),
        saleRate: Number(item.sale_rate || 0),
        purcRate: Number(item.purchase_rate),
        unitRate: Number(item.unit_rate || item.purchase_rate),
        unitMRP: Number(item.mrp || item.sale_rate),
        cgst: Number(item.cgst || 0),
        sgst: Number(item.sgst || 0),
        igst: Number(item.igst || 0),
        purcAmt: Number(item.purchase_rate) * Number(item.quantity),
        saleAmt: Number(item.sale_rate || 0) * Number(item.quantity),
      })),
    };

    res.json(response);
  } catch (error) {
    console.error("Error processing invoice:", error);
    res.status(500).json({
      success: false,
      message: "Failed to process invoice",
      error: error.message,
    });
  }
});

// Index all data to Meilisearch
router.post("/index-all", async (req, res) => {
  try {
    const result = await indexAllData();
    res.json({
      success: result.success,
      message: result.success ? "Data indexed successfully" : "Indexing failed",
      indexed: result.indexed || 0,
      errors: result.errors || 0,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to index data",
      details: error.message,
    });
  }
});

// Test Meilisearch connection
router.get("/test-meilisearch", async (req, res) => {
  try {
    const { client } = require("../utils/meilisearch");

    // Test basic connection
    const health = await client.health();

    res.json({
      success: true,
      message: "Meilisearch connection successful",
      health: health,
    });
  } catch (error) {
    res.json({
      success: false,
      message: "Meilisearch connection failed",
      error: error.message,
    });
  }
});

// Get search health
router.get("/search/health", async (req, res) => {
  try {
    const { client, getIndexStats } = require("../utils/meilisearch");
    const health = await client.health();
    const indexStats = await getIndexStats();
    const mongoCount = await PharmacyInventory.countDocuments({
      hospitalId: req.hospitalId,
    });

    res.json({
      status: "healthy",
      meilisearch: health,
      index: indexStats,
      mongodb: {
        totalDocuments: mongoCount,
        hasData: mongoCount > 0,
      },
    });
  } catch (error) {
    res.json({
      status: "unhealthy",
      error: error.message,
    });
  }
});

module.exports = router;
