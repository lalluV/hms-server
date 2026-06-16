const AuditLog = require("../models/AuditLog");
const { getActor } = require("../middleware/rolePermissions");

async function writeAuditLog(req, action, targetStaff, metadata = {}) {
  try {
    const actor = req.actor || getActor(req);
    await AuditLog.create({
      hospitalId: req.hospitalId,
      actorUserId: actor.userId || actor.id,
      actorType: actor.type,
      action,
      targetStaffId: targetStaff?.id || targetStaff?._id?.toString?.(),
      targetUserId: targetStaff?.userId,
      metadata,
    });
  } catch (error) {
    console.error("audit log write failed:", error.message);
  }
}

module.exports = { writeAuditLog };
