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

// @route   GET api/diagnostics-users/phone/:phoneNumber
// @desc    Get diagnostics user by phone number
// @access  Public (for mobile app)
router.get("/phone/:phoneNumber", async (req, res) => {
  try {
    const user = await DiagnosticsUser.findOne({
      phone: req.params.phoneNumber,
    });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   POST api/diagnostics-users/phone
// @desc    Create or get diagnostics user by phone number
// @access  Public (for mobile app)
router.post("/phone", async (req, res) => {
  try {
    const { phone, ...userData } = req.body;

    if (!phone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    // Check if user already exists
    let user = await DiagnosticsUser.findOne({ phone });

    if (user) {
      return res.json(user);
    }

    // Create new user
    const newUser = new DiagnosticsUser({
      phone,
      ...userData,
    });

    await newUser.save();
    res.json(newUser);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   PUT api/diagnostics-users/phone/:phoneNumber
// @desc    Update diagnostics user by phone number
// @access  Public (for mobile app)
router.put("/phone/:phoneNumber", async (req, res) => {
  try {
    const user = await DiagnosticsUser.findOneAndUpdate(
      { phone: req.params.phoneNumber },
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

// @route   POST api/diagnostics-users/send-otp
// @desc    Send OTP to phone number
// @access  Public (for mobile app)
router.post("/send-otp", async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    // Generate OTP (in real app, send via SMS service)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP temporarily (in real app, use Redis or similar)
    // For now, just return success
    res.json({
      message: "OTP sent successfully",
      otp: otp, // Remove this in production
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   POST api/diagnostics-users/verify-otp
// @desc    Verify OTP and get/create user
// @access  Public (for mobile app)
router.post("/verify-otp", async (req, res) => {
  try {
    const { phoneNumber, otp } = req.body;

    if (!phoneNumber || !otp) {
      return res.status(400).json({
        message: "Phone number and OTP are required",
      });
    }

    // In real app, verify OTP here
    // For now, just proceed with user creation/lookup

    let user = await DiagnosticsUser.findOne({ phone: phoneNumber });

    if (!user) {
      // Create new user
      user = new DiagnosticsUser({
        phone: phoneNumber,
        userType: "Patient",
        name: "",
        age: "",
        gender: "",
        email: "",
        addresses: [],
        familyMembers: [],
      });

      await user.save();
    }

    res.json({
      message: "OTP verified successfully",
      user: user,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

module.exports = router;
