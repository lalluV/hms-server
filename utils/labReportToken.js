const crypto = require("crypto");

/**
 * Signed token for public lab report view links (same shape as prescription tokens).
 */

const TOKEN_SEPARATOR = "~";

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(input) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

function getSecret() {
  const secret =
    process.env.LAB_REPORT_LINK_SECRET || process.env.PRESCRIPTION_LINK_SECRET;
  if (!secret) {
    throw new Error(
      "LAB_REPORT_LINK_SECRET or PRESCRIPTION_LINK_SECRET must be configured.",
    );
  }
  return secret;
}

function sign(payloadPart) {
  return base64UrlEncode(
    crypto.createHmac("sha256", getSecret()).update(payloadPart).digest(),
  );
}

function splitToken(token) {
  if (token.includes(TOKEN_SEPARATOR)) {
    const idx = token.indexOf(TOKEN_SEPARATOR);
    return [token.slice(0, idx), token.slice(idx + 1)];
  }
  if (token.includes(".")) {
    const idx = token.indexOf(".");
    return [token.slice(0, idx), token.slice(idx + 1)];
  }
  return [null, null];
}

function createLabReportToken({ hospitalId, receiptId }) {
  if (!hospitalId || !receiptId) {
    throw new Error("hospitalId and receiptId are required to create a token.");
  }

  const payload = {
    h: String(hospitalId),
    r: String(receiptId),
    iat: Date.now(),
  };

  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const signaturePart = sign(payloadPart);
  return `${payloadPart}${TOKEN_SEPARATOR}${signaturePart}`;
}

function normalizeLabReportToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string") return rawToken;

  let token = rawToken.trim();
  try {
    token = decodeURIComponent(token);
  } catch {
    // keep raw value
  }

  token = token.replace(/^(\{\{1\}\}|%7B%7B1%7D%7D)+/i, "");
  return token;
}

function verifyLabReportToken(token) {
  token = normalizeLabReportToken(token);

  if (!token || typeof token !== "string") {
    throw new Error("Invalid token format.");
  }

  const [payloadPart, signaturePart] = splitToken(token);
  if (!payloadPart || !signaturePart) {
    throw new Error("Invalid token format.");
  }

  const expectedSignature = sign(payloadPart);
  const provided = Buffer.from(signaturePart);
  const expected = Buffer.from(expectedSignature);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    throw new Error("Invalid token signature.");
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadPart));
  } catch {
    throw new Error("Invalid token payload.");
  }

  if (!payload.h || !payload.r) {
    throw new Error("Invalid token payload.");
  }

  return {
    hospitalId: payload.h,
    receiptId: payload.r,
    iat: payload.iat,
  };
}

module.exports = {
  createLabReportToken,
  verifyLabReportToken,
};
