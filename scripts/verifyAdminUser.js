const mongoose = require("mongoose");
const AdminUser = require("../models/AdminUser");
require("dotenv").config({ path: "./.env" });

async function verifyAdminUser() {
  try {
    console.log("\n============================================================");
    console.log("HMS Admin User Verification");
    console.log("============================================================\n");

    console.log("📡 Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI_SHARED, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB\n");

    // Find all admin users
    const admins = await AdminUser.find({}).select("-password");
    
    if (admins.length === 0) {
      console.log("❌ No admin users found in database!");
      console.log("\n💡 To create an admin user, run:");
      console.log("   node scripts/createAdminUser.js\n");
    } else {
      console.log(`✅ Found ${admins.length} admin user(s):\n`);
      
      admins.forEach((admin, index) => {
        console.log(`${index + 1}. Admin User:`);
        console.log(`   ID:       ${admin._id}`);
        console.log(`   Username: ${admin.username}`);
        console.log(`   Email:    ${admin.email}`);
        console.log(`   Role:     ${admin.role}`);
        console.log(`   Created:  ${admin.createdAt}`);
        console.log();
      });

      console.log("============================================================");
      console.log("✅ Admin users verified successfully");
      console.log("============================================================\n");
      
      console.log("🔐 Login Credentials:");
      console.log(`   Email:    ${admins[0].email}`);
      console.log(`   Password: (the password you set during creation)`);
      console.log("\n🌐 Login URL:");
      console.log("   http://localhost:5173 or http://localhost:5174\n");
      console.log("============================================================\n");
    }

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error("\n💡 Make sure:");
    console.error("   1. MongoDB is running");
    console.error("   2. MONGO_URI_SHARED is set in .env file");
    console.error("   3. You have network access to MongoDB\n");
    process.exit(1);
  }
}

verifyAdminUser();

