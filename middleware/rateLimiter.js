/**
 * In-Memory Sliding Window Rate Limiter Middleware
 * Protects auth and sensitive endpoints against brute-force and credential stuffing.
 */

function createRateLimiter(options = {}) {
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes default
    max = 20, // max requests per window per IP
    message = { message: "Too many requests. Please try again later." },
    statusCode = 429,
  } = options;

  // Map of IP -> array of timestamps
  const hits = new Map();

  // Periodic cleanup of stale entries every 5 minutes
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of hits.entries()) {
      const validTimestamps = timestamps.filter((t) => now - t < windowMs);
      if (validTimestamps.length === 0) {
        hits.delete(ip);
      } else {
        hits.set(ip, validTimestamps);
      }
    }
  }, 5 * 60 * 1000);

  // Unref interval so it does not keep process alive in tests
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return function rateLimiter(req, res, next) {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown_ip";

    const now = Date.now();
    const timestamps = hits.get(ip) || [];

    // Filter to timestamps within current window
    const windowStart = now - windowMs;
    const recentHits = timestamps.filter((t) => t > windowStart);

    // Set standard rate limit headers
    const remaining = Math.max(0, max - recentHits.length);
    const resetTime = Math.ceil((recentHits[0] ? recentHits[0] + windowMs : now + windowMs) / 1000);

    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", remaining);
    res.setHeader("RateLimit-Reset", resetTime);

    if (recentHits.length >= max) {
      const retryAfter = Math.ceil((recentHits[0] + windowMs - now) / 1000);
      res.setHeader("Retry-After", retryAfter);
      return res.status(statusCode).json(message);
    }

    recentHits.push(now);
    hits.set(ip, recentHits);

    next();
  };
}

module.exports = { createRateLimiter };
