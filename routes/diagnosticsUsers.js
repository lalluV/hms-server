const express = require("express");
const router = express.Router();
const DiagnosticsUser = require("../models/DiagnosticsUser");
const auth = require("../middleware/auth");
const jwt = require("jsonwebtoken");

// @route   GET api/diagnostics-users
// @desc    Get all diagnostics users
// @access  Private
router.get("/", auth, async (req, res) => {
  try {
    const users = await DiagnosticsUser.find();
    res.json(users);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   GET api/diagnostics-users/:id
// @desc    Get diagnostics user by ID
// @access  Private
router.get("/:id", auth, async (req, res) => {
  try {
    const user = await DiagnosticsUser.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   POST api/diagnostics-users
// @desc    Create a new diagnostics user
// @access  Private
router.post("/", auth, async (req, res) => {
  try {
    const user = new DiagnosticsUser(req.body);
    await user.save();
    res.json(user);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   PUT api/diagnostics-users/:id
// @desc    Update diagnostics user
// @access  Private
router.put("/:id", auth, async (req, res) => {
  try {
    const user = await DiagnosticsUser.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   DELETE api/diagnostics-users/:id
// @desc    Delete diagnostics user
// @access  Private
router.delete("/:id", auth, async (req, res) => {
  try {
    const user = await DiagnosticsUser.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   POST api/diagnostics-users/send-otp
// @desc    Send OTP to phone number
// @access  Public
router.post("/send-otp", async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // For demo purposes, we'll just return the OTP
    // In production, you would send this via SMS service
    res.json({
      success: true,
      message: "OTP sent successfully",
      otp: otp, // Remove this in production
      confirmCode: otp,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   POST api/diagnostics-users/verify-otp
// @desc    Verify OTP and login/register user
// @access  Public
router.post("/verify-otp", async (req, res) => {
  try {
    const { phoneNumber, otp } = req.body;

    if (!phoneNumber || !otp) {
      return res
        .status(400)
        .json({ message: "Phone number and OTP are required" });
    }

    // For demo purposes, accept any 4-digit OTP
    // In production, you would verify against stored OTP
    if (otp.length !== 4) {
      return res.status(400).json({ message: "Invalid OTP format" });
    }

    // Check if user exists
    let user = await DiagnosticsUser.findOne({ phone: phoneNumber });

    if (!user) {
      // Create new user with basic info
      user = new DiagnosticsUser({
        phone: phoneNumber,
        createdAt: new Date(),
        isActive: true,
        name: "",
        email: "",
        gender: "",
        age: "",
      });
      await user.save();
    }

    // Create JWT token
    const payload = {
      user: {
        id: user.id,
        phone: user.phone,
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: "24h" },
      (err, token) => {
        if (err) throw err;
        res.json({
          success: true,
          message: "OTP verified successfully",
          token,
          user: {
            id: user.id,
            phoneNumber: user.phoneNumber,
            name: user.name || "",
            email: user.email || "",
            createdAt: user.createdAt,
          },
        });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   POST api/diagnostics-users/get-or-create-user
// @desc    Get or create user with phone number
// @access  Public
router.post("/get-or-create-user", async (req, res) => {
  try {
    const { phoneNumber, ...userData } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    // Check if user exists
    let user = await DiagnosticsUser.findOne({ phoneNumber });

    if (!user) {
      // Create new user with all provided data
      user = new DiagnosticsUser({
        phone: phoneNumber,
        name: userData.name || "",
        email: userData.email || "",
        gender: userData.gender || "",
        age: userData.age || "",
        ...userData,
        createdAt: new Date(),
        isActive: true,
      });
      await user.save();
    } else {
      // Update existing user with new data
      Object.assign(user, userData);
      await user.save();
    }

    // Create JWT token
    const payload = {
      user: {
        id: user.id,
        phone: user.phone,
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: "24h" },
      (err, token) => {
        if (err) throw err;
        res.json({
          success: true,
          message: "User retrieved/created successfully",
          token,
          user: {
            id: user.id,
            phone: user.phone,
            name: user.name || "",
            email: user.email || "",
            createdAt: user.createdAt,
          },
        });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

module.exports = router;
