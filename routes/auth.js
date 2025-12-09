const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Staff = require("../models/Staff");
const auth = require("../middleware/auth");

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

    // Check if staff member exists (include password field for comparison)
    const staff = await Staff.findOne({ userId }).select("+password");
    if (!staff) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Validate password
    if (!staff.password) {
      return res.status(400).json({ message: "Account not properly set up" });
    }

    const isMatch = await bcrypt.compare(password, staff.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Create JWT token
    const payload = {
      user: {
        id: staff._id,
        userId: staff.userId,
        type: staff.type,
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
