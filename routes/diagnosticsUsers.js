const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");
const tenantDbFromQuery = require("../middleware/tenantDbFromQuery");
const jwt = require("jsonwebtoken");

/**
 * Helper to create JWT for diagnostics user (for mobile app login/registration)
 */
function createDiagnosticsToken(user) {
  const hospitalId = user.hospitalId?.toString?.() || user.hospitalId;
  const payload = {
    user: {
      id: user._id.toString(),
      phone: user.phone,
      hospitalId,
      userType: "diagnostics",
    },
  };
  return jwt.sign(payload, process.env.JWT_SECRET); // No expiry - valid until logout
}

// ========== PUBLIC ROUTES (no auth - for login/registration flow) ==========
// These must be defined BEFORE router.use(auth)
// Uses tenantDbFromQuery to get hospitalId from query param or body

// @route   POST api/diagnostics-users/send-otp
router.post("/send-otp", tenantDbFromQuery, async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    res.json({
      message: "OTP sent successfully",
      otp: otp, // Remove in production
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   POST api/diagnostics-users/verify-otp
router.post("/verify-otp", tenantDbFromQuery, async (req, res) => {
  try {
    const { phoneNumber, otp } = req.body;

    if (!phoneNumber || !otp) {
      return res.status(400).json({
        message: "Phone number and OTP are required",
      });
    }

    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const query = { phone: phoneNumber };
    if (req.body.hospitalId) query.hospitalId = req.body.hospitalId;

    let user = await DiagnosticsUser.findOne(query);

    if (!user) {
      user = new DiagnosticsUser({
        phone: phoneNumber,
        userType: "Patient",
        name: "",
        age: "",
        gender: "",
        email: "",
        addresses: [],
        familyMembers: [],
        hospitalId: req.body.hospitalId,
      });
      await user.save();
    }

    const token = createDiagnosticsToken(user);

    res.json({
      message: "OTP verified successfully",
      token,
      user: user,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   GET api/diagnostics-users/phone/:phoneNumber
router.get("/phone/:phoneNumber", tenantDbFromQuery, async (req, res) => {
  try {
    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const query = { phone: req.params.phoneNumber };
    if (req.query.hospitalId) query.hospitalId = req.query.hospitalId;
    const user = await DiagnosticsUser.findOne(query);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    const token = createDiagnosticsToken(user);
    res.json({ ...user.toObject(), token });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   POST api/diagnostics-users/phone
router.post("/phone", tenantDbFromQuery, async (req, res) => {
  try {
    const DiagnosticsUser = req.tenantDb.model("DiagnosticsUser");
    const { phone, ...userData } = req.body;

    if (!phone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    const query = { phone };
    if (req.body.hospitalId) query.hospitalId = req.body.hospitalId;
    let user = await DiagnosticsUser.findOne(query);

    if (user) {
      const token = createDiagnosticsToken(user);
      return res.json({ ...user.toObject(), token });
    }

    const newUser = new DiagnosticsUser({
      phone,
      ...userData,
      hospitalId: req.body.hospitalId || req.hospitalId,
    });
    await newUser.save();

    const token = createDiagnosticsToken(newUser);
    res.json({ ...newUser.toObject(), token });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   PUT api/diagnostics-users/phone/:phoneNumber
router.put("/phone/:phoneNumber", tenantDbFromQuery, async (req, res) => {
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

// ========== PRIVATE ROUTES (require auth) ==========
const {
  loadEntitlements,
  requireActiveSubscription,
  requireModule,
} = require("../middleware/entitlements");
router.use(auth);
router.use(loadEntitlements);
router.use(requireActiveSubscription);
router.use(requireModule("lab"));
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
      { new: true },
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

module.exports = router;
