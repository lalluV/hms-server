const express = require("express");
const router = express.Router();
const Expense = require("../models/Expense");

// Get all expenses
router.get("/", async (req, res) => {
  try {
    const expenses = await Expense.find({});
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get expense by ID
router.get("/:id", async (req, res) => {
  try {
    const expense = await Expense.findOne({ id: req.params.id });
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
    const expense = new Expense(req.body);
    const newExpense = await expense.save();
    res.status(201).json(newExpense);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update expense
router.put("/:id", async (req, res) => {
  try {
    const expense = await Expense.findOneAndUpdate(
      { id: req.params.id },
      req.body,
      { new: true }
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
    const expense = await Expense.findOneAndDelete({ id: req.params.id });
    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }
    res.json({ message: "Expense deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get expenses by category
router.get("/category/:category", async (req, res) => {
  try {
    const expenses = await Expense.find({ category: req.params.category });
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get expenses by date range
router.get("/date-range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const expenses = await Expense.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    });
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
