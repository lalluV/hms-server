/**
 * Migration Script: Convert existing PharmacyInventory to use MasterMedicines
 * 
 * This script:
 * 1. Extracts unique medicines from PharmacyInventory
 * 2. Creates MasterMedicine records
 * 3. Links existing PharmacyInventory records to MasterMedicines
 * 
 * Run: node scripts/migrateToMasterMedicines.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const MasterMedicine = require('../models/MasterMedicine');
const PharmacyInventory = require('../models/PharmacyInventory');

const MONGO_URI = process.env.MONGO_URI;

async function migrate() {
  try {
    console.log('🔄 Starting migration to Master Medicines...\n');

    // Connect to MongoDB
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB\n');

    // Step 1: Get all pharmacy inventory items
    const allInventory = await PharmacyInventory.find({});
    console.log(`📦 Found ${allInventory.length} pharmacy inventory items\n`);

    if (allInventory.length === 0) {
      console.log('✅ No inventory items to migrate');
      await mongoose.disconnect();
      return;
    }

    // Step 2: Extract unique medicines
    const medicineMap = new Map();
    
    for (const item of allInventory) {
      // Create a unique key based on medicine properties
      const key = `${item.item_code || ''}_${item.generic_name || ''}_${item.manufacturer || ''}_${item.pack || ''}`.toLowerCase();
      
      if (!medicineMap.has(key)) {
        medicineMap.set(key, {
          item_code: item.item_code,
          generic_name: item.generic_name,
          generic_name2: item.generic_name2,
          pack: item.pack,
          manufacturer: item.manufacturer,
          type: item.type,
          description: item.description,
          hsn_code: item.hsn_code,
          active: item.active !== false, // Default to true
          inventoryItems: [],
        });
      }
      
      medicineMap.get(key).inventoryItems.push(item._id);
    }

    console.log(`🔍 Found ${medicineMap.size} unique medicines\n`);

    // Step 3: Create MasterMedicine records
    const masterMedicinesMap = new Map();
    let created = 0;
    let skipped = 0;

    for (const [key, medicineData] of medicineMap.entries()) {
      // Check if master medicine already exists
      let masterMedicine = await MasterMedicine.findOne({
        item_code: medicineData.item_code,
      });

      if (!masterMedicine) {
        // Create new master medicine
        try {
          masterMedicine = new MasterMedicine({
            item_code: medicineData.item_code,
            generic_name: medicineData.generic_name,
            generic_name2: medicineData.generic_name2,
            pack: medicineData.pack,
            manufacturer: medicineData.manufacturer,
            type: medicineData.type || 'Tablet',
            description: medicineData.description,
            hsn_code: medicineData.hsn_code,
            active: medicineData.active,
          });

          await masterMedicine.save();
          created++;
          console.log(`✅ Created master medicine: ${medicineData.generic_name} (${medicineData.item_code})`);
        } catch (error) {
          if (error.code === 11000) {
            // Duplicate item_code, try to find existing
            masterMedicine = await MasterMedicine.findOne({
              item_code: medicineData.item_code,
            });
            skipped++;
            console.log(`⚠️  Skipped duplicate: ${medicineData.item_code}`);
          } else {
            console.error(`❌ Error creating master medicine ${medicineData.item_code}:`, error.message);
            continue;
          }
        }
      } else {
        skipped++;
        console.log(`ℹ️  Master medicine already exists: ${medicineData.item_code}`);
      }

      if (masterMedicine) {
        masterMedicinesMap.set(key, masterMedicine._id);
      }
    }

    console.log(`\n📊 Master Medicines: ${created} created, ${skipped} already existed\n`);

    // Step 4: Link PharmacyInventory to MasterMedicines
    let linked = 0;
    let failed = 0;

    for (const [key, medicineData] of medicineMap.entries()) {
      const masterMedicineId = masterMedicinesMap.get(key);
      
      if (!masterMedicineId) {
        console.log(`⚠️  No master medicine ID for key: ${key}`);
        continue;
      }

      for (const inventoryId of medicineData.inventoryItems) {
        try {
          await PharmacyInventory.findByIdAndUpdate(inventoryId, {
            $set: {
              medicineId: masterMedicineId,
            },
          });
          linked++;
        } catch (error) {
          console.error(`❌ Error linking inventory ${inventoryId}:`, error.message);
          failed++;
        }
      }
    }

    console.log(`\n📊 Inventory Linking: ${linked} linked, ${failed} failed\n`);

    // Step 5: Summary
    const totalMasterMedicines = await MasterMedicine.countDocuments({});
    const totalWithLinks = await PharmacyInventory.countDocuments({
      medicineId: { $exists: true, $ne: null },
    });

    console.log('📈 Migration Summary:');
    console.log(`   - Total Master Medicines: ${totalMasterMedicines}`);
    console.log(`   - Inventory items with links: ${totalWithLinks} / ${allInventory.length}`);
    console.log(`   - Coverage: ${((totalWithLinks / allInventory.length) * 100).toFixed(2)}%\n`);

    console.log('✅ Migration completed successfully!\n');

    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Migration failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run migration
if (require.main === module) {
  migrate();
}

module.exports = migrate;

