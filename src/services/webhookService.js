const axios = require("axios");

async function postJson(url, payload) {
  if (!url || url.includes("example.com")) {
    return { skipped: true, reason: "Webhook URL not configured." };
  }

  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 10000,
  });

  return { skipped: false, status: response.status };
}

module.exports = { postJson };
