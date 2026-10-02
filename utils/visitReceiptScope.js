function eventScopeFromRecord(event) {
  if (!event) return null;
  if (event.kind === "ip" || event.kind === "op") return event;

  // An admission document's own id is the stay. A person record must not
  // use its patient id as the stay id.
  if (event.ipNumber) {
    const admissionId = String(event.admissionId || event._id || "");
    return admissionId ? { kind: "ip", admissionId } : null;
  }

  const type = String(event.patient_type || "").toUpperCase();
  const admissionId = String(
    event.admissionId || event.activeAdmissionId || "",
  );
  const prescriptionId = String(
    event.selectedPrescriptionId || event.prescriptionId || "",
  );

  if (type === "IP" || type === "OPTOIP") {
    return admissionId ? { kind: "ip", admissionId } : null;
  }
  if (type === "OP") {
    return prescriptionId ? { kind: "op", prescriptionId } : null;
  }
  if (admissionId) return { kind: "ip", admissionId };
  if (prescriptionId) return { kind: "op", prescriptionId };
  return null;
}

function receiptBelongsToEvent(receipt, event) {
  const scope = eventScopeFromRecord(event);
  if (!receipt || !scope) return false;
  if (scope.kind === "ip") {
    return String(receipt.admissionId || "") === scope.admissionId;
  }
  return String(receipt.prescriptionId || "") === scope.prescriptionId;
}

function filterReceiptsForEvent(receipts, event) {
  return (receipts || []).filter((receipt) =>
    receiptBelongsToEvent(receipt, event),
  );
}

module.exports = {
  eventScopeFromRecord,
  receiptBelongsToEvent,
  filterReceiptsForEvent,
};
