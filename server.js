const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors"); // <--- import cors
require("dotenv").config();
const {
  initializeMeilisearch,
  indexAllMasterData,
  getAllIndexStats,
} = require("./utils/meilisearch");
const { initializeMasterDatabase } = require("./utils/tenantDb");

const app = express();

// Enable CORS for all routes
// Note: Subdomain-based tenant authentication is implemented
// Login routes require subdomain identification (via Host header, query param, or header)
// For production, configure wildcard subdomain support: *.yourdomain.com
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      // Allow localhost origins (development)
      const allowedOrigins = [
        "http://localhost:5173",
        "http://localhost:5174",
        "https://healeka.com", // Root domain
      ];

      // Check if origin is in allowed list
      if (allowedOrigins.indexOf(origin) !== -1) {
        return callback(null, true);
      }

      // Allow localhost subdomains (development): *.localhost:PORT
      // Pattern matches: http://subdomain.localhost:PORT or http://subdomain.localhost
      // Examples: http://hs-6619038603.localhost:5173, http://hospitalcode.localhost
      if (origin.match(/^http:\/\/[a-zA-Z0-9_-]+\.localhost(:\d+)?$/)) {
        return callback(null, true);
      }

      // Allow production subdomains: *.healeka.com
      // Examples: https://hs-6619038603.healeka.com, https://hospitalcode.healeka.com
      if (origin.match(/^https:\/\/[a-zA-Z0-9_-]+\.healeka\.com$/)) {
        return callback(null, true);
      }

      callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
  }),
);

app.use(express.json());

// Initialize master database connection (for shared data)
mongoose
  .connect(process.env.MONGO_URI_SHARED || process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("✅ Connected to Master MongoDB Database");
    initializeMasterDatabase();
  })
  .catch((err) => console.error("❌ Master MongoDB connection error:", err));

// Your existing routes here...
app.use("/api/pharmacy", require("./routes/pharmacy"));
// Use routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin/auth", require("./routes/adminAuth"));
app.use("/api/patients", require("./routes/patients"));
app.use("/api/prescriptions", require("./routes/prescriptions"));
app.use("/api/appointments", require("./routes/appointments"));
app.use("/api/staff", require("./routes/staff"));
app.use("/api/diagnostics", require("./routes/diagnostics"));
app.use("/api/expenses", require("./routes/expenses"));
app.use("/api/adjustments", require("./routes/adjustments"));
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
app.use("/api/insurance-settings", require("./routes/insuranceSettings"));
app.use("/api/lab-inventory", require("./routes/labInventoryRoutes"));
app.use("/api/indent-store", require("./routes/indentStoreRoutes"));
app.use("/api/pharmacy-receipts", require("./routes/pharmacyReceipts"));
app.use("/api/diagnostics-receipts", require("./routes/diagnosticsReceipts"));
app.use("/api/discharge-summary", require("./routes/dischargeSummary"));
app.use("/api/gemini-live", require("./routes/geminiLive"));
app.use("/api/healeka-agent", require("./routes/healekaAgent"));
app.use("/api/consents", require("./routes/consentRoutes"));
app.use("/api/consent-templates", require("./routes/consentTemplateRoutes"));
app.use(
  "/api/clinical-order-packages",
  require("./routes/clinicalOrderPackageRoutes"),
);
app.use("/api/doctor-memory", require("./routes/doctorMemory"));
app.use("/api/stamps", require("./routes/stamps"));
app.use("/api/upload", require("./routes/upload"));
app.use("/api/diagnostics-users", require("./routes/diagnosticsUsers"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/commissions", require("./routes/commissions"));
app.use("/api/hospitals", require("./routes/hospitals"));
app.use("/api/master-medicines", require("./routes/masterMedicines"));
app.use("/api/master-parameters", require("./routes/masterParameters"));
app.use("/api/master-diagnostics", require("./routes/masterDiagnostics"));
app.use("/api/master-lab-items", require("./routes/masterLabItems"));

// Database error handling middleware
const { dbErrorHandler } = require("./middleware/dbErrorHandler");
app.use(dbErrorHandler);

// General error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: "Something went wrong!" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // Initialize Meilisearch and index master data after server starts
  setTimeout(async () => {
    try {
      const success = await initializeMeilisearch();
      if (success) {
        console.log("✅ Meilisearch initialized successfully for master data");

        // Check if master data needs to be indexed
        const indexStats = await getAllIndexStats();
        if (indexStats) {
          const totalIndexed =
            indexStats.master_medicines.documents +
            indexStats.master_diagnostics.documents +
            indexStats.master_parameters.documents +
            indexStats.master_lab_items.documents;

          if (totalIndexed === 0) {
            console.log(
              "📝 No master data indexed, starting automatic indexing...",
            );
            const result = await indexAllMasterData();
            if (result.success) {
              console.log(
                `✅ Automatic master data indexing completed: ${result.totalIndexed} documents indexed`,
              );
              console.log(
                `   - Medicines: ${result.results.medicines.indexed}`,
              );
              console.log(
                `   - Diagnostics: ${result.results.diagnostics.indexed}`,
              );
              console.log(
                `   - Parameters: ${result.results.parameters.indexed}`,
              );
              console.log(`   - Lab Items: ${result.results.labItems.indexed}`);
            } else {
              console.log(
                "❌ Automatic master data indexing failed:",
                result.error,
              );
            }
          } else {
            console.log("✅ Meilisearch master data indices status:");
            console.log(
              `   - Medicines: ${indexStats.master_medicines.documents} documents`,
            );
            console.log(
              `   - Diagnostics: ${indexStats.master_diagnostics.documents} documents`,
            );
            console.log(
              `   - Parameters: ${indexStats.master_parameters.documents} documents`,
            );
            console.log(
              `   - Lab Items: ${indexStats.master_lab_items.documents} documents`,
            );
            console.log(`   - Total: ${totalIndexed} documents indexed`);
          }
        }
      } else {
        console.log(
          "⚠️  Meilisearch initialization failed - master data search will use MongoDB fallback",
        );
      }
    } catch (error) {
      console.error("❌ Meilisearch initialization error:", error);
      console.log("⚠️  Master data search will use MongoDB fallback");
    }
  }, 2000);
});
