const Typesense = require("typesense");
const PharmacyInventory = require("../models/PharmacyInventory");

// Typesense client configuration
const client = new Typesense.Client({
  nodes: [
    {
      host: process.env.TYPESENSE_HOST || "localhost",
      port: process.env.TYPESENSE_PORT || "8108",
      protocol: process.env.TYPESENSE_PROTOCOL || "http",
    },
  ],
  apiKey: process.env.TYPESENSE_API_KEY || "xyz",
  connectionTimeoutSeconds: 10,
  retryIntervalSeconds: 0.1,
  numRetries: 3,
});

// Simple collection schema
const collectionSchema = {
  name: "pharmacyinventory",
  fields: [
    { name: "id", type: "string" },
    { name: "item_code", type: "string" },
    { name: "generic_name", type: "string" },
    { name: "generic_name2", type: "string" },
    { name: "manufacturer", type: "string" },
    { name: "description", type: "string" },
    { name: "searchable_text", type: "string" },
  ],
};

// Initialize Typesense
async function initializeTypesense() {
  try {
    console.log("🔍 Initializing Typesense...");

    // Test connection
    await client.health.retrieve();
    console.log("✅ Typesense server is reachable");

    // Check if collection exists
    const collections = await client.collections().retrieve();
    const collectionExists = collections.find(
      (col) => col.name === "pharmacyinventory"
    );

    if (!collectionExists) {
      console.log("📦 Creating collection...");
      await client.collections().create(collectionSchema);
      console.log("✅ Collection created successfully");
    } else {
      console.log("✅ Collection already exists");
    }

    return true;
  } catch (error) {
    console.error("❌ Typesense initialization failed:", error.message);
    return false;
  }
}

// Index a single document
async function indexDocument(doc) {
  try {
    const searchableText = [
      doc.generic_name || "",
      doc.generic_name2 || "",
      doc.manufacturer || "",
      doc.description || "",
      doc.item_code || "",
    ]
      .filter(Boolean)
      .join(" ");

    const document = {
      id: doc._id.toString(),
      item_code: doc.item_code,
      generic_name: doc.generic_name,
      generic_name2: doc.generic_name2,
      manufacturer: doc.manufacturer,
      description: doc.description,
      searchable_text: searchableText,
    };

    await client.collections("pharmacyinventory").documents().upsert(document);
    return true;
  } catch (error) {
    console.error("❌ Error indexing document:", error.message);
    return false;
  }
}

// Search medicines
async function searchMedicines(query, limit = 10) {
  try {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const searchParameters = {
      q: cleanQuery,
      query_by:
        "generic_name,generic_name2,manufacturer,description,item_code,searchable_text",
      per_page: Math.min(limit, 50),
      num_typos: 2,
      prefix: true,
    };

    console.log("🔍 Searching with parameters:", searchParameters);

    const searchResults = await client
      .collections("pharmacyinventory")
      .documents()
      .search(searchParameters);

    console.log("📊 Search results:", searchResults.hits.length, "hits");

    return searchResults.hits.map((hit) => ({
      ...hit.document,
      score: hit.text_match,
    }));
  } catch (error) {
    console.error("❌ Search error:", error.message);
    return [];
  }
}

// Index all data in small batches
async function indexAllData() {
  try {
    console.log("📊 Starting data indexing...");

    const totalCount = await PharmacyInventory.countDocuments({});
    console.log(`📝 Total documents: ${totalCount}`);

    if (totalCount === 0) {
      console.log("⚠️ No data to index");
      return { success: true, indexed: 0 };
    }

    const batchSize = 100;
    let indexedCount = 0;
    let errorCount = 0;

    for (let skip = 0; skip < totalCount; skip += batchSize) {
      try {
        const items = await PharmacyInventory.find({})
          .skip(skip)
          .limit(batchSize);

        const documents = items.map((item) => {
          const doc = item.toObject();
          const searchableText = [
            doc.generic_name || "",
            doc.generic_name2 || "",
            doc.manufacturer || "",
            doc.description || "",
            doc.item_code || "",
          ]
            .filter(Boolean)
            .join(" ");

          return {
            id: doc._id.toString(),
            item_code: doc.item_code,
            generic_name: doc.generic_name,
            generic_name2: doc.generic_name2,
            manufacturer: doc.manufacturer,
            description: doc.description,
            searchable_text: searchableText,
          };
        });

        const results = await client
          .collections("pharmacyinventory")
          .documents()
          .import(documents);
        const successCount = results.filter((result) => !result.error).length;

        indexedCount += successCount;
        errorCount += results.length - successCount;

        console.log(
          `📦 Batch ${
            Math.floor(skip / batchSize) + 1
          }: ${successCount} indexed`
        );

        // Small delay
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (error) {
        console.error(`❌ Batch error:`, error.message);
        errorCount += batchSize;
      }
    }

    console.log(
      `✅ Indexing completed: ${indexedCount} success, ${errorCount} errors`
    );
    return { success: true, indexed: indexedCount, errors: errorCount };
  } catch (error) {
    console.error("❌ Indexing failed:", error.message);
    return { success: false, error: error.message };
  }
}

// Delete document
async function deleteDocument(id) {
  try {
    await client.collections("pharmacyinventory").documents(id).delete();
    return true;
  } catch (error) {
    console.error("❌ Error deleting document:", error.message);
    return false;
  }
}

// Get collection stats
async function getCollectionStats() {
  try {
    const collection = await client.collections("pharmacyinventory").retrieve();
    return {
      name: collection.name,
      documents: collection.num_documents,
      fields: collection.num_documents > 0 ? "indexed" : "empty",
    };
  } catch (error) {
    console.error("❌ Error getting collection stats:", error.message);
    return null;
  }
}

module.exports = {
  client,
  initializeTypesense,
  searchMedicines,
  indexDocument,
  deleteDocument,
  indexAllData,
  getCollectionStats,
};
