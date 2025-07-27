const { MeiliSearch } = require("meilisearch");
const PharmacyInventory = require("../models/PharmacyInventory");

const client = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: "ts_live_XY9v2@Qf38nLzr7WcD5MtaE1",
});

const index = client.index("pharmacy");

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
    });

    console.log(`📊 Search results: ${searchResults.hits.length} hits found`);
    console.log(`📊 Total estimated hits: ${searchResults.estimatedTotalHits}`);

    return searchResults.hits.map((hit) => ({
      ...hit,
      score: hit._score,
    }));
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

    const batchSize = 100;
    let indexedCount = 0;

    for (let skip = 0; skip < totalCount; skip += batchSize) {
      const items = await PharmacyInventory.find({})
        .skip(skip)
        .limit(batchSize);

      const documents = items.map((item) => {
        const doc = item.toObject();
        return {
          id: doc._id.toString(),
          item_code: doc.item_code,
          generic_name: doc.generic_name,
          generic_name2: doc.generic_name2,
          manufacturer: doc.manufacturer,
          description: doc.description,
        };
      });

      await index.addDocuments(documents);
      indexedCount += documents.length;

      console.log(
        `📦 Batch ${Math.floor(skip / batchSize) + 1}: ${
          documents.length
        } indexed`
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
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
