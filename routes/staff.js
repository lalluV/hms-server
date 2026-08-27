const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const {
  requirePermission,
  requireStaffWriteOrSelf,
  requireAssignableRole,
  requireCanManageTargetStaff,
} = require("../middleware/rolePermissions");
const {
  hasPermission,
  normalizeRole,
  canManageTargetRole,
} = require("../config/rolePermissions");
const { writeAuditLog } = require("../utils/auditLog");

applyTenantEntitlements(router, { moduleKey: "staff", useAuth: "flexible" });

const ROLE_MODULE_REQUIREMENTS = {
  Doctor: "clinical",
  Nurse: "ipdNursePanel",
  Pharmacist: "pharmacy",
  LabTechnician: "lab",
  Phlebotomist: "lab",
  Receptionist: "opd",
  Accountant: "expenses",
  "HR Manager": "hr",
  PRO: "commission",
};

function stripPassword(staff) {
  if (!staff) return staff;
  const obj = typeof staff.toObject === "function" ? staff.toObject() : { ...staff };
  delete obj.password;
  delete obj.loginPassword;
  return obj;
}

const SELF_PROFILE_FIELDS = [
  "name",
  "email",
  "phone",
  "gender",
  "dateOfBirth",
  "location",
  "position",
  "qualification",
  "specialization",
  "department",
  "opCharges",
  "ipCharges",
  "licenseNumber",
  "labCertification",
  "imgUrl",
  "signatureUrl",
];

function staffUpdatePayload(req) {
  if (req.selfProfileOnly) {
    const out = {};
    for (const key of SELF_PROFILE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        out[key] = req.body[key];
      }
    }
    return out;
  }
  const updateData = { ...(req.body || {}) };
  delete updateData.password;
  delete updateData.loginPassword;
  return updateData;
}

// NOTE: canViewLoginCredentials removed — plaintext passwords are no longer stored.
// Admins should use the reset-password endpoint to issue new passwords.

function requireRoleEnabledByPlan(roleFromRequest = (req) => req.body?.type) {
  return (req, res, next) => {
    const role = normalizeRole(roleFromRequest(req));
    const moduleKey = ROLE_MODULE_REQUIREMENTS[role];
    if (moduleKey && req.entitlements?.modules?.[moduleKey] !== true) {
      return res.status(403).json({
        code: "MODULE_NOT_IN_PLAN",
        message: `${role} role is not included in your subscription plan.`,
        module: moduleKey,
      });
    }
    next();
  };
}

// Get all staff members
router.get("/", requirePermission("staff.read"), async (req, res) => {
  try {
    const Staff = req.tenantDb.model("Staff");
    const staff = await Staff.find({ hospitalId: req.hospitalId }).select("-password");
    res.json(staff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get staff member by ID (userId)
router.get("/:id", requirePermission("staff.read"), async (req, res) => {
  try {
    const Staff = req.tenantDb.model("Staff");
    const staff = await Staff.findOne({
      userId: req.params.id,
      hospitalId: req.hospitalId,
    }).select("-password");
    if (!staff) {
      return res.status(404).json({ message: "Staff member not found" });
    }
    res.json(staff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get staff member by employee ID
router.get("/employee/:employeeId", requirePermission("staff.read"), async (req, res) => {
  try {
    const Staff = req.tenantDb.model("Staff");
    const staff = await Staff.findOne({
      id: req.params.employeeId,
      hospitalId: req.hospitalId,
    }).select("-password -loginPassword");
    if (!staff) {
      return res.status(404).json({ message: "Staff member not found" });
    }

    res.json(typeof staff.toObject === "function" ? staff.toObject() : { ...staff });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new staff member
router.post(
  "/",
  requirePermission("staff.create"),
  requireAssignableRole(),
  requireRoleEnabledByPlan(),
  async (req, res) => {
    try {
      const Staff = req.tenantDb.model("Staff");
      const { password, ...staffData } = req.body;

      if (staffData.userId) {
        const existingStaff = await Staff.findOne({
          userId: staffData.userId,
          hospitalId: req.hospitalId,
        });
        if (existingStaff) {
          return res.status(400).json({ message: "User ID already exists" });
        }
      }

      if (password) {
        const salt = await bcrypt.genSalt(10);
        staffData.password = await bcrypt.hash(password, salt);
      }

      const staff = new Staff({ ...staffData, hospitalId: req.hospitalId });
      const newStaff = await staff.save();
      await writeAuditLog(req, "staff.create", newStaff, { role: newStaff.type });
      res.status(201).json(stripPassword(newStaff));
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  },
);

// Admin reset staff password by employee ID
router.put(
  "/:id/reset-password",
  requirePermission("staff.password.reset"),
  requireCanManageTargetStaff({ lookup: "employeeId" }),
  async (req, res) => {
    try {
      const { newPassword, password } = req.body;
      const nextPassword = newPassword || password;
      if (!nextPassword || String(nextPassword).length < 6) {
        return res.status(400).json({
          message: "New password is required and must be at least 6 characters",
        });
      }

      const Staff = req.tenantDb.model("Staff");
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(nextPassword, salt);
      const staff = await Staff.findOneAndUpdate(
        { id: req.params.id, hospitalId: req.hospitalId },
        { $set: { password: hashedPassword }, $unset: { loginPassword: 1 } },
        { new: true },
      ).select("-password -loginPassword");

      await writeAuditLog(req, "staff.password.reset", staff);
      res.json({ message: "Password reset successfully", staff });
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  },
);

// Update staff member by userId (must come before /:id route)
router.put(
  "/user/:userId",
  requireStaffWriteOrSelf(),
  requireCanManageTargetStaff({ lookup: "userId" }),
  requireRoleEnabledByPlan(),
  async (req, res) => {
    try {
      const Staff = req.tenantDb.model("Staff");
      const updateData = staffUpdatePayload(req);

      const previousType = req.targetStaff?.type;
      if (
        updateData.type &&
        normalizeRole(updateData.type) !== normalizeRole(previousType) &&
        !hasPermission(req.actor?.type, "staff.role.change")
      ) {
        return res.status(403).json({
          code: "ROLE_CHANGE_DENIED",
          message: "You do not have permission to change staff roles.",
        });
      }

      const staff = await Staff.findOneAndUpdate(
        { userId: req.params.userId, hospitalId: req.hospitalId },
        updateData,
        { new: true },
      ).select("-password");
      if (!staff) {
        return res.status(404).json({ message: "Staff member not found" });
      }

      await writeAuditLog(
        req,
        previousType !== staff.type ? "staff.role.change" : "staff.update",
        staff,
        previousType !== staff.type ? { from: previousType, to: staff.type } : {},
      );
      res.json(staff);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  },
);

// Update staff status
router.put(
  "/:id/status",
  requirePermission("staff.update"),
  requireCanManageTargetStaff({ lookup: "employeeId" }),
  async (req, res) => {
    try {
      const Staff = req.tenantDb.model("Staff");
      const { status, active } = req.body;
      const update = {};
      if (typeof status !== "undefined") update.status = status;
      if (typeof active !== "undefined") update.active = active;

      const staff = await Staff.findOneAndUpdate(
        { id: req.params.id, hospitalId: req.hospitalId },
        { $set: update },
        { new: true },
      ).select("-password");
      if (!staff) {
        return res.status(404).json({ message: "Staff member not found" });
      }
      await writeAuditLog(req, "staff.status.update", staff, update);
      res.json(staff);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  },
);

// Update staff member
router.put(
  "/:id",
  requireStaffWriteOrSelf(),
  requireCanManageTargetStaff({ lookup: "employeeId" }),
  requireRoleEnabledByPlan(),
  async (req, res) => {
    try {
      const Staff = req.tenantDb.model("Staff");
      const updateData = staffUpdatePayload(req);

      const previousType = req.targetStaff?.type;
      if (
        updateData.type &&
        normalizeRole(updateData.type) !== normalizeRole(previousType) &&
        !hasPermission(req.actor?.type, "staff.role.change")
      ) {
        return res.status(403).json({
          code: "ROLE_CHANGE_DENIED",
          message: "You do not have permission to change staff roles.",
        });
      }

      const staff = await Staff.findOneAndUpdate(
        { id: req.params.id, hospitalId: req.hospitalId },
        updateData,
        { new: true },
      ).select("-password");
      if (!staff) {
        return res.status(404).json({ message: "Staff member not found" });
      }

      await writeAuditLog(
        req,
        previousType !== staff.type ? "staff.role.change" : "staff.update",
        staff,
        previousType !== staff.type ? { from: previousType, to: staff.type } : {},
      );
      res.json(staff);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  },
);

// Delete staff member
router.delete(
  "/:id",
  requirePermission("staff.delete"),
  requireCanManageTargetStaff({ lookup: "employeeId" }),
  async (req, res) => {
    try {
      const Staff = req.tenantDb.model("Staff");
      const staff = await Staff.findOneAndDelete({
        id: req.params.id,
        hospitalId: req.hospitalId,
      }).select("-password");
      if (!staff) {
        return res.status(404).json({ message: "Staff member not found" });
      }
      await writeAuditLog(req, "staff.delete", staff);
      res.json({ message: "Staff member deleted" });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },
);

// Get staff by department
router.get("/department/:department", requirePermission("staff.read"), async (req, res) => {
  try {
    const Staff = req.tenantDb.model("Staff");
    const staff = await Staff.find({
      department: req.params.department,
      hospitalId: req.hospitalId,
    }).select("-password");
    res.json(staff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get staff by type
router.get("/type/:type", requirePermission("staff.read"), async (req, res) => {
  try {
    const Staff = req.tenantDb.model("Staff");
    const staff = await Staff.find({
      type: req.params.type,
      hospitalId: req.hospitalId,
    }).select("-password");
    res.json(staff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get staff by status
router.get("/status/:status", requirePermission("staff.read"), async (req, res) => {
  try {
    const Staff = req.tenantDb.model("Staff");
    const staff = await Staff.find({
      status: req.params.status,
      hospitalId: req.hospitalId,
    }).select("-password");
    res.json(staff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
