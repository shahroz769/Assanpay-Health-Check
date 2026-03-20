const ReportRun = require("../models/ReportRun");
const Incident = require("../models/Incident");
const { postJson } = require("./webhookService");

function getPreviousWindow(windowEndUtc) {
  const start = new Date(windowEndUtc.getTime() - 12 * 60 * 60 * 1000);
  return { start, end: windowEndUtc };
}

function getNextReportBoundary(reportHoursUtc) {
  const now = new Date();
  const candidates = [];

  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const hour of reportHoursUtc) {
      const candidate = new Date(now);
      candidate.setUTCDate(now.getUTCDate() + dayOffset);
      candidate.setUTCHours(hour, 0, 0, 0);
      if (candidate > now) {
        candidates.push(candidate);
      }
    }
  }

  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0];
}

function computeDowntimeIntervals(incidents, windowStart, windowEnd) {
  const intervals = [];

  for (const incident of incidents) {
    const actualStart = incident.startedAt > windowStart ? incident.startedAt : windowStart;
    const incidentEnd = incident.endedAt || windowEnd;
    const actualEnd = incidentEnd < windowEnd ? incidentEnd : windowEnd;

    if (actualEnd <= windowStart || actualStart >= windowEnd || actualEnd <= actualStart) {
      continue;
    }

    intervals.push({
      startedAt: actualStart,
      endedAt: incident.endedAt ? actualEnd : null,
      durationSeconds: Math.round((actualEnd.getTime() - actualStart.getTime()) / 1000),
      status: incident.endedAt && incident.endedAt <= windowEnd ? "resolved" : "ongoing",
    });
  }

  return intervals;
}

function buildReportPayload(reportLike) {
  return {
    eventType: "uptime_report",
    serverName: reportLike.serverName,
    serverUrl: reportLike.serverUrl,
    windowStartUtc: reportLike.windowStartUtc.toISOString(),
    windowEndUtc: reportLike.windowEndUtc.toISOString(),
    uptimeSeconds: reportLike.uptimeSeconds,
    downtimeSeconds: reportLike.downtimeSeconds,
    uptimePercent: reportLike.uptimePercent,
    downtimePercent: reportLike.downtimePercent,
    downtimeIntervalCount: reportLike.downtimeIntervalCount,
    downtimeIntervals: (reportLike.downtimeIntervals || []).map((item) => ({
      startedAt: item.startedAt.toISOString(),
      endedAt: item.endedAt ? item.endedAt.toISOString() : null,
      durationSeconds: item.durationSeconds,
      status: item.status,
    })),
  };
}

async function generateServerReport(server, windowStart, windowEnd, reportWebhookUrl) {
  console.log(
    `[report] start server=${server.name} windowStart=${windowStart.toISOString()} windowEnd=${windowEnd.toISOString()}`
  );
  const incidents = await Incident.find({
    serverName: server.name,
    startedAt: { $lt: windowEnd },
    $or: [{ endedAt: null }, { endedAt: { $gt: windowStart } }],
  }).sort({ startedAt: 1 });

  const downtimeIntervals = computeDowntimeIntervals(incidents, windowStart, windowEnd);
  const downtimeSeconds = downtimeIntervals.reduce((sum, item) => sum + item.durationSeconds, 0);
  const windowSeconds = Math.round((windowEnd.getTime() - windowStart.getTime()) / 1000);
  const uptimeSeconds = Math.max(0, windowSeconds - downtimeSeconds);
  const uptimePercent = Number(((uptimeSeconds / windowSeconds) * 100).toFixed(2));
  const downtimePercent = Number(((downtimeSeconds / windowSeconds) * 100).toFixed(2));

  console.log(
    `[report] summary server=${server.name} incidents=${incidents.length} downtimeIntervals=${downtimeIntervals.length} uptimeSeconds=${uptimeSeconds} downtimeSeconds=${downtimeSeconds} uptimePercent=${uptimePercent}`
  );

  const payload = buildReportPayload({
    serverName: server.name,
    serverUrl: server.url,
    windowStartUtc: windowStart,
    windowEndUtc: windowEnd,
    uptimeSeconds,
    downtimeSeconds,
    uptimePercent,
    downtimePercent,
    downtimeIntervalCount: downtimeIntervals.length,
    downtimeIntervals,
  });

  const reportRun = await ReportRun.findOneAndUpdate(
    {
      serverName: server.name,
      windowStartUtc: windowStart,
      windowEndUtc: windowEnd,
    },
    {
      $set: {
        serverUrl: server.url,
        uptimeSeconds,
        downtimeSeconds,
        uptimePercent,
        downtimePercent,
        downtimeIntervalCount: downtimeIntervals.length,
        downtimeIntervals,
        webhookUrl: reportWebhookUrl || null,
        webhookStatus: "pending",
        webhookError: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  try {
    console.log(`[report] webhook_send server=${server.name} webhookConfigured=${Boolean(reportWebhookUrl)}`);
    const result = await postJson(reportWebhookUrl, payload);
    const success = result.skipped || (result.status >= 200 && result.status < 300);

    reportRun.webhookStatus = success ? "success" : "failed";
    reportRun.webhookDeliveredAt = success ? new Date() : null;
    reportRun.webhookError = result.skipped ? result.reason : null;
    console.log(
      `[report] webhook_result server=${server.name} status=${reportRun.webhookStatus}${result.skipped ? ` reason="${result.reason}"` : ""}`
    );
  } catch (error) {
    reportRun.webhookStatus = "failed";
    reportRun.webhookDeliveredAt = null;
    reportRun.webhookError = error.message;
    console.error(`[report] webhook_result server=${server.name} status=failed error="${error.message}"`);
  }

  await reportRun.save();
  console.log(
    `[report] saved server=${server.name} reportRunId=${reportRun._id} windowStart=${windowStart.toISOString()} windowEnd=${windowEnd.toISOString()}`
  );
  return payload;
}

async function resendLatestReports({ servers, reportWebhookUrl }) {
  const results = [];

  for (const server of servers) {
    const reportRun = await ReportRun.findOne({ serverName: server.name }).sort({ windowEndUtc: -1 });

    if (!reportRun) {
      results.push({
        serverName: server.name,
        resent: false,
        reason: "No saved report found",
      });
      continue;
    }

    const payload = buildReportPayload(reportRun);

    try {
      console.log(
        `[report] manual_resend server=${server.name} windowStart=${reportRun.windowStartUtc.toISOString()} windowEnd=${reportRun.windowEndUtc.toISOString()}`
      );
      const result = await postJson(reportWebhookUrl || reportRun.webhookUrl, payload);
      const success = result.skipped || (result.status >= 200 && result.status < 300);

      reportRun.webhookStatus = success ? "success" : "failed";
      reportRun.webhookDeliveredAt = success ? new Date() : null;
      reportRun.webhookError = result.skipped ? result.reason : null;
      await reportRun.save();

      results.push({
        serverName: server.name,
        resent: success,
        status: result.status || null,
        skipped: Boolean(result.skipped),
        reason: result.skipped ? result.reason : null,
        windowStartUtc: reportRun.windowStartUtc.toISOString(),
        windowEndUtc: reportRun.windowEndUtc.toISOString(),
      });
    } catch (error) {
      reportRun.webhookStatus = "failed";
      reportRun.webhookDeliveredAt = null;
      reportRun.webhookError = error.message;
      await reportRun.save();

      results.push({
        serverName: server.name,
        resent: false,
        reason: error.message,
        windowStartUtc: reportRun.windowStartUtc.toISOString(),
        windowEndUtc: reportRun.windowEndUtc.toISOString(),
      });
    }
  }

  return results;
}

function startReportScheduler({ servers, reportHoursUtc, reportWebhookUrl, onError }) {
  let timer = null;

  const scheduleNext = () => {
    const nextRun = getNextReportBoundary(reportHoursUtc);
    const delayMs = Math.max(1000, nextRun.getTime() - Date.now());
    console.log(
      `[report] next_run scheduledAt=${nextRun.toISOString()} delayMs=${delayMs} servers=${servers.length}`
    );

    timer = setTimeout(async () => {
      const { start, end } = getPreviousWindow(nextRun);
      console.log(
        `[report] cycle_start windowStart=${start.toISOString()} windowEnd=${end.toISOString()}`
      );

      try {
        for (const server of servers) {
          await generateServerReport(server, start, end, reportWebhookUrl);
        }
      } catch (error) {
        onError(error);
      } finally {
        scheduleNext();
      }
    }, delayMs);
  };

  scheduleNext();

  return () => {
    if (timer) {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  buildReportPayload,
  generateServerReport,
  resendLatestReports,
  startReportScheduler,
  getNextReportBoundary,
};
