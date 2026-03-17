require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const config = require("./config");
const MonitorService = require("./services/monitorService");
const { startReportScheduler, getNextReportBoundary } = require("./services/reportService");

async function start() {
  if (!config.mongoUri) {
    throw new Error("MONGODB_URI is required.");
  }

  await mongoose.connect(config.mongoUri);

  const monitorService = new MonitorService(config);
  await monitorService.start();

  const stopReportScheduler = startReportScheduler({
    servers: config.servers,
    reportHoursUtc: config.reportHoursUtc,
    reportWebhookUrl: config.reportWebhookUrl,
    onError: (error) => {
      console.error("Report scheduler error:", error);
    },
  });

  const app = express();

  app.get("/", (req, res) => {
    res.json({
      success: true,
      message: "Server is running",
      data: {
        ok: true,
        timestamp: new Date().toISOString(),
        mongoState: mongoose.connection.readyState,
      },
    });
  });

  app.get("/health", (req, res) => {
    res.json({
      success: true,
      message: "Monitor service is running",
      data: {
        ok: true,
        timestamp: new Date().toISOString(),
        mongoState: mongoose.connection.readyState,
        nextReportAtUtc: getNextReportBoundary(config.reportHoursUtc).toISOString(),
      },
    });
  });

  app.get("/status", (req, res) => {
    res.json({
      success: true,
      data: monitorService.getStatusSnapshot(),
    });
  });

  const server = app.listen(config.port, () => {
    console.log(`Health monitor listening on port ${config.port}`);
  });

  const shutdown = async () => {
    console.log("Shutting down monitor service...");
    monitorService.stop();
    stopReportScheduler();
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error("Failed to start application:", error);
  process.exit(1);
});
