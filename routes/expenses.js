const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "expenses" });

function expenseLookup(id, hospitalId) {
  const base = { hospitalId };
  if (mongoose.Types.ObjectId.isValid(id)) {
    return { ...base, _id: id };
  }
  return { ...base, id };
}

// Get all expenses
router.get("/", async (req, res) => {
  try {
    const Expense = req.tenantDb.model("Expense");
    const expenses = await Expense.find({ hospitalId: req.hospitalId }).sort({
      createdAt: -1,
    });
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get expenses by date range (must be before /:id)
router.get("/date-range", async (req, res) => {
  try {
    const Expense = req.tenantDb.model("Expense");
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ message: "startDate and endDate are required" });
    }
    const expenses = await Expense.find({
      hospitalId: req.hospitalId,
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    }).sort({ createdAt: -1 });
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get expenses by category (must be before /:id)
router.get("/category/:category", async (req, res) => {
  try {
    const Expense = req.tenantDb.model("Expense");
    const expenses = await Expense.find({
      category: req.params.category,
      hospitalId: req.hospitalId,
    }).sort({ createdAt: -1 });
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get expense by ID
router.get("/:id", async (req, res) => {
  try {
    const Expense = req.tenantDb.model("Expense");
    const expense = await Expense.findOne(expenseLookup(req.params.id, req.hospitalId));
    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }
    res.json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new expense
router.post("/", async (req, res) => {
  try {
    const Expense = req.tenantDb.model("Expense");
    const expense = new Expense({ ...req.body, hospitalId: req.hospitalId });
    const newExpense = await expense.save();
    res.status(201).json(newExpense);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update expense
router.put("/:id", async (req, res) => {
  try {
    const Expense = req.tenantDb.model("Expense");
    const { hospitalId, _id, ...updates } = req.body;
    const expense = await Expense.findOneAndUpdate(
      expenseLookup(req.params.id, req.hospitalId),
      updates,
      { new: true, runValidators: true },
    );
    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }
    res.json(expense);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete expense
router.delete("/:id", async (req, res) => {
  try {
    const Expense = req.tenantDb.model("Expense");
    const expense = await Expense.findOneAndDelete(
      expenseLookup(req.params.id, req.hospitalId),
    );
    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }
    res.json({ message: "Expense deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
