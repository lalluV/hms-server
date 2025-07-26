// routes/pharmacy.js
const express = require("express");
const router = express.Router();
const PharmacyInventory = require("../models/PharmacyInventory");
const multer = require("multer");
const path = require("path");
const axios = require("axios");

// Levenshtein distance function for fuzzy matching
function levenshteinDistance(str1, str2) {
  const matrix = [];
  const n = str2.length;
  const m = str1.length;

  if (n === 0) return m;
  if (m === 0) return n;

  // Create matrix
  for (let i = 0; i <= n; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= m; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        );
      }
    }
  }

  return matrix[n][m];
}

// Calculate similarity score (0-1, where 1 is exact match)
function calculateSimilarity(str1, str2) {
  const maxLength = Math.max(str1.length, str2.length);
  if (maxLength === 0) return 1;
  const distance = levenshteinDistance(str1.toLowerCase(), str2.toLowerCase());
  return (maxLength - distance) / maxLength;
}

// Enhanced fuzzy search function
function fuzzySearch(items, query, threshold = 0.6) {
  const results = [];
  const queryLower = query.toLowerCase();

  items.forEach((item) => {
    let maxSimilarity = 0;
    let matchedField = "";

    // Fields to search in
    const searchFields = [
      { field: "generic_name", value: item.generic_name || "" },
      { field: "generic_name2", value: item.generic_name2 || "" },
      { field: "manufacturer", value: item.manufacturer || "" },
      { field: "description", value: item.description || "" },
      { field: "brand_name", value: item.brand_name || "" },
      { field: "composition", value: item.composition || "" },
    ];

    searchFields.forEach(({ field, value }) => {
      if (value) {
        const valueLower = value.toLowerCase();

        // Exact match gets highest score
        if (valueLower.includes(queryLower)) {
          maxSimilarity = Math.max(maxSimilarity, 1.0);
          matchedField = field;
        } else {
          // Calculate fuzzy similarity
          const similarity = calculateSimilarity(queryLower, valueLower);
          if (similarity > maxSimilarity) {
            maxSimilarity = similarity;
            matchedField = field;
          }

          // Also check if query words are present in the value
          const queryWords = queryLower.split(" ");
          const valueWords = valueLower.split(" ");

          queryWords.forEach((queryWord) => {
            valueWords.forEach((valueWord) => {
              const wordSimilarity = calculateSimilarity(queryWord, valueWord);
              if (wordSimilarity > maxSimilarity) {
                maxSimilarity = wordSimilarity;
                matchedField = field;
              }
            });
          });
        }
      }
    });

    if (maxSimilarity >= threshold) {
      results.push({
        item,
        similarity: maxSimilarity,
        matchedField,
      });
    }
  });

  // Sort by similarity score (highest first)
  return results.sort((a, b) => b.similarity - a.similarity);
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

// Enhanced search medicines with fuzzy matching
router.get("/search", async (req, res) => {
  const { q, threshold = 0.6 } = req.query;

  if (!q) {
    return res
      .status(400)
      .json({ error: 'Missing search query parameter "q"' });
  }

  try {
    // First try exact regex search for fast results
    const searchRegex = new RegExp(q, "i");
    const exactResults = await PharmacyInventory.find({
      $or: [
        { generic_name: searchRegex },
        { generic_name2: searchRegex },
        { manufacturer: searchRegex },
        { description: searchRegex },
        { brand_name: searchRegex },
        { composition: searchRegex },
      ],
    }).limit(20);

    if (exactResults.length >= 10) {
      // If we have enough exact matches, return them
      return res.json(exactResults.slice(0, 10));
    }

    // If not enough exact matches, get all items and do fuzzy search
    const allItems = await PharmacyInventory.find().lean();
    const fuzzyResults = fuzzySearch(allItems, q, parseFloat(threshold));

    // Combine exact and fuzzy results, avoiding duplicates
    const exactIds = new Set(exactResults.map((item) => item._id.toString()));
    const combinedResults = [
      ...exactResults,
      ...fuzzyResults
        .filter((result) => !exactIds.has(result.item._id.toString()))
        .map((result) => result.item),
    ];

    res.json(combinedResults.slice(0, 10));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
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
