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
  recreateCollection,
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
    console.log("🔄 Manual reindex requested...");

    // First check if we have data in MongoDB
    const totalCount = await PharmacyInventory.countDocuments({});
    console.log(`📊 Found ${totalCount} documents in MongoDB`);

    if (totalCount === 0) {
      return res.json({
        message: "No data found in MongoDB to index",
        totalCount: 0,
      });
    }

    // Force reindex
    await initializeTypesense();

    // Check the result
    const { client } = require("../utils/typesense");
    const collections = await client.collections().retrieve();
    const pharmacyCollection = collections.find(
      (col) => col.name === "pharmacyinventory"
    );

    res.json({
      message: "Typesense reindex completed",
      mongoCount: totalCount,
      typesenseCount: pharmacyCollection ? pharmacyCollection.num_documents : 0,
      success: true,
    });
  } catch (error) {
    console.error("❌ Reindex error:", error);
    res.status(500).json({
      error: "Failed to reindex data",
      details: error.message,
      success: false,
    });
  }
});

// Force recreate collection with new schema
router.post("/recreate", async (req, res) => {
  try {
    console.log("🔄 Force recreate collection requested...");

    // First check if we have data in MongoDB
    const totalCount = await PharmacyInventory.countDocuments({});
    console.log(`📊 Found ${totalCount} documents in MongoDB`);

    if (totalCount === 0) {
      return res.json({
        message: "No data found in MongoDB to index",
        totalCount: 0,
      });
    }

    // Force recreate collection
    await recreateCollection();

    // Check the result
    const { client } = require("../utils/typesense");
    const collections = await client.collections().retrieve();
    const pharmacyCollection = collections.find(
      (col) => col.name === "pharmacyinventory"
    );

    res.json({
      message: "Typesense collection recreated successfully",
      mongoCount: totalCount,
      typesenseCount: pharmacyCollection ? pharmacyCollection.num_documents : 0,
      success: true,
    });
  } catch (error) {
    console.error("❌ Recreate error:", error);
    res.status(500).json({
      error: "Failed to recreate collection",
      details: error.message,
      success: false,
    });
  }
});

// Progressive indexing - index data in chunks
router.post("/progressive-index", async (req, res) => {
  try {
    console.log("🔄 Starting progressive indexing...");

    const { client } = require("../utils/typesense");

    // First ensure collection exists
    const collections = await client.collections().retrieve();
    const collectionExists = collections.find(
      (c) => c.name === "pharmacyinventory"
    );

    if (!collectionExists) {
      // Create collection
      const pharmacySchema = {
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
        strict: false,
      };

      await client.collections().create(pharmacySchema);
      console.log("✅ Created pharmacyinventory collection");
    }

    // Get total count
    const totalCount = await PharmacyInventory.countDocuments({});
    console.log(`📊 Total documents to index: ${totalCount}`);

    // Index in chunks of 1000
    const chunkSize = 1000;
    let indexedCount = 0;
    let errorCount = 0;

    for (let skip = 0; skip < totalCount; skip += chunkSize) {
      try {
        console.log(
          `📦 Processing chunk ${Math.floor(skip / chunkSize) + 1}/${Math.ceil(
            totalCount / chunkSize
          )}...`
        );

        const items = await PharmacyInventory.find({})
          .skip(skip)
          .limit(chunkSize);

        const documents = items.map((item) => {
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

        const results = await client
          .collections("pharmacyinventory")
          .documents()
          .import(documents);

        const successCount = results.filter((result) => !result.error).length;
        const chunkErrors = results.filter((result) => result.error);

        indexedCount += successCount;
        errorCount += chunkErrors.length;

        console.log(
          `✅ Chunk ${
            Math.floor(skip / chunkSize) + 1
          }: ${successCount} success, ${chunkErrors.length} errors`
        );

        // Small delay to prevent overwhelming the server
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (chunkError) {
        console.error(
          `❌ Error processing chunk ${Math.floor(skip / chunkSize) + 1}:`,
          chunkError.message
        );
        errorCount += chunkSize;
      }
    }

    res.json({
      message: "Progressive indexing completed",
      totalCount: totalCount,
      indexedCount: indexedCount,
      errorCount: errorCount,
      success: indexedCount > 0,
    });
  } catch (error) {
    console.error("❌ Progressive indexing error:", error);
    res.status(500).json({
      error: "Progressive indexing failed",
      details: error.message,
      success: false,
    });
  }
});

// Test Typesense connection and collection creation
router.post("/test-typesense", async (req, res) => {
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

    // Try to create the pharmacy collection
    const pharmacySchema = {
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
      strict: false,
    };

    try {
      // Delete existing collection if it exists
      const existingCollection = collections.find(
        (c) => c.name === "pharmacyinventory"
      );
      if (existingCollection) {
        await client.collections("pharmacyinventory").delete();
        console.log("🗑️  Deleted existing pharmacyinventory collection");
      }

      // Create new collection
      await client.collections().create(pharmacySchema);
      console.log("✅ Pharmacy collection created successfully");

      res.json({
        message: "Pharmacy collection created successfully",
        health: health,
        collections: collections.map((c) => c.name),
        canCreateCollections: true,
        success: true,
      });
    } catch (createError) {
      console.error("❌ Collection creation failed:", createError.message);
      res.json({
        message: "Typesense connection works but collection creation failed",
        health: health,
        collections: collections.map((c) => c.name),
        canCreateCollections: false,
        error: createError.message,
        success: false,
      });
    }
  } catch (error) {
    console.error("❌ Typesense connection test failed:", error);
    res.status(500).json({
      error: "Typesense connection test failed",
      details: error.message,
      success: false,
    });
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
      (col) => col.name === "pharmacyinventory"
    );

    // Also check MongoDB data
    const mongoCount = await PharmacyInventory.countDocuments({});
    const sampleItems = await PharmacyInventory.find({}).limit(3);

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
      mongodb: {
        totalDocuments: mongoCount,
        sampleItems: sampleItems.length,
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
