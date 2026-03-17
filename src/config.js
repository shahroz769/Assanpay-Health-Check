const SERVER_DEFINITIONS = [
  {
    name: "api.assanpay.com",
    url: "https://api.assanpay.com/service-beacon",
  },
  {
    name: "api.sahulatpay.com",
    url: "https://api.sahulatpay.com/service-beacon",
  },
];

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  port: parseInteger(process.env.PORT, 3000),
  mongoUri: process.env.MONGODB_URI,
  reportWebhookUrl: process.env.REPORT_WEBHOOK_URL,
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
  requestTimeoutMs: parseInteger(process.env.REQUEST_TIMEOUT_MS, 10000),
  normalPollIntervalMs: parseInteger(process.env.NORMAL_POLL_INTERVAL_MS, 30000),
  downRetryIntervalMs: parseInteger(process.env.DOWN_RETRY_INTERVAL_MS, 15000),
  downFailureThreshold: parseInteger(process.env.DOWN_FAILURE_THRESHOLD, 3),
  upSuccessThreshold: parseInteger(process.env.UP_SUCCESS_THRESHOLD, 3),
  reportHoursUtc: [7, 19],
  servers: SERVER_DEFINITIONS,
};
