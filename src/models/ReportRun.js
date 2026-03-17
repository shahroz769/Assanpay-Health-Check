const mongoose = require("mongoose");

const ReportRunSchema = new mongoose.Schema(
  {
    serverName: { type: String, required: true, index: true },
    serverUrl: { type: String, required: true },
    windowStartUtc: { type: Date, required: true, index: true },
    windowEndUtc: { type: Date, required: true, index: true },
    uptimeSeconds: { type: Number, required: true },
    downtimeSeconds: { type: Number, required: true },
    uptimePercent: { type: Number, required: true },
    downtimePercent: { type: Number, required: true },
    downtimeIntervalCount: { type: Number, required: true },
    downtimeIntervals: [
      {
        startedAt: { type: Date, required: true },
        endedAt: { type: Date, default: null },
        durationSeconds: { type: Number, required: true },
        status: { type: String, enum: ["resolved", "ongoing"], required: true },
      },
    ],
    webhookUrl: { type: String, default: null },
    webhookDeliveredAt: { type: Date, default: null },
    webhookStatus: { type: String, enum: ["pending", "success", "failed"], default: "pending" },
    webhookError: { type: String, default: null },
  },
  { timestamps: true }
);

ReportRunSchema.index({ serverName: 1, windowStartUtc: 1, windowEndUtc: 1 }, { unique: true });

module.exports = mongoose.model("ReportRun", ReportRunSchema);
