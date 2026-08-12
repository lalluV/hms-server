const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const {
  PORTAL_STAFF_SEED,
  SUPERADMIN_SEED,
} = require("../config/portalStaffSeed");
const { getTenantConnection } = require("../utils/tenantDb");
const { registerTenantModels } = require("../utils/tenantModels");

function buildStaffId(type, index) {
  const slug = type.replace(/\s+/g, "").toUpperCase();
  return `DEMO-${slug}-${String(index).padStart(3, "0")}`;
}

async function upsertStaff(Staff, hospitalId, entry, index, force = false) {
  const existing = await Staff.findOne({ userId: entry.userId });

  if (existing && !force) {
    return { action: "skipped", userId: entry.userId, type: entry.type };
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(entry.password, salt);
  const now = new Date().toISOString();

  const payload = {
    id: existing?.id || buildStaffId(entry.type, index),
    userId: entry.userId,
    password: hashedPassword,
    name: entry.name,
    email: entry.email,
    phone: entry.phone,
    gender: entry.gender,
    department: entry.department,
    position: entry.position,
    qualification: entry.qualification,
    specialization: entry.specialization,
    opCharges: entry.opCharges,
    ipCharges: entry.ipCharges,
    licenseNumber: entry.licenseNumber,
    labCertification: entry.labCertification,
    adminLevel: entry.adminLevel,
    active: true,
    type: entry.type,
    hospitalId: new mongoose.Types.ObjectId(hospitalId),
    joinDate: now.split("T")[0],
    createdAt: existing?.createdAt || now,
    createdAtOriginal: existing?.createdAtOriginal || now,
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) delete payload[key];
  });

  if (existing) {
    await Staff.updateOne({ _id: existing._id }, { $set: payload });
    return { action: "updated", userId: entry.userId, type: entry.type };
  }

  await Staff.create(payload);
  return { action: "created", userId: entry.userId, type: entry.type };
}

/**
 * Seed demo portal staff into a hospital tenant database.
 * @param {string} hospitalId
 * @param {{ force?: boolean, includeSuperAdmin?: boolean }} options
 */
async function seedPortalStaffForHospital(hospitalId, options = {}) {
  const { force = false, includeSuperAdmin = false } = options;
  const connection = await getTenantConnection(hospitalId);
  registerTenantModels(connection);
  const Staff = connection.model("Staff");

  const results = [];
  const entries = [...PORTAL_STAFF_SEED];

  if (includeSuperAdmin) {
    const hasSuperAdmin = await Staff.findOne({ type: "SuperAdmin" });
    if (!hasSuperAdmin) {
      entries.unshift(SUPERADMIN_SEED);
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const result = await upsertStaff(Staff, hospitalId, entry, i + 1, force);
    results.push({
      ...result,
      password: entry.password,
      portal: entry.portal,
    });
  }

  return results;
}

module.exports = {
  PORTAL_STAFF_SEED,
  SUPERADMIN_SEED,
  seedPortalStaffForHospital,
};
