const { MeiliSearch } = require("meilisearch");

// Import master models
const MasterMedicine = require("../models/MasterMedicine");
const MasterDiagnostic = require("../models/MasterDiagnostic");
const MasterParameter = require("../models/MasterParameter");
const MasterLabItem = require("../models/MasterLabItem");

// Initialize Meilisearch client
const client = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "your-secret-key-here",
});

// Index instances for master data
const masterMedicinesIndex = client.index("master_medicines");
const masterDiagnosticsIndex = client.index("master_diagnostics");
const masterParametersIndex = client.index("master_parameters");
const masterLabItemsIndex = client.index("master_lab_items");

/**
 * Initialize all Meilisearch indices with proper configuration
 */
async function initializeMeilisearch() {
  try {
    console.log("🔍 Initializing Meilisearch for master data...");
    const health = await client.health();
    console.log("✅ Meilisearch server is reachable");

    // Configure Master Medicines index
    await masterMedicinesIndex.updateFilterableAttributes([
      "active",
      "type",
      "manufacturer",
    ]);
    await masterMedicinesIndex.updateSortableAttributes([
      "generic_name",
      "item_code",
      "createdAt",
    ]);
    console.log("✅ Master Medicines index configured");

    // Configure Master Diagnostics index
    await masterDiagnosticsIndex.updateFilterableAttributes([
      "active",
      "deptname",
      "subdeptname",
    ]);
    await masterDiagnosticsIndex.updateSortableAttributes([
      "name",
      "test_code",
      "createdAt",
    ]);
    console.log("✅ Master Diagnostics index configured");

    // Configure Master Parameters index
    await masterParametersIndex.updateFilterableAttributes([
      "active",
      "category",
    ]);
    await masterParametersIndex.updateSortableAttributes([
      "name",
      "parameter_code",
      "createdAt",
    ]);
    console.log("✅ Master Parameters index configured");

    // Configure Master Lab Items index
    await masterLabItemsIndex.updateFilterableAttributes([
      "active",
      "type",
      "category",
      "manufacturer",
    ]);
    await masterLabItemsIndex.updateSortableAttributes([
      "name",
      "item_code",
      "createdAt",
    ]);
    console.log("✅ Master Lab Items index configured");

    console.log("✅ All Meilisearch indices initialized successfully");
    return true;
  } catch (error) {
    console.error("❌ Meilisearch initialization failed:", error.message);
    return false;
  }
}

// ==================== MASTER MEDICINES ====================

/**
 * Index a single master medicine document
 */
async function indexMasterMedicine(medicine) {
  try {
    if (!medicine || !medicine._id) {
      console.error("❌ Invalid medicine document for indexing");
      return false;
    }

    const document = {
      id: medicine._id.toString(),
      item_code: medicine.item_code || "",
      generic_name: medicine.generic_name || "",
      generic_name2: medicine.generic_name2 || "",
      manufacturer: medicine.manufacturer || "",
      pack: medicine.pack || "",
      type: medicine.type || "",
      description: medicine.description || "",
      hsn_code: medicine.hsn_code || "",
      active: medicine.active !== undefined ? medicine.active : true,
    };

    await masterMedicinesIndex.addDocuments([document]);
    return true;
  } catch (error) {
    console.error("❌ Error indexing master medicine:", error.message);
    return false;
  }
}

/**
 * Delete a master medicine from index
 */
async function deleteMasterMedicine(id) {
  try {
    await masterMedicinesIndex.deleteDocument(id.toString());
    console.log(`🗑️ Deleted master medicine from index: ${id}`);
    return true;
  } catch (error) {
    console.error(
      "❌ Error deleting master medicine from index:",
      error.message
    );
    return false;
  }
}

/**
 * Search master medicines
 */
async function searchMasterMedicines(query, limit = 20, filters = {}) {
  try {
    const cleanQuery = query.trim();
    if (!cleanQuery || cleanQuery.length < 2) return [];

    const searchParams = {
      attributesToSearchOn: [
        "item_code",
        "generic_name",
        "generic_name2",
        "manufacturer",
        "description",
      ],
      limit: Math.min(limit, 50),
      attributesToRetrieve: [
        "id",
        "item_code",
        "generic_name",
        "generic_name2",
        "manufacturer",
        "pack",
        "type",
        "description",
        "hsn_code",
      ],
      attributesToHighlight: [],
      showRankingScore: false,
      showMatchesPosition: false,
      filter: [],
    };

    // Add filters
    if (filters.active !== undefined) {
      searchParams.filter.push(`active = ${filters.active}`);
    }
    if (filters.type) {
      searchParams.filter.push(`type = "${filters.type}"`);
    }
    if (filters.manufacturer) {
      searchParams.filter.push(`manufacturer = "${filters.manufacturer}"`);
    }

    const searchResults = await masterMedicinesIndex.search(
      cleanQuery,
      searchParams
    );
    return searchResults.hits || [];
  } catch (error) {
    console.error("❌ Error searching master medicines:", error.message);
    return [];
  }
}

/**
 * Index all master medicines
 */
async function indexAllMasterMedicines() {
  try {
    const totalCount = await MasterMedicine.countDocuments({});
    console.log(`📝 Total master medicines: ${totalCount}`);

    if (totalCount === 0) {
      return { success: true, indexed: 0 };
    }

    const batchSize = 1000;
    let skip = 0;
    let indexedCount = 0;

    while (skip < totalCount) {
      const medicines = await MasterMedicine.find({})
        .skip(skip)
        .limit(batchSize)
        .lean();

      if (medicines.length === 0) break;

      const documents = medicines.map((medicine) => ({
        id: medicine._id.toString(),
        item_code: medicine.item_code || "",
        generic_name: medicine.generic_name || "",
        generic_name2: medicine.generic_name2 || "",
        manufacturer: medicine.manufacturer || "",
        pack: medicine.pack || "",
        type: medicine.type || "",
        description: medicine.description || "",
        hsn_code: medicine.hsn_code || "",
        active: medicine.active !== undefined ? medicine.active : true,
      }));

      await masterMedicinesIndex.addDocuments(documents);
      indexedCount += documents.length;

      console.log(
        `📦 Master Medicines - Batch ${Math.floor(skip / batchSize) + 1}: ${
          documents.length
        } indexed`
      );
      skip += batchSize;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return { success: true, indexed: indexedCount };
  } catch (error) {
    console.error("❌ Error indexing all master medicines:", error.message);
    return { success: false, error: error.message };
  }
}

// ==================== MASTER DIAGNOSTICS ====================

/**
 * Index a single master diagnostic document
 */
async function indexMasterDiagnostic(diagnostic) {
  try {
    if (!diagnostic || !diagnostic._id) {
      console.error("❌ Invalid diagnostic document for indexing");
      return false;
    }

    const document = {
      id: diagnostic._id.toString(),
      test_code: diagnostic.test_code || "",
      name: diagnostic.name || "",
      deptname: diagnostic.deptname || "",
      subdeptname: diagnostic.subdeptname || "",
      description: diagnostic.description || "",
      default_fasting: diagnostic.default_fasting || "",
      default_reportsIn: diagnostic.default_reportsIn || "",
      active: diagnostic.active !== undefined ? diagnostic.active : true,
    };

    await masterDiagnosticsIndex.addDocuments([document]);
    return true;
  } catch (error) {
    console.error("❌ Error indexing master diagnostic:", error.message);
    return false;
  }
}

/**
 * Delete a master diagnostic from index
 */
async function deleteMasterDiagnostic(id) {
  try {
    await masterDiagnosticsIndex.deleteDocument(id.toString());
    console.log(`🗑️ Deleted master diagnostic from index: ${id}`);
    return true;
  } catch (error) {
    console.error(
      "❌ Error deleting master diagnostic from index:",
      error.message
    );
    return false;
  }
}

/**
 * Search master diagnostics
 */
async function searchMasterDiagnostics(query, limit = 20, filters = {}) {
  try {
    const cleanQuery = query.trim();
    if (!cleanQuery || cleanQuery.length < 2) return [];

    const searchParams = {
      attributesToSearchOn: [
        "test_code",
        "name",
        "description",
        "deptname",
        "subdeptname",
      ],
      limit: Math.min(limit, 50),
      attributesToRetrieve: [
        "id",
        "test_code",
        "name",
        "deptname",
        "subdeptname",
        "description",
        "default_fasting",
        "default_reportsIn",
      ],
      attributesToHighlight: [],
      showRankingScore: false,
      showMatchesPosition: false,
      filter: [],
    };

    // Add filters
    if (filters.active !== undefined) {
      searchParams.filter.push(`active = ${filters.active}`);
    }
    if (filters.deptname) {
      searchParams.filter.push(`deptname = "${filters.deptname}"`);
    }
    if (filters.subdeptname) {
      searchParams.filter.push(`subdeptname = "${filters.subdeptname}"`);
    }

    const searchResults = await masterDiagnosticsIndex.search(
      cleanQuery,
      searchParams
    );
    return searchResults.hits || [];
  } catch (error) {
    console.error("❌ Error searching master diagnostics:", error.message);
    return [];
  }
}

/**
 * Index all master diagnostics
 */
async function indexAllMasterDiagnostics() {
  try {
    const totalCount = await MasterDiagnostic.countDocuments({});
    console.log(`📝 Total master diagnostics: ${totalCount}`);

    if (totalCount === 0) {
      return { success: true, indexed: 0 };
    }

    const batchSize = 1000;
    let skip = 0;
    let indexedCount = 0;

    while (skip < totalCount) {
      const diagnostics = await MasterDiagnostic.find({})
        .skip(skip)
        .limit(batchSize)
        .lean();

      if (diagnostics.length === 0) break;

      const documents = diagnostics.map((diagnostic) => ({
        id: diagnostic._id.toString(),
        test_code: diagnostic.test_code || "",
        name: diagnostic.name || "",
        deptname: diagnostic.deptname || "",
        subdeptname: diagnostic.subdeptname || "",
        description: diagnostic.description || "",
        default_fasting: diagnostic.default_fasting || "",
        default_reportsIn: diagnostic.default_reportsIn || "",
        active: diagnostic.active !== undefined ? diagnostic.active : true,
      }));

      await masterDiagnosticsIndex.addDocuments(documents);
      indexedCount += documents.length;

      console.log(
        `📦 Master Diagnostics - Batch ${Math.floor(skip / batchSize) + 1}: ${
          documents.length
        } indexed`
      );
      skip += batchSize;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return { success: true, indexed: indexedCount };
  } catch (error) {
    console.error("❌ Error indexing all master diagnostics:", error.message);
    return { success: false, error: error.message };
  }
}

// ==================== MASTER PARAMETERS ====================

/**
 * Index a single master parameter document
 */
async function indexMasterParameter(parameter) {
  try {
    if (!parameter || !parameter._id) {
      console.error("❌ Invalid parameter document for indexing");
      return false;
    }

    const document = {
      id: parameter._id.toString(),
      parameter_code: parameter.parameter_code || "",
      name: parameter.name || "",
      units: parameter.units || "",
      category: parameter.category || "",
      default_normal_range: parameter.default_normal_range || {},
      default_critical_values: parameter.default_critical_values || {},
      active: parameter.active !== undefined ? parameter.active : true,
    };

    await masterParametersIndex.addDocuments([document]);
    return true;
  } catch (error) {
    console.error("❌ Error indexing master parameter:", error.message);
    return false;
  }
}

/**
 * Delete a master parameter from index
 */
async function deleteMasterParameter(id) {
  try {
    await masterParametersIndex.deleteDocument(id.toString());
    console.log(`🗑️ Deleted master parameter from index: ${id}`);
    return true;
  } catch (error) {
    console.error(
      "❌ Error deleting master parameter from index:",
      error.message
    );
    return false;
  }
}

/**
 * Search master parameters
 */
async function searchMasterParameters(query, limit = 20, filters = {}) {
  try {
    const cleanQuery = query.trim();
    if (!cleanQuery || cleanQuery.length < 2) return [];

    const searchParams = {
      attributesToSearchOn: ["parameter_code", "name", "units", "category"],
      limit: Math.min(limit, 50),
      attributesToRetrieve: [
        "id",
        "parameter_code",
        "name",
        "units",
        "category",
        "default_normal_range",
        "default_critical_values",
      ],
      attributesToHighlight: [],
      showRankingScore: false,
      showMatchesPosition: false,
      filter: [],
    };

    // Add filters
    if (filters.active !== undefined) {
      searchParams.filter.push(`active = ${filters.active}`);
    }
    if (filters.category) {
      searchParams.filter.push(`category = "${filters.category}"`);
    }

    const searchResults = await masterParametersIndex.search(
      cleanQuery,
      searchParams
    );
    return searchResults.hits || [];
  } catch (error) {
    console.error("❌ Error searching master parameters:", error.message);
    return [];
  }
}

/**
 * Index all master parameters
 */
async function indexAllMasterParameters() {
  try {
    const totalCount = await MasterParameter.countDocuments({});
    console.log(`📝 Total master parameters: ${totalCount}`);

    if (totalCount === 0) {
      return { success: true, indexed: 0 };
    }

    const batchSize = 1000;
    let skip = 0;
    let indexedCount = 0;

    while (skip < totalCount) {
      const parameters = await MasterParameter.find({})
        .skip(skip)
        .limit(batchSize)
        .lean();

      if (parameters.length === 0) break;

      const documents = parameters.map((parameter) => ({
        id: parameter._id.toString(),
        parameter_code: parameter.parameter_code || "",
        name: parameter.name || "",
        units: parameter.units || "",
        category: parameter.category || "",
        default_normal_range: parameter.default_normal_range || {},
        default_critical_values: parameter.default_critical_values || {},
        active: parameter.active !== undefined ? parameter.active : true,
      }));

      await masterParametersIndex.addDocuments(documents);
      indexedCount += documents.length;

      console.log(
        `📦 Master Parameters - Batch ${Math.floor(skip / batchSize) + 1}: ${
          documents.length
        } indexed`
      );
      skip += batchSize;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return { success: true, indexed: indexedCount };
  } catch (error) {
    console.error("❌ Error indexing all master parameters:", error.message);
    return { success: false, error: error.message };
  }
}

// ==================== MASTER LAB ITEMS ====================

/**
 * Index a single master lab item document
 */
async function indexMasterLabItem(item) {
  try {
    if (!item || !item._id) {
      console.error("❌ Invalid lab item document for indexing");
      return false;
    }

    const document = {
      id: item._id.toString(),
      item_code: item.item_code || "",
      name: item.name || "",
      category: item.category || "",
      manufacturer: item.manufacturer || "",
      type: item.type || "",
      unit: item.unit || "",
      description: item.description || "",
      hsn_code: item.hsn_code || "",
      active: item.active !== undefined ? item.active : true,
    };

    await masterLabItemsIndex.addDocuments([document]);
    return true;
  } catch (error) {
    console.error("❌ Error indexing master lab item:", error.message);
    return false;
  }
}

/**
 * Delete a master lab item from index
 */
async function deleteMasterLabItem(id) {
  try {
    await masterLabItemsIndex.deleteDocument(id.toString());
    console.log(`🗑️ Deleted master lab item from index: ${id}`);
    return true;
  } catch (error) {
    console.error(
      "❌ Error deleting master lab item from index:",
      error.message
    );
    return false;
  }
}

/**
 * Search master lab items
 */
async function searchMasterLabItems(query, limit = 20, filters = {}) {
  try {
    const cleanQuery = query.trim();
    if (!cleanQuery || cleanQuery.length < 2) return [];

    const searchParams = {
      attributesToSearchOn: [
        "item_code",
        "name",
        "description",
        "manufacturer",
        "category",
      ],
      limit: Math.min(limit, 50),
      attributesToRetrieve: [
        "id",
        "item_code",
        "name",
        "category",
        "manufacturer",
        "type",
        "unit",
        "description",
        "hsn_code",
      ],
      attributesToHighlight: [],
      showRankingScore: false,
      showMatchesPosition: false,
      filter: [],
    };

    // Add filters
    if (filters.active !== undefined) {
      searchParams.filter.push(`active = ${filters.active}`);
    }
    if (filters.type) {
      searchParams.filter.push(`type = "${filters.type}"`);
    }
    if (filters.category) {
      searchParams.filter.push(`category = "${filters.category}"`);
    }
    if (filters.manufacturer) {
      searchParams.filter.push(`manufacturer = "${filters.manufacturer}"`);
    }

    const searchResults = await masterLabItemsIndex.search(
      cleanQuery,
      searchParams
    );
    return searchResults.hits || [];
  } catch (error) {
    console.error("❌ Error searching master lab items:", error.message);
    return [];
  }
}

/**
 * Index all master lab items
 */
async function indexAllMasterLabItems() {
  try {
    const totalCount = await MasterLabItem.countDocuments({});
    console.log(`📝 Total master lab items: ${totalCount}`);

    if (totalCount === 0) {
      return { success: true, indexed: 0 };
    }

    const batchSize = 1000;
    let skip = 0;
    let indexedCount = 0;

    while (skip < totalCount) {
      const items = await MasterLabItem.find({})
        .skip(skip)
        .limit(batchSize)
        .lean();

      if (items.length === 0) break;

      const documents = items.map((item) => ({
        id: item._id.toString(),
        item_code: item.item_code || "",
        name: item.name || "",
        category: item.category || "",
        manufacturer: item.manufacturer || "",
        type: item.type || "",
        unit: item.unit || "",
        description: item.description || "",
        hsn_code: item.hsn_code || "",
        active: item.active !== undefined ? item.active : true,
      }));

      await masterLabItemsIndex.addDocuments(documents);
      indexedCount += documents.length;

      console.log(
        `📦 Master Lab Items - Batch ${Math.floor(skip / batchSize) + 1}: ${
          documents.length
        } indexed`
      );
      skip += batchSize;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return { success: true, indexed: indexedCount };
  } catch (error) {
    console.error("❌ Error indexing all master lab items:", error.message);
    return { success: false, error: error.message };
  }
}

// ==================== INDEX ALL MASTER DATA ====================

/**
 * Index all master data (medicines, diagnostics, parameters, lab items)
 */
async function indexAllMasterData() {
  try {
    console.log("🚀 Starting full index of all master data...");

    const results = {
      medicines: { success: false, indexed: 0 },
      diagnostics: { success: false, indexed: 0 },
      parameters: { success: false, indexed: 0 },
      labItems: { success: false, indexed: 0 },
    };

    // Index medicines
    console.log("📋 Indexing master medicines...");
    results.medicines = await indexAllMasterMedicines();

    // Index diagnostics
    console.log("📋 Indexing master diagnostics...");
    results.diagnostics = await indexAllMasterDiagnostics();

    // Index parameters
    console.log("📋 Indexing master parameters...");
    results.parameters = await indexAllMasterParameters();

    // Index lab items
    console.log("📋 Indexing master lab items...");
    results.labItems = await indexAllMasterLabItems();

    const totalIndexed =
      results.medicines.indexed +
      results.diagnostics.indexed +
      results.parameters.indexed +
      results.labItems.indexed;

    const allSuccess =
      results.medicines.success &&
      results.diagnostics.success &&
      results.parameters.success &&
      results.labItems.success;

    console.log(
      `✅ Master data indexing completed. Total indexed: ${totalIndexed}`
    );
    console.log(`   - Medicines: ${results.medicines.indexed}`);
    console.log(`   - Diagnostics: ${results.diagnostics.indexed}`);
    console.log(`   - Parameters: ${results.parameters.indexed}`);
    console.log(`   - Lab Items: ${results.labItems.indexed}`);

    return {
      success: allSuccess,
      totalIndexed,
      results,
    };
  } catch (error) {
    console.error("❌ Error indexing all master data:", error.message);
    return { success: false, error: error.message };
  }
}

// ==================== GET INDEX STATS ====================

/**
 * Get statistics for all master data indices
 */
async function getAllIndexStats() {
  try {
    const [medicinesStats, diagnosticsStats, parametersStats, labItemsStats] =
      await Promise.all([
        masterMedicinesIndex.getStats().catch(() => ({ numberOfDocuments: 0 })),
        masterDiagnosticsIndex
          .getStats()
          .catch(() => ({ numberOfDocuments: 0 })),
        masterParametersIndex
          .getStats()
          .catch(() => ({ numberOfDocuments: 0 })),
        masterLabItemsIndex.getStats().catch(() => ({ numberOfDocuments: 0 })),
      ]);

    return {
      master_medicines: {
        name: "master_medicines",
        documents: medicinesStats.numberOfDocuments || 0,
      },
      master_diagnostics: {
        name: "master_diagnostics",
        documents: diagnosticsStats.numberOfDocuments || 0,
      },
      master_parameters: {
        name: "master_parameters",
        documents: parametersStats.numberOfDocuments || 0,
      },
      master_lab_items: {
        name: "master_lab_items",
        documents: labItemsStats.numberOfDocuments || 0,
      },
    };
  } catch (error) {
    console.error("❌ Error getting index stats:", error.message);
    return null;
  }
}

module.exports = {
  client,
  initializeMeilisearch,
  indexAllMasterData,
  getAllIndexStats,
  // Master Medicines
  indexMasterMedicine,
  deleteMasterMedicine,
  searchMasterMedicines,
  indexAllMasterMedicines,
  // Master Diagnostics
  indexMasterDiagnostic,
  deleteMasterDiagnostic,
  searchMasterDiagnostics,
  indexAllMasterDiagnostics,
  // Master Parameters
  indexMasterParameter,
  deleteMasterParameter,
  searchMasterParameters,
  indexAllMasterParameters,
  // Master Lab Items
  indexMasterLabItem,
  deleteMasterLabItem,
  searchMasterLabItems,
  indexAllMasterLabItems,
};
