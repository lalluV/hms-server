const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeRole,
  hasPermission,
  canManageTargetRole,
  canAssignRole,
  allowedAssignableRoles,
} = require("../config/rolePermissions");
const {
  requirePermission,
  requireAssignableRole,
  requireCanManageTargetStaff,
} = require("../middleware/rolePermissions");

function mockRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

describe("role permission helpers", () => {
  it("normalizes common role aliases", () => {
    assert.equal(normalizeRole("Lab Technician"), "LabTechnician");
    assert.equal(normalizeRole("lab-technician"), "LabTechnician");
    assert.equal(normalizeRole("super admin"), "SuperAdmin");
  });

  it("SuperAdmin has all staff admin permissions", () => {
    assert.equal(hasPermission("SuperAdmin", "staff.delete"), true);
    assert.equal(hasPermission("SuperAdmin", "staff.role.change"), true);
  });

  it("Admin can manage non-SuperAdmin but not SuperAdmin", () => {
    assert.equal(canManageTargetRole("Admin", "Doctor"), true);
    assert.equal(canManageTargetRole("Admin", "SuperAdmin"), false);
    assert.equal(canAssignRole("Admin", "SuperAdmin"), false);
    assert.equal(allowedAssignableRoles("Admin").includes("SuperAdmin"), false);
  });

  it("Doctor has no staff admin permissions", () => {
    assert.equal(hasPermission("Doctor", "staff.update"), false);
    assert.equal(hasPermission("Doctor", "staff.read"), true);
    assert.equal(hasPermission("Doctor", "self.password.change"), true);
    assert.equal(hasPermission("Doctor", "self.profile.update"), true);
  });
});

describe("role permission middleware", () => {
  it("requirePermission denies non-admin staff writes", () => {
    const req = { user: { id: "u1", userId: "doc", type: "Doctor" } };
    const res = mockRes();
    let nextCalled = false;
    requirePermission("staff.update")(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, "ROLE_PERMISSION_DENIED");
  });

  it("requireAssignableRole denies Admin assigning SuperAdmin", () => {
    const req = {
      user: { id: "u1", userId: "admin", type: "Admin" },
      body: { type: "SuperAdmin" },
    };
    const res = mockRes();
    let nextCalled = false;
    requirePermission("staff.create")(req, mockRes(), () => {});
    requireAssignableRole()(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, "ROLE_ASSIGNMENT_DENIED");
  });

  it("target guard denies Admin managing SuperAdmin", async () => {
    const req = {
      actor: { id: "a1", userId: "admin", type: "Admin" },
      hospitalId: "h1",
      params: { id: "EMP1" },
      tenantDb: {
        model() {
          return {
            findOne() {
              return {
                select() {
                  return Promise.resolve({
                    _id: "target1",
                    id: "EMP1",
                    userId: "owner",
                    type: "SuperAdmin",
                  });
                },
              };
            },
          };
        },
      },
    };
    const res = mockRes();
    let nextCalled = false;
    await requireCanManageTargetStaff({ lookup: "employeeId" })(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, "TARGET_ROLE_DENIED");
  });
});
