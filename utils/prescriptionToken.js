const crypto = require("crypto");

/**
 * Signed, tamper-proof token used to build a public prescription view link.
 *
 * Uses "~" as the payload/signature separator (not ".") so SPA hosts like Vite
 * do not treat the path as a static file and return 404.
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
  const secret = process.env.PRESCRIPTION_LINK_SECRET;
  if (!secret) {
    throw new Error(
      "PRESCRIPTION_LINK_SECRET is not configured. Set it in the server environment.",
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
  // Legacy tokens used "."
  if (token.includes(".")) {
    const idx = token.indexOf(".");
    return [token.slice(0, idx), token.slice(idx + 1)];
  }
  return [null, null];
}

/**
 * Create a signed token for a specific prescription.
 * @param {{ hospitalId: string, patientId: string, prescriptionId: string }} params
 * @returns {string} opaque, URL-safe token (no "." so SPA fallback works)
 */
function createPrescriptionToken({ hospitalId, patientId, prescriptionId }) {
  if (!hospitalId || !patientId || !prescriptionId) {
    throw new Error(
      "hospitalId, patientId and prescriptionId are required to create a token.",
    );
  }

  const payload = {
    h: String(hospitalId),
    p: String(patientId),
    r: String(prescriptionId),
    iat: Date.now(),
  };

  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const signaturePart = sign(payloadPart);
  return `${payloadPart}${TOKEN_SEPARATOR}${signaturePart}`;
}

/**
 * Normalize a token taken from a URL path / WhatsApp CTA button.
 * Meta sometimes leaves a literal "{{1}}" prefix when the dynamic URL
 * button variable is not substituted correctly.
 */
function normalizePrescriptionToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string") return rawToken;

  let token = rawToken.trim();
  try {
    token = decodeURIComponent(token);
  } catch {
    // keep raw value if it wasn't URI-encoded
  }

  // Strip accidental Meta template placeholders left in the path
  token = token.replace(/^(\{\{1\}\}|%7B%7B1%7D%7D)+/i, "");

  return token;
}

/**
 * Verify and decode a prescription token.
 * @param {string} token
 * @returns {{ hospitalId: string, patientId: string, prescriptionId: string, iat: number }}
 */
function verifyPrescriptionToken(token) {
  token = normalizePrescriptionToken(token);

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
  } catch (error) {
    throw new Error("Invalid token payload.");
  }

  if (!payload.h || !payload.p || !payload.r) {
    throw new Error("Invalid token payload.");
  }

  return {
    hospitalId: payload.h,
    patientId: payload.p,
    prescriptionId: payload.r,
    iat: payload.iat,
  };
}

module.exports = {
  createPrescriptionToken,
  verifyPrescriptionToken,
};
