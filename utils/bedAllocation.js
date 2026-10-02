/**
 * Atomic bed claim / release on the Ward document. Uses positional updates so
 * concurrent admits, transfers and discharges in the same ward never overwrite
 * each other's bed changes.
 */

/**
 * Mark a bed Occupied for this patient. Succeeds if the bed is free or already
 * held by the same patient. Returns { ok, reason }.
 */
async function claimBed(tenantDb, hospitalId, { wardId, bed, patient }) {
  if (!wardId || !bed) return { ok: true, skipped: true };
  const Ward = tenantDb.model("Ward");
  const umr = String(patient?.UMRNo || "");
  const result = await Ward.updateOne(
    {
      hospitalId,
      wardId,
      beds: {
        $elemMatch: {
          bed: String(bed),
          $or: [{ status: { $ne: "Occupied" } }, { UMRNo: umr }],
        },
      },
    },
    {
      $set: {
        "beds.$.status": "Occupied",
        "beds.$.UMRNo": umr,
        "beds.$.name": patient?.name || "",
        "beds.$.age": patient?.age != null ? String(patient.age) : "",
        "beds.$.gender": patient?.gender || "",
      },
    },
  );
  if (result.modifiedCount || result.matchedCount) return { ok: true };
  const ward = await Ward.findOne({ hospitalId, wardId }).lean();
  if (!ward) return { ok: false, reason: "Ward not found" };
  if (!(ward.beds || []).some((b) => b.bed === String(bed))) {
    return { ok: false, reason: `Bed ${bed} not found in ${ward.wardName}` };
  }
  return { ok: false, reason: `Bed ${bed} is already occupied` };
}

/**
 * Free a bed. When umr is given, only frees it if this patient holds it, so a
 * late release never evicts the next occupant.
 */
async function releaseBed(tenantDb, hospitalId, { wardId, bed, umr }) {
  if (!wardId || !bed) return;
  const Ward = tenantDb.model("Ward");
  const match = { bed: String(bed) };
  if (umr) match.$or = [{ UMRNo: String(umr) }, { UMRNo: { $in: ["", null] } }];
  await Ward.updateOne(
    { hospitalId, wardId, beds: { $elemMatch: match } },
    {
      $set: {
        "beds.$.status": "Empty",
        "beds.$.UMRNo": "",
        "beds.$.name": "",
        "beds.$.age": "",
        "beds.$.gender": "",
      },
    },
  );
}

module.exports = { claimBed, releaseBed };
