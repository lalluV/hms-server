const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "hr" });

// Get all departments
router.get("/", async (req, res) => {
  try {
    const Department = req.tenantDb.model("Department");
    const departments = await Department.find({ hospitalId: req.hospitalId });
    res.json(departments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get department by ID
router.get("/:id", async (req, res) => {
  try {
    const Department = req.tenantDb.model("Department");
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ message: "Department not found" });
    }
    res.json(department);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new department
router.post("/", async (req, res) => {
  try {
    const Department = req.tenantDb.model("Department");
    const department = new Department({
      ...req.body,
      hospitalId: req.hospitalId,
    });
    const newDepartment = await department.save();
    res.status(201).json(newDepartment);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update department
router.put("/:id", async (req, res) => {
  try {
    const Department = req.tenantDb.model("Department");
    const department = await Department.findByIdAndUpdate(
      req.params.id,
      req.body,
      {
        new: true,
      }
    );
    if (!department) {
      return res.status(404).json({ message: "Department not found" });
    }
    res.json(department);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete department
router.delete("/:id", async (req, res) => {
  try {
    const Department = req.tenantDb.model("Department");
    const department = await Department.findByIdAndDelete(req.params.id);
    if (!department) {
      return res.status(404).json({ message: "Department not found" });
    }
    res.json({ message: "Department deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get departments by type
router.get("/type/:type", async (req, res) => {
  try {
    const Department = req.tenantDb.model("Department");
    const departments = await Department.find({
      type: req.params.type,
      hospitalId: req.hospitalId,
    });
    res.json(departments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get departments by status
router.get("/status/:status", async (req, res) => {
  try {
    const Department = req.tenantDb.model("Department");
    const departments = await Department.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
    });
    res.json(departments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get departments by HOD
router.get("/hod/:hodName", async (req, res) => {
  try {
    const Department = req.tenantDb.model("Department");
    const departments = await Department.find({
      hod_name: req.params.hodName,
      hospitalId: req.hospitalId,
    });
    res.json(departments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update department status
router.put("/:id/status", async (req, res) => {
  try {
    const Department = req.tenantDb.model("Department");
    const department = await Department.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    if (!department) {
      return res.status(404).json({ message: "Department not found" });
    }
    res.json(department);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;
