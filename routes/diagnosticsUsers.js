const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");
const jwt = require("jsonwebtoken");

router.use(auth);
router.use(tenantDb);

// @route   GET api/diagnostics-users
// @desc    Get all diagnostics users
// @access  Private
router.get("/", async (req, res) => {
  try {
    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const users = await DiagnosticsUser.find({ hospitalId: req.hospitalId });
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
    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const user = await DiagnosticsUser.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
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

// @route   POST api/diagnostics-users
// @desc    Create a new diagnostics user
// @access  Private
router.post("/", auth, async (req, res) => {
  try {
    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const user = new DiagnosticsUser({
      ...req.body,
      hospitalId: req.hospitalId,
    });
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
    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const user = await DiagnosticsUser.findOneAndUpdate(
      { _id: req.params.id, hospitalId: req.hospitalId },
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
    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const user = await DiagnosticsUser.findOneAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
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
    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const query = { phone: req.params.phoneNumber };
    if (req.query.hospitalId) query.hospitalId = req.query.hospitalId;
    const user = await DiagnosticsUser.findOne(query);
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
    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const { phone, ...userData } = req.body;

    if (!phone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    // Check if user already exists
    const query = { phone };
    if (req.body.hospitalId) query.hospitalId = req.body.hospitalId;
    let user = await DiagnosticsUser.findOne(query);

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
    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const query = { phone: req.params.phoneNumber };
    if (req.body.hospitalId) query.hospitalId = req.body.hospitalId;

    const user = await DiagnosticsUser.findOneAndUpdate(query, req.body, {
      new: true,
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
    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const query = { phone: phoneNumber };
    if (req.body.hospitalId) query.hospitalId = req.body.hospitalId;

    let user = await DiagnosticsUser.findOne(query);

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
        hospitalId: req.body.hospitalId, // Optional but good if provided
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
