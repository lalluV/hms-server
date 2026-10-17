function isClinicalMode(entitlements) {
  return (
    String(entitlements?.productMode || "full").toLowerCase() === "clinical"
  );
}

function rejectClinicalBilling(req, res, next) {
  if (!isClinicalMode(req.entitlements)) return next();
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  return res.status(403).json({
    code: "CLINICAL_MODE",
    message: "Billing is turned off for this hospital.",
  });
}

/**
 * Clinical hospitals may create lab/radiology report rows, never charges.
 * Purchase and return receipts are rejected.
 */
function prepareClinicalDiagnosticsBody(entitlements, body, options = {}) {
  if (!isClinicalMode(entitlements) || !body || typeof body !== "object") {
    return body;
  }
  const type = String(body.type || "");
  if (/purchase|return/i.test(type)) {
    const error = new Error("Billing is turned off for this hospital.");
    error.status = 403;
    error.code = "CLINICAL_MODE";
    throw error;
  }
  const creating = options.creating === true;
  const touchesMoney =
    creating ||
    body.billingSkipped === true ||
    body.totalAmount !== undefined ||
    body.paymentStatus !== undefined ||
    body.paymentType !== undefined;
  if (!touchesMoney) return body;
  return {
    ...body,
    billingSkipped: true,
    paymentStatus: "Not billed",
    paymentType: "none",
    totalAmount: 0,
    baseTotalAmount: 0,
    discount: 0,
    refundAmount: 0,
    paymentSplit: {},
  };
}

module.exports = {
  isClinicalMode,
  rejectClinicalBilling,
  prepareClinicalDiagnosticsBody,
};
