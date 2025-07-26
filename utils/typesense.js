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
  name: "pharmacyinventory",
  fields: [
    { name: "id", type: "string" },
    { name: "item_code", type: "string" },
    { name: "generic_name", type: "string" },
    { name: "generic_name2", type: "string" },
    { name: "pack", type: "string" },
    { name: "manufacturer", type: "string" },
    { name: "default_mrp", type: "float" },
    { name: "default_rate", type: "float" },
    { name: "type", type: "string" },
    { name: "description", type: "string" },
    { name: "active", type: "bool" },
    { name: "orderingNumber", type: "int32" },
    { name: "createdAt", type: "string" },
    { name: "updatedAt", type: "string" },
    { name: "searchable_text", type: "string" }, // Combined searchable text
  ],
  default_sorting_field: "orderingNumber",
  strict: false, // Allow additional fields to be indexed
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
      (col) => col.name === "pharmacyinventory"
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
      const stats = await client.collections("pharmacyinventory").retrieve();
      if (stats.num_documents === 0) {
        console.log("📝 Collection is empty, indexing data...");
        await indexAllData();
      } else {
        console.log(`📊 Collection has ${stats.num_documents} documents`);
      }
    }
  } catch (error) {
    console.error("❌ Error initializing Typesense:", error.message);
    // Don't throw error, let the app continue without search
    console.log("⚠️  Search functionality will be disabled");
  }
}

// Force recreate collection with new schema
async function recreateCollection() {
  try {
    console.log("🔄 Recreating Typesense collection...");

    // Delete existing collection if it exists
    const collections = await client.collections().retrieve();
    const collectionExists = collections.find(
      (col) => col.name === "pharmacyinventory"
    );

    if (collectionExists) {
      await client.collections("pharmacyinventory").delete();
      console.log("🗑️  Deleted existing collection");
    }

    // Create new collection with updated schema
    await client.collections().create(pharmacyCollectionSchema);
    console.log("✅ Created new collection with updated schema");

    // Index all data
    await indexAllData();

    console.log("✅ Collection recreated and indexed successfully");
  } catch (error) {
    console.error("❌ Error recreating collection:", error.message);
  }
}

// Index all pharmacy inventory data
async function indexAllData() {
  try {
    console.log("📊 Indexing all pharmacy inventory data...");

    // First, let's check what collections exist in MongoDB
    const collections = await PharmacyInventory.db.listCollections().toArray();
    console.log(
      "📋 Available MongoDB collections:",
      collections.map((c) => c.name)
    );

    // Check total count in the collection
    const totalCount = await PharmacyInventory.countDocuments({});
    console.log(
      `📊 Total documents in pharmacyinventory collection: ${totalCount}`
    );

    const allItems = await PharmacyInventory.find({}).limit(5);
    console.log(`📝 Sample items found: ${allItems.length}`);

    if (allItems.length > 0) {
      console.log(
        "🔍 Sample item structure:",
        JSON.stringify(allItems[0], null, 2)
      );
    }

    if (totalCount === 0) {
      console.log("⚠️  No pharmacy inventory data found to index");
      return;
    }

    console.log(`📝 Processing ${totalCount} items...`);

    // Get all items
    const allItemsFull = await PharmacyInventory.find({});
    console.log(`📝 Retrieved ${allItemsFull.length} items from database`);

    const documents = allItemsFull.map((item) => {
      const doc = item.toObject();

      // Get the first batch for flattening
      const firstBatch =
        doc.batches && doc.batches.length > 0 ? doc.batches[0] : {};

      // Create a combined searchable text field
      const searchableText = [
        doc.generic_name || "",
        doc.generic_name2 || "",
        doc.manufacturer || "",
        doc.description || "",
        doc.pack || "",
        doc.type || "",
        firstBatch.batch_no || "",
        firstBatch.pack_size || "",
      ]
        .filter(Boolean)
        .join(" ");

      return {
        id: doc._id.toString(),
        item_code: doc.item_code,
        generic_name: doc.generic_name,
        generic_name2: doc.generic_name2,
        pack: doc.pack,
        manufacturer: doc.manufacturer,
        default_mrp: doc.default_mrp,
        default_rate: doc.default_rate,
        type: doc.type,
        description: doc.description,
        active: doc.active,
        orderingNumber: doc.orderingNumber,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        // Flatten first batch data
        batch_no: firstBatch.batch_no,
        quantity: firstBatch.quantity,
        expiry_date: firstBatch.expiry_date,
        pack_size: firstBatch.pack_size,
        purchase_price: firstBatch.purchase_price,
        mrp: firstBatch.mrp,
        searchable_text: searchableText,
      };
    });

    // Index documents in batches
    const batchSize = 100;
    let indexedCount = 0;

    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const results = await client
        .collections("pharmacyinventory")
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
        "generic_name,generic_name2,manufacturer,description,pack,type,searchable_text",
      sort_by: "orderingNumber:desc",
      per_page: Math.min(limit, 50), // Cap at 50 results
      num_typos: 2, // Allow 2 typos for fuzzy matching
      prefix: true, // Enable prefix matching
      filter_by: "quantity:>0", // Only show items with stock
      group_by: "generic_name",
      group_limit: 1,
      highlight_full_fields: "generic_name,manufacturer,description",
    };

    const searchResults = await client
      .collections("pharmacyinventory")
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
    // Get the first batch for flattening
    const firstBatch =
      doc.batches && doc.batches.length > 0 ? doc.batches[0] : {};

    const searchableText = [
      doc.generic_name || "",
      doc.generic_name2 || "",
      doc.manufacturer || "",
      doc.description || "",
      doc.pack || "",
      doc.type || "",
      firstBatch.batch_no || "",
      firstBatch.pack_size || "",
    ]
      .filter(Boolean)
      .join(" ");

    const document = {
      id: doc._id.toString(),
      item_code: doc.item_code,
      generic_name: doc.generic_name,
      generic_name2: doc.generic_name2,
      pack: doc.pack,
      manufacturer: doc.manufacturer,
      default_mrp: doc.default_mrp,
      default_rate: doc.default_rate,
      type: doc.type,
      description: doc.description,
      active: doc.active,
      orderingNumber: doc.orderingNumber,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      // Flatten first batch data
      batch_no: firstBatch.batch_no,
      quantity: firstBatch.quantity,
      expiry_date: firstBatch.expiry_date,
      pack_size: firstBatch.pack_size,
      purchase_price: firstBatch.purchase_price,
      mrp: firstBatch.mrp,
      searchable_text: searchableText,
    };

    await client.collections("pharmacyinventory").documents().upsert(document);
  } catch (error) {
    console.error("❌ Error indexing document:", error.message);
    // Don't throw error, just log it
  }
}

// Delete a document from index
async function deleteDocument(id) {
  try {
    await client.collections("pharmacyinventory").documents(id).delete();
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
  recreateCollection,
};
