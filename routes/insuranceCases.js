const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");

applyTenantEntitlements(router, { moduleKey: "insurance" });

function daysSince(value) {
  const raw = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 0;
  const start = new Date(`${raw}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today - start) / 86400000));
}

function eventDate(row) {
  return String(row.date || row.admissionDate || row.createdAt || "");
}

/**
 * Insured OP visits and IP stays. Insurance fields come from the visit or stay.
 */
router.get("/", async (req, res) => {
  try {
    const IPAdmission = req.tenantDb.model("IPAdmission");
    const Prescription = req.tenantDb.model("Prescription");
    const Patient = req.tenantDb.model("Patient");

    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const search = String(req.query.search || "").trim();
    const companyId = String(req.query.insuranceProviderId || "").trim();
    const source = String(req.query.source || "all").toLowerCase();
    const admittedOnly = String(req.query.status || "") === "admitted";
    const maxDays = parseInt(req.query.maxDaysAdmitted, 10);
    const minDays = parseInt(req.query.minDaysAdmitted, 10);

    const insured = { hospitalId: req.hospitalId, paymentMethod: "Insurance" };
    if (companyId) insured.insurance_providerId = companyId;

    let patientIds = null;
    if (search.length >= 2) {
      const people = await Patient.find({
        hospitalId: req.hospitalId,
        $or: [
          { name: { $regex: search, $options: "i" } },
          { UMRNo: { $regex: search, $options: "i" } },
          { phone: { $regex: search, $options: "i" } },
        ],
      })
        .select("_id")
        .lean();
      patientIds = people.map((row) => row._id);
    }

    const stayQuery = { ...insured };
    if (admittedOnly) stayQuery.patient_status = "Admitted";
    if (patientIds) {
      stayQuery.$or = [
        { patientId: { $in: patientIds } },
        { UMRNo: { $regex: search, $options: "i" } },
        { patientName: { $regex: search, $options: "i" } },
        { ipNumber: { $regex: search, $options: "i" } },
      ];
    }

    const visitQuery = { ...insured };
    if (patientIds) {
      visitQuery.$or = [
        { patientId: { $in: patientIds } },
        { UMRNo: { $regex: search, $options: "i" } },
        { prescriptionId: { $regex: search, $options: "i" } },
      ];
    }

    const [stays, visits] = await Promise.all([
      source === "op"
        ? []
        : IPAdmission.find(stayQuery)
            .select(
              "patientId UMRNo patientName ipNumber admissionDate wardName selectedBed patient_status paymentMethod insurance_provider insurance_providerId policy_number coPayPercentage createdAt",
            )
            .lean(),
      source === "ip"
        ? []
        : Prescription.find(visitQuery)
            .select(
              "patientId UMRNo prescriptionId date doctorName consultantDoctor paymentMethod insurance_provider insurance_providerId policy_number coPayPercentage createdAt",
            )
            .lean(),
    ]);

    let cases = [
      ...stays.map((stay) => ({
        id: String(stay._id),
        source: "IP",
        admissionId: String(stay._id),
        prescriptionId: "",
        patientId: String(stay.patientId || ""),
        UMRNo: stay.UMRNo || "",
        name: stay.patientName || "",
        ipNumber: stay.ipNumber || "",
        wardName: stay.wardName || "",
        selectedBed: stay.selectedBed || "",
        admissionDate: stay.admissionDate || "",
        visitDate: "",
        patient_status: stay.patient_status || "",
        daysAdmitted: daysSince(stay.admissionDate),
        paymentMethod: stay.paymentMethod || "Insurance",
        insurance_provider: stay.insurance_provider || "",
        insurance_providerId: stay.insurance_providerId || "",
        policy_number: stay.policy_number || "",
        coPayPercentage: stay.coPayPercentage ?? 0,
        sortDate: eventDate(stay),
      })),
      ...visits.map((visit) => ({
        id: String(visit.prescriptionId || visit._id),
        source: "OP",
        admissionId: "",
        prescriptionId: String(visit.prescriptionId || ""),
        patientId: String(visit.patientId || ""),
        UMRNo: visit.UMRNo || "",
        name: "",
        wardName: "",
        admissionDate: "",
        visitDate: visit.date || "",
        consultantDoctor: visit.consultantDoctor || visit.doctorName || "",
        patient_status: "",
        daysAdmitted: 0,
        paymentMethod: visit.paymentMethod || "Insurance",
        insurance_provider: visit.insurance_provider || "",
        insurance_providerId: visit.insurance_providerId || "",
        policy_number: visit.policy_number || "",
        coPayPercentage: visit.coPayPercentage ?? 0,
        sortDate: eventDate(visit),
      })),
    ];

    if (Number.isFinite(maxDays)) {
      cases = cases.filter(
        (row) => row.source !== "IP" || row.daysAdmitted <= maxDays,
      );
    }
    if (Number.isFinite(minDays)) {
      cases = cases.filter(
        (row) => row.source === "IP" && row.daysAdmitted >= minDays,
      );
    }

    cases.sort((a, b) => (a.sortDate < b.sortDate ? 1 : a.sortDate > b.sortDate ? -1 : 0));

    const total = cases.length;
    const pageRows = cases.slice((pageNum - 1) * limitNum, pageNum * limitNum);
    const ids = pageRows
      .map((row) => row.patientId)
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    const people = ids.length
      ? await Patient.find({ _id: { $in: ids }, hospitalId: req.hospitalId })
          .select("name phone age gender UMRNo")
          .lean()
      : [];
    const peopleById = new Map(people.map((row) => [String(row._id), row]));

    const result = pageRows.map((row) => {
      const person = peopleById.get(row.patientId);
      return {
        ...row,
        name: person?.name || row.name || "",
        phone: person?.phone || "",
        age: person?.age || "",
        gender: person?.gender || "",
        UMRNo: person?.UMRNo || row.UMRNo,
      };
    });

    res.json({
      cases: result,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
        totalItems: total,
        itemsPerPage: limitNum,
        hasNextPage: pageNum * limitNum < total,
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
