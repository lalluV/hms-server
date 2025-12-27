const mongoose = require("mongoose");

const diagnosticsUserSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
    },
  },
  { strict: false, timestamps: true }
);

module.exports = mongoose.model("DiagnosticsUser", diagnosticsUserSchema);
