/**
 * Script to create a Super Admin user for HMS Admin Panel
 * Run: node scripts/createAdminUser.js
 */

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const readline = require("readline");
require("dotenv").config();

const AdminUser = require("../models/AdminUser");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function createAdminUser() {
  try {
    console.log("\n" + "=".repeat(60));
    console.log("HMS Admin User Creation");
    console.log("=".repeat(60) + "\n");

    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI_SHARED || process.env.MONGO_URI;
    if (!mongoUri) {
      console.error("❌ MONGO_URI not found in .env file");
      process.exit(1);
    }

    console.log("📡 Connecting to MongoDB...");
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB\n");

    // Get user input
    const username = await question("Enter username: ");
    const email = await question("Enter email: ");
    const password = await question("Enter password (min 8 chars): ");
    const confirmPassword = await question("Confirm password: ");

    // Validate input
    if (!username || !email || !password) {
      console.error("\n❌ All fields are required");
      process.exit(1);
    }

    if (password.length < 8) {
      console.error("\n❌ Password must be at least 8 characters");
      process.exit(1);
    }

    if (password !== confirmPassword) {
      console.error("\n❌ Passwords do not match");
      process.exit(1);
    }

    // Check if admin already exists
    const existingAdmin = await AdminUser.findOne({ email });
    if (existingAdmin) {
      console.error(`\n❌ Admin with email ${email} already exists`);
      const overwrite = await question("Overwrite? (yes/no): ");
      if (overwrite.toLowerCase() !== "yes") {
        console.log("Cancelled.");
        process.exit(0);
      }
      await AdminUser.deleteOne({ email });
    }

    // Hash password
    console.log("\n🔐 Hashing password...");
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create admin user
    console.log("👤 Creating admin user...");
    const admin = new AdminUser({
      username,
      email,
      password: hashedPassword,
      role: "SuperAdmin",
    });

    await admin.save();

    console.log("\n" + "=".repeat(60));
    console.log("✅ SUCCESS! Super Admin created");
    console.log("=".repeat(60));
    console.log("\nLogin Credentials:");
    console.log(`  Email: ${email}`);
    console.log(`  Password: ${password}`);
    console.log(`  Username: ${username}`);
    console.log(`  Role: SuperAdmin`);
    console.log("\nLogin URL:");
    console.log("  http://localhost:5173 (HMS Admin Panel)");
    console.log("\n" + "=".repeat(60));
    console.log("\n⚠️  IMPORTANT: Save these credentials securely!");
    console.log("⚠️  Change the password after first login in production.\n");

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error creating admin user:", error);
    process.exit(1);
  }
}

// Run the script
createAdminUser();

