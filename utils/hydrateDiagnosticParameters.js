/**
 * Hospital Diagnostic.parameters should store Parameter refs only:
 *   [{ parameterId: ObjectId, order: Number }]
 *
 * On read we hydrate live hospital Parameter fields so edits in Lab Inventory
 * reflect on every test / receipt / report that references that parameter.
 *
 * Receipts store parameterId + result fields; ranges/units/name are always
 * merged from the live Parameter catalog on GET.
 */

const mongoose = require("mongoose");

const RESULT_KEYS = [
  "result",
  "resultStatus",
  "resultDate",
  "resultBy",
  "isAbnormal",
  "remarks",
];

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === "object" && value._id) return toObjectId(value._id);
  if (mongoose.Types.ObjectId.isValid(String(value))) {
    return new mongoose.Types.ObjectId(String(value));
  }
  return null;
}

/**
 * Extract the hospital Parameter catalog id from a link / Parameter-shaped object.
 * Prefer `_id` when both `_id` (hospital) and `parameterId` (master) exist.
 */
function extractHospitalParameterId(p) {
  if (!p) return null;
  const hospitalDocId = p._id || null;
  const linkField =
    (p.parameterId && typeof p.parameterId === "object"
      ? p.parameterId._id
      : p.parameterId) ||
    p.id ||
    null;

  let rawId = hospitalDocId || linkField || null;
  if (
    hospitalDocId &&
    linkField &&
    String(hospitalDocId) !== String(linkField)
  ) {
    // Differing ids → `_id` is the hospital catalog row
    rawId = hospitalDocId;
  }
  return rawId;
}

function normalizeParametersForStorage(parameters = []) {
  if (!Array.isArray(parameters)) return [];
  const out = [];
  const seen = new Set();
  parameters.forEach((p, index) => {
    if (!p) return;
    const rawId = extractHospitalParameterId(p);
    const idStr = rawId != null ? String(rawId) : "";
    if (
      !idStr ||
      idStr.startsWith("manual-") ||
      idStr.startsWith("param-") ||
      idStr.startsWith("master-")
    ) {
      return;
    }
    const oid = toObjectId(rawId);
    if (!oid) return;
    const key = String(oid);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      parameterId: oid,
      order: typeof p.order === "number" ? p.order : index,
    });
  });
  return out;
}

function hospitalIdFilter(hospitalId) {
  const key = String(hospitalId);
  return { $or: [{ hospitalId }, { hospitalId: key }] };
}

/**
 * Resolve client parameter payloads to hospital Parameter._id refs.
 * Handles mistaken master ids and creates missing custom params by name.
 */
async function resolveParametersForHospital(
  ParameterModel,
  hospitalId,
  parameters = [],
) {
  if (!Array.isArray(parameters) || parameters.length === 0) return [];

  const candidates = [];
  for (let index = 0; index < parameters.length; index++) {
    const p = parameters[index];
    if (!p) continue;
    const rawId = extractHospitalParameterId(p);
    const idStr = rawId != null ? String(rawId) : "";
    if (
      idStr.startsWith("manual-") ||
      idStr.startsWith("param-") ||
      idStr.startsWith("master-")
    ) {
      continue;
    }
    candidates.push({
      p,
      index,
      oid: toObjectId(rawId),
      name: String(p.name || "").trim(),
      order: typeof p.order === "number" ? p.order : index,
    });
  }
  if (candidates.length === 0) return [];

  const ids = candidates.map((c) => c.oid).filter(Boolean);
  const hospitalFilter = hospitalIdFilter(hospitalId);
  const docs =
    ids.length > 0
      ? await ParameterModel.find({
          $and: [
            hospitalFilter,
            {
              $or: [{ _id: { $in: ids } }, { parameterId: { $in: ids } }],
            },
          ],
        }).lean()
      : [];

  const byId = new Map();
  const byMasterId = new Map();
  for (const doc of docs) {
    byId.set(String(doc._id), doc);
    if (doc.parameterId) byMasterId.set(String(doc.parameterId), doc);
  }

  const out = [];
  const seen = new Set();

  for (const c of candidates) {
    let doc = null;
    if (c.oid) {
      const key = String(c.oid);
      doc = byId.get(key) || byMasterId.get(key) || null;
    }

    if (!doc && c.name) {
      doc = await ParameterModel.findOne({
        ...hospitalFilter,
        name: new RegExp(`^${escapeRegex(c.name)}$`, "i"),
      });
      if (!doc) {
        doc = await ParameterModel.create({
          name: c.name,
          units: String(c.p.units || "").trim() || "-",
          normal_range: c.p.normal_range || {},
          critical_values: c.p.critical_values || {},
          category: c.p.category || "",
          hospitalId,
          isCustom: true,
          active: true,
        });
      }
      const plain =
        typeof doc.toObject === "function" ? doc.toObject() : doc;
      byId.set(String(plain._id), plain);
    }

    if (!doc) continue;
    const plain =
      typeof doc.toObject === "function" ? doc.toObject() : doc;
    const key = String(plain._id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      parameterId: plain._id,
      order: c.order,
    });
  }

  return out;
}

async function resolveDiagnosticBodyForHospital(
  ParameterModel,
  hospitalId,
  body = {},
) {
  const next = { ...body };
  if (Object.prototype.hasOwnProperty.call(body, "parameters")) {
    next.parameters = await resolveParametersForHospital(
      ParameterModel,
      hospitalId,
      body.parameters,
    );
  }
  if (Object.prototype.hasOwnProperty.call(body, "includedTests")) {
    const included = Array.isArray(body.includedTests)
      ? body.includedTests
      : [];
    next.includedTests = [];
    for (const t of included) {
      next.includedTests.push({
        id: t.id || t._id || t.code || "",
        code: t.code || "",
        name: t.name || "",
        deptname: t.deptname || "",
        subdeptname: t.subdeptname || "",
        price: t.price,
        mrp: t.mrp,
        parameters: await resolveParametersForHospital(
          ParameterModel,
          hospitalId,
          t.parameters || [],
        ),
      });
    }
    if (next.type === "Package" || body.type === "Package") {
      const flat = [];
      for (const t of next.includedTests) {
        for (const p of t.parameters || []) flat.push(p);
      }
      next.parameters = normalizeParametersForStorage(flat);
    }
  }
  return next;
}

function paramDocToHydrated(link, paramDoc) {
  const order = typeof link?.order === "number" ? link.order : 0;
  if (!paramDoc) {
    return {
      parameterId: link?.parameterId || null,
      id: link?.parameterId ? String(link.parameterId) : null,
      order,
      name: "",
      units: "",
      normal_range: {},
      critical_values: {},
      category: "",
      _unresolved: true,
    };
  }
  const plain =
    typeof paramDoc.toObject === "function" ? paramDoc.toObject() : paramDoc;
  return {
    parameterId: plain._id,
    id: String(plain._id),
    order,
    name: plain.name,
    units: plain.units || "",
    normal_range: plain.normal_range || {},
    critical_values: plain.critical_values || {},
    category: plain.category || "",
    active: plain.active !== false,
    _live: true,
  };
}

function isLegacySnapshot(entry) {
  if (!entry || typeof entry !== "object") return false;
  const hasName = Boolean(entry.name);
  const rawId = entry.parameterId || entry.id || entry._id;
  const idStr = rawId != null ? String(rawId) : "";
  const hasRef =
    Boolean(entry.parameterId) ||
    (Boolean(idStr) &&
      mongoose.Types.ObjectId.isValid(idStr) &&
      !idStr.startsWith("manual-") &&
      !idStr.startsWith("param-"));
  return hasName && !hasRef;
}

function collectParameterIds(parameters = []) {
  const ids = [];
  for (const p of parameters || []) {
    if (!p || isLegacySnapshot(p)) continue;
    const oid = toObjectId(p.parameterId || p.id || p._id);
    if (oid) ids.push(oid);
  }
  return ids;
}

function hydrateParametersArray(parameters, paramMap) {
  if (!Array.isArray(parameters) || parameters.length === 0) return [];
  return parameters
    .map((link, index) => {
      if (isLegacySnapshot(link)) {
        return {
          ...link,
          id: link.id || link._id || link.name,
          order: typeof link.order === "number" ? link.order : index,
          _legacySnapshot: true,
        };
      }
      const raw = link.parameterId || link.id || link._id;
      const oid = toObjectId(raw);
      const key = oid ? String(oid) : raw != null ? String(raw) : "";
      const doc = key ? paramMap.get(key) : null;
      return paramDocToHydrated(
        { ...link, order: typeof link.order === "number" ? link.order : index },
        doc,
      );
    })
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function normalizeIncludedTestsForStorage(includedTests = []) {
  if (!Array.isArray(includedTests)) return [];
  return includedTests.map((t) => ({
    id: t.id || t._id || t.code || "",
    code: t.code || "",
    name: t.name || "",
    deptname: t.deptname || "",
    subdeptname: t.subdeptname || "",
    price: t.price,
    mrp: t.mrp,
    parameters: normalizeParametersForStorage(t.parameters || []),
  }));
}

async function hydrateDiagnostics(ParameterModel, diagnosticsInput) {
  const list = Array.isArray(diagnosticsInput)
    ? diagnosticsInput
    : diagnosticsInput
      ? [diagnosticsInput]
      : [];
  if (list.length === 0) return diagnosticsInput;

  const plains = list.map((d) =>
    d && typeof d.toObject === "function" ? d.toObject() : { ...d },
  );

  const allIds = [];
  for (const d of plains) {
    allIds.push(...collectParameterIds(d.parameters));
    for (const t of d.includedTests || []) {
      allIds.push(...collectParameterIds(t.parameters));
    }
  }

  const unique = [
    ...new Map(allIds.map((id) => [String(id), id])).values(),
  ];

  const paramMap = new Map();
  if (unique.length > 0) {
    // Resolve both hospital Parameter._id and mistaken master parameterId refs
    const docs = await ParameterModel.find({
      $or: [
        { _id: { $in: unique } },
        { parameterId: { $in: unique } },
      ],
    }).lean();
    for (const doc of docs) {
      paramMap.set(String(doc._id), doc);
      if (doc.parameterId) {
        paramMap.set(String(doc.parameterId), doc);
      }
    }
  }

  const hydrated = plains.map((d) => ({
    ...d,
    // Ensure clients always get a stable string id for update/delete
    _id: d._id,
    id: d._id != null ? String(d._id) : d.id,
    parameters: hydrateParametersArray(d.parameters, paramMap),
    includedTests: (d.includedTests || []).map((t) => ({
      ...t,
      parameters: hydrateParametersArray(t.parameters, paramMap),
    })),
  }));

  return Array.isArray(diagnosticsInput) ? hydrated : hydrated[0];
}

function normalizeDiagnosticBody(body = {}) {
  const next = { ...body };
  if (Object.prototype.hasOwnProperty.call(body, "parameters")) {
    next.parameters = normalizeParametersForStorage(body.parameters);
  }
  if (Object.prototype.hasOwnProperty.call(body, "includedTests")) {
    next.includedTests = normalizeIncludedTestsForStorage(
      body.includedTests || [],
    );
    if (
      (next.type === "Package" || body.type === "Package") &&
      Object.prototype.hasOwnProperty.call(body, "includedTests")
    ) {
      const flat = [];
      for (const t of next.includedTests) {
        for (const p of t.parameters || []) flat.push(p);
      }
      next.parameters = normalizeParametersForStorage(flat);
    }
  }
  return next;
}

function pickResultFields(param = {}) {
  const out = {};
  for (const k of RESULT_KEYS) {
    if (param[k] !== undefined) out[k] = param[k];
  }
  return out;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Receipt param storage: link + results + display fallbacks (live overlay on GET) */
function toReceiptParameterForStorage(param = {}, order = 0) {
  const rawId = extractHospitalParameterId(param);
  const oid = toObjectId(rawId);
  return {
    parameterId: oid || rawId || null,
    id: oid ? String(oid) : rawId != null ? String(rawId) : param.name || null,
    order: typeof param.order === "number" ? param.order : order,
    name: param.name || "",
    units: param.units || "",
    normal_range: param.normal_range || {},
    critical_values: param.critical_values || {},
    category: param.category || "",
    ...pickResultFields(param),
  };
}

function normalizeReceiptItemsForStorage(items = []) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    const next = { ...item };
    if (Array.isArray(item.parameters)) {
      next.parameters = item.parameters.map((p, i) =>
        toReceiptParameterForStorage(p, i),
      );
    }
    if (Array.isArray(item.includedTests)) {
      next.includedTests = item.includedTests.map((t) => ({
        ...t,
        parameters: Array.isArray(t.parameters)
          ? t.parameters.map((p, i) => toReceiptParameterForStorage(p, i))
          : [],
      }));
    }
    return next;
  });
}

function mergeLiveOntoReceiptParam(param, liveDoc) {
  const results = pickResultFields(param);
  if (!liveDoc) {
    // Keep whatever display fields were stored on the receipt
    return {
      ...param,
      ...results,
      parameterId: param.parameterId || param.id || null,
      id: param.id || param.parameterId || param.name,
      units: param.units || "",
      normal_range: param.normal_range || {},
      critical_values: param.critical_values || {},
      _live: false,
    };
  }
  return {
    ...param,
    ...results,
    parameterId: liveDoc._id,
    id: String(liveDoc._id),
    name: liveDoc.name || param.name || "",
    units: liveDoc.units || param.units || "",
    normal_range:
      liveDoc.normal_range &&
      (liveDoc.normal_range.adult_male ||
        liveDoc.normal_range.adult_female ||
        liveDoc.normal_range.child)
        ? liveDoc.normal_range
        : param.normal_range || {},
    critical_values: liveDoc.critical_values || param.critical_values || {},
    category: liveDoc.category || param.category || "",
    active: liveDoc.active !== false,
    order: param.order,
    _live: true,
  };
}

function findLiveParam(
  param,
  byId,
  byName,
  byMasterId = new Map(),
  fallbackNames = [],
) {
  const oid = toObjectId(param.parameterId || param.id || param._id);
  if (oid) {
    const key = String(oid);
    if (byId.has(key)) return byId.get(key);
    if (byMasterId.has(key)) return byMasterId.get(key);
  }
  const candidates = [
    String(param.name || "").trim(),
    ...fallbackNames.map((n) => String(n || "").trim()),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const nameKey = candidate.toLowerCase();
    if (byName.has(nameKey)) return byName.get(nameKey);
    // "Haemoglobin1" → "Haemoglobin"
    const stripped = nameKey.replace(/[\s_-]*\d+$/, "").trim();
    if (stripped && stripped !== nameKey && byName.has(stripped)) {
      return byName.get(stripped);
    }
  }
  return null;
}

function hydrateReceiptParametersArray(
  parameters,
  byId,
  byName,
  byMasterId = new Map(),
  fallbackNames = [],
) {
  if (!Array.isArray(parameters)) return [];
  return parameters.map((p) =>
    mergeLiveOntoReceiptParam(
      p,
      findLiveParam(p, byId, byName, byMasterId, fallbackNames),
    ),
  );
}

async function hydrateReceipts(ParameterModel, hospitalId, receiptsInput) {
  const list = Array.isArray(receiptsInput)
    ? receiptsInput
    : receiptsInput
      ? [receiptsInput]
      : [];
  if (list.length === 0) return receiptsInput;

  const plains = list.map((r) =>
    r && typeof r.toObject === "function" ? r.toObject() : { ...r },
  );

  const ids = [];
  const names = new Set();
  const walkParams = (params) => {
    for (const p of params || []) {
      const oid = toObjectId(p.parameterId || p.id || p._id);
      if (oid) ids.push(oid);
      if (p.name) names.add(String(p.name).trim());
    }
  };
  for (const r of plains) {
    for (const item of r.items || []) {
      if (item.name) names.add(String(item.name).trim());
      walkParams(item.parameters);
      for (const t of item.includedTests || []) {
        if (t.name) names.add(String(t.name).trim());
        walkParams(t.parameters);
      }
    }
  }

  const uniqueIds = [...new Map(ids.map((id) => [String(id), id])).values()];
  const nameList = [...names].filter(Boolean);

  // Match hospitalId as ObjectId or string (legacy docs)
  const hospitalKey = String(hospitalId);
  const hospitalFilter = {
    $or: [{ hospitalId }, { hospitalId: hospitalKey }],
  };

  const query = { ...hospitalFilter };
  if (uniqueIds.length || nameList.length) {
    const nameMatchers = [];
    for (const n of nameList) {
      nameMatchers.push(new RegExp(`^${escapeRegex(n)}$`, "i"));
      const stripped = String(n)
        .trim()
        .replace(/[\s_-]*\d+$/, "")
        .trim();
      if (stripped && stripped.toLowerCase() !== String(n).trim().toLowerCase()) {
        nameMatchers.push(new RegExp(`^${escapeRegex(stripped)}$`, "i"));
      }
    }
    query.$and = [
      hospitalFilter,
      {
        $or: [
          ...(uniqueIds.length
            ? [
                { _id: { $in: uniqueIds } },
                // Also match when receipt stored a master Parameter id
                { parameterId: { $in: uniqueIds } },
              ]
            : []),
          ...(nameMatchers.length ? [{ name: { $in: nameMatchers } }] : []),
        ],
      },
    ];
    delete query.$or;
    delete query.hospitalId;
  }

  const byId = new Map();
  const byMasterId = new Map();
  const byName = new Map();
  const docs = await ParameterModel.find(query).lean();
  for (const doc of docs) {
    byId.set(String(doc._id), doc);
    if (doc.parameterId) {
      byMasterId.set(String(doc.parameterId), doc);
    }
    const nk = String(doc.name || "")
      .trim()
      .toLowerCase();
    if (nk && !byName.has(nk)) byName.set(nk, doc);
  }

  const hydrated = plains.map((r) => ({
    ...r,
    items: (r.items || []).map((item) => ({
      ...item,
      parameters: hydrateReceiptParametersArray(
        item.parameters,
        byId,
        byName,
        byMasterId,
        [item.name],
      ),
      includedTests: (item.includedTests || []).map((t) => ({
        ...t,
        parameters: hydrateReceiptParametersArray(
          t.parameters,
          byId,
          byName,
          byMasterId,
          [t.name, item.name],
        ),
      })),
    })),
  }));

  return Array.isArray(receiptsInput) ? hydrated : hydrated[0];
}

module.exports = {
  toObjectId,
  normalizeParametersForStorage,
  normalizeIncludedTestsForStorage,
  normalizeDiagnosticBody,
  resolveParametersForHospital,
  resolveDiagnosticBodyForHospital,
  hydrateDiagnostics,
  hydrateParametersArray,
  hydrateReceipts,
  normalizeReceiptItemsForStorage,
  toReceiptParameterForStorage,
};
