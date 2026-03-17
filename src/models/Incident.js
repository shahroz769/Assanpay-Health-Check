const mongoose = require("mongoose");

const IncidentSchema = new mongoose.Schema(
  {
    serverName: { type: String, required: true, index: true },
    serverUrl: { type: String, required: true },
    startedAt: { type: Date, required: true, index: true },
    detectedDownAt: { type: Date, required: true },
    endedAt: { type: Date, default: null, index: true },
    detectedUpAt: { type: Date, default: null },
    status: { type: String, enum: ["ongoing", "resolved"], required: true, index: true },
    startCheckId: { type: mongoose.Schema.Types.ObjectId, ref: "HealthCheck", default: null },
    endCheckId: { type: mongoose.Schema.Types.ObjectId, ref: "HealthCheck", default: null },
    lastFailureReason: { type: String, default: null },
    failureCountAtDetection: { type: Number, default: 0 },
    recoverySuccessCountAtDetection: { type: Number, default: 0 },
    alertDownSentAt: { type: Date, default: null },
    alertUpSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

IncidentSchema.index({ serverName: 1, startedAt: -1 });

module.exports = mongoose.model("Incident", IncidentSchema);
