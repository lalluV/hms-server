const express = require("express");
const router = express.Router();
const Diagnostic = require("../models/Diagnostic");

// Get all diagnostics with pagination and search
router.get("/", async (req, res) => {
  try {
    const { search, page = 1, limit } = req.query;

    // Use different limits based on whether search is active
    const defaultLimit = search ? 10 : 50;
    const actualLimit = limit ? parseInt(limit) : defaultLimit;

    // Build search query
    let searchQuery = {};
    if (search) {
      searchQuery = {
        $or: [
          { code: { $regex: search, $options: "i" } },
          { name: { $regex: search, $options: "i" } },
          { description: { $regex: search, $options: "i" } },
          { deptname: { $regex: search, $options: "i" } },
          { subdeptname: { $regex: search, $options: "i" } },
          { type: { $regex: search, $options: "i" } },
          { visitType: { $regex: search, $options: "i" } },
          { "parameters.name": { $regex: search, $options: "i" } },
          { "parameters.category": { $regex: search, $options: "i" } },
        ],
      };
    }

    // Calculate skip value for pagination
    const skip = (parseInt(page) - 1) * actualLimit;

    // Get total count for pagination info
    const totalDiagnostics = await Diagnostic.countDocuments(searchQuery);

    // Fetch diagnostics with pagination and search
    const diagnostics = await Diagnostic.find(searchQuery)
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
    const diagnostic = await Diagnostic.findOne({ id: req.params.id });
    if (!diagnostic) {
      return res.status(404).json({ message: "Diagnostic not found" });
    }
    res.json(diagnostic);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new diagnostic
router.post("/", async (req, res) => {
  try {
    const diagnostic = new Diagnostic(req.body);
    const newDiagnostic = await diagnostic.save();
    res.status(201).json(newDiagnostic);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update diagnostic
router.put("/:id", async (req, res) => {
  try {
    const diagnostic = await Diagnostic.findOneAndUpdate(
      { id: req.params.id },
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
    const diagnostic = await Diagnostic.findOneAndDelete({ id: req.params.id });
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
    const diagnostics = await Diagnostic.find({
      patientId: req.params.patientId,
    });
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get diagnostics by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const diagnostics = await Diagnostic.find({
      doctorId: req.params.doctorId,
    });
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
