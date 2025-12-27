const jwt = require("jsonwebtoken");
require("dotenv").config();

module.exports = function (req, res, next) {
  // Get token from header
  const token = req.header("x-auth-token");

  // Check if not token
  if (!token) {
    return res.status(401).json({ msg: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if token is for AdminUser (not Staff)
    if (!decoded.adminUser) {
      return res.status(401).json({ msg: "Token is not for Super Admin" });
    }

    req.adminUser = decoded.adminUser;
    next();
  } catch (err) {
    res.status(401).json({ msg: "Token is not valid" });
  }
};
