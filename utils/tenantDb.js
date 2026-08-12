const mongoose = require("mongoose");
require("dotenv").config();
const { registerTenantModels } = require("./tenantModels");

// Cache for tenant database connections
const tenantConnections = new Map();
const tenantLastAccessed = new Map();

// Evict isolated tenant connections idle for more than 5 minutes
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const evictionInterval = setInterval(async () => {
  const now = Date.now();
  for (const [hospitalId, lastAccess] of tenantLastAccessed.entries()) {
    if (now - lastAccess > IDLE_TIMEOUT_MS) {
      console.log(`🧹 Evicting idle connection for hospital ${hospitalId}`);
      await closeTenantConnection(hospitalId);
    }
  }
}, 2 * 60 * 1000);

if (evictionInterval.unref) {
  evictionInterval.unref();
}

// Shared master database connection (default mongoose connection)
let masterConnection = null;

// Shared multi-tenant database connection (hms_shared)
let sharedConnection = null;

/**
 * Initialize the master database connection
 * This connection is used for master data (MasterMedicine, Hospital, etc.)
 */
async function initializeMasterDatabase() {
  try {
    if (!masterConnection) {
      const masterUri = process.env.MONGO_URI_SHARED || process.env.MONGO_URI;
      masterConnection = await mongoose.connect(masterUri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      console.log("✅ Master database connected");
    }
    return masterConnection;
  } catch (error) {
    console.error("❌ Master database connection error:", error);
    throw error;
  }
}

/**
 * Get the database name for a tenant
 * @param {string} hospitalId - The hospital ObjectId
 * @returns {string} Database name
 */
function getTenantDatabaseName(hospitalId) {
  // Use hospitalId-based naming for consistency
  return `hms_hospital_${hospitalId}`;
}

/**
 * Get or create a tenant database connection
 * @param {string} hospitalId - The hospital ObjectId
 * @returns {Promise<mongoose.Connection>} Tenant database connection
 */
async function getTenantConnection(hospitalId) {
  try {
    if (!hospitalId) {
      throw new Error("Hospital ID is required for tenant connection");
    }

    // Check if connection already exists in cache
    if (tenantConnections.has(hospitalId)) {
      const connection = tenantConnections.get(hospitalId);

      // Verify connection is still alive
      if (connection.readyState === 1) {
        tenantLastAccessed.set(hospitalId, Date.now());
        return connection;
      } else {
        // Connection is dead, remove from cache and recreate
        console.warn(
          `⚠️  Connection for hospital ${hospitalId} is dead, reconnecting...`,
        );
        tenantConnections.delete(hospitalId);
        tenantLastAccessed.delete(hospitalId);
      }
    }

    // Create new connection
    const dbName = getTenantDatabaseName(hospitalId);
    const baseUri =
      process.env.MONGO_URI_TENANT_BASE || "mongodb://localhost:27017";

    // Properly construct the connection URI with database name
    // Remove any trailing slash from baseUri
    const cleanBaseUri = baseUri.replace(/\/$/, "");
    const tenantUri = `${cleanBaseUri}/${dbName}?authSource=admin`;

    console.log(
      `📡 Creating connection for hospital ${hospitalId} to database ${dbName}`,
    );

    const connection = await mongoose.createConnection(tenantUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 3, // Small pool per isolated tenant to prevent connection blowup
      minPoolSize: 0, // Allow scaling down to 0 when idle
      maxIdleTimeMS: 60000, // Close idle pool connections after 1 min
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 5000,
    });

    // Handle connection events
    connection.on("connected", () => {
      console.log(`✅ Tenant database connected: ${dbName}`);
    });

    connection.on("error", (err) => {
      console.error(`❌ Tenant database error for ${dbName}:`, err);
    });

    connection.on("disconnected", () => {
      console.warn(`⚠️  Tenant database disconnected: ${dbName}`);
      // Remove from cache on disconnect
      tenantConnections.delete(hospitalId);
      tenantLastAccessed.delete(hospitalId);
    });

    // Register tenant models with this connection
    registerTenantModels(connection);

    // Cache the connection and update last accessed timestamp
    tenantConnections.set(hospitalId, connection);
    tenantLastAccessed.set(hospitalId, Date.now());

    return connection;
  } catch (error) {
    console.error(
      `❌ Error creating tenant connection for hospital ${hospitalId}:`,
      error,
    );
    throw error;
  }
}

/**
 * Close a specific tenant connection
 * @param {string} hospitalId - The hospital ObjectId
 */
async function closeTenantConnection(hospitalId) {
  try {
    if (tenantConnections.has(hospitalId)) {
      const connection = tenantConnections.get(hospitalId);
      await connection.close();
      tenantConnections.delete(hospitalId);
      tenantLastAccessed.delete(hospitalId);
      console.log(`✅ Closed tenant connection for hospital ${hospitalId}`);
    }
  } catch (error) {
    console.error(
      `❌ Error closing tenant connection for hospital ${hospitalId}:`,
      error,
    );
  }
}

/**
 * Close all tenant connections
 */
async function closeAllTenantConnections() {
  try {
    const promises = Array.from(tenantConnections.keys()).map((hospitalId) =>
      closeTenantConnection(hospitalId),
    );
    await Promise.all(promises);
    console.log("✅ All tenant connections closed");
  } catch (error) {
    console.error("❌ Error closing tenant connections:", error);
  }
}

/**
 * Get connection statistics
 * @returns {Object} Connection stats
 */
function getConnectionStats() {
  const stats = {
    activeTenants: tenantConnections.size,
    tenants: [],
    master: {
      connected: masterConnection?.connection?.readyState === 1,
      readyState: masterConnection?.connection?.readyState,
    },
  };

  tenantConnections.forEach((connection, hospitalId) => {
    stats.tenants.push({
      hospitalId,
      dbName: getTenantDatabaseName(hospitalId),
      readyState: connection.readyState,
      connected: connection.readyState === 1,
    });
  });

  return stats;
}

/**
 * Check if a tenant database exists
 * @param {string} hospitalId - The hospital ObjectId
 * @returns {Promise<boolean>} True if database exists
 */
async function tenantDatabaseExists(hospitalId) {
  try {
    const connection = await getTenantConnection(hospitalId);
    const admin = connection.db.admin();
    const { databases } = await admin.listDatabases();
    const dbName = getTenantDatabaseName(hospitalId);
    return databases.some((db) => db.name === dbName);
  } catch (error) {
    console.error(
      `❌ Error checking tenant database existence for hospital ${hospitalId}:`,
      error,
    );
    return false;
  }
}

/**
 * Get or create the shared multi-tenant database connection (hms_shared).
 * All shared-tier hospitals use this single pool instead of per-tenant DBs.
 * @returns {Promise<mongoose.Connection>} Shared database connection
 */
async function getSharedConnection() {
  // Return existing healthy connection
  if (sharedConnection && sharedConnection.readyState === 1) {
    return sharedConnection;
  }

  const baseUri =
    process.env.MONGO_URI_TENANT_BASE || "mongodb://localhost:27017";
  const cleanBaseUri = baseUri.replace(/\/$/, "");
  const sharedUri = `${cleanBaseUri}/hms_shared?authSource=admin`;

  console.log("📡 Creating shared multi-tenant connection to hms_shared");

  sharedConnection = await mongoose.createConnection(sharedUri, {
    maxPoolSize: 20, // shared pool serves many tenants
    minPoolSize: 2,
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 5000,
  });

  sharedConnection.on("connected", () => {
    console.log("✅ Shared multi-tenant database connected: hms_shared");
  });

  sharedConnection.on("error", (err) => {
    console.error("❌ Shared multi-tenant database error:", err);
  });

  sharedConnection.on("disconnected", () => {
    console.warn("⚠️  Shared multi-tenant database disconnected: hms_shared");
    sharedConnection = null;
  });

  // Register tenant models on shared connection
  registerTenantModels(sharedConnection);

  return sharedConnection;
}

/**
 * Get master database connection
 * @returns {mongoose.Connection} Master database connection
 */
function getMasterConnection() {
  return mongoose.connection;
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("🛑 Received SIGINT, closing database connections...");
  await closeAllTenantConnections();
  if (sharedConnection) {
    await sharedConnection.close();
    console.log("✅ Shared multi-tenant connection closed");
  }
  if (masterConnection) {
    await mongoose.disconnect();
    console.log("✅ Master database connection closed");
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("🛑 Received SIGTERM, closing database connections...");
  await closeAllTenantConnections();
  if (sharedConnection) {
    await sharedConnection.close();
    console.log("✅ Shared multi-tenant connection closed");
  }
  if (masterConnection) {
    await mongoose.disconnect();
    console.log("✅ Master database connection closed");
  }
  process.exit(0);
});

module.exports = {
  initializeMasterDatabase,
  getTenantConnection,
  getSharedConnection,
  getTenantDatabaseName,
  closeTenantConnection,
  closeAllTenantConnections,
  getConnectionStats,
  tenantDatabaseExists,
  getMasterConnection,
};
