const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createRateLimiter } = require("../../middleware/rateLimiter");

describe("Rate Limiter Middleware", () => {
  it("allows requests under the limit and sets standard headers", (t, done) => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
    const req = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
    const headers = {};
    const res = {
      setHeader(key, val) {
        headers[key] = val;
      },
      status(code) {
        return {
          json(body) {
            assert.fail("Should not reach error status under limit");
          },
        };
      },
    };

    limiter(req, res, () => {
      assert.equal(headers["RateLimit-Limit"], 2);
      assert.equal(headers["RateLimit-Remaining"], 2);
      done();
    });
  });

  it("blocks requests over the limit with 429 status code", () => {
    const limiter = createRateLimiter({ windowMs: 5000, max: 2 });
    const req = { socket: { remoteAddress: "192.168.1.100" }, headers: {} };
    const headers = {};
    let blockedStatusCode = null;
    let blockedResponse = null;

    const res = {
      setHeader(key, val) {
        headers[key] = val;
      },
      status(code) {
        blockedStatusCode = code;
        return {
          json(body) {
            blockedResponse = body;
          },
        };
      },
    };

    // 1st request
    limiter(req, res, () => {});
    // 2nd request
    limiter(req, res, () => {});
    // 3rd request (should be blocked)
    limiter(req, res, () => {});

    assert.equal(blockedStatusCode, 429, "Must return HTTP 429");
    assert.ok(headers["Retry-After"] > 0, "Must set Retry-After header");
    assert.ok(blockedResponse, "Must return rate limit JSON message");
  });
});
