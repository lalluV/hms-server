const express = require("express");
const router = express.Router();
const MasterDiagnostic = require("../models/MasterDiagnostic");
const MasterParameter = require("../models/MasterParameter");
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const {
  resolveDiagnosticBodyForHospital,
  hydrateDiagnostics,
} = require("../utils/hydrateDiagnosticParameters");

applyTenantEntitlements(router, { moduleKey: "lab" });

// Get all diagnostics with pagination and search
router.get("/", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const Parameter = req.tenantDb.model("Parameter");

    const { search, page = 1, limit } = req.query;

    // Use different limits based on whether search is active
    const defaultLimit = search ? 10 : 50;
    const actualLimit = limit ? parseInt(limit) : defaultLimit;

    // Build search query
    let searchQuery = { hospitalId: req.hospitalId };
    if (search) {
      searchQuery.$or = [
        { code: { $regex: search, $options: "i" } },
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { deptname: { $regex: search, $options: "i" } },
        { subdeptname: { $regex: search, $options: "i" } },
        { type: { $regex: search, $options: "i" } },
        { visitType: { $regex: search, $options: "i" } },
        // legacy embedded snapshots
        { "parameters.name": { $regex: search, $options: "i" } },
        { "parameters.category": { $regex: search, $options: "i" } },
        { "includedTests.name": { $regex: search, $options: "i" } },
        { "includedTests.code": { $regex: search, $options: "i" } },
      ];
    }

    // Calculate skip value for pagination
    const skip = (parseInt(page) - 1) * actualLimit;

    // Get total count for pagination info
    const totalDiagnostics = await Diagnostic.countDocuments(searchQuery);

    // Do not populate diagnosticId → MasterDiagnostic (lives on master DB, not tenant)
    const diagnostics = await Diagnostic.find(searchQuery)
      .sort({ createdAt: -1 }) // Sort by newest first
      .skip(skip)
      .limit(actualLimit);

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
        isSearchActive: !!search,
        searchTerm: search || null,
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
