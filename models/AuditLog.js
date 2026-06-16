const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    hospitalId: { type: String, required: true, index: true },
    actorUserId: { type: String },
    actorType: { type: String },
    action: { type: String, required: true, index: true },
    targetStaffId: { type: String },
    targetUserId: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { strict: true, timestamps: true }
);

module.exports = mongoose.model("AuditLog", auditLogSchema);
