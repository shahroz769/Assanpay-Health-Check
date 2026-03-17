const axios = require("axios");
const HealthCheck = require("../models/HealthCheck");
const Incident = require("../models/Incident");
const { postJson } = require("./webhookService");

function isExpectedHealthyPayload(payload) {
  return (
    payload &&
    payload.success === true &&
    payload.message === "Service is active" &&
    payload.data &&
    payload.data.ok === true &&
    payload.statusCode === 200
  );
}

class MonitorService {
  constructor(config) {
    this.config = config;
    this.serverStates = new Map();
    this.watchdogTimer = null;
  }

  async start() {
    for (const server of this.config.servers) {
      this.serverStates.set(server.name, {
        server,
        currentStatus: "healthy",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        firstFailureAt: null,
        firstFailureCheckId: null,
        recoveryStartedAt: null,
        currentIncidentId: null,
        lastCheckAt: null,
        lastCheckStartedAt: null,
        lastHealthyAt: null,
        lastError: null,
        inRetryMode: false,
        timer: null,
        running: false,
      });

      console.log(`[monitor] initialized server=${server.name} url=${server.url}`);
      this.scheduleNextCheck(server.name, 0);
    }

    this.startWatchdog();
  }

  stop() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    for (const state of this.serverStates.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
  }

  getStatusSnapshot() {
    return this.config.servers.map((server) => {
      const state = this.serverStates.get(server.name);
      return {
        serverName: server.name,
        serverUrl: server.url,
        currentStatus: state.currentStatus,
        inRetryMode: state.inRetryMode,
        consecutiveFailures: state.consecutiveFailures,
        consecutiveSuccesses: state.consecutiveSuccesses,
        firstFailureAt: state.firstFailureAt ? state.firstFailureAt.toISOString() : null,
        recoveryStartedAt: state.recoveryStartedAt ? state.recoveryStartedAt.toISOString() : null,
        lastCheckStartedAt: state.lastCheckStartedAt ? state.lastCheckStartedAt.toISOString() : null,
        lastCheckAt: state.lastCheckAt ? state.lastCheckAt.toISOString() : null,
        lastHealthyAt: state.lastHealthyAt ? state.lastHealthyAt.toISOString() : null,
        lastError: state.lastError,
      };
    });
  }

  scheduleNextCheck(serverName, delayMs) {
    const state = this.serverStates.get(serverName);
    if (!state) {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
    }

    console.log(
      `[poll] next server=${serverName} delayMs=${delayMs} mode=${state.inRetryMode ? "retry" : "normal"}`
    );

    state.timer = setTimeout(() => {
      this.runCheck(serverName).catch((error) => {
        console.error(`Monitor error for ${serverName}:`, error);
        this.scheduleNextCheck(
          serverName,
          state.inRetryMode ? this.config.downRetryIntervalMs : this.config.normalPollIntervalMs
        );
      });
    }, delayMs);
  }

  async runCheck(serverName) {
    const state = this.serverStates.get(serverName);
    if (!state) {
      console.error(`[poll] skipped server=${serverName} reason=missing_state`);
      return;
    }

    if (state.running) {
      console.error(`[poll] skipped server=${serverName} reason=already_running`);
      return;
    }

    state.running = true;
    state.lastCheckStartedAt = new Date();

    try {
      console.log(
        `[poll] server=${state.server.name} url=${state.server.url} mode=${state.inRetryMode ? "retry" : "normal"}`
      );
      const result = await this.fetchHealth(state.server);
      const healthCheck = await HealthCheck.create({
        serverName: state.server.name,
        serverUrl: state.server.url,
        checkedAt: result.checkedAt,
        httpStatus: result.httpStatus,
        isHealthy: result.isHealthy,
        responseTimeMs: result.responseTimeMs,
        failureReason: result.failureReason,
        payload: result.payload,
      });

      state.lastCheckAt = result.checkedAt;
      console.log(
        `[poll] result server=${state.server.name} healthy=${result.isHealthy} status=${result.httpStatus ?? "null"} responseMs=${result.responseTimeMs} checkedAt=${result.checkedAt.toISOString()}${result.failureReason ? ` reason="${result.failureReason}"` : ""}`
      );
      if (result.payloadWarning) {
        console.warn(
          `[poll] payload_warning server=${state.server.name} checkedAt=${result.checkedAt.toISOString()} warning="${result.payloadWarning}"`
        );
      }

      if (result.isHealthy) {
        await this.handleSuccess(state, healthCheck);
      } else {
        await this.handleFailure(state, healthCheck);
      }
    } catch (error) {
      console.error(`[poll] failed server=${serverName} error="${error.message}"`);
      throw error;
    } finally {
      state.running = false;
      const nextDelay = state.inRetryMode
        ? this.config.downRetryIntervalMs
        : this.config.normalPollIntervalMs;
      this.scheduleNextCheck(serverName, nextDelay);
    }
  }

  startWatchdog() {
    const baselineInterval = Math.max(this.config.normalPollIntervalMs, this.config.downRetryIntervalMs);
    const watchdogIntervalMs = Math.max(30000, baselineInterval);
    const staleThresholdMs = Math.max(90000, baselineInterval * 3);

    console.log(
      `[monitor] watchdog started intervalMs=${watchdogIntervalMs} staleThresholdMs=${staleThresholdMs}`
    );

    this.watchdogTimer = setInterval(() => {
      const now = Date.now();

      for (const state of this.serverStates.values()) {
        const lastActivityAt = state.lastCheckAt || state.lastCheckStartedAt;

        if (!lastActivityAt) {
          console.error(`[watchdog] server=${state.server.name} status=no_poll_yet`);
          continue;
        }

        const ageMs = now - lastActivityAt.getTime();
        if (ageMs > staleThresholdMs) {
          console.error(
            `[watchdog] server=${state.server.name} status=stale lastActivityAt=${lastActivityAt.toISOString()} ageMs=${ageMs} running=${state.running}`
          );
        } else {
          console.log(
            `[watchdog] server=${state.server.name} status=ok lastActivityAt=${lastActivityAt.toISOString()} ageMs=${ageMs} running=${state.running}`
          );
        }
      }
    }, watchdogIntervalMs);
  }

  async fetchHealth(server) {
    const startedAt = Date.now();
    const checkedAt = new Date();

    try {
      const response = await axios.get(server.url, {
        timeout: this.config.requestTimeoutMs,
        validateStatus: () => true,
      });

      const payload = response.data;
      const payloadMatchesExpected = isExpectedHealthyPayload(payload);
      const isHealthy = response.status === 200;

      return {
        checkedAt,
        httpStatus: response.status,
        isHealthy,
        payload,
        responseTimeMs: Date.now() - startedAt,
        failureReason: isHealthy
          ? null
          : `Unexpected HTTP status ${response.status}`,
        payloadWarning: payloadMatchesExpected ? null : "Unexpected response payload",
      };
    } catch (error) {
      return {
        checkedAt,
        httpStatus: null,
        isHealthy: false,
        payload: null,
        responseTimeMs: Date.now() - startedAt,
        failureReason: error.code || error.message,
      };
    }
  }

  async handleFailure(state, healthCheck) {
    state.consecutiveFailures += 1;
    state.consecutiveSuccesses = 0;
    state.inRetryMode = true;
    state.lastError = healthCheck.failureReason;
    state.recoveryStartedAt = null;

    console.log(
      `[event] failure server=${state.server.name} consecutiveFailures=${state.consecutiveFailures} checkedAt=${healthCheck.checkedAt.toISOString()} reason="${healthCheck.failureReason}"`
    );

    if (!state.firstFailureAt) {
      state.firstFailureAt = healthCheck.checkedAt;
      state.firstFailureCheckId = healthCheck._id;
    }

    if (state.currentStatus !== "down" && state.consecutiveFailures >= this.config.downFailureThreshold) {
      state.currentStatus = "down";

      const incident = await Incident.create({
        serverName: state.server.name,
        serverUrl: state.server.url,
        startedAt: state.firstFailureAt,
        detectedDownAt: healthCheck.checkedAt,
        status: "ongoing",
        startCheckId: state.firstFailureCheckId,
        lastFailureReason: healthCheck.failureReason,
        failureCountAtDetection: state.consecutiveFailures,
      });

      state.currentIncidentId = incident._id;
      console.log(
        `[event] incident_opened server=${state.server.name} incidentId=${incident._id} startedAt=${incident.startedAt.toISOString()} detectedDownAt=${incident.detectedDownAt.toISOString()} failureCount=${state.consecutiveFailures}`
      );

      await this.sendAlert(this.config.alertWebhookUrl, {
        eventType: "server_down",
        serverName: state.server.name,
        serverUrl: state.server.url,
        detectedAt: healthCheck.checkedAt.toISOString(),
        incidentStart: state.firstFailureAt.toISOString(),
        reason: healthCheck.failureReason,
      });

      incident.alertDownSentAt = new Date();
      await incident.save();
    }
  }

  async handleSuccess(state, healthCheck) {
    state.lastHealthyAt = healthCheck.checkedAt;
    state.lastError = null;

    console.log(
      `[event] success server=${state.server.name} checkedAt=${healthCheck.checkedAt.toISOString()} currentStatus=${state.currentStatus}`
    );

    if (state.currentStatus === "down") {
      state.consecutiveSuccesses += 1;

      if (!state.recoveryStartedAt) {
        state.recoveryStartedAt = healthCheck.checkedAt;
      }

      console.log(
        `[event] recovery_progress server=${state.server.name} consecutiveSuccesses=${state.consecutiveSuccesses} recoveryStartedAt=${state.recoveryStartedAt.toISOString()}`
      );

      if (state.consecutiveSuccesses >= this.config.upSuccessThreshold) {
        const incident = await Incident.findById(state.currentIncidentId);

        if (incident) {
          incident.endedAt = state.recoveryStartedAt;
          incident.detectedUpAt = healthCheck.checkedAt;
          incident.endCheckId = healthCheck._id;
          incident.status = "resolved";
          incident.recoverySuccessCountAtDetection = state.consecutiveSuccesses;

          console.log(
            `[event] incident_resolved server=${state.server.name} incidentId=${incident._id} startedAt=${incident.startedAt.toISOString()} endedAt=${incident.endedAt.toISOString()} detectedUpAt=${incident.detectedUpAt.toISOString()}`
          );

          await this.sendAlert(this.config.alertWebhookUrl, {
            eventType: "server_up",
            serverName: state.server.name,
            serverUrl: state.server.url,
            detectedAt: healthCheck.checkedAt.toISOString(),
            incidentStart: incident.startedAt.toISOString(),
            incidentEnd: incident.endedAt.toISOString(),
            durationSeconds: Math.round(
              (incident.endedAt.getTime() - incident.startedAt.getTime()) / 1000
            ),
          });

          incident.alertUpSentAt = new Date();
          await incident.save();
        }

        state.currentStatus = "healthy";
        state.currentIncidentId = null;
        state.consecutiveFailures = 0;
        state.consecutiveSuccesses = 0;
        state.firstFailureAt = null;
        state.firstFailureCheckId = null;
        state.recoveryStartedAt = null;
        state.inRetryMode = false;
      }

      return;
    }

    state.currentStatus = "healthy";
    state.consecutiveFailures = 0;
    state.consecutiveSuccesses = 0;
    state.firstFailureAt = null;
    state.firstFailureCheckId = null;
    state.recoveryStartedAt = null;
    state.inRetryMode = false;
  }

  async sendAlert(url, payload) {
    try {
      console.log(
        `[event] alert_send type=${payload.eventType} server=${payload.serverName} webhookConfigured=${Boolean(url)}`
      );
      await postJson(url, payload);
      console.log(`[event] alert_result type=${payload.eventType} server=${payload.serverName} status=success`);
    } catch (error) {
      console.error(`Webhook delivery failed for ${payload.serverName}:`, error.message);
    }
  }
}

module.exports = MonitorService;
