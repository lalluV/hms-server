const jwt = require("jsonwebtoken");
const AdminUser = require("../models/AdminUser");
require("dotenv").config();

/**
 * Flexible authentication middleware that accepts both admin and regular user tokens
 * Useful for routes that can be accessed by both admins and regular users
 */
module.exports = async function (req, res, next) {
  // Get token from header
  const token = req.header("x-auth-token");

  // Check if no token
  if (!token) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if it's an admin token
    if (decoded.adminUser) {
      // Admin token - verify admin exists
      const admin = await AdminUser.findById(decoded.adminUser.id).select("-password");
      if (!admin) {
        return res.status(401).json({ message: "Admin user not found" });
      }
      
      req.adminUser = decoded.adminUser;
      req.isAdmin = true;
      // For admin operations, hospitalId might come from request body
      req.hospitalId = req.body?.hospitalId || req.params?.hospitalId;
      
      return next();
    }

    // Regular user token
    if (decoded.user) {
      req.user = decoded.user;
      req.isAdmin = false;
      
      // Ensure hospitalId is available
      if (decoded.user.hospitalId) {
        req.hospitalId = decoded.user.hospitalId;
      }
      
      return next();
    }

    // Token doesn't have expected structure
    return res.status(401).json({ message: "Invalid token format" });
  } catch (err) {
    console.error("Auth error:", err);
    res.status(401).json({ message: "Token is not valid" });
  }
};

