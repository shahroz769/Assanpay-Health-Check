const axios = require("axios");
const config = require("../config");

async function postJson(url, payload) {
  if (!url || url.includes("example.com")) {
    return { skipped: true, reason: "Webhook URL not configured." };
  }

  const headers = {
    "Content-Type": "application/json",
  };

  if (config.webhookAuthKey) {
    headers["X-Webhook-Key"] = config.webhookAuthKey;
  }

  const response = await axios.post(url, payload, {
    headers,
    timeout: 10000,
  });

  return { skipped: false, status: response.status };
}

module.exports = { postJson };
