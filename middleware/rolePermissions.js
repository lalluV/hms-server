const {
  normalizeRole,
  hasPermission,
  canManageTargetRole,
  canAssignRole,
} = require("../config/rolePermissions");

function getActor(req) {
  if (req.isAdmin && req.adminUser) {
    return {
      id: req.adminUser.id,
      userId: req.adminUser.email || req.adminUser.id,
      type: "SuperAdmin",
      isMasterAdmin: true,
    };
  }

  const user = req.user || {};
  return {
    id: user.id,
    userId: user.userId || user.id,
    type: normalizeRole(user.type),
    isMasterAdmin: false,
  };
}

function isActorSelf(actor, target) {
  if (!actor || !target) return false;
  const actorId = actor.id?.toString?.() || String(actor.id || "");
  const targetMongoId = target._id?.toString?.() || String(target._id || "");
  const targetEmpId = target.id?.toString?.() || String(target.id || "");
  return Boolean(
    (actorId && (actorId === targetMongoId || actorId === targetEmpId)) ||
      (actor.userId &&
        (actor.userId === target.userId || actor.userId === target.id)),
  );
}

function requirePermission(permission) {
  return (req, res, next) => {
    const actor = getActor(req);
    if (actor.isMasterAdmin || hasPermission(actor.type, permission)) {
      req.actor = actor;
      return next();
    }

    return res.status(403).json({
      code: "ROLE_PERMISSION_DENIED",
      message: "You do not have permission to perform this action.",
      permission,
    });
  };
}

function requireStaffWriteOrSelf() {
  return (req, res, next) => {
    const actor = getActor(req);
    req.actor = actor;
    if (actor.isMasterAdmin || hasPermission(actor.type, "staff.update")) {
      return next();
    }
    if (hasPermission(actor.type, "self.profile.update")) {
      req.selfProfileOnly = true;
      return next();
    }
    return res.status(403).json({
      code: "ROLE_PERMISSION_DENIED",
      message: "You do not have permission to perform this action.",
      permission: "staff.update",
    });
  };
}

function getTargetQuery(req, lookup) {
  switch (lookup) {
    case "userId":
      return { userId: req.params.userId, hospitalId: req.hospitalId };
    case "employeeId":
    default:
      return { id: req.params.id, hospitalId: req.hospitalId };
  }
}

function requireAssignableRole(roleFromRequest = (req) => req.body?.type) {
  return (req, res, next) => {
    const actor = req.actor || getActor(req);
    const requestedRole = roleFromRequest(req);
    if (!requestedRole) return next();

    if (actor.isMasterAdmin || canAssignRole(actor.type, requestedRole)) {
      return next();
    }

    return res.status(403).json({
      code: "ROLE_ASSIGNMENT_DENIED",
      message: "You cannot assign this role.",
      role: normalizeRole(requestedRole),
    });
  };
}

function requireCanManageTargetStaff(options = {}) {
  const { lookup = "employeeId", allowSelf = false } = options;

  return async (req, res, next) => {
    try {
      const Staff = req.tenantDb.model("Staff");
      const target = await Staff.findOne(getTargetQuery(req, lookup)).select("-password");

      if (!target) {
        return res.status(404).json({ message: "Staff member not found" });
      }

      const actor = req.actor || getActor(req);
      const isSelf = isActorSelf(actor, target);

      if (req.selfProfileOnly && !isSelf) {
        return res.status(403).json({
          code: "ROLE_PERMISSION_DENIED",
          message: "You do not have permission to perform this action.",
          permission: "staff.update",
        });
      }

      if ((allowSelf || req.selfProfileOnly) && isSelf) {
        req.targetStaff = target;
        req.isSelfStaffUpdate = true;
        return next();
      }

      if (!actor.isMasterAdmin && !canManageTargetRole(actor.type, target.type)) {
        return res.status(403).json({
          code: "TARGET_ROLE_DENIED",
          message: "You cannot manage this staff member.",
          targetRole: normalizeRole(target.type),
        });
      }

      const requestedRole = req.body?.type;
      if (
        requestedRole &&
        normalizeRole(requestedRole) !== normalizeRole(target.type) &&
        !actor.isMasterAdmin &&
        !canAssignRole(actor.type, requestedRole)
      ) {
        return res.status(403).json({
          code: "ROLE_ASSIGNMENT_DENIED",
          message: "You cannot assign this role.",
          role: normalizeRole(requestedRole),
        });
      }

      req.targetStaff = target;
      return next();
    } catch (error) {
      console.error("role target guard error:", error);
      return res.status(500).json({ message: "Error checking target staff permissions" });
    }
  };
}

module.exports = {
  getActor,
  requirePermission,
  requireStaffWriteOrSelf,
  requireAssignableRole,
  requireCanManageTargetStaff,
};
