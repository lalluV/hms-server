function calculateLeaveDays(from, to) {
  if (!from || !to) return 0;
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.ceil(Math.abs(end - start) / (1000 * 60 * 60 * 24)) + 1;
}

async function findStaffMember(req, body) {
  const Staff = req.tenantDb.model("Staff");
  const hospitalId = req.hospitalId;
  const employeeId = body.employeeId;

  if (employeeId) {
    const byId = await Staff.findOne({
      hospitalId,
      $or: [{ id: employeeId }, { employeeId }],
    });
    if (byId) return byId;
  }

  if (body.employeeName) {
    return Staff.findOne({ hospitalId, name: body.employeeName });
  }

  return null;
}

async function findShiftNameForEmployee(req, employeeId) {
  if (!employeeId) return "";
  const Shift = req.tenantDb.model("Shift");
  const shifts = await Shift.find({ hospitalId: req.hospitalId });
  for (const shift of shifts) {
    if (shift.employees?.some((e) => e.id === employeeId)) {
      return shift.shiftName || "";
    }
  }
  return "";
}

async function enrichLeavePayload(req, body) {
  const enriched = { ...body };
  const staff = await findStaffMember(req, enriched);

  if (staff) {
    enriched.employeeId = staff.id || staff.employeeId || enriched.employeeId;
    enriched.employeeName = staff.name || enriched.employeeName;
    enriched.department =
      staff.department || staff.specialization || enriched.department || "";
    enriched.position =
      staff.position || staff.designation || enriched.position || "";
  }

  if (!enriched.shiftName && enriched.employeeId) {
    enriched.shiftName = await findShiftNameForEmployee(
      req,
      enriched.employeeId,
    );
  }

  if (enriched.from && enriched.to) {
    enriched.numberOfDays = calculateLeaveDays(enriched.from, enriched.to);
  }

  if (!enriched.status) {
    enriched.status = "Pending";
  }

  return enriched;
}

module.exports = { enrichLeavePayload, calculateLeaveDays };
