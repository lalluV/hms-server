const Hospital = require("../models/Hospital");

/**
 * Middleware to extract subdomain from request and identify tenant hospital
 * Uses ONLY subdomain-based authentication (no fallbacks):
 * Priority order (checks in this sequence):
 * 1. Origin header (where request came from - frontend subdomain)
 * 2. Referer header (fallback to identify frontend subdomain)
 * 3. Host header (only as last resort, filters out backend subdomains like "hms-server")
 *
 * This ensures we always use the frontend/hospital subdomain (e.g., hs-6619038603)
 * and never the backend server subdomain (e.g., hms-server)
 */
async function extractSubdomain(req, res, next) {
  try {
    let hospitalCode = null;
    let hospital = null;

    // List of backend/infrastructure subdomains to ignore
    // These should never be treated as hospital codes
    const backendSubdomains = [
      "hms-server",
      "api",
      "backend",
      "www",
      "admin",
      "localhost",
    ];

    // Helper function to extract subdomain from hostname
    const extractSubdomainFromHostname = (hostname) => {
      if (!hostname) return null;

      // Handle localhost subdomains (e.g., hs-6619038603.localhost)
      if (hostname.includes(".localhost")) {
        const parts = hostname.split(".localhost");
        if (parts[0] && !backendSubdomains.includes(parts[0].toLowerCase())) {
          return parts[0];
        }
      } else {
        // Handle regular domain subdomains (e.g., hospitalcode.example.com)
        const domainParts = hostname.split(".");
        if (domainParts.length > 2) {
          const subdomain = domainParts[0];
          if (
            subdomain &&
            !backendSubdomains.includes(subdomain.toLowerCase())
          ) {
            return subdomain;
          }
        } else if (
          domainParts.length === 2 &&
          !backendSubdomains.includes(domainParts[0].toLowerCase())
        ) {
          return domainParts[0];
        }
      }
      return null;
    };

    // PRIORITY 1: Extract from Origin header FIRST (when frontend is on different host/port)
    // This handles cases where frontend is on hs-6619038603.lalluvemula.cloud
    // but makes API requests to hms-server.lalluvemula.cloud
    // Origin header represents where the request came from (the frontend)
    if (!hospitalCode && req.headers.origin) {
      try {
        const originUrl = new URL(req.headers.origin);
        const originHostname = originUrl.hostname;
        hospitalCode = extractSubdomainFromHostname(originHostname);
        if (hospitalCode && process.env.NODE_ENV === "development") {
          console.log(
            `[Subdomain] Extracted code from Origin header: ${hospitalCode}`
          );
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

    // PRIORITY 2: Extract from Referer header (fallback when Origin is not available)
    // Referer also represents where the request came from (the frontend)
    if (!hospitalCode && req.headers.referer) {
      try {
        const refererUrl = new URL(req.headers.referer);
        const refererHostname = refererUrl.hostname;
        hospitalCode = extractSubdomainFromHostname(refererHostname);
        if (hospitalCode && process.env.NODE_ENV === "development") {
          console.log(
            `[Subdomain] Extracted code from Referer header: ${hospitalCode}`
          );
        }
      } catch (error) {
        // Invalid Referer header, skip
      }
    }

    // PRIORITY 3: Extract from Host header LAST (only if Origin/Referer didn't provide a subdomain)
    // Host header is the backend server, so we only use it as a last resort
    // and we filter out known backend subdomains
    let host = null;
    if (!hospitalCode) {
      host = req.headers.host || req.headers["x-forwarded-host"];
      if (host) {
        const hostParts = host.split(":");
        const hostname = hostParts[0];
        hospitalCode = extractSubdomainFromHostname(hostname);
        if (hospitalCode && process.env.NODE_ENV === "development") {
          console.log(
            `[Subdomain] Extracted code from Host header: ${hospitalCode}`
          );
        }
      }
    }

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
        // Shared-tier hospitals use hms_shared which is always ready;
        // only isolated-tier hospitals need the provisioning status check.
        if (
          hospital.tenancyMode !== "shared" &&
          hospital.databaseStatus !== "active"
        ) {
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
      hint: "Ensure you are accessing the application through the correct hospital subdomain. The subdomain must match your hospital code in the database.",
      detectedHost: host,
      detectedOrigin: origin !== "unknown" ? origin : null,
      detectedReferer: referer !== "unknown" ? referer : null,
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
