const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Staff = require("../models/Staff");
const Hospital = require("../models/Hospital");
const auth = require("../middleware/auth");
const { getTenantConnection } = require("../utils/tenantDb");

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

    // Check if hospital with same code already exists
    const existingHospital = await Hospital.findOne({ code: hospitalCode });
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
        code: hospitalCode,
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
// @desc    Authenticate staff member & get token
// @access  Public
router.post("/login", async (req, res) => {
  try {
    const { userId, password } = req.body;

    // STEP 1: Find all hospitals and search for staff in each tenant database
    const hospitals = await Hospital.find({ databaseStatus: "active" });

    if (!hospitals || hospitals.length === 0) {
      return res
        .status(400)
        .json({
          message: "No active hospitals found. Please contact administrator.",
        });
    }

    let staff = null;
    let staffHospital = null;

    // STEP 2: Search for staff in each hospital's tenant database
    for (const hospital of hospitals) {
      try {
        const tenantConnection = await getTenantConnection(
          hospital._id.toString()
        );
        const StaffModel = tenantConnection.model("Staff");

        const foundStaff = await StaffModel.findOne({ userId }).select(
          "+password"
        );

        if (foundStaff) {
          staff = foundStaff;
          staffHospital = hospital;
          break; // Found the staff, stop searching
        }
      } catch (error) {
        console.error(
          `Error searching in hospital ${hospital._id}:`,
          error.message
        );
        // Continue to next hospital
      }
    }

    // STEP 3: Validate staff exists
    if (!staff) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // STEP 4: Validate password exists
    if (!staff.password) {
      return res
        .status(400)
        .json({ message: "Account not properly set up. Password not found." });
    }

    // STEP 5: Compare password
    const isMatch = await bcrypt.compare(password, staff.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // STEP 6: Create JWT token with hospitalId
    const payload = {
      user: {
        id: staff._id,
        userId: staff.userId,
        type: staff.type,
        hospitalId: staffHospital._id.toString(),
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
            hospitalId: staffHospital._id.toString(),
            hospitalName: staffHospital.name,
          },
        });
      }
    );
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).send("Server error");
  }
});

// @route   GET api/auth/me
// @desc    Get current staff member
// @access  Private
router.get("/me", auth, async (req, res) => {
  try {
    const staff = await Staff.findById(req.user.id).select("-password");
    if (!staff) {
      return res.status(404).json({ message: "Staff member not found" });
    }
    res.json(staff);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

module.exports = router;
