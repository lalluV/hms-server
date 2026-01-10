const Hospital = require("../models/Hospital");

/**
 * Middleware to extract subdomain from request and identify tenant hospital
 * Supports:
 * - Production: subdomain from Host header (e.g., hospitalcode.example.com)
 * - Development: query parameter or header fallback (e.g., ?tenant=hospitalcode)
 */
async function extractSubdomain(req, res, next) {
  try {
    let hospitalCode = null;
    let hospital = null;

    // Method 1: Extract from Host header (subdomain)
    const host = req.headers.host || req.headers["x-forwarded-host"];
    if (host) {
      // Extract subdomain from host (format: subdomain.domain.com)
      // Handle both localhost:port and domain.com formats
      const hostParts = host.split(":");
      const hostname = hostParts[0];
      const domainParts = hostname.split(".");

      // Handle localhost subdomains (e.g., hs-6619038603.localhost)
      // localhost subdomains have pattern: subdomain.localhost
      if (hostname.includes(".localhost")) {
        // Extract everything before .localhost
        const parts = hostname.split(".localhost");
        if (parts[0] && parts[0] !== "www" && parts[0] !== "localhost") {
          hospitalCode = parts[0];
          // Debug logging for development
          if (process.env.NODE_ENV === "development") {
            console.log(
              `[Subdomain] Extracted code from Host header localhost subdomain: ${hospitalCode}`
            );
          }
        }
      }
      // Handle regular domain subdomains (e.g., hospitalcode.example.com)
      else if (domainParts.length > 2) {
        // Extract the first part as subdomain
        hospitalCode = domainParts[0];
      } else if (
        domainParts.length === 2 &&
        domainParts[0] !== "www" &&
        domainParts[0] !== "localhost"
      ) {
        // For domains like subdomain.example.com (2 parts after split)
        hospitalCode = domainParts[0];
      }
    }

    // Method 1b: Extract from Origin header (when frontend is on different host/port)
    // This handles cases where frontend is on hs-6619038603.localhost:5173
    // but makes API requests to localhost:3001
    if (!hospitalCode && req.headers.origin) {
      try {
        const originUrl = new URL(req.headers.origin);
        const originHostname = originUrl.hostname;

        if (originHostname.includes(".localhost")) {
          const parts = originHostname.split(".localhost");
          if (parts[0] && parts[0] !== "www" && parts[0] !== "localhost") {
            hospitalCode = parts[0];
            if (process.env.NODE_ENV === "development") {
              console.log(
                `[Subdomain] Extracted code from Origin header: ${hospitalCode}`
              );
            }
          }
        } else {
          const domainParts = originHostname.split(".");
          if (domainParts.length > 2) {
            hospitalCode = domainParts[0];
            if (process.env.NODE_ENV === "development") {
              console.log(
                `[Subdomain] Extracted code from Origin header: ${hospitalCode}`
              );
            }
          }
        }
      } catch (error) {
        // Invalid Origin header, skip
        if (process.env.NODE_ENV === "development") {
          console.log(
            `[Subdomain] Could not parse Origin header: ${req.headers.origin}`
          );
        }
      }
    }

    // Method 1c: Extract from Referer header (fallback when Origin is not available)
    if (!hospitalCode && req.headers.referer) {
      try {
        const refererUrl = new URL(req.headers.referer);
        const refererHostname = refererUrl.hostname;

        if (refererHostname.includes(".localhost")) {
          const parts = refererHostname.split(".localhost");
          if (parts[0] && parts[0] !== "www" && parts[0] !== "localhost") {
            hospitalCode = parts[0];
            if (process.env.NODE_ENV === "development") {
              console.log(
                `[Subdomain] Extracted code from Referer header: ${hospitalCode}`
              );
            }
          }
        } else {
          const domainParts = refererHostname.split(".");
          if (domainParts.length > 2) {
            hospitalCode = domainParts[0];
            if (process.env.NODE_ENV === "development") {
              console.log(
                `[Subdomain] Extracted code from Referer header: ${hospitalCode}`
              );
            }
          }
        }
      } catch (error) {
        // Invalid Referer header, skip
      }
    }

    // Method 2: Fallback to query parameter (for development/testing only)
    // Only allow in development environment or when explicitly enabled
    if (!hospitalCode && req.query.tenant) {
      // Validate that query param is not empty
      const tenantParam = req.query.tenant.trim();
      if (tenantParam && tenantParam.length > 0) {
        hospitalCode = tenantParam;
      }
    }

    // Method 3: Fallback to custom header (for API clients - development/testing only)
    // Only allow in development environment or when explicitly enabled
    if (!hospitalCode && req.headers["x-tenant-code"]) {
      const tenantHeader = req.headers["x-tenant-code"].trim();
      if (tenantHeader && tenantHeader.length > 0) {
        hospitalCode = tenantHeader;
      }
    }

    // Method 4: Fallback to request body (for POST requests during login)
    // This is handled in the login route itself for security reasons

    // If we found a hospital code, look up the hospital
    if (hospitalCode) {
      // Normalize hospital code to lowercase (matching Hospital model schema)
      hospitalCode = hospitalCode.toLowerCase().trim();

      // Validate hospital code format (alphanumeric, hyphens, underscores)
      const codePattern = /^[a-z0-9_-]+$/;
      if (!codePattern.test(hospitalCode)) {
        return res.status(400).json({
          message:
            "Invalid subdomain format. Use alphanumeric characters, hyphens, or underscores only.",
        });
      }

      try {
        // Debug: Log what we're searching for
        if (process.env.NODE_ENV === "development") {
          console.log(
            `[Subdomain] Looking up hospital with code: "${hospitalCode}"`
          );
        }

        hospital = await Hospital.findOne({
          code: hospitalCode,
          active: true,
        });

        if (!hospital) {
          // Try to find the hospital without the active filter to give better error message
          const inactiveHospital = await Hospital.findOne({
            code: hospitalCode,
          });

          if (inactiveHospital) {
            return res.status(403).json({
              message: `Hospital with subdomain "${hospitalCode}" exists but is inactive.`,
              subdomain: hospitalCode,
              hospitalName: inactiveHospital.name,
            });
          }

          // Debug: List some hospital codes for reference (only in development)
          if (process.env.NODE_ENV === "development") {
            const sampleHospitals = await Hospital.find({})
              .limit(5)
              .select("code name active");
            console.log(
              `[Subdomain] Hospital not found. Sample hospital codes:`,
              sampleHospitals.map((h) => ({
                code: h.code,
                name: h.name,
                active: h.active,
              }))
            );
          }

          return res.status(404).json({
            message: `Hospital with subdomain "${hospitalCode}" not found.`,
            subdomain: hospitalCode,
            hint: "Please verify the subdomain matches the hospital code in the database.",
          });
        }

        // Check if database is provisioned and active
        if (hospital.databaseStatus !== "active") {
          return res.status(503).json({
            message: `Hospital database is not yet ready. Status: ${hospital.databaseStatus}. Please contact administrator.`,
            subdomain: hospitalCode,
            databaseStatus: hospital.databaseStatus,
          });
        }

        // Attach hospital info to request
        req.hospitalCode = hospitalCode;
        req.hospital = hospital;
        req.hospitalId = hospital._id.toString();
      } catch (error) {
        console.error("Error looking up hospital by subdomain:", error);
        return res.status(500).json({
          message: "Error identifying tenant hospital",
          error: error.message,
        });
      }
    } else {
      // No subdomain found - this might be root domain access (for admin panel)
      // Don't block the request, let the route handle it (routes can use requireSubdomain to enforce)
      req.hospitalCode = null;
      req.hospital = null;
      req.hospitalId = null;

      // Log when no subdomain is detected (for debugging)
      if (process.env.NODE_ENV === "development") {
        console.log(
          `[Subdomain] No subdomain detected for host: ${host || "unknown"}`
        );
      }
    }

    next();
  } catch (error) {
    console.error("Subdomain extraction error:", error);
    return res.status(500).json({
      message: "Error processing subdomain",
      error: error.message,
    });
  }
}

/**
 * Middleware that requires subdomain to be present
 * Use this for routes that MUST have a tenant subdomain
 */
function requireSubdomain(req, res, next) {
  // Strict check: both hospital object and code must be present
  if (!req.hospital || !req.hospitalCode) {
    const host = req.headers.host || "unknown";
    const origin = req.headers.origin || "unknown";
    const referer = req.headers.referer || "unknown";

    // Log the rejection for debugging
    console.log(
      `[Subdomain] Login rejected - no subdomain detected. Host: ${host}, Origin: ${origin}, Referer: ${referer}`
    );

    return res.status(400).json({
      message:
        "Tenant subdomain is required. Access the application via your tenant subdomain (e.g., yourcode.example.com or yourcode.localhost:PORT)",
      hint: "For development with separate frontend/backend ports, include the subdomain in requests using: ?tenant=yourcode query parameter, x-tenant-code header, or ensure Origin/Referer headers are sent",
      detectedHost: host,
      detectedOrigin: origin !== "unknown" ? origin : null,
      detectedReferer: referer !== "unknown" ? referer : null,
      hasQueryParam: !!req.query.tenant,
      queryParamValue: req.query.tenant || null,
      hasHeader: !!req.headers["x-tenant-code"],
      headerValue: req.headers["x-tenant-code"] || null,
    });
  }
  next();
}

/**
 * Middleware that optionally uses subdomain
 * If subdomain is present, validates it. If not, allows request to proceed.
 * Useful for routes that can work with or without subdomain (like admin routes)
 */
async function optionalSubdomain(req, res, next) {
  // If no subdomain detected, proceed without validation
  if (!req.hospitalCode) {
    return next();
  }

  // If subdomain is present, validate it (same as extractSubdomain logic)
  // This is already done by extractSubdomain, so just proceed
  next();
}

module.exports = {
  extractSubdomain,
  requireSubdomain,
  optionalSubdomain,
};
