const mongoose = require("mongoose");
const { getConnectionStats } = require("./tenantDb");

/**
 * Database Health Monitoring Utility
 */

/**
 * Check master database health
 */
function checkMasterDbHealth() {
  const connection = mongoose.connection;
  
  return {
    connected: connection.readyState === 1,
    readyState: connection.readyState,
    readyStateLabel: getReadyStateLabel(connection.readyState),
    host: connection.host,
    port: connection.port,
    name: connection.name,
  };
}

/**
 * Get human-readable label for connection ready state
 */
function getReadyStateLabel(readyState) {
  const labels = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };
  return labels[readyState] || "unknown";
}

/**
 * Get overall database health
 */
async function getDatabaseHealth() {
  try {
    const masterHealth = checkMasterDbHealth();
    const tenantStats = getConnectionStats();

    const health = {
      timestamp: new Date().toISOString(),
      master: masterHealth,
      tenants: tenantStats,
      overall: {
        healthy: masterHealth.connected,
        activeTenants: tenantStats.activeTenants,
      },
    };

    // Check if all tenant connections are healthy
    health.overall.tenantHealthy = tenantStats.tenants.every((t) => t.connected);

    return health;
  } catch (error) {
    console.error("Error getting database health:", error);
    return {
      timestamp: new Date().toISOString(),
      error: error.message,
      overall: {
        healthy: false,
      },
    };
  }
}

/**
 * Monitor database connections
 * Logs health status at regular intervals
 */
function startHealthMonitoring(intervalMs = 60000) {
  console.log(`🏥 Starting database health monitoring (interval: ${intervalMs}ms)`);

  setInterval(async () => {
    const health = await getDatabaseHealth();
    
    if (!health.overall.healthy) {
      console.error("❌ Database health check failed:", JSON.stringify(health, null, 2));
    } else {
      console.log(`✅ Database healthy - Master: ${health.master.readyStateLabel}, Active Tenants: ${health.overall.activeTenants}`);
    }
  }, intervalMs);
}

/**
 * Get performance metrics
 */
async function getPerformanceMetrics() {
  try {
    const masterConnection = mongoose.connection;
    
    // Get admin stats for master DB
    const admin = masterConnection.db.admin();
    const serverStatus = await admin.serverStatus();

    return {
      timestamp: new Date().toISOString(),
      connections: {
        current: serverStatus.connections.current,
        available: serverStatus.connections.available,
        totalCreated: serverStatus.connections.totalCreated,
      },
      network: {
        bytesIn: serverStatus.network.bytesIn,
        bytesOut: serverStatus.network.bytesOut,
        numRequests: serverStatus.network.numRequests,
      },
      opcounters: serverStatus.opcounters,
      uptime: serverStatus.uptime,
    };
  } catch (error) {
    console.error("Error getting performance metrics:", error);
    return {
      error: error.message,
    };
  }
}

/**
 * Alert on database issues
 */
function setupAlerts(options = {}) {
  const {
    onConnectionLost = () => {},
    onConnectionRestored = () => {},
    onError = () => {},
  } = options;

  const connection = mongoose.connection;

  connection.on("disconnected", () => {
    console.error("❌ Master database disconnected");
    onConnectionLost();
  });

  connection.on("reconnected", () => {
    console.log("✅ Master database reconnected");
    onConnectionRestored();
  });

  connection.on("error", (err) => {
    console.error("❌ Master database error:", err);
    onError(err);
  });

  console.log("🚨 Database alerts configured");
}

module.exports = {
  checkMasterDbHealth,
  getDatabaseHealth,
  startHealthMonitoring,
  getPerformanceMetrics,
  setupAlerts,
  getReadyStateLabel,
};

