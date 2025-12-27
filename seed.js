const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
require("dotenv").config();
const AdminUser = require("./models/AdminUser");

const seedData = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected for Seeding");

    // 1. Create Default Hospital (Optional for Super Admin, but good to have)
    // ... code for hospital ...

    // 2. Create Super Admin (Platform Owner)
    const adminEmail = "admin@srichakra.com";
    let adminUser = await AdminUser.findOne({ email: adminEmail });

    if (!adminUser) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash("password123", salt);

      adminUser = new AdminUser({
        username: "superadmin",
        email: adminEmail,
        password: hashedPassword,
        role: "SuperAdmin",
      });

      await adminUser.save();
      console.log(
        "Super Admin Created in AdminUser collection: email='admin@srichakra.com', password='password123'"
      );
    } else {
      console.log("Super Admin already exists");
    }

    console.log("Seeding Completed Successfully");
    process.exit(0);
  } catch (err) {
    console.error("Seeding Failed:", err);
    process.exit(1);
  }
};

seedData();
