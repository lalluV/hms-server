const express = require("express");
const router = express.Router();
const Parameter = require("../models/Parameter");

// Get all parameters with pagination and search
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
          { name: { $regex: search, $options: "i" } },
          { category: { $regex: search, $options: "i" } },
          { units: { $regex: search, $options: "i" } },
          { id: { $regex: search, $options: "i" } },
          { "normal_range.adult_male": { $regex: search, $options: "i" } },
          { "normal_range.adult_female": { $regex: search, $options: "i" } },
          { "normal_range.child": { $regex: search, $options: "i" } },
          { "critical_values.low": { $regex: search, $options: "i" } },
          { "critical_values.high": { $regex: search, $options: "i" } },
        ],
      };
    }

    // Calculate skip value for pagination
    const skip = (parseInt(page) - 1) * actualLimit;

    // Get total count for pagination info
    const totalParameters = await Parameter.countDocuments(searchQuery);

    // Fetch parameters with pagination and search
    const parameters = await Parameter.find(searchQuery)
      .sort({ updatedAt: -1 }) // Sort by most recently updated
      .skip(skip)
      .limit(actualLimit);

    // Calculate pagination info
    const totalPages = Math.ceil(totalParameters / actualLimit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    res.json({
      parameters,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalParameters,
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

// Get parameter by ID
router.get("/:id", async (req, res) => {
  try {
    const parameter = await Parameter.findById(req.params.id);
    if (!parameter) {
      return res.status(404).json({ message: "Parameter not found" });
    }
    res.json(parameter);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create parameter
router.post("/", async (req, res) => {
  const parameter = new Parameter(req.body);
  try {
    const newParameter = await parameter.save();
    res.status(201).json(newParameter);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update parameter
router.put("/:id", async (req, res) => {
  try {
    const parameter = await Parameter.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!parameter) {
      return res.status(404).json({ message: "Parameter not found" });
    }
    res.json(parameter);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete parameter
router.delete("/:id", async (req, res) => {
  try {
    const parameter = await Parameter.findByIdAndDelete(req.params.id);
    if (!parameter) {
      return res.status(404).json({ message: "Parameter not found" });
    }
    res.json({ message: "Parameter deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get parameters by category
router.get("/category/:category", async (req, res) => {
  try {
    const parameters = await Parameter.find({ category: req.params.category });
    res.json(parameters);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
