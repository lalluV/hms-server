// routes/pharmacy.js
const express = require("express");
const router = express.Router();
const PharmacyInventory = require("../models/PharmacyInventory");
const multer = require("multer");
const path = require("path");
const axios = require("axios");

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

// Enhanced search medicines with 1mg-style fuzzy matching
router.get("/search", async (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res
      .status(400)
      .json({ error: 'Missing search query parameter "q"' });
  }

  try {
    const searchQuery = q.trim();

    // Create multiple search patterns for better matching
    const exactRegex = new RegExp(`\\b${searchQuery}`, "i"); // Word boundary match
    const partialRegex = new RegExp(searchQuery, "i"); // Partial match
    const spaceInsensitiveRegex = new RegExp(
      searchQuery.replace(/\s+/g, ".*"),
      "i"
    ); // Space insensitive

    // Check if query contains numbers for dosage/strength matching
    const hasNumbers = /\d/.test(searchQuery);
    const numberMatch = searchQuery.match(/\d+/g);

    // Build comprehensive search criteria
    const searchCriteria = {
      $or: [
        // Exact word boundary matches (highest priority)
        { generic_name: exactRegex },
        { generic_name2: exactRegex },
        { name: exactRegex },
        { brand_name: exactRegex },
        { product_name: exactRegex },
        { itemDesc: exactRegex },

        // Partial matches in main fields
        { generic_name: partialRegex },
        { generic_name2: partialRegex },
        { name: partialRegex },
        { brand_name: partialRegex },
        { product_name: partialRegex },
        { itemDesc: partialRegex },
        { description: partialRegex },

        // Manufacturer matches
        { manufacturer: partialRegex },
        { company: partialRegex },

        // Space-insensitive matches (for compound names)
        { generic_name: spaceInsensitiveRegex },
        { generic_name2: spaceInsensitiveRegex },
        { name: spaceInsensitiveRegex },
        { brand_name: spaceInsensitiveRegex },
        { description: spaceInsensitiveRegex },

        // Composition/salt matches
        { composition: partialRegex },
        { salt: partialRegex },
        { salt_name: partialRegex },

        // Category/type matches
        { category: partialRegex },
        { type: partialRegex },
        { drug_type: partialRegex },
      ],
    };

    // Add number-specific searches if query contains numbers
    if (hasNumbers && numberMatch) {
      numberMatch.forEach((num) => {
        const numRegex = new RegExp(num, "i");
        searchCriteria.$or.push(
          { strength: numRegex },
          { dosage: numRegex },
          { pack_size: numRegex },
          { generic_name: numRegex },
          { generic_name2: numRegex },
          { name: numRegex },
          { description: numRegex },
          { composition: numRegex }
        );
      });
    }

    // First get all matching results
    let results = await PharmacyInventory.find(searchCriteria).lean();

    // Calculate relevance score and sort in JavaScript for better control
    results = results.map((item) => {
      let score = 0;
      const fields = [
        { field: item.generic_name, weight: 10 },
        { field: item.name, weight: 10 },
        { field: item.brand_name, weight: 8 },
        { field: item.generic_name2, weight: 7 },
        { field: item.itemDesc, weight: 6 },
        { field: item.description, weight: 5 },
        { field: item.manufacturer, weight: 3 },
        { field: item.composition, weight: 4 },
      ];

      fields.forEach(({ field, weight }) => {
        if (field && typeof field === "string") {
          // Exact word match gets full weight
          if (exactRegex.test(field)) {
            score += weight;
          }
          // Partial match gets half weight
          else if (partialRegex.test(field)) {
            score += weight * 0.5;
          }
          // Space-insensitive match gets quarter weight
          else if (spaceInsensitiveRegex.test(field)) {
            score += weight * 0.25;
          }
        }
      });

      // Boost score if it's an exact or near-exact match
      const primaryName = item.generic_name || item.name || "";
      if (primaryName.toLowerCase() === searchQuery.toLowerCase()) {
        score += 50;
      } else if (
        primaryName.toLowerCase().startsWith(searchQuery.toLowerCase())
      ) {
        score += 25;
      }

      return { ...item, relevanceScore: score };
    });

    // Sort by relevance score (highest first), then alphabetically
    results.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      const nameA = a.generic_name || a.name || "";
      const nameB = b.generic_name || b.name || "";
      return nameA.localeCompare(nameB);
    });

    // Remove relevance score and limit results
    results = results.slice(0, 15).map((item) => {
      delete item.relevanceScore;
      return item;
    });

    res.json(results);
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Autocomplete endpoint for quick suggestions (1mg-style)
router.get("/autocomplete", async (req, res) => {
  const { q } = req.query;

  if (!q || q.length < 2) {
    return res.json([]);
  }

  try {
    const searchQuery = q.trim();
    const quickRegex = new RegExp(`^${searchQuery}`, "i"); // Starts with search
    const partialRegex = new RegExp(searchQuery, "i"); // Contains search

    // Get quick autocomplete results (limited to 8 for fast response)
    const suggestions = await PharmacyInventory.find({
      $or: [
        { generic_name: quickRegex },
        { name: quickRegex },
        { brand_name: quickRegex },
        { generic_name: partialRegex },
        { name: partialRegex },
        { brand_name: partialRegex },
      ],
    })
      .select("generic_name name brand_name manufacturer strength")
      .lean()
      .limit(8);

    // Format suggestions for autocomplete
    const formattedSuggestions = suggestions.map((item) => {
      const primaryName =
        item.generic_name || item.name || item.brand_name || "";
      const manufacturer = item.manufacturer || "";
      const strength = item.strength || "";

      return {
        id: item._id,
        name: primaryName,
        display: `${primaryName}${strength ? ` ${strength}` : ""}${
          manufacturer ? ` - ${manufacturer}` : ""
        }`,
        manufacturer: manufacturer,
        strength: strength,
      };
    });

    res.json(formattedSuggestions);
  } catch (err) {
    console.error("Autocomplete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get trending/popular medicines for search suggestions
router.get("/trending", async (req, res) => {
  try {
    // Get medicines sorted by popularity (orderingNumber) and quantity available
    const trendingMedicines = await PharmacyInventory.find({
      quantity: { $gt: 0 }, // Only in-stock items
      $or: [
        { generic_name: { $exists: true, $ne: "" } },
        { name: { $exists: true, $ne: "" } },
        { brand_name: { $exists: true, $ne: "" } },
      ],
    })
      .select("generic_name name brand_name manufacturer strength category")
      .sort({ orderingNumber: -1, quantity: -1 })
      .lean()
      .limit(10);

    const formatted = trendingMedicines.map((item) => ({
      id: item._id,
      name: item.generic_name || item.name || item.brand_name,
      strength: item.strength || "",
      manufacturer: item.manufacturer || "",
      category: item.category || "Medicine",
    }));

    res.json(formatted);
  } catch (error) {
    console.error("Trending medicines error:", error);
    res.status(500).json({ error: "Failed to fetch trending medicines" });
  }
});

// Smart filter search (by category, manufacturer, price range etc.)
router.get("/filter", async (req, res) => {
  try {
    const {
      category,
      manufacturer,
      minPrice,
      maxPrice,
      inStock,
      sortBy = "name",
      sortOrder = "asc",
      page = 1,
      limit = 20,
    } = req.query;

    // Build filter criteria
    const filterCriteria = {};

    if (category) {
      filterCriteria.category = new RegExp(category, "i");
    }

    if (manufacturer) {
      filterCriteria.manufacturer = new RegExp(manufacturer, "i");
    }

    if (minPrice || maxPrice) {
      filterCriteria.price = {};
      if (minPrice) filterCriteria.price.$gte = Number(minPrice);
      if (maxPrice) filterCriteria.price.$lte = Number(maxPrice);
    }

    if (inStock === "true") {
      filterCriteria.quantity = { $gt: 0 };
    }

    // Build sort criteria
    const sortCriteria = {};
    sortCriteria[sortBy] = sortOrder === "desc" ? -1 : 1;

    // Calculate pagination
    const skip = (Number(page) - 1) * Number(limit);

    // Execute query
    const [results, totalCount] = await Promise.all([
      PharmacyInventory.find(filterCriteria)
        .sort(sortCriteria)
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      PharmacyInventory.countDocuments(filterCriteria),
    ]);

    res.json({
      results,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(totalCount / Number(limit)),
        totalItems: totalCount,
        hasNextPage: skip + results.length < totalCount,
        hasPrevPage: Number(page) > 1,
      },
    });
  } catch (error) {
    console.error("Filter search error:", error);
    res.status(500).json({ error: "Failed to filter medicines" });
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
