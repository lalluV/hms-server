// routes/pharmacy.js
const express = require("express");
const router = express.Router();
const PharmacyInventory = require("../models/PharmacyInventory");
const multer = require("multer");
const path = require("path");
const axios = require("axios");

// Simple fuzzy matching function for autocomplete
function createFuzzyRegex(query) {
  // Create a regex that allows for typos and partial matches
  const chars = query.toLowerCase().split("");
  const pattern = chars
    .map((char) => {
      // Allow optional characters between each character
      return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join(".*?");

  return new RegExp(pattern, "i");
}

// Create multiple search patterns for better matching
function createSearchPatterns(query) {
  const cleanQuery = query.trim().toLowerCase();

  return [
    new RegExp(cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), // Exact match
    new RegExp("^" + cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), // Starts with
    new RegExp(cleanQuery.split("").join(".*?"), "i"), // Fuzzy match
    new RegExp(cleanQuery.split(" ").join(".*"), "i"), // Word-based match
  ];
}

// Score search results for better ranking
function scoreResult(item, query, matchedField) {
  const queryLower = query.toLowerCase();
  const fieldValue = (item[matchedField] || "").toLowerCase();

  // Exact match gets highest score
  if (fieldValue === queryLower) return 100;

  // Starts with query gets high score
  if (fieldValue.startsWith(queryLower)) return 90;

  // Contains exact query gets good score
  if (fieldValue.includes(queryLower)) return 80;

  // Partial matches get lower scores based on position
  const index = fieldValue.indexOf(queryLower);
  if (index !== -1) {
    return Math.max(70 - index, 50);
  }

  // Default score for fuzzy matches
  return 30;
}

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

// Enhanced search with 1mg-style functionality
router.get("/search", async (req, res) => {
  const { q, limit = 10 } = req.query;

  if (!q || q.trim().length < 1) {
    return res.json([]);
  }

  try {
    const query = q.trim();
    const searchPatterns = createSearchPatterns(query);
    const searchLimit = Math.min(parseInt(limit), 50);

    // Define search fields with priority weights
    const searchFields = [
      "name",
      "generic_name",
      "brand_name",
      "item_name",
      "generic_name2",
      "manufacturer",
      "composition",
      "description",
      "drug_name",
      "medicine_name",
    ];

    // Build MongoDB aggregation pipeline for better performance
    const pipeline = [
      {
        $match: {
          $or: searchFields.flatMap((field) =>
            searchPatterns.map((pattern) => ({ [field]: pattern }))
          ),
        },
      },
      {
        $addFields: {
          searchScore: {
            $switch: {
              branches: searchFields.map((field, index) => ({
                case: {
                  $regexMatch: {
                    input: { $ifNull: [`$${field}`, ""] },
                    regex: searchPatterns[0],
                  },
                },
                then: 100 - index * 2, // Higher score for priority fields
              })),
              default: 1,
            },
          },
        },
      },
      { $sort: { searchScore: -1, name: 1 } },
      { $limit: searchLimit },
    ];

    const results = await PharmacyInventory.aggregate(pipeline);

    // If no results with complex search, try simpler approach
    if (results.length === 0) {
      const simpleResults = await PharmacyInventory.find({
        $or: searchFields.map((field) => ({
          [field]: { $regex: query, $options: "i" },
        })),
      }).limit(searchLimit);

      return res.json(simpleResults);
    }

    res.json(results);
  } catch (err) {
    console.error("Search error:", err);

    // Fallback to simple search if aggregation fails
    try {
      const fallbackResults = await PharmacyInventory.find({
        $or: [
          { name: { $regex: query, $options: "i" } },
          { generic_name: { $regex: query, $options: "i" } },
          { brand_name: { $regex: query, $options: "i" } },
          { manufacturer: { $regex: query, $options: "i" } },
        ],
      }).limit(10);

      res.json(fallbackResults);
    } catch (fallbackErr) {
      console.error("Fallback search error:", fallbackErr);
      res.status(500).json({ error: "Search failed" });
    }
  }
});

// Auto-suggestions endpoint for autocomplete
router.get("/suggestions", async (req, res) => {
  const { q, limit = 5 } = req.query;

  if (!q || q.trim().length < 2) {
    return res.json([]);
  }

  try {
    const query = q.trim();
    const suggestionsLimit = Math.min(parseInt(limit), 10);

    // Get suggestions from different fields
    const suggestions = await PharmacyInventory.aggregate([
      {
        $match: {
          $or: [
            { name: { $regex: `^${query}`, $options: "i" } },
            { generic_name: { $regex: `^${query}`, $options: "i" } },
            { brand_name: { $regex: `^${query}`, $options: "i" } },
          ],
        },
      },
      {
        $project: {
          suggestion: {
            $cond: [
              {
                $regexMatch: {
                  input: "$name",
                  regex: `^${query}`,
                  options: "i",
                },
              },
              "$name",
              {
                $cond: [
                  {
                    $regexMatch: {
                      input: "$generic_name",
                      regex: `^${query}`,
                      options: "i",
                    },
                  },
                  "$generic_name",
                  "$brand_name",
                ],
              },
            ],
          },
        },
      },
      { $group: { _id: "$suggestion", count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: suggestionsLimit },
      { $project: { suggestion: "$_id", _id: 0 } },
    ]);

    res.json(suggestions.map((s) => s.suggestion).filter(Boolean));
  } catch (error) {
    console.error("Suggestions error:", error);
    res.json([]);
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

module.exports = router;
