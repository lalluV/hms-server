const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Mirrors the date-range helper used by OPD queue / IPD list filters.
 */
function buildDateStringRange(fromDate, toDate) {
  const start = fromDate ? String(fromDate).slice(0, 10) : null;
  const end = toDate ? String(toDate).slice(0, 10) : null;
  if (!start && !end) return null;
  const range = {};
  if (start) range.$gte = start;
  if (end) range.$lte = `${end}T23:59:59.999Z`;
  return range;
}

describe("visit-centric list date ranges", () => {
  it("matches both yyyy-MM-dd and ISO prescription dates for today", () => {
    const range = buildDateStringRange("2026-08-12", "2026-08-12");
    assert.ok(range);
    assert.equal(range.$gte, "2026-08-12");
    assert.equal(range.$lte, "2026-08-12T23:59:59.999Z");

    const ymd = "2026-08-12";
    const iso = "2026-08-12T09:30:00.000Z";
    assert.ok(ymd >= range.$gte && ymd <= range.$lte);
    assert.ok(iso >= range.$gte && iso <= range.$lte);
  });

  it("excludes prior-day visits from today's queue range", () => {
    const range = buildDateStringRange("2026-08-12", "2026-08-12");
    const prior = "2026-08-09T18:00:00.000Z";
    assert.ok(prior < range.$gte);
  });
});
