const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors"); // <--- import cors
require("dotenv").config();
const {
  initializeMeilisearch,
  indexAllData,
  getIndexStats,
} = require("./utils/meilisearch");

const app = express();

// Enable CORS for all routes (you can restrict origins if needed)
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://srichakrahms.web.app",
    ],
    credentials: true,
  })
);

app.use(express.json());

mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// Your existing routes here...
app.use("/api/pharmacy", require("./routes/pharmacy"));
// Use routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/patients", require("./routes/patients"));
app.use("/api/appointments", require("./routes/appointments"));
app.use("/api/staff", require("./routes/staff"));
app.use("/api/diagnostics", require("./routes/diagnostics"));
app.use("/api/expenses", require("./routes/expenses"));
app.use("/api/leaves", require("./routes/leaves"));
app.use("/api/holidays", require("./routes/holidays"));
app.use("/api/wards", require("./routes/wards"));
app.use("/api/departments", require("./routes/departments"));
app.use("/api/shifts", require("./routes/shifts"));
app.use("/api/nurse-desc", require("./routes/nurseDesc"));
app.use("/api/consultations", require("./routes/consultations"));
app.use("/api/actions", require("./routes/actions"));
app.use("/api/advance-receipts", require("./routes/advanceReceipts"));
app.use("/api/parameters", require("./routes/parameterRoutes"));
app.use("/api/vendors", require("./routes/vendorRoutes"));
app.use("/api/insurance-companies", require("./routes/insuranceRoutes"));
app.use("/api/insurance-tariffs", require("./routes/insuranceTariffs"));
app.use("/api/insurance-exclusions", require("./routes/insuranceExclusions"));
app.use("/api/lab-inventory", require("./routes/labInventoryRoutes"));
app.use("/api/indent-store", require("./routes/indentStoreRoutes"));
app.use("/api/pharmacy-receipts", require("./routes/pharmacyReceipts"));
app.use("/api/diagnostics-receipts", require("./routes/diagnosticsReceipts"));
app.use("/api/discharge-summary", require("./routes/dischargeSummary"));
app.use("/api/consents", require("./routes/consentRoutes"));
app.use("/api/consent-templates", require("./routes/consentTemplateRoutes"));
app.use("/api/stamps", require("./routes/stamps"));
app.use("/api/upload", require("./routes/upload"));
app.use("/api/diagnostics-users", require("./routes/diagnosticsUsers"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/commissions", require("./routes/commissions"));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: "Something went wrong!" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // Initialize Meilisearch and index data after server starts
  setTimeout(async () => {
    try {
      const success = await initializeMeilisearch();
      if (success) {
        console.log("✅ Meilisearch initialized successfully");

        // Check if data needs to be indexed
        const indexStats = await getIndexStats();
        if (!indexStats || indexStats.documents === 0) {
          console.log("📝 No data indexed, starting automatic indexing...");
          const result = await indexAllData();
          if (result.success) {
            console.log(
              `✅ Automatic indexing completed: ${result.indexed} documents indexed`
            );
          } else {
            console.log("❌ Automatic indexing failed:", result.error);
          }
        } else {
          console.log(
            `✅ Meilisearch already has ${indexStats.documents} documents indexed`
          );
        }
      } else {
        console.log(
          "⚠️  Meilisearch initialization failed - search will be disabled"
        );
      }
    } catch (error) {
      console.error("❌ Meilisearch initialization error:", error);
    }
  }, 2000);
});
