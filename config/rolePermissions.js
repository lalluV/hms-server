const ROLE_ALIASES = {
  superadmin: "SuperAdmin",
  "super admin": "SuperAdmin",
  admin: "Admin",
  doctor: "Doctor",
  nurse: "Nurse",
  pharmacist: "Pharmacist",
  labtechnician: "LabTechnician",
  "lab technician": "LabTechnician",
  phlebotomist: "Phlebotomist",
  receptionist: "Receptionist",
  accountant: "Accountant",
  "hr manager": "HR Manager",
  hrmanager: "HR Manager",
  "it support": "IT Support",
  itsupport: "IT Support",
  pro: "PRO",
};

const ALL_STAFF_ROLES = [
  "SuperAdmin",
  "Admin",
  "Doctor",
  "Nurse",
  "Pharmacist",
  "LabTechnician",
  "Phlebotomist",
  "Receptionist",
  "Accountant",
  "HR Manager",
  "IT Support",
  "PRO",
];

const ALL_PERMISSIONS = [
  "staff.read",
  "staff.create",
  "staff.update",
  "staff.delete",
  "staff.role.change",
  "staff.password.reset",
  "self.password.change",
  "self.profile.update",
];

const ROLE_PERMISSIONS = {
  SuperAdmin: new Set(ALL_PERMISSIONS),
  Admin: new Set([
    "staff.read",
    "staff.create",
    "staff.update",
    "staff.password.reset",
    "self.password.change",
    "self.profile.update",
  ]),
  Doctor: new Set(["staff.read", "self.password.change", "self.profile.update"]),
  Nurse: new Set(["staff.read", "self.password.change", "self.profile.update"]),
  Pharmacist: new Set(["staff.read", "self.password.change", "self.profile.update"]),
  LabTechnician: new Set(["staff.read", "self.password.change", "self.profile.update"]),
  Phlebotomist: new Set(["staff.read", "self.password.change", "self.profile.update"]),
  Receptionist: new Set(["staff.read", "self.password.change", "self.profile.update"]),
  Accountant: new Set(["staff.read", "self.password.change", "self.profile.update"]),
  "HR Manager": new Set(["staff.read", "self.password.change", "self.profile.update"]),
  "IT Support": new Set(["staff.read", "self.password.change", "self.profile.update"]),
  PRO: new Set(["staff.read", "self.password.change", "self.profile.update"]),
};

function normalizeRole(role) {
  if (!role || typeof role !== "string") return "";
  const compact = role.trim().toLowerCase().replace(/[_-]+/g, " ");
  return ROLE_ALIASES[compact] || ROLE_ALIASES[compact.replace(/\s+/g, "")] || role.trim();
}

function getPermissionsForRole(role) {
  return ROLE_PERMISSIONS[normalizeRole(role)] || new Set();
}

function hasPermission(role, permission) {
  return getPermissionsForRole(role).has(permission);
}

function canManageTargetRole(actorRole, targetRole) {
  const actor = normalizeRole(actorRole);
  const target = normalizeRole(targetRole);
  if (actor === "SuperAdmin") return true;
  if (actor === "Admin") return target !== "SuperAdmin";
  return false;
}

function canAssignRole(actorRole, targetRole) {
  const actor = normalizeRole(actorRole);
  const target = normalizeRole(targetRole);
  if (actor === "SuperAdmin") return true;
  if (actor === "Admin") return target !== "SuperAdmin";
  return false;
}

function allowedAssignableRoles(actorRole) {
  return ALL_STAFF_ROLES.filter((role) => canAssignRole(actorRole, role));
}

module.exports = {
  ALL_STAFF_ROLES,
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  normalizeRole,
  getPermissionsForRole,
  hasPermission,
  canManageTargetRole,
  canAssignRole,
  allowedAssignableRoles,
};
