require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const config = require("./config");
const MonitorService = require("./services/monitorService");
const { startReportScheduler, getNextReportBoundary } = require("./services/reportService");

process.on("uncaughtException", (error) => {
  console.error("[fatal] uncaughtException:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
});

mongoose.connection.on("connected", () => {
  console.log("[mongodb] connected");
});

mongoose.connection.on("disconnected", () => {
  console.error("[mongodb] disconnected");
});

mongoose.connection.on("error", (error) => {
  console.error("[mongodb] error:", error);
});

async function start() {
  if (!config.mongoUri) {
    throw new Error("MONGODB_URI is required.");
  }

  console.log(
    `[startup] port=${config.port} servers=${config.servers.length} reportHoursUtc=${config.reportHoursUtc.join(",")}`
  );
  await mongoose.connect(config.mongoUri);
  console.log("[startup] mongodb connected");

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
    server.close(() => {
      console.log("[shutdown] http server closed");
    });
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
