const express = require("express");
const router = express.Router();
const MasterDiagnostic = require("../models/MasterDiagnostic");
const auth = require("../middleware/auth");
const tenantDb = require("../middleware/tenantDb");

router.use(auth);
router.use(tenantDb);

// Get all diagnostics with pagination and search
router.get("/", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");

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
        { "parameters.name": { $regex: search, $options: "i" } },
        { "parameters.category": { $regex: search, $options: "i" } },
      ];
    }

    // Calculate skip value for pagination
    const skip = (parseInt(page) - 1) * actualLimit;

    // Get total count for pagination info
    const totalDiagnostics = await Diagnostic.countDocuments(searchQuery);

    // Fetch diagnostics with pagination and search, populate master diagnostic if exists
    const diagnostics = await Diagnostic.find(searchQuery)
      .populate(
        "diagnosticId",
        "test_code name deptname subdeptname description"
      )
      .sort({ createdAt: -1 }) // Sort by newest first
      .skip(skip)
      .limit(actualLimit);

    // Calculate pagination info
    const totalPages = Math.ceil(totalDiagnostics / actualLimit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    res.json({
      diagnostics,
      pagination: {
        currentPage: parseInt(page),
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
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostic by ID
router.get("/:id", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const diagnostic = await Diagnostic.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!diagnostic) {
      return res.status(404).json({ message: "Diagnostic not found" });
    }
    res.json(diagnostic);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create diagnostic from master diagnostic
router.post("/from-master/:masterId", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");

    const masterDiagnostic = await MasterDiagnostic.findById(
      req.params.masterId
    ).populate("suggested_parameters.parameterId");

    if (!masterDiagnostic) {
      return res.status(404).json({ message: "Master diagnostic not found" });
    }

    // Check if hospital already has this diagnostic
    const existing = await Diagnostic.findOne({
      hospitalId: req.hospitalId,
      diagnosticId: masterDiagnostic._id,
    });

    if (existing) {
      return res.status(400).json({
        message: "Diagnostic already exists from this master",
        diagnostic: existing,
      });
    }

    // Create hospital diagnostic from master with defaults
    const hospitalDiagnostic = new Diagnostic({
      hospitalId: req.hospitalId,
      diagnosticId: masterDiagnostic._id,
      code: req.body.code || "", // Hospital-specific code (not from master)
      name: masterDiagnostic.name,
      deptname: masterDiagnostic.deptname,
      subdeptname: masterDiagnostic.subdeptname,
      description: masterDiagnostic.description,
      fasting: masterDiagnostic.default_fasting || "Not Required",
      reportsIn: masterDiagnostic.default_reportsIn || "Same Day",
      testInstructions: masterDiagnostic.default_testInstructions || [],
      type: "Test",
      visitType: "Center",
      isCustom: false, // Created from master
      // Pricing must be set by hospital
      mrp: req.body.mrp || 0,
      price: req.body.price || 0,
      // Parameters will be set from hospital's own parameters
      parameters: req.body.parameters || [],
    });

    // Allow overriding defaults from request body
    if (req.body.code) hospitalDiagnostic.code = req.body.code;
    if (req.body.name) hospitalDiagnostic.name = req.body.name;
    if (req.body.deptname) hospitalDiagnostic.deptname = req.body.deptname;
    if (req.body.subdeptname)
      hospitalDiagnostic.subdeptname = req.body.subdeptname;
    if (req.body.description)
      hospitalDiagnostic.description = req.body.description;
    if (req.body.fasting) hospitalDiagnostic.fasting = req.body.fasting;
    if (req.body.reportsIn) hospitalDiagnostic.reportsIn = req.body.reportsIn;
    if (req.body.testInstructions)
      hospitalDiagnostic.testInstructions = req.body.testInstructions;
    if (req.body.visitType) hospitalDiagnostic.visitType = req.body.visitType;

    const newDiagnostic = await hospitalDiagnostic.save();
    res.status(201).json(newDiagnostic);
  } catch (error) {
    console.error("Error creating diagnostic from master:", error);
    res.status(400).json({ message: error.message });
  }
});

// Create new diagnostic (supports both custom and from master)
router.post("/", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");

    // If diagnosticId is provided, verify it exists
    if (req.body.diagnosticId) {
      const masterDiag = await MasterDiagnostic.findById(req.body.diagnosticId);
      if (!masterDiag) {
        return res.status(404).json({ message: "Master diagnostic not found" });
      }
    }

    const diagnostic = new Diagnostic({
      ...req.body,
      hospitalId: req.hospitalId,
      isCustom: !req.body.diagnosticId, // Custom if no master reference
    });
    const newDiagnostic = await diagnostic.save();
    res.status(201).json(newDiagnostic);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update diagnostic
router.put("/:id", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const diagnostic = await Diagnostic.findOneAndUpdate(
      { _id: req.params.id, hospitalId: req.hospitalId },
      req.body,
      { new: true }
    );
    if (!diagnostic) {
      return res.status(404).json({ message: "Diagnostic not found" });
    }
    res.json(diagnostic);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete diagnostic
router.delete("/:id", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const diagnostic = await Diagnostic.findOneAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!diagnostic) {
      return res.status(404).json({ message: "Diagnostic not found" });
    }
    res.json({ message: "Diagnostic deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics by patient ID
router.get("/patient/:patientId", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const diagnostics = await Diagnostic.find({
      patientId: req.params.patientId,
      hospitalId: req.hospitalId,
    });
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const Diagnostic = req.tenantDb.model("Diagnostic");
    const diagnostics = await Diagnostic.find({
      doctorId: req.params.doctorId,
      hospitalId: req.hospitalId,
    });
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
