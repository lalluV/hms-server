const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Staff = require("../models/Staff");
const Hospital = require("../models/Hospital");
const auth = require("../middleware/auth");
const { getTenantConnection } = require("../utils/tenantDb");
const { toClientPayloadFromHospital } = require("../services/entitlementsService");
const { hasPermission, normalizeRole } = require("../config/rolePermissions");
const { writeAuditLog } = require("../utils/auditLog");
const {
  extractSubdomain,
  requireSubdomain,
} = require("../middleware/subdomain");

// @route   POST api/auth/register-hospital
// @desc    Register a new hospital and SuperAdmin Staff user
// @access  Public
router.post("/register-hospital", async (req, res) => {
  try {
    const {
      // Hospital data
      hospitalName,
      hospitalCode,
      hospitalAddress,
      hospitalCity,
      hospitalPhone,
      hospitalEmail,
      // Staff/SuperAdmin data
      adminUsername,
      adminEmail,
      adminPassword,
      staffUserId, // Optional, defaults to adminUsername if not provided
    } = req.body;

    // Validate required fields
    if (!hospitalName || !hospitalCode) {
      return res
        .status(400)
        .json({ message: "Hospital name and code are required" });
    }

    if (!adminUsername || !adminEmail || !adminPassword) {
      return res
        .status(400)
        .json({ message: "Admin username, email, and password are required" });
    }

    // Normalize hospital code for subdomain use (lowercase, trimmed)
    const normalizedCode = hospitalCode.toLowerCase().trim();

    // Validate hospital code format (alphanumeric, hyphens, underscores only - URL-safe for subdomains)
    const codePattern = /^[a-z0-9_-]+$/;
    if (!codePattern.test(normalizedCode)) {
      return res.status(400).json({
        message:
          "Hospital code must contain only lowercase letters, numbers, hyphens, and underscores (used as subdomain identifier)",
      });
    }

    // Check if hospital with same code already exists
    const existingHospital = await Hospital.findOne({ code: normalizedCode });
    if (existingHospital) {
      return res
        .status(400)
        .json({ message: "Hospital with this code already exists" });
    }

    // Use provided staffUserId or default to adminUsername
    const finalStaffUserId = staffUserId || adminUsername;

    // Check if staff user with same userId already exists
    const existingStaff = await Staff.findOne({ userId: finalStaffUserId });
    if (existingStaff) {
      return res.status(400).json({
        message: `Staff user with ID "${finalStaffUserId}" already exists`,
      });
    }

    // Check if staff user with same email already exists
    const existingStaffEmail = await Staff.findOne({ email: adminEmail });
    if (existingStaffEmail) {
      return res
        .status(400)
        .json({ message: "Staff user with this email already exists" });
    }

    // Create Hospital first
    let hospital;
    try {
      hospital = new Hospital({
        name: hospitalName,
        code: normalizedCode, // Use normalized code for subdomain compatibility
        address: hospitalAddress,
        city: hospitalCity,
        phone: hospitalPhone,
        email: hospitalEmail,
      });
      await hospital.save();
    } catch (hospitalErr) {
      if (hospitalErr.code === 11000) {
        const duplicateField = Object.keys(hospitalErr.keyPattern || {})[0];
        return res.status(400).json({
          message: `Hospital ${
            duplicateField === "code" ? "code" : duplicateField
          } already exists`,
        });
      }
      throw hospitalErr;
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(adminPassword, salt);

    // Generate staff ID
    const staffId = `EMP${Date.now()}`;

    // Create Staff user as SuperAdmin
    let staff;
    try {
      staff = new Staff({
        id: staffId,
        userId: finalStaffUserId,
        password: hashedPassword,
        loginPassword: adminPassword,
        name: adminUsername,
        email: adminEmail,
        type: "SuperAdmin",
        hospitalId: hospital._id,
        active: true,
        createdAt: new Date().toISOString(),
        createdAtOriginal: new Date().toISOString(),
      });
      await staff.save();
    } catch (staffErr) {
      // Rollback hospital creation if staff creation fails
      await Hospital.findByIdAndDelete(hospital._id);
      if (staffErr.code === 11000) {
        const duplicateField = Object.keys(staffErr.keyPattern || {})[0];
        let fieldName = duplicateField;
        if (duplicateField === "userId") fieldName = "User ID";
        else if (duplicateField === "email") fieldName = "Email";
        else if (duplicateField === "id") fieldName = "Staff ID";
        return res
          .status(400)
          .json({ message: `Staff ${fieldName} already exists` });
      }
      throw staffErr;
    }

    // Update hospital with createdBy field (using staff ID)
    hospital.createdBy = staff._id.toString();
    await hospital.save();

    // Create JWT token for Staff user
    const payload = {
      user: {
        id: staff._id,
        userId: staff.userId,
        type: staff.type,
        hospitalId: staff.hospitalId,
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: "24h" },
      (err, token) => {
        if (err) throw err;
        res.status(201).json({
          token,
          user: {
            id: staff._id,
            userId: staff.userId,
            email: staff.email,
            type: staff.type,
            hospitalId: staff.hospitalId,
          },
          hospital: {
            id: hospital._id,
            name: hospital.name,
            code: hospital.code,
          },
          staff: {
            id: staff._id,
            userId: staff.userId,
            name: staff.name,
            type: staff.type,
          },
        });
      }
    );
  } catch (err) {
    console.error("Error registering hospital:", err.message);
    console.error("Full error:", err);
    // Handle duplicate key errors with more specific messages
    if (err.code === 11000) {
      const duplicateField = Object.keys(err.keyPattern || {})[0];
      let fieldName = duplicateField;
      if (duplicateField === "code") fieldName = "Hospital code";
      else if (duplicateField === "email") fieldName = "Email";
      else if (duplicateField === "userId") fieldName = "User ID";
      else if (duplicateField === "username") fieldName = "Username";

      return res.status(400).json({ message: `${fieldName} already exists` });
    }
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// @route   POST api/auth/register
// @desc    Register a staff member
// @access  Public
router.post("/register", async (req, res) => {
  try {
    const { userId, password, email, type, ...staffData } = req.body;

    // Check if staff member with userId already exists
    let staff = await Staff.findOne({ userId });
    if (staff) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create new staff member with authentication fields
    staff = new Staff({
      ...staffData,
      userId,
      email,
      password: hashedPassword,
      loginPassword: password,
      type: type || "Staff", // Default type if not specified
    });

    // Save staff member
    await staff.save();

    // Create JWT token
    const payload = {
      user: {
        id: staff._id,
        userId: staff.userId,
        type: staff.type,
        hospitalId: staff.hospitalId,
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: "24h" },
      (err, token) => {
        if (err) throw err;
        res.json({
          token,
          user: {
            id: staff._id,
            userId: staff.userId,
            email: staff.email,
            type: staff.type,
          },
        });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   POST api/auth/login
// @desc    Authenticate staff member & get token (subdomain-based tenant login)
// @access  Public
// @note    This route REQUIRES subdomain identification via Origin/Referer/Host headers
// @note    Only subdomain-based authentication is supported (no query params or custom headers)
router.post("/login", extractSubdomain, requireSubdomain, async (req, res) => {
  try {
    const { userId, password } = req.body;

    // Validate required fields
    if (!userId || !password) {
      return res.status(400).json({
        message: "User ID and password are required",
      });
    }

    // Hospital is already identified by subdomain middleware and attached to req.hospital
    const hospital = req.hospital;

    if (!hospital) {
      return res.status(400).json({
        message:
          "Tenant hospital not identified. Please access via your tenant subdomain.",
      });
    }

    // Validate hospital is active and database is ready
    if (!hospital.active) {
      return res.status(403).json({
        message: "Hospital account is inactive. Please contact administrator.",
      });
    }

    if (hospital.databaseStatus !== "active") {
      return res.status(503).json({
        message: `Hospital database is not yet ready. Status: ${hospital.databaseStatus}. Please contact administrator.`,
        databaseStatus: hospital.databaseStatus,
      });
    }

    // STEP 1: Connect to the specific tenant database (already identified by subdomain)
    let tenantConnection;
    try {
      tenantConnection = await getTenantConnection(hospital._id.toString());
    } catch (error) {
      console.error(
        `Error connecting to tenant database for hospital ${hospital._id}:`,
        error
      );
      return res.status(503).json({
        message:
          "Unable to connect to tenant database. Please contact administrator.",
        error: error.message,
      });
    }

    // STEP 2: Search for staff in this specific tenant database only
    let staff = null;
    try {
      const StaffModel = tenantConnection.model("Staff");
      staff = await StaffModel.findOne({ userId }).select("+password");
    } catch (error) {
      console.error(
        `Error searching for staff in hospital ${hospital._id}:`,
        error
      );
      return res.status(500).json({
        message: "Error searching for user. Please try again.",
        error: error.message,
      });
    }

    // STEP 3: Validate staff exists
    if (!staff) {
      return res.status(400).json({
        message: "Invalid credentials",
      });
    }

    // STEP 4: Validate staff is active
    if (!staff.active) {
      return res.status(403).json({
        message: "Your account is inactive. Please contact administrator.",
      });
    }

    // STEP 5: Validate password exists
    if (!staff.password) {
      return res.status(400).json({
        message:
          "Account not properly set up. Password not found. Please contact administrator.",
      });
    }

    // STEP 6: Compare password
    let isMatch = false;
    try {
      isMatch = await bcrypt.compare(password, staff.password);
    } catch (error) {
      console.error("Password comparison error:", error);
      return res.status(500).json({
        message: "Error validating credentials. Please try again.",
      });
    }

    if (!isMatch) {
      return res.status(400).json({
        message: "Invalid credentials",
      });
    }

    // STEP 7: Create JWT token with hospitalId
    const payload = {
      user: {
        id: staff._id,
        userId: staff.userId,
        type: staff.type,
        hospitalId: hospital._id.toString(),
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: "24h" },
      (err, token) => {
        if (err) {
          console.error("JWT signing error:", err);
          return res.status(500).json({
            message: "Error generating authentication token",
          });
        }

        res.json({
          token,
          user: {
            id: staff._id,
            userId: staff.userId,
            email: staff.email,
            name: staff.name,
            type: staff.type,
            hospitalId: hospital._id.toString(),
            hospitalName: hospital.name,
            hospitalCode: hospital.code,
          },
          hospital: {
            id: hospital._id.toString(),
            name: hospital.name,
            code: hospital.code,
          },
          entitlements: toClientPayloadFromHospital(hospital),
        });
      }
    );
  } catch (err) {
    console.error("Login error:", err.message);
    console.error("Full error:", err);
    res.status(500).json({
      message: "Server error during authentication",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

// @route   GET api/auth/tenant-info
// @desc    Get tenant information from subdomain (for debugging)
// @access  Public
router.get("/tenant-info", extractSubdomain, (req, res) => {
  res.json({
    detectedHost: req.headers.host || "unknown",
    detectedOrigin: req.headers.origin || null,
    detectedReferer: req.headers.referer || null,
    hospitalCode: req.hospitalCode || null,
    hospital: req.hospital
      ? {
          id: req.hospital._id,
          name: req.hospital.name,
          code: req.hospital.code,
          active: req.hospital.active,
          databaseStatus: req.hospital.databaseStatus,
        }
      : null,
    detectionMethods: {
      fromHost: !!(req.headers.host && req.hospitalCode),
      fromOrigin: !!(req.headers.origin && req.hospitalCode),
      fromReferer: !!(req.headers.referer && req.hospitalCode),
    },
  });
});

// @route   GET api/auth/me
// @desc    Get current staff member
// @access  Private
// @note    Uses JWT token which already contains hospitalId, so subdomain is not required
router.get("/me", auth, async (req, res) => {
  try {
    // Get tenant connection using hospitalId from JWT token
    const hospitalId = req.user.hospitalId;
    if (!hospitalId) {
      return res.status(400).json({
        message: "Hospital ID not found in token",
      });
    }

    const tenantConnection = await getTenantConnection(hospitalId);
    const StaffModel = tenantConnection.model("Staff");

    const staff = await StaffModel.findById(req.user.id).select("-password");
    if (!staff) {
      return res.status(404).json({
        message: "Staff member not found",
      });
    }

    const masterHospital = await Hospital.findById(hospitalId);
    const entitlements = masterHospital
      ? toClientPayloadFromHospital(masterHospital)
      : null;

    res.json({ ...staff.toObject(), entitlements });
  } catch (err) {
    console.error("Error fetching current user:", err.message);
    res.status(500).json({
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

// @route   GET api/auth/hospital-profile
// @desc    Branding profile for printable bills/receipts (JWT)
// @access  Private
router.get("/hospital-profile", auth, async (req, res) => {
  try {
    const hospitalId = req.user.hospitalId;
    if (!hospitalId) {
      return res.status(400).json({ message: "Hospital ID not found in token" });
    }
    const hospital = await Hospital.findById(hospitalId).select(
      "name code address city state zipCode phone email website logoUrl settings",
    );
    if (!hospital) {
      return res.status(404).json({ message: "Hospital not found" });
    }
    res.json(hospital.toObject());
  } catch (err) {
    console.error("hospital-profile error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// @route   PUT api/auth/hospital-profile
// @desc    Update hospital branding for bills/receipts (SuperAdmin / Admin)
// @access  Private
router.put("/hospital-profile", auth, async (req, res) => {
  try {
    const role = normalizeRole(req.user.type);
    if (role !== "SuperAdmin" && role !== "Admin") {
      return res.status(403).json({
        message: "Only Super Admin or Admin can update hospital branding.",
      });
    }

    const hospitalId = req.user.hospitalId;
    if (!hospitalId) {
      return res.status(400).json({ message: "Hospital ID not found in token" });
    }

    const hospital = await Hospital.findById(hospitalId);
    if (!hospital) {
      return res.status(404).json({ message: "Hospital not found" });
    }

    const rootFields = [
      "name",
      "address",
      "city",
      "state",
      "zipCode",
      "phone",
      "email",
      "website",
      "logoUrl",
    ];
    for (const key of rootFields) {
      if (req.body[key] !== undefined) {
        hospital[key] = req.body[key];
      }
    }

    const settingFields = [
      "gstNumber",
      "pharmacyGstNumber",
      "panNumber",
      "drugLicenseNumber",
      "labLicenseNumber",
      "receiptFooterNote",
      "currency",
      "timezone",
      "dateFormat",
    ];
    if (req.body.settings && typeof req.body.settings === "object") {
      hospital.settings = hospital.settings || {};
      for (const key of settingFields) {
        if (req.body.settings[key] !== undefined) {
          hospital.settings[key] = req.body.settings[key];
        }
      }
      hospital.markModified("settings");
    }

    await hospital.save();

    res.json(hospital.toObject());
  } catch (err) {
    console.error("hospital-profile update error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// @route   GET api/auth/entitlements
// @desc    Refresh subscription / module entitlements for current hospital (JWT)
// @access  Private
router.get("/entitlements", auth, async (req, res) => {
  try {
    const hospitalId = req.user.hospitalId;
    if (!hospitalId) {
      return res.status(400).json({ message: "Hospital ID not found in token" });
    }
    const masterHospital = await Hospital.findById(hospitalId);
    if (!masterHospital) {
      return res.status(404).json({ message: "Hospital not found" });
    }
    res.json(toClientPayloadFromHospital(masterHospital));
  } catch (err) {
    console.error("entitlements error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// @route   PUT api/auth/change-password
// @desc    Change password for the currently logged-in staff user
// @access  Private
router.put("/change-password", auth, async (req, res) => {
  try {
    if (!hasPermission(req.user.type, "self.password.change")) {
      return res.status(403).json({
        code: "ROLE_PERMISSION_DENIED",
        message: "You do not have permission to change password.",
      });
    }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({
        message: "Current password and a new password of at least 6 characters are required",
      });
    }

    const hospitalId = req.user.hospitalId;
    if (!hospitalId) {
      return res.status(400).json({ message: "Hospital ID not found in token" });
    }

    const tenantConnection = await getTenantConnection(hospitalId);
    const StaffModel = tenantConnection.model("Staff");
    const staff = await StaffModel.findById(req.user.id).select("+password");
    if (!staff) {
      return res.status(404).json({ message: "Staff member not found" });
    }
    if (!staff.password) {
      return res.status(400).json({ message: "Password is not set for this account" });
    }

    const isMatch = await bcrypt.compare(currentPassword, staff.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    await StaffModel.findByIdAndUpdate(req.user.id, {
      $set: { password: hashedPassword },
      $unset: { loginPassword: 1 },
    });

    await writeAuditLog(
      {
        user: req.user,
        hospitalId,
        actor: {
          id: req.user.id,
          userId: req.user.userId,
          type: req.user.type,
        },
      },
      "self.password.change",
      staff,
    );

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("change-password error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
