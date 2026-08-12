/**
 * Security Headers Middleware
 * Standard HTTP security headers without heavy external dependencies.
 */
function securityHeaders(req, res, next) {
  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Prevent clickjacking by only allowing frames from same origin
  res.setHeader("X-Frame-Options", "SAMEORIGIN");

  // Legacy XSS filter activation
  res.setHeader("X-XSS-Protection", "1; mode=block");

  // Strict Referrer Policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Remove X-Powered-By if present
  res.removeHeader("X-Powered-By");

  // HSTS for HTTPS connections (1 year)
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }

  next();
}

module.exports = securityHeaders;
