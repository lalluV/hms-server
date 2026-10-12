const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const MasterDiagnostic = require("../models/MasterDiagnostic");
const MasterParameter = require("../models/MasterParameter");
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const {
  resolveDiagnosticBodyForHospital,
  hydrateDiagnostics,
} = require("../utils/hydrateDiagnosticParameters");
const {
  indexHospitalDiagnostic,
  deleteHospitalDiagnostic,
  searchHospitalDiagnostics,
} = require("../utils/meilisearch");

applyTenantEntitlements(router, { moduleKey: "lab" });

function indexHospitalDiagnosticSafely(diagnostic) {
  indexHospitalDiagnostic(diagnostic).catch((error) => {
    console.warn(
      "⚠️  Failed to index hospital diagnostic:",
      error.message,
    );
  });
}

// Get all diagnostics with pagination and search
router.get("/", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const Parameter = req.tenantDb.model("Parameter");

    const { search, page = 1, limit, deptScope } = req.query;
    const searchText = typeof search === "string" ? search.trim() : "";

    // Use different limits based on whether search is active
    const defaultLimit = searchText ? 10 : 50;
    const actualLimit = limit ? parseInt(limit) : defaultLimit;

    // Typed search is Meilisearch on hospital diagnostics only.
    // Master diagnostics are used when creating a test, not when listing.
    const skip = (parseInt(page) - 1) * actualLimit;
    let totalDiagnostics = 0;
    let diagnostics = [];

    if (searchText) {
      let searchResults;
      try {
        searchResults = await searchHospitalDiagnostics(searchText, {
          hospitalId: req.hospitalId,
          limit: actualLimit,
          offset: skip,
          deptScope,
        });
      } catch (searchError) {
        console.error("Hospital diagnostic search failed:", searchError.message);
        return res.status(503).json({
          message: "Lab search is unavailable",
        });
      }

      const orderedIds = (searchResults.hits || [])
        .map((hit) => hit.id)
        .filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
      totalDiagnostics = searchResults.estimatedTotalHits || 0;

      if (orderedIds.length > 0) {
        const hospitalKey = String(req.hospitalId);
        const hospitalObjectId = mongoose.Types.ObjectId.isValid(hospitalKey)
          ? new mongoose.Types.ObjectId(hospitalKey)
          : req.hospitalId;
        const rows = await Diagnostic.find({
          _id: { $in: orderedIds },
          $or: [{ hospitalId: hospitalObjectId }, { hospitalId: hospitalKey }],
        });
        const byId = new Map(rows.map((row) => [String(row._id), row]));
        diagnostics = orderedIds
          .map((id) => byId.get(String(id)))
          .filter(Boolean);
      }
    } else {
      const searchQuery = { hospitalId: req.hospitalId };
      if (deptScope === "radiology") {
        searchQuery.deptname = { $regex: /^radiology$/i };
      } else if (deptScope === "lab") {
        searchQuery.$and = [
          {
            $or: [
              { deptname: { $exists: false } },
              { deptname: null },
              { deptname: "" },
              { deptname: { $not: /^radiology$/i } },
            ],
          },
        ];
      }

      totalDiagnostics = await Diagnostic.countDocuments(searchQuery);
      diagnostics = await Diagnostic.find(searchQuery)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(actualLimit);
    }

    // Calculate pagination info
    const pageNum = parseInt(page, 10) || 1;
    const totalPages = Math.ceil(totalDiagnostics / actualLimit) || 0;
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    const hydrated = await hydrateDiagnostics(Parameter, diagnostics);

    res.json({
      diagnostics: hydrated,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalDiagnostics,
        hasNextPage,
        hasPrevPage,
        limit: actualLimit,
        isSearchActive: !!searchText,
        searchTerm: searchText || null,
      },
    });
  } catch (error) {
    console.error("Error listing diagnostics:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostic by ID
router.get("/:id", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const Parameter = req.tenantDb.model("Parameter");
    const diagnostic = await Diagnostic.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!diagnostic) {
      return res.status(404).json({ message: "Diagnostic not found" });
    }
    const hydrated = await hydrateDiagnostics(Parameter, diagnostic);
    res.json(hydrated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create diagnostic from master diagnostic
router.post("/from-master/:masterId", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const Parameter = req.tenantDb.model("Parameter");

    const masterDiagnostic = await MasterDiagnostic.findById(
      req.params.masterId,
    ).populate("suggested_parameters.parameterId");

    if (!masterDiagnostic) {
      return res.status(404).json({ message: "Master diagnostic not found" });
    }

    const normalized = await resolveDiagnosticBodyForHospital(
      Parameter,
      req.hospitalId,
      req.body || {},
    );

    // Ensure suggested master parameters exist in hospital Parameter catalog
    const hospitalFilter = {
      $or: [
        { hospitalId: req.hospitalId },
        { hospitalId: String(req.hospitalId) },
      ],
    };
    const ensureFromMaster = async (masterParamDoc, order = 0) => {
      if (!masterParamDoc?._id && !masterParamDoc?.name) return null;
      const masterId = masterParamDoc._id;
      let hospitalParam = null;
      if (masterId) {
        hospitalParam = await Parameter.findOne({
          ...hospitalFilter,
          parameterId: masterId,
        });
      }
      if (!hospitalParam && masterParamDoc.name) {
        hospitalParam = await Parameter.findOne({
          ...hospitalFilter,
          name: new RegExp(
            `^${String(masterParamDoc.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            "i",
          ),
        });
      }
      if (!hospitalParam) {
        hospitalParam = await Parameter.create({
          hospitalId: req.hospitalId,
          parameterId: masterId || undefined,
          name: masterParamDoc.name,
          units: masterParamDoc.units || "-",
          normal_range: masterParamDoc.default_normal_range || {},
          critical_values: masterParamDoc.default_critical_values || {},
          category: masterParamDoc.category || "",
          isCustom: !masterId,
          active: true,
        });
      } else if (masterId && !hospitalParam.parameterId) {
        hospitalParam.parameterId = masterId;
        hospitalParam.isCustom = false;
        await hospitalParam.save();
      }
      return { parameterId: hospitalParam._id, order };
    };

    let parameterLinks = Array.isArray(normalized.parameters)
      ? normalized.parameters.filter((p) => p?.parameterId)
      : [];

    // If client sent no valid refs, build from master suggested_parameters
    if (
      parameterLinks.length === 0 &&
      Array.isArray(masterDiagnostic.suggested_parameters)
    ) {
      const built = [];
      for (let i = 0; i < masterDiagnostic.suggested_parameters.length; i++) {
        const sp = masterDiagnostic.suggested_parameters[i];
        const masterParam =
          sp.parameterId && typeof sp.parameterId === "object"
            ? sp.parameterId
            : null;
        if (!masterParam) continue;
        const link = await ensureFromMaster(masterParam, i);
        if (link) built.push(link);
      }
      parameterLinks = built;
    } else if (parameterLinks.length > 0) {
      // Make sure each linked id exists; if a master id was sent, create hospital param
      const resolved = [];
      for (let i = 0; i < parameterLinks.length; i++) {
        const link = parameterLinks[i];
        const oid = link.parameterId;
        const asHospital = await Parameter.findOne({
          ...hospitalFilter,
          _id: oid,
        });
        if (asHospital) {
          resolved.push({
            parameterId: asHospital._id,
            order: typeof link.order === "number" ? link.order : i,
          });
          continue;
        }
        // Maybe client passed a master Parameter id
        const masterParam = await MasterParameter.findById(oid);
        if (masterParam) {
          const created = await ensureFromMaster(masterParam, i);
          if (created) resolved.push(created);
        }
      }
      parameterLinks = resolved;
    }

    // Create hospital diagnostic from master with defaults
    const hospitalDiagnostic = new Diagnostic({
      hospitalId: req.hospitalId,
      diagnosticId: masterDiagnostic._id,
      code: req.body.code || "", // Hospital-specific code (not from master)
      name: req.body.name || masterDiagnostic.name,
      deptname: req.body.deptname || masterDiagnostic.deptname,
      subdeptname: req.body.subdeptname || masterDiagnostic.subdeptname,
      description: req.body.description || masterDiagnostic.description,
      fasting:
        req.body.fasting || masterDiagnostic.default_fasting || "Not Required",
      reportsIn:
        req.body.reportsIn || masterDiagnostic.default_reportsIn || "Same Day",
      testInstructions:
        req.body.testInstructions ||
        masterDiagnostic.default_testInstructions ||
        [],
      type: req.body.type || "Test",
      visitType: req.body.visitType || "Center",
      active: req.body.active !== false,
      isCustom: false, // Created from master
      // Pricing must be set by hospital
      mrp: req.body.mrp || 0,
      price: req.body.price || 0,
      // Parameter refs only (normalized)
      parameters: parameterLinks,
      includedTests: normalized.includedTests || [],
    });

    const newDiagnostic = await hospitalDiagnostic.save();
    const hydrated = await hydrateDiagnostics(Parameter, newDiagnostic);
    indexHospitalDiagnosticSafely(hydrated);
    res.status(201).json(hydrated);
  } catch (error) {
    console.error("Error creating diagnostic from master:", error);
    res.status(400).json({ message: error.message });
  }
});

// Create new diagnostic (supports both custom and from master)
router.post("/", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const Parameter = req.tenantDb.model("Parameter");

    // If diagnosticId is provided, verify it exists
    if (req.body.diagnosticId) {
      const masterDiag = await MasterDiagnostic.findById(req.body.diagnosticId);
      if (!masterDiag) {
        return res.status(404).json({ message: "Master diagnostic not found" });
      }
    }

    const normalized = await resolveDiagnosticBodyForHospital(
      Parameter,
      req.hospitalId,
      req.body || {},
    );

    const diagnostic = new Diagnostic({
      ...normalized,
      hospitalId: req.hospitalId,
      isCustom: !req.body.diagnosticId, // Custom if no master reference
    });
    const newDiagnostic = await diagnostic.save();
    const hydrated = await hydrateDiagnostics(Parameter, newDiagnostic);
    indexHospitalDiagnosticSafely(hydrated);
    res.status(201).json(hydrated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update diagnostic
router.put("/:id", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const Parameter = req.tenantDb.model("Parameter");
    const normalized = await resolveDiagnosticBodyForHospital(
      Parameter,
      req.hospitalId,
      req.body || {},
    );
    const hospitalKey = String(req.hospitalId);

    let diagnostic = await Diagnostic.findById(req.params.id);
    if (!diagnostic || String(diagnostic.hospitalId) !== hospitalKey) {
      return res.status(404).json({ message: "Diagnostic not found" });
    }

    Object.assign(diagnostic, normalized);
    await diagnostic.save();
    const hydrated = await hydrateDiagnostics(Parameter, diagnostic);
    indexHospitalDiagnosticSafely(hydrated);
    res.json(hydrated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete diagnostic
router.delete("/:id", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const id = req.params.id;
    const hospitalKey = String(req.hospitalId);

    // Prefer hospital document _id; fall back to master diagnosticId
    // (UI sometimes sends diagnosticId when _id is missing from cached rows)
    let diagnostic = await Diagnostic.findById(id);
    if (!diagnostic) {
      diagnostic = await Diagnostic.findOne({ diagnosticId: id });
    }

    if (!diagnostic || String(diagnostic.hospitalId) !== hospitalKey) {
      return res.status(404).json({
        message: "Diagnostic not found",
        id,
      });
    }

    await diagnostic.deleteOne();
    deleteHospitalDiagnostic(diagnostic._id).catch((error) => {
      console.warn(
        "⚠️  Failed to delete hospital diagnostic from search:",
        error.message,
      );
    });
    res.json({ message: "Diagnostic deleted", id: diagnostic._id });
  } catch (error) {
    console.error("Error deleting diagnostic:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics by patient ID
router.get("/patient/:patientId", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const Parameter = req.tenantDb.model("Parameter");
    const diagnostics = await Diagnostic.find({
      patientId: req.params.patientId,
      hospitalId: req.hospitalId,
    });
    const hydrated = await hydrateDiagnostics(Parameter, diagnostics);
    res.json(hydrated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const Parameter = req.tenantDb.model("Parameter");
    const diagnostics = await Diagnostic.find({
      doctorId: req.params.doctorId,
      hospitalId: req.hospitalId,
    });
    const hydrated = await hydrateDiagnostics(Parameter, diagnostics);
    res.json(hydrated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
