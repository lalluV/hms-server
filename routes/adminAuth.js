const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const AdminUser = require("../models/AdminUser");
const adminAuth = require("../middleware/adminAuth");

// @route   POST api/admin/auth/register
// @desc    Register a Super Admin (Use cautiously or disable in prod)
// @access  Public
router.post("/register", async (req, res) => {
  const { username, email, password } = req.body;

  try {
    let admin = await AdminUser.findOne({ email });
    if (admin) {
      return res.status(400).json({ msg: "Admin already exists" });
    }

    admin = new AdminUser({
      username,
      email,
      password,
    });

    const salt = await bcrypt.genSalt(10);
    admin.password = await bcrypt.hash(password, salt);

    await admin.save();

    const payload = {
      adminUser: {
        id: admin.id,
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
          adminUser: {
            id: admin.id,
            username: admin.username,
            email: admin.email,
            role: admin.role,
          },
        });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   POST api/admin/auth/login
// @desc    Authenticate Super Admin & get token
// @access  Public
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    let admin = await AdminUser.findOne({ email });
    if (!admin) {
      return res.status(400).json({ msg: "Invalid Credentials" });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(400).json({ msg: "Invalid Credentials" });
    }

    const payload = {
      adminUser: {
        id: admin.id,
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
          adminUser: {
            id: admin.id,
            username: admin.username,
            email: admin.email,
            role: admin.role,
          },
        });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// @route   GET api/admin/auth/me
// @desc    Get logged in Super Admin
// @access  Private (AdminAuth)
router.get("/me", adminAuth, async (req, res) => {
  try {
    const admin = await AdminUser.findById(req.adminUser.id).select(
      "-password"
    );
    res.json(admin);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

module.exports = router;
