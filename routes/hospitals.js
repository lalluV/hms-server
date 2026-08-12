const express = require("express");
const router = express.Router();
const Hospital = require("../models/Hospital");
const adminAuth = require("../middleware/adminAuth");
const {
  provisionTenantDatabase,
  getDatabaseStats,
  isDatabaseProvisioned,
} = require("../services/databaseProvisioner");
const { getTenantDatabaseName } = require("../utils/tenantDb");

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
// @desc    Create a new hospital with owner ID from logged-in SuperAdmin and provision database
// @access  SuperAdmin
router.post("/", async (req, res) => {
  try {
    const {
      name, code, address, city, phone, email,
      tenancyMode: requestedMode,
      autoProvision = true,
    } = req.body;

    // Validate required fields
    if (!name || !code) {
      return res
        .status(400)
        .json({ message: "Hospital name and code are required" });
    }

    // Normalize hospital code for subdomain use (lowercase, trimmed)
    const normalizedCode = code.toLowerCase().trim();
    
    // Validate hospital code format (alphanumeric, hyphens, underscores only - URL-safe for subdomains)
    const codePattern = /^[a-z0-9_-]+$/;
    if (!codePattern.test(normalizedCode)) {
      return res.status(400).json({
        message: "Hospital code must contain only lowercase letters, numbers, hyphens, and underscores (used as subdomain identifier)",
      });
    }

    // Get the logged-in SuperAdmin ID from the token (set by adminAuth middleware)
    const ownerId = req.adminUser?.id;
    if (!ownerId) {
      return res
        .status(401)
        .json({ message: "Unauthorized - No admin user found" });
    }

    // Check if Hospital with same code already exists
    const existingHospital = await Hospital.findOne({ code: normalizedCode });
    if (existingHospital) {
      return res
        .status(400)
        .json({ message: "Hospital with this code already exists" });
    }

    // Determine tenancy mode: default to "shared" for new clinics
    const tenancyMode = requestedMode === "isolated" ? "isolated" : "shared";

    // Create Hospital with tenancy-aware fields
    const hospital = new Hospital({
      name,
      code: normalizedCode,
      address,
      city,
      phone,
      email,
      createdBy: ownerId,
      tenancyMode,
      // Shared hospitals are instantly ready; isolated need provisioning
      databaseName: tenancyMode === "shared" ? "hms_shared" : undefined,
      databaseStatus: tenancyMode === "shared" ? "active" : "pending",
    });
    
    await hospital.save();

    // Shared-tier: no provisioning needed — hospital is immediately ready
    if (tenancyMode === "shared") {
      return res.status(201).json({
        hospital,
        message: "Hospital created with shared tenancy — ready immediately",
      });
    }

    // Isolated-tier: provision dedicated database if autoProvision is enabled
    if (autoProvision) {
      try {
        // Update status to provisioning
        hospital.databaseStatus = "provisioning";
        hospital.databaseName = getTenantDatabaseName(hospital._id.toString());
        await hospital.save();

        // Provision database SYNCHRONOUSLY (wait for completion)
        console.log(`🔄 Starting database provisioning for hospital ${hospital._id}...`);
        const result = await provisionTenantDatabase(hospital._id.toString());

        if (result.success) {
          hospital.databaseStatus = "active";
          hospital.databaseProvisionedAt = new Date();
          await hospital.save();
          console.log(`✅ Database provisioned successfully for hospital ${hospital._id}`);

          return res.status(201).json({
            hospital,
            message: "Hospital created and database provisioned successfully",
          });
        } else {
          hospital.databaseStatus = "error";
          await hospital.save();
          console.error(`❌ Failed to provision database for hospital ${hospital._id}`);

          return res.status(500).json({
            hospital,
            message: "Hospital created but database provisioning failed",
            error: result.error,
          });
        }
      } catch (error) {
        console.error(`❌ Error provisioning database:`, error);
        hospital.databaseStatus = "error";
        await hospital.save();

        return res.status(500).json({
          hospital,
          message: "Hospital created but database provisioning failed",
          error: error.message,
        });
      }
    }

    // Return the created hospital without provisioning
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

// @route   GET api/hospitals/:id/database-status
// @desc    Get database status for a hospital
// @access  SuperAdmin
router.get("/:id/database-status", async (req, res) => {
  try {
    const hospital = await Hospital.findById(req.params.id);
    if (!hospital) {
      return res.status(404).json({ message: "Hospital not found" });
    }

    // Check if database is actually provisioned
    const isProvisioned = await isDatabaseProvisioned(hospital._id.toString());
    
    // Get database stats if provisioned
    let stats = null;
    if (isProvisioned) {
      try {
        stats = await getDatabaseStats(hospital._id.toString());
      } catch (error) {
        console.error("Error getting database stats:", error);
      }
    }

    res.json({
      hospitalId: hospital._id,
      hospitalName: hospital.name,
      tenancyMode: hospital.tenancyMode || "isolated",
      databaseName: hospital.databaseName,
      databaseStatus: hospital.databaseStatus,
      databaseProvisionedAt: hospital.databaseProvisionedAt,
      isProvisioned,
      stats,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// @route   POST api/hospitals/:id/provision-database
// @desc    Manually trigger database provisioning for a hospital
// @access  SuperAdmin
router.post("/:id/provision-database", async (req, res) => {
  try {
    const hospital = await Hospital.findById(req.params.id);
    if (!hospital) {
      return res.status(404).json({ message: "Hospital not found" });
    }

    if (hospital.databaseStatus === "active") {
      return res.status(400).json({ message: "Database already provisioned" });
    }

    // Update status to provisioning
    hospital.databaseStatus = "provisioning";
    hospital.databaseName = getTenantDatabaseName(hospital._id.toString());
    await hospital.save();

    // Provision database
    const result = await provisionTenantDatabase(hospital._id.toString());

    if (result.success) {
      hospital.databaseStatus = "active";
      hospital.databaseProvisionedAt = new Date();
      await hospital.save();

      res.json({
        message: "Database provisioned successfully",
        hospital,
        result,
      });
    } else {
      hospital.databaseStatus = "error";
      await hospital.save();

      res.status(500).json({
        message: "Database provisioning failed",
        error: result.error,
      });
    }
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// @route   POST api/hospitals/:id/migrate-tenancy
// @desc    Migrate hospital between Shared and Isolated database tiers
// @access  SuperAdmin
router.post("/:id/migrate-tenancy", async (req, res) => {
  try {
    const { targetMode, dropSourceDb = false } = req.body;

    if (!targetMode || !["shared", "isolated"].includes(targetMode)) {
      return res.status(400).json({
        message: 'Valid targetMode is required ("shared" or "isolated")',
      });
    }

    const { migrateHospitalTenancy } = require("../services/tenancyMigrationService");
    const result = await migrateHospitalTenancy(req.params.id, targetMode, {
      cleanupSource: true,
      dropSourceDb,
    });

    res.json(result);
  } catch (err) {
    console.error("Migration error:", err);
    res.status(500).json({
      message: "Tenancy migration failed",
      error: err.message,
    });
  }
});

module.exports = router;
