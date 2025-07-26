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

// Search medicines with Typesense (1mg style fast search)
router.get("/search", async (req, res) => {
  const { q, limit = 10 } = req.query;

  if (!q) {
    return res
      .status(400)
      .json({ error: 'Missing search query parameter "q"' });
  }

  try {
    const startTime = Date.now();

    // Use Typesense for fast, fuzzy search
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
    // Return empty results instead of error
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

    // Index the new item in Typesense
    try {
      await indexDocument(savedItem.toObject());
    } catch (indexError) {
      console.error("Failed to index item in Typesense:", indexError);
      // Don't fail the request if indexing fails
    }

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
    try {
      await indexDocument(updatedItem.toObject());
    } catch (indexError) {
      console.error("Failed to update item in Typesense:", indexError);
      // Don't fail the request if indexing fails
    }

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

    // Remove the item from Typesense
    try {
      await deleteDocument(req.params.id);
    } catch (indexError) {
      console.error("Failed to delete item from Typesense:", indexError);
      // Don't fail the request if deletion from index fails
    }

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
      quantity: { $lt: 10 }, // Assuming 10 is the threshold for low stock
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

// Initialize Typesense and reindex all data
router.post("/reindex", async (req, res) => {
  try {
    await initializeTypesense();
    res.json({
      message: "Typesense initialized and data indexed successfully",
    });
  } catch (error) {
    console.error("Reindex error:", error);
    res
      .status(500)
      .json({ error: "Failed to reindex data", details: error.message });
  }
});

// Get search statistics
router.get("/search/stats", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res
        .status(400)
        .json({ error: 'Missing search query parameter "q"' });
    }

    const startTime = Date.now();
    const results = await searchMedicines(q, 1);
    const searchTime = Date.now() - startTime;

    res.json({
      query: q,
      searchTime: `${searchTime}ms`,
      totalResults: results.length,
      performance:
        searchTime < 100 ? "Excellent" : searchTime < 500 ? "Good" : "Slow",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get search stats" });
  }
});

// Health check for Typesense
router.get("/search/health", async (req, res) => {
  try {
    const { client } = require("../utils/typesense");
    const health = await client.health.retrieve();
    const collections = await client.collections().retrieve();
    const pharmacyCollection = collections.find(
      (col) => col.name === "pharmacy_inventory"
    );

    res.json({
      status: "healthy",
      typesense: health,
      collection: pharmacyCollection
        ? {
            name: pharmacyCollection.name,
            documents: pharmacyCollection.num_documents,
            fields: pharmacyCollection.num_documents > 0 ? "indexed" : "empty",
          }
        : null,
    });
  } catch (error) {
    res.json({
      status: "unhealthy",
      error: error.message,
    });
  }
});

module.exports = router;
