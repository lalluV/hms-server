const express = require("express");
const router = express.Router();
const { applyTenantEntitlements } = require("../utils/applyTenantEntitlements");
const Hospital = require("../models/Hospital");
const {
  sendAppointmentWhatsApp,
  mapWhatsAppHttpError,
} = require("../utils/whatsappCloud");

applyTenantEntitlements(router, { moduleKey: "core" });

const APPOINTMENT_EVENT_TO_TEMPLATE = {
  booked: "appointment_booked",
  confirmed: "appointment_confirmed",
  rescheduled: "appointment_rescheduled",
  cancelled: "appointment_cancelled",
};

function appointmentPhone(appointment) {
  return appointment?.phone || appointment?.mobile || null;
}

function appointmentDoctorName(appointment) {
  return appointment?.doctorName || appointment?.doctor || "-";
}

function appointmentDate(appointment) {
  return (
    appointment?.slotDate ||
    appointment?.appointmentDate ||
    appointment?.rescheduledDate ||
    "-"
  );
}

function appointmentTime(appointment) {
  return (
    appointment?.slotTime ||
    appointment?.time ||
    appointment?.rescheduledTime ||
    "-"
  );
}

// Get all appointments with pagination support
router.get("/", async (req, res) => {
  try {
    const Appointment = req.tenantDb.model("Appointment");
    
    const {
      page = 1,
      limit = 20,
      search = "",
      doctorId = "",
      patientId = "",
      status = "",
      startDate = "",
      endDate = "",
    } = req.query;

    // Build query
    const query = { hospitalId: req.hospitalId };

    // Filter by doctor ID
    if (doctorId) {
      query.doctorId = doctorId;
    }

    // Filter by patient ID
    if (patientId) {
      query.patientId = patientId;
    }

    // Filter by status
    if (status) {
      query.status = status;
    }

    // Filter by date range
    if (startDate && endDate) {
      query.slotDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (startDate) {
      query.slotDate = { $gte: new Date(startDate) };
    } else if (endDate) {
      query.slotDate = { $lte: new Date(endDate) };
    }

    // Search filter
    if (search && search.length >= 2) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { fullName: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { mobile: { $regex: search, $options: "i" } },
        { doctor: { $regex: search, $options: "i" } },
        { doctorName: { $regex: search, $options: "i" } },
        { treatment: { $regex: search, $options: "i" } },
      ];
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count
    const total = await Appointment.countDocuments(query);

    // Get paginated appointments
    const appointments = await Appointment.find(query)
      .sort({ slotDate: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      appointments: appointments,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(total / limitNum),
        totalItems: total,
        itemsPerPage: limitNum,
        hasNextPage: pageNum < Math.ceil(total / limitNum),
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get appointment by ID
router.get("/:id", async (req, res) => {
  try {
    const Appointment = req.tenantDb.model("Appointment");
    const appointment = await Appointment.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new appointment
router.post("/", async (req, res) => {
  try {
    const Appointment = req.tenantDb.model("Appointment");
    const appointment = new Appointment({
      ...req.body,
      hospitalId: req.hospitalId,
    });
    const newAppointment = await appointment.save();
    res.status(201).json(newAppointment);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update appointment
router.put("/:id", async (req, res) => {
  try {
    const Appointment = req.tenantDb.model("Appointment");
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, hospitalId: req.hospitalId },
      req.body,
      { new: true }
    );
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    res.json(appointment);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

/**
 * AUTHENTICATED: notify patient about an appointment via WhatsApp.
 * POST /api/appointments/:id/send-whatsapp
 * Body: { event: 'booked' | 'confirmed' | 'rescheduled' | 'cancelled' }
 */
router.post("/:id/send-whatsapp", async (req, res) => {
  try {
    const { event } = req.body || {};
    const templateKey = APPOINTMENT_EVENT_TO_TEMPLATE[event];
    if (!templateKey) {
      return res.status(400).json({
        message:
          "event must be one of: booked, confirmed, rescheduled, cancelled",
      });
    }

    const Appointment = req.tenantDb.model("Appointment");
    const appointment = await Appointment.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    }).lean();

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    const phone = appointmentPhone(appointment);
    if (!phone) {
      return res
        .status(400)
        .json({ message: "Appointment does not have a mobile number." });
    }

    const hospital = await Hospital.findById(req.hospitalId).lean();
    const result = await sendAppointmentWhatsApp({
      templateKey,
      phone,
      patientName: appointment.name || appointment.fullName,
      hospitalName: hospital?.name || "Your Clinic",
      doctorName: appointmentDoctorName(appointment),
      date: appointmentDate(appointment),
      time: appointmentTime(appointment),
    });

    return res.json({
      success: true,
      event,
      templateKey,
      destination: result.destination,
    });
  } catch (error) {
    console.error("Send appointment WhatsApp error:", error);
    const mapped = mapWhatsAppHttpError(error, res);
    if (mapped) return mapped;
    return res
      .status(500)
      .json({ message: "Failed to send appointment WhatsApp message." });
  }
});

// Delete appointment
router.delete("/:id", async (req, res) => {
  try {
    const Appointment = req.tenantDb.model("Appointment");
    const appointment = await Appointment.findOneAndDelete({
      _id: req.params.id,
      hospitalId: req.hospitalId,
    });
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    res.json({ message: "Appointment deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get appointments by doctor ID
router.get("/doctor/:doctorId", async (req, res) => {
  try {
    const Appointment = req.tenantDb.model("Appointment");
    const appointments = await Appointment.find({
      doctorId: req.params.doctorId,
      hospitalId: req.hospitalId,
    });
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get appointments by patient ID
router.get("/patient/:patientId", async (req, res) => {
  try {
    const Appointment = req.tenantDb.model("Appointment");
    const appointments = await Appointment.find({
      patientId: req.params.patientId,
      hospitalId: req.hospitalId,
    });
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
