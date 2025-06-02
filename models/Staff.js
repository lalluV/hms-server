const mongoose = require("mongoose");

const staffSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      unique: true,
      required: true,
    },
  },
  { strict: false }
);

module.exports = mongoose.model("Staff", staffSchema);
