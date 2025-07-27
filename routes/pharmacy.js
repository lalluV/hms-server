// routes/pharmacy.js
const express = require("express");
const router = express.Router();
const PharmacyInventory = require("../models/PharmacyInventory");
const multer = require("multer");
const path = require("path");
const axios = require("axios");
const {
  searchMedicines,
  indexDocument,
  deleteDocument,
  initializeTypesense,
  indexAllData,
  getCollectionStats,
} = require("../utils/typesense");

// Get popular medicines
router.get("/popular", async (req, res) => {
  try {
    const popularMedicines = await PharmacyInventory.find()
      .sort({ orderingNumber: -1 })
      .limit(5);
    res.json(popularMedicines);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch popular medicines" });
  }
});

// Fast search with Typesense
router.get("/search", async (req, res) => {
  const { q, limit = 10 } = req.query;

  if (!q) {
    return res
      .status(400)
      .json({ error: 'Missing search query parameter "q"' });
  }

  try {
    const startTime = Date.now();
    const results = await searchMedicines(q, parseInt(limit));
    const searchTime = Date.now() - startTime;

    res.json({
      results,
      searchTime: `${searchTime}ms`,
      totalResults: results.length,
      query: q,
      success: true,
    });
  } catch (err) {
    console.error("❌ Search error:", err);
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
    const items = await PharmacyInventory.find();
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch pharmacy inventory" });
  }
});

// Get pharmacy inventory item by ID
router.get("/:id", async (req, res) => {
  try {
    const item = await PharmacyInventory.findOne({ item_code: req.params.id });
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
    const newItem = new PharmacyInventory(req.body);
    const savedItem = await newItem.save();

    // Index the new item
    await indexDocument(savedItem.toObject());

    res.status(201).json(savedItem);
  } catch (error) {
    res.status(500).json({ error: "Failed to create item" });
  }
});

// Update pharmacy inventory item
router.put("/:id", async (req, res) => {
  try {
    const updatedItem = await PharmacyInventory.findOneAndUpdate(
      { item_code: req.params.id },
      req.body,
      { new: true }
    );
    if (!updatedItem) {
      return res
        .status(404)
        .json({ error: "Item not found with the given item code" });
    }

    // Update the item in Typesense
    await indexDocument(updatedItem.toObject());

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
    const deletedItem = await PharmacyInventory.findByIdAndDelete(
      req.params.id
    );
    if (!deletedItem) {
      return res.status(404).json({ error: "Item not found" });
    }

    // Remove from Typesense
    await deleteDocument(req.params.id);

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
    });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch items by category" });
  }
});

// Get items by status
router.get("/status/:status", async (req, res) => {
  try {
    const items = await PharmacyInventory.find({ status: req.params.status });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch items by status" });
  }
});

// Get low stock items
router.get("/low-stock", async (req, res) => {
  try {
    const lowStockItems = await PharmacyInventory.find({
      quantity: { $lt: 10 },
    });
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
      req.params.id,
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

    const deepseekResponse = await axios.post(
      "https://api.deepseek.com/v1/vision/invoice",
      {
        image: req.file.path,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const extractedData = deepseekResponse.data;

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

// Typesense management endpoints

// Initialize Typesense
router.post("/init-typesense", async (req, res) => {
  try {
    const success = await initializeTypesense();
    res.json({
      success,
      message: success
        ? "Typesense initialized successfully"
        : "Typesense initialization failed",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to initialize Typesense",
      details: error.message,
    });
  }
});

// Index all data
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

// Test indexing with small sample
router.post("/test-index", async (req, res) => {
  try {
    console.log("🧪 Testing indexing with sample data...");

    // Initialize Typesense first
    await initializeTypesense();

    // Get just 10 documents for testing
    const sampleItems = await PharmacyInventory.find({}).limit(10);
    console.log(`📝 Found ${sampleItems.length} sample items`);

    if (sampleItems.length === 0) {
      return res.json({
        message: "No sample data found",
        success: false,
      });
    }

    // Index the sample
    const documents = sampleItems.map((item) => {
      const doc = item.toObject();
      const searchableText = [
        doc.generic_name || "",
        doc.generic_name2 || "",
        doc.manufacturer || "",
        doc.description || "",
        doc.item_code || "",
      ]
        .filter(Boolean)
        .join(" ");

      return {
        id: doc._id.toString(),
        item_code: doc.item_code,
        generic_name: doc.generic_name,
        generic_name2: doc.generic_name2,
        manufacturer: doc.manufacturer,
        description: doc.description,
        searchable_text: searchableText,
      };
    });

    const { client } = require("../utils/typesense");
    const results = await client
      .collections("pharmacyinventory")
      .documents()
      .import(documents);

    const successCount = results.filter((result) => !result.error).length;
    const errors = results.filter((result) => result.error);

    res.json({
      message: "Test indexing completed",
      sampleCount: sampleItems.length,
      indexedCount: successCount,
      errors: errors.length > 0 ? errors : null,
      success: successCount > 0,
    });
  } catch (error) {
    console.error("❌ Test indexing error:", error);
    res.status(500).json({
      error: "Test indexing failed",
      details: error.message,
      success: false,
    });
  }
});

// Test Typesense connection
router.post("/test-connection", async (req, res) => {
  try {
    console.log("🔍 Testing Typesense connection...");

    const { client } = require("../utils/typesense");

    // Test health
    const health = await client.health.retrieve();
    console.log("✅ Health check:", health);

    // List collections
    const collections = await client.collections().retrieve();
    console.log(
      "📋 Collections:",
      collections.map((c) => c.name)
    );

    // Try to create collection
    const collectionSchema = {
      name: "pharmacyinventory",
      fields: [
        { name: "id", type: "string" },
        { name: "item_code", type: "string" },
        { name: "generic_name", type: "string" },
        { name: "generic_name2", type: "string" },
        { name: "manufacturer", type: "string" },
        { name: "description", type: "string" },
        { name: "searchable_text", type: "string" },
      ],
      default_sorting_field: "id",
    };

    // Delete existing collection if it exists
    const existingCollection = collections.find(
      (c) => c.name === "pharmacyinventory"
    );
    if (existingCollection) {
      await client.collections("pharmacyinventory").delete();
      console.log("🗑️ Deleted existing collection");
    }

    // Create new collection
    await client.collections().create(collectionSchema);
    console.log("✅ Collection created successfully");

    res.json({
      message: "Typesense connection test successful",
      health: health,
      collections: collections.map((c) => c.name),
      canCreateCollections: true,
      success: true,
    });
  } catch (error) {
    console.error("❌ Typesense connection test failed:", error);
    res.status(500).json({
      error: "Typesense connection test failed",
      details: error.message,
      success: false,
    });
  }
});

// Get search health
router.get("/search/health", async (req, res) => {
  try {
    const { client } = require("../utils/typesense");
    const health = await client.health.retrieve();
    const collectionStats = await getCollectionStats();
    const mongoCount = await PharmacyInventory.countDocuments({});

    res.json({
      status: "healthy",
      typesense: health,
      collection: collectionStats,
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
