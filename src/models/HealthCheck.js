const mongoose = require("mongoose");

const HealthCheckSchema = new mongoose.Schema(
  {
    serverName: { type: String, required: true, index: true },
    serverUrl: { type: String, required: true },
    checkedAt: { type: Date, required: true },
    httpStatus: { type: Number, default: null },
    isHealthy: { type: Boolean, required: true, index: true },
    responseTimeMs: { type: Number, default: null },
    failureReason: { type: String, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

HealthCheckSchema.index({ serverName: 1, checkedAt: -1 });
HealthCheckSchema.index({ checkedAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model("HealthCheck", HealthCheckSchema);
