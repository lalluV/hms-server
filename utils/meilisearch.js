const { MeiliSearch } = require("meilisearch");
const PharmacyInventory = require("../models/PharmacyInventory");

const client = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "your-secret-key-here",
});

const index = client.index("pharmacy");

// Simple cache for search results (5 minutes TTL)
const searchCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Initialize Meilisearch
async function initializeMeilisearch() {
  try {
    console.log("🔍 Initializing Meilisearch...");
    const health = await client.health();
    console.log("✅ Meilisearch server is reachable");
    return true;
  } catch (error) {
    console.error("❌ Meilisearch initialization failed:", error.message);
    return false;
  }
}

// Search medicines
async function searchMedicines(query, limit = 10) {
  try {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    // Check cache first
    const cacheKey = `${cleanQuery}_${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`🔍 Cache hit for: "${cleanQuery}"`);
      return cached.results;
    }

    console.log(`🔍 Searching for: "${cleanQuery}" with limit: ${limit}`);

    const searchResults = await index.search(cleanQuery, {
      attributesToSearchOn: [
        "generic_name",
        "generic_name2",
        "manufacturer",
        "description",
        "item_code",
      ],
      limit: Math.min(limit, 50),
      // Performance optimizations
      attributesToRetrieve: ["id"], // Only get ID, not full document
      attributesToHighlight: ["generic_name", "description"],
      highlightPreTag: "<mark>",
      highlightPostTag: "</mark>",
    });

    console.log(`📊 Search results: ${searchResults.hits.length} hits found`);
    console.log(`📊 Total estimated hits: ${searchResults.estimatedTotalHits}`);

    // Get IDs from Meilisearch results
    const ids = searchResults.hits.map((hit) => hit.id);

    // Fetch full documents from MongoDB using IDs (optimized query)
    const fullDocuments = await PharmacyInventory.find({
      _id: { $in: ids },
    }).lean(); // Use lean() for better performance

    // Map back to original order and add search score
    const results = searchResults.hits.map((hit) => {
      const fullDoc = fullDocuments.find(
        (doc) => doc._id.toString() === hit.id
      );
      return {
        ...fullDoc,
        _score: hit._score,
        _highlights: hit._formatted || {},
      };
    });

    // Cache the results
    searchCache.set(cacheKey, {
      results,
      timestamp: Date.now(),
    });

    return results;
  } catch (error) {
    console.error("❌ Search error:", error.message);
    return [];
  }
}

// Index a single document (for create/update)
async function indexDocument(doc) {
  try {
    const document = {
      id: doc._id.toString(),
      item_code: doc.item_code,
      generic_name: doc.generic_name,
      generic_name2: doc.generic_name2,
      manufacturer: doc.manufacturer,
      description: doc.description,
    };

    await index.addDocuments([document]);
    console.log(`✅ Indexed document: ${doc.item_code}`);
    return true;
  } catch (error) {
    console.error("❌ Error indexing document:", error.message);
    return false;
  }
}

// Delete a document from index
async function deleteDocument(id) {
  try {
    await index.deleteDocument(id);
    console.log(`🗑️ Deleted document from index: ${id}`);
    return true;
  } catch (error) {
    console.error("❌ Error deleting document from index:", error.message);
    return false;
  }
}

// Index all data
async function indexAllData() {
  try {
    const totalCount = await PharmacyInventory.countDocuments({});
    console.log(`📝 Total documents: ${totalCount}`);

    const batchSize = 500; // Increased from 100 for better performance
    let indexedCount = 0;

    for (let skip = 0; skip < totalCount; skip += batchSize) {
      const items = await PharmacyInventory.find({})
        .skip(skip)
        .limit(batchSize)
        .lean(); // Use lean() for better performance

      const documents = items.map((item) => {
        return {
          id: item._id.toString(),
          item_code: item.item_code,
          generic_name: item.generic_name,
          generic_name2: item.generic_name2,
          manufacturer: item.manufacturer,
          description: item.description,
        };
      });

      await index.addDocuments(documents);
      indexedCount += documents.length;

      console.log(
        `📦 Batch ${Math.floor(skip / batchSize) + 1}: ${
          documents.length
        } indexed`
      );
      await new Promise((resolve) => setTimeout(resolve, 50)); // Reduced delay
    }

    return { success: true, indexed: indexedCount };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get index statistics
async function getIndexStats() {
  try {
    console.log("📊 Getting index stats...");
    const stats = await index.getStats();
    console.log("📊 Index stats:", stats);

    return {
      name: "pharmacy",
      documents: stats.numberOfDocuments,
      fields: stats.numberOfDocuments > 0 ? "indexed" : "empty",
    };
  } catch (error) {
    console.error("❌ Error getting index stats:", error.message);
    console.error("❌ Full error:", error);
    return null;
  }
}

module.exports = {
  client,
  initializeMeilisearch,
  searchMedicines,
  indexDocument,
  deleteDocument,
  indexAllData,
  getIndexStats,
};
