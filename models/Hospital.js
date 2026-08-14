const mongoose = require("mongoose");

const hospitalSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    code: {
      type: String,
      required: true,
      unique: true,
      lowercase: true, // Ensure lowercase for subdomain consistency
      trim: true,
      // Validate: alphanumeric, hyphens, underscores only (URL-safe for subdomains)
      validate: {
        validator: function (v) {
          return /^[a-z0-9_-]+$/.test(v);
        },
        message:
          "Hospital code must contain only lowercase letters, numbers, hyphens, and underscores",
      },
    }, // Unique slug for the hospital (used as subdomain identifier)
    address: { type: String },
    city: { type: String },
    state: { type: String },
    zipCode: { type: String },
    phone: { type: String },
    email: { type: String },
    website: { type: String },
    logoUrl: { type: String },
    active: { type: Boolean, default: true },
    subscriptionPlan: { type: String, default: "pro" },
    subscriptionExpiry: { type: Date },
    subscriptionStatus: {
      type: String,
      enum: ["active", "trialing", "past_due", "canceled", "expired"],
      default: "active",
    },
    /** Merges with plan; support can toggle booleans to unlock modules */
    moduleOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
    settings: {
      currency: { type: String, default: "INR" },
      timezone: { type: String, default: "Asia/Kolkata" },
      dateFormat: { type: String, default: "DD-MM-YYYY" },
      /** Primary hospital GSTIN on printed bills */
      gstNumber: { type: String },
      /** Pharmacy unit GSTIN when different from hospital */
      pharmacyGstNumber: { type: String },
      panNumber: { type: String },
      drugLicenseNumber: { type: String },
      labLicenseNumber: { type: String },
      /** Shown above footer disclaimer on receipts */
      receiptFooterNote: { type: String },
      /** Bill Print Configuration (TatvaPractice / modern clinic format) */
      billPrintSettings: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    // Tenant Database Fields
    /** "shared" = data in hms_shared (multi-tenant); "isolated" = dedicated hms_hospital_{id} DB */
    tenancyMode: {
      type: String,
      enum: ["shared", "isolated"],
      default: "isolated",
    },
    databaseName: { type: String }, // Name of the tenant database
    databaseStatus: {
      type: String,
      enum: ["pending", "provisioning", "active", "error", "migrating"],
      default: "pending",
    },
    databaseProvisionedAt: { type: Date },
    databaseUrl: { type: String }, // Optional: if using separate connection strings
    databaseStats: {
      collections: { type: Number },
      dataSize: { type: Number },
      storageSize: { type: Number },
      lastUpdated: { type: Date },
    },
    createdBy: { type: String }, // Super Admin ID
    modifiedBy: [
      {
        user: String,
        type: { type: String },
        modifiedTime: String,
      },
    ],
  },
  { strict: true, timestamps: true }
);

module.exports = mongoose.model("Hospital", hospitalSchema);
