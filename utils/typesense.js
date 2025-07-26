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
  connectionTimeoutSeconds: 5,
  retryIntervalSeconds: 0.1,
  numRetries: 3,
});

// Collection schema for pharmacy inventory
const pharmacyCollectionSchema = {
  name: "pharmacy_inventory",
  fields: [
    { name: "id", type: "string" },
    { name: "item_code", type: "string" },
    { name: "name", type: "string" },
    { name: "generic_name", type: "string" },
    { name: "generic_name2", type: "string" },
    { name: "manufacturer", type: "string" },
    { name: "description", type: "string" },
    { name: "category", type: "string" },
    { name: "status", type: "string" },
    { name: "quantity", type: "int32" },
    { name: "price", type: "float" },
    { name: "orderingNumber", type: "int32" },
    // Add all other fields from your schema
    { name: "hsn_code", type: "string" },
    { name: "batch_number", type: "string" },
    { name: "expiry_date", type: "string" },
    { name: "pack_size", type: "string" },
    { name: "sale_rate", type: "float" },
    { name: "purchase_rate", type: "float" },
    { name: "mrp", type: "float" },
    { name: "cgst", type: "float" },
    { name: "sgst", type: "float" },
    { name: "igst", type: "float" },
    { name: "searchable_text", type: "string" }, // Combined searchable text
  ],
  default_sorting_field: "orderingNumber",
};

// Initialize Typesense collection
async function initializeTypesense() {
  try {
    console.log("🔍 Checking Typesense connection...");

    // Test connection first
    await client.health.retrieve();
    console.log("✅ Typesense server is reachable");

    // Check if collection exists
    const collections = await client.collections().retrieve();
    const collectionExists = collections.find(
      (col) => col.name === "pharmacy_inventory"
    );

    if (!collectionExists) {
      console.log("📦 Creating Typesense collection...");
      await client.collections().create(pharmacyCollectionSchema);
      console.log("✅ Typesense collection created successfully");

      // Index all existing data
      await indexAllData();
    } else {
      console.log("✅ Typesense collection already exists");
      // Check if collection has data, if not, reindex
      const stats = await client.collections("pharmacy_inventory").retrieve();
      if (stats.num_documents === 0) {
        console.log("📝 Collection is empty, indexing data...");
        await indexAllData();
      }
    }
  } catch (error) {
    console.error("❌ Error initializing Typesense:", error.message);
    // Don't throw error, let the app continue without search
    console.log("⚠️  Search functionality will be disabled");
  }
}

// Index all pharmacy inventory data
async function indexAllData() {
  try {
    console.log("📊 Indexing all pharmacy inventory data...");
    const allItems = await PharmacyInventory.find({});

    if (allItems.length === 0) {
      console.log("⚠️  No pharmacy inventory data found to index");
      return;
    }

    console.log(`📝 Processing ${allItems.length} items...`);

    const documents = allItems.map((item) => {
      const doc = item.toObject();
      // Create a combined searchable text field
      const searchableText = [
        doc.name || "",
        doc.generic_name || "",
        doc.generic_name2 || "",
        doc.manufacturer || "",
        doc.description || "",
        doc.hsn_code || "",
        doc.batch_number || "",
        doc.pack_size || "",
        doc.category || "",
        doc.status || "",
      ]
        .filter(Boolean)
        .join(" ");

      return {
        id: doc._id.toString(),
        ...doc,
        searchable_text: searchableText,
      };
    });

    // Index documents in batches
    const batchSize = 100;
    let indexedCount = 0;

    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const results = await client
        .collections("pharmacy_inventory")
        .documents()
        .import(batch);

      // Count successful imports
      const successCount = results.filter((result) => !result.error).length;
      indexedCount += successCount;

      if (i + batchSize < documents.length) {
        console.log(`📦 Indexed ${indexedCount}/${documents.length} items...`);
      }
    }

    console.log(`✅ Successfully indexed ${indexedCount} documents`);
  } catch (error) {
    console.error("❌ Error indexing data:", error.message);
  }
}

// Search function with fuzzy matching
async function searchMedicines(query, limit = 10) {
  try {
    // Clean and validate query
    const cleanQuery = query.trim();
    if (!cleanQuery || cleanQuery.length < 1) {
      return [];
    }

    const searchParameters = {
      q: cleanQuery,
      query_by:
        "name,generic_name,generic_name2,manufacturer,description,searchable_text",
      sort_by: "orderingNumber:desc",
      per_page: Math.min(limit, 50), // Cap at 50 results
      num_typos: 2, // Allow 2 typos for fuzzy matching
      prefix: true, // Enable prefix matching
      filter_by: "quantity:>0", // Only show items with stock
      group_by: "name",
      group_limit: 1,
      highlight_full_fields: "name,generic_name,manufacturer",
    };

    const searchResults = await client
      .collections("pharmacy_inventory")
      .documents()
      .search(searchParameters);

    return searchResults.hits.map((hit) => ({
      ...hit.document,
      score: hit.text_match,
      highlights: hit.highlights || [],
    }));
  } catch (error) {
    console.error("❌ Search error:", error.message);
    // Return empty results instead of throwing error
    return [];
  }
}

// Add or update a single document
async function indexDocument(doc) {
  try {
    const searchableText = [
      doc.name || "",
      doc.generic_name || "",
      doc.generic_name2 || "",
      doc.manufacturer || "",
      doc.description || "",
      doc.hsn_code || "",
      doc.batch_number || "",
      doc.pack_size || "",
      doc.category || "",
      doc.status || "",
    ]
      .filter(Boolean)
      .join(" ");

    const document = {
      id: doc._id.toString(),
      ...doc,
      searchable_text: searchableText,
    };

    await client.collections("pharmacy_inventory").documents().upsert(document);
  } catch (error) {
    console.error("❌ Error indexing document:", error.message);
    // Don't throw error, just log it
  }
}

// Delete a document from index
async function deleteDocument(id) {
  try {
    await client.collections("pharmacy_inventory").documents(id).delete();
  } catch (error) {
    console.error("❌ Error deleting document:", error.message);
    // Don't throw error, just log it
  }
}

module.exports = {
  client,
  initializeTypesense,
  searchMedicines,
  indexDocument,
  deleteDocument,
  indexAllData,
};
