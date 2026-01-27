// routes/pharmacy.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const MasterMedicine = require("../models/MasterMedicine");
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);
const multer = require("multer");
const path = require("path");
const axios = require("axios");
// Meilisearch removed - using MongoDB search for tenant data

/**
 * Helper function to manually populate master medicine data
 * (Can't use Mongoose populate because MasterMedicine is on default connection, not tenant)
 */
async function populateMasterMedicine(items) {
  if (!items) return items;
  
  const isArray = Array.isArray(items);
  const itemsArray = isArray ? items : [items];
  
  // Get all unique medicineIds
  const medicineIds = itemsArray
    .map(item => {
      const medId = item.medicineId || (item.toObject ? item.toObject().medicineId : null);
      return medId && mongoose.Types.ObjectId.isValid(medId) ? medId : null;
    })
    .filter(id => id !== null);
  
  if (medicineIds.length === 0) {
    return items;
  }
  
  // Fetch all master medicines at once
  const masterMedicines = await MasterMedicine.find({
    _id: { $in: medicineIds }
  }).select("item_code generic_name generic_name2 manufacturer pack type description hsn_code").lean();
  
  // Create a map for quick lookup
  const masterMedMap = new Map();
  masterMedicines.forEach(med => {
    masterMedMap.set(med._id.toString(), med);
  });
  
  // Attach master medicine data to each item
  const populatedItems = itemsArray.map(item => {
    const itemObj = item.toObject ? item.toObject() : item;
    const medId = itemObj.medicineId;
    
    if (medId && mongoose.Types.ObjectId.isValid(medId)) {
      const masterMed = masterMedMap.get(medId.toString());
      if (masterMed) {
        itemObj.medicineId = masterMed;
      }
    }
    
    return itemObj;
  });
  
  return isArray ? populatedItems : populatedItems[0];
}

// Get popular medicines
router.get("/popular", async (req, res) => {
  try {
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");

    const popularMedicines = await PharmacyInventory.find({
      hospitalId: req.hospitalId,
      active: true,
    })
      .sort({ orderingNumber: -1 })
      .limit(5)
      .lean();
    const populatedMedicines = await populateMasterMedicine(popularMedicines);
    res.json(populatedMedicines);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch popular medicines" });
  }
});

// Get pharmacy inventory items by medicineIds
router.get("/by-medicine-ids", async (req, res) => {
  try {
    const { medicineIds } = req.query;
    
    if (!medicineIds) {
      return res.status(400).json({ error: "medicineIds query parameter is required" });
    }

    // Parse medicineIds - can be comma-separated string or array
    let idsArray;
    if (Array.isArray(medicineIds)) {
      idsArray = medicineIds;
    } else if (typeof medicineIds === "string") {
      idsArray = medicineIds.split(",").map(id => id.trim());
    } else {
      return res.status(400).json({ error: "medicineIds must be a string or array" });
    }

    // Validate all IDs are valid ObjectIds
    const validIds = idsArray.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) {
      return res.json([]);
    }

    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");
    
    const inventoryItems = await PharmacyInventory.find({
      hospitalId: req.hospitalId,
      medicineId: { $in: validIds },
      active: true,
    }).lean();

    const populatedItems = await populateMasterMedicine(inventoryItems);
    res.json(populatedItems);
  } catch (error) {
    console.error("Error fetching inventory by medicineIds:", error);
    res.status(500).json({ error: "Failed to fetch inventory items" });
  }
});

// Search medicines (MongoDB search for tenant data)
router.get("/search", async (req, res) => {
  const { q, limit = 10 } = req.query;

  if (!q) {
    return res
      .status(400)
      .json({ error: 'Missing search query parameter "q"' });
  }

  try {
    const startTime = Date.now();
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");

    // Search in tenant database using MongoDB
    const searchQuery = {
      hospitalId: req.hospitalId,
      active: true,
      $or: [
        { item_code: { $regex: q, $options: "i" } },
        { generic_name: { $regex: q, $options: "i" } },
        { generic_name2: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { manufacturer: { $regex: q, $options: "i" } },
      ],
    };

    const results = await PharmacyInventory.find(searchQuery)
      .limit(parseInt(limit))
      .sort({ orderingNumber: -1 })
      .lean();
    const populatedResults = await populateMasterMedicine(results);

    const searchTime = Date.now() - startTime;

    res.json({
      results: populatedResults.map((item) => ({
        ...item,
        _id: item._id.toString(),
      })),
      searchTime: `${searchTime}ms`,
      totalResults: populatedResults.length,
      query: q,
      success: true,
    });
  } catch (err) {
    console.error("Search error:", err);
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
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");
    const items = await PharmacyInventory.find({
      hospitalId: req.hospitalId,
      active: true,
    })
      .sort({ orderingNumber: -1 })
      .lean();
    const populatedItems = await populateMasterMedicine(items);
    res.json(populatedItems);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch pharmacy inventory" });
  }
});

// Get pharmacy inventory item by ID
router.get("/:id", async (req, res) => {
  try {
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");
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

    const item = await PharmacyInventory.findOne(query).lean();
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }
    const populatedItem = await populateMasterMedicine(item);
    res.json(populatedItem);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch item" });
  }
});

// Create new pharmacy inventory item
router.post("/", async (req, res) => {
  try {
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");
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
    } else if (req.body.item_code) {
      // Also check by item_code if medicineId is not available
      const existing = await PharmacyInventory.findOne({
        hospitalId: req.hospitalId,
        item_code: req.body.item_code,
      });
      if (existing) {
        return res.status(400).json({
          error: "Inventory already exists for this item_code",
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

    // Manually populate master medicine data
    // (Can't use Mongoose populate because MasterMedicine is on default connection, not tenant)
    const populatedItem = await populateMasterMedicine(savedItem);

    res.status(201).json(populatedItem);
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
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");
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
    ).lean();

    if (!updatedItem) {
      return res.status(404).json({ error: "Item not found" });
    }

    const populatedItem = await populateMasterMedicine(updatedItem);
    res.json(populatedItem);
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
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");
    const deletedItem = await PharmacyInventory.findByIdAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
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
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");
    const items = await PharmacyInventory.find({
      category: req.params.category,
      hospitalId: req.hospitalId,
      active: true,
    }).lean();
    const populatedItems = await populateMasterMedicine(items);
    res.json(populatedItems);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch items by category" });
  }
});

// Get items by status
router.get("/status/:status", async (req, res) => {
  try {
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");
    const items = await PharmacyInventory.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
      active: true,
    }).lean();
    const populatedItems = await populateMasterMedicine(items);
    res.json(populatedItems);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch items by status" });
  }
});

// Get low stock items
router.get("/low-stock", async (req, res) => {
  try {
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");
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
    }).lean();
    const populatedItems = await populateMasterMedicine(lowStockItems);
    res.json(populatedItems);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch low stock items" });
  }
});

// Update item quantity
router.put("/:id/quantity", async (req, res) => {
  try {
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");
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

// Get search health (MongoDB only - no Meilisearch for tenant data)
router.get("/search/health", async (req, res) => {
  try {
    const PharmacyInventory = req.tenantDb.model("PharmacyInventory");
    const mongoCount = await PharmacyInventory.countDocuments({
      hospitalId: req.hospitalId,
      active: true,
    });

    res.json({
      status: "healthy",
      searchEngine: "mongodb",
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
