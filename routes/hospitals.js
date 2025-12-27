const express = require("express");
const router = express.Router();
const Hospital = require("../models/Hospital");
const adminAuth = require("../middleware/adminAuth");

router.use(adminAuth);

// @route   GET api/hospitals
// @desc    Get all hospitals
// @access  SuperAdmin
router.get("/", async (req, res) => {
  try {
    const hospitals = await Hospital.find();
    res.json(hospitals);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   GET api/hospitals/:id
// @desc    Get hospital by ID
// @access  SuperAdmin
router.get("/:id", async (req, res) => {
  try {
    const hospital = await Hospital.findById(req.params.id);
    if (!hospital) {
      return res.status(404).json({ message: "Hospital not found" });
    }
    res.json(hospital);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   POST api/hospitals
// @desc    Create a new hospital with owner ID from logged-in SuperAdmin
// @access  SuperAdmin
// Note: Staff creation is handled separately in the frontend after hospital creation
router.post("/", async (req, res) => {
  try {
    const { name, code, address, city, phone, email } = req.body;

    // Validate required fields
    if (!name || !code) {
      return res
        .status(400)
        .json({ message: "Hospital name and code are required" });
    }

    // Get the logged-in SuperAdmin ID from the token (set by adminAuth middleware)
    const ownerId = req.adminUser?.id;
    if (!ownerId) {
      return res
        .status(401)
        .json({ message: "Unauthorized - No admin user found" });
    }

    // Check if Hospital with same code already exists
    const existingHospital = await Hospital.findOne({ code });
    if (existingHospital) {
      return res
        .status(400)
        .json({ message: "Hospital with this code already exists" });
    }

    // Create Hospital with owner ID
    const hospital = new Hospital({
      name,
      code,
      address,
      city,
      phone,
      email,
      createdBy: ownerId, // Set the logged-in SuperAdmin as the owner
    });
    await hospital.save();

    // Return the created hospital (frontend will use the _id to create staff)
    res.status(201).json({ hospital });
  } catch (err) {
    console.error("Error creating hospital:", err.message);
    // Handle duplicate key errors (if code is unique in schema)
    if (err.code === 11000) {
      return res
        .status(400)
        .json({ message: "Hospital with this code already exists" });
    }
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// @route   PUT api/hospitals/:id
// @desc    Update hospital
// @access  SuperAdmin
router.put("/:id", async (req, res) => {
  try {
    const hospital = await Hospital.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    );
    res.json(hospital);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

module.exports = router;
