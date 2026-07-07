// ============================================================
//  MQTT Source — 针能管理终端 MQTT 数据源
//
//  协议层抽象，暴露与模拟源一致的接口：
//    { start(), stop(), onData(fn), sendCommand(cmd) }
//
//  对接 RK3506 网关时，网关按 PROTOCOL.md 定义的 JSON 载荷
//  发布到对应 topic 即可。
// ============================================================

export const MQTT_SOURCE_VERSION = 1;

const DEFAULT_TOPIC_PREFIX = "energy";

/**
 * createMqttSource(opts)
 *
 * opts.brokerUrl   — MQTT broker WSS 地址，如 "wss://broker.emqx.io:8084/mqtt"
 * opts.deviceId    — 设备/网关唯一 ID
 * opts.username    — (可选) broker 用户名
 * opts.password    — (可选) broker 密码
 * opts.topicPrefix — (可选) topic 前缀，默认 "energy"
 */
export function createMqttSource(opts = {}) {
  const brokerUrl = String(opts.brokerUrl || "").trim();
  const deviceId = String(opts.deviceId || "").trim();
  const username = String(opts.username || "").trim();
  const password = String(opts.password || "").trim();
  const topicPrefix = String(opts.topicPrefix || DEFAULT_TOPIC_PREFIX).replace(/\/$/, "");

  // MQTT client instance
  let client = null;
  let running = false;
  let dataCallback = null;
  let statusCallback = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_DELAY = 30_000; // 30s max backoff

  const TELEMETRY_TOPIC = `${topicPrefix}/${deviceId}/telemetry`;
  const COMMAND_TOPIC = `${topicPrefix}/${deviceId}/command`;

  function log(level, ...args) {
    if (statusCallback) {
      statusCallback({ type: "log", level, message: args.join(" ") });
    }
    console[level]("[MQTT]", ...args);
  }

  function statusChange(state, detail = "") {
    if (statusCallback) {
      statusCallback({ type: "status", state, detail });
    }
  }

  function connect() {
    if (!brokerUrl || !deviceId) {
      statusChange("error", "Broker 地址或设备 ID 未配置");
      return Promise.reject(new Error("Broker 地址或设备 ID 未配置"));
    }

    return new Promise((resolve, reject) => {
      // Clean up existing client
      if (client) {
        try { client.end(true); } catch (_) { /* ignore */ }
        client = null;
      }

      statusChange("connecting");

      const connectOpts = {
        clean: true,
        connectTimeout: 10_000,
        reconnectPeriod: 0, // We handle reconnection ourselves
      };
      if (username) connectOpts.username = username;
      if (password) connectOpts.password = password;

      try {
        client = window.mqtt.connect(brokerUrl, connectOpts);
      } catch (err) {
        statusChange("error", err.message);
        return reject(err);
      }

      const timeoutId = setTimeout(() => {
        if (client && !client.connected) {
          client.end(true);
          client = null;
          statusChange("error", "连接超时");
          reject(new Error("MQTT 连接超时"));
        }
      }, 12_000);

      client.on("connect", () => {
        clearTimeout(timeoutId);
        reconnectAttempts = 0;
        log("info", `已连接 → ${brokerUrl}`);

        // Subscribe to telemetry topic
        client.subscribe(TELEMETRY_TOPIC, { qos: 1 }, (err) => {
          if (err) {
            log("warn", `订阅遥测失败: ${err.message}`);
            statusChange("error", `订阅失败: ${err.message}`);
            return reject(err);
          }
          statusChange("connected");
          log("info", `已订阅遥测 → ${TELEMETRY_TOPIC}`);
          resolve();
        });
      });

      client.on("message", (topic, payload) => {
        try {
          const str = payload.toString();
          const data = JSON.parse(str);
          if (topic === TELEMETRY_TOPIC && dataCallback) {
            dataCallback(parseTelemetry(data));
          }
        } catch (err) {
          // Ignore non-JSON payloads
          log("warn", `无法解析消息: ${topic}`);
        }
      });

      client.on("error", (err) => {
        clearTimeout(timeoutId);
        log("error", err.message);
        statusChange("error", err.message);
        if (!client || !client.connected) {
          reject(err);
        }
      });

      client.on("close", () => {
        log("info", "连接已关闭");
        statusChange("disconnected");
        if (running) {
          scheduleReconnect();
        }
      });

      client.on("offline", () => {
        statusChange("offline");
      });
    });
  }

  function scheduleReconnect() {
    if (!running) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);

    const delay = Math.min(
      30_000,
      1000 * Math.pow(2, Math.min(reconnectAttempts, 5)),
    );
    reconnectAttempts++;
    statusChange("reconnecting", `${Math.round(delay / 1000)}s 后重试 (第 ${reconnectAttempts} 次)`);
    log("info", `${Math.round(delay / 1000)}s 后重连...`);

    reconnectTimer = setTimeout(() => {
      if (!running) return;
      connect().catch(() => {
        // scheduleReconnect will be called from 'close' handler
      });
    }, delay);
  }

  function parseTelemetry(raw) {
    // Normalize incoming data to the shape the dashboard expects
    return {
      metrics: {
        vin: Number(raw.vin ?? raw.Vin ?? raw.VIN ?? 0),
        iin: Number(raw.iin ?? raw.Iin ?? raw.IIN ?? 0),
        pin: Number(raw.pin ?? raw.Pin ?? raw.PIN ?? raw.vin * raw.iin ?? 0),
        vout: Number(raw.vout ?? raw.Vout ?? raw.VOUT ?? 0),
        iout: Number(raw.iout ?? raw.Iout ?? raw.IOUT ?? 0),
        pout: Number(raw.pout ?? raw.Pout ?? raw.POUT ?? raw.vout * raw.iout ?? 0),
        efficiency: Number(raw.efficiency ?? raw.eff ?? raw.Efficiency ?? 0),
        temp: Number(raw.temp ?? raw.temperature ?? raw.Temp ?? 0),
      },
      pwm: {
        pwmc: Math.round(Number(raw.pwmc ?? raw.PWMC ?? 0)),
        pwm: Math.round(Number(raw.pwm ?? raw.PWM ?? 0)),
        ppwm: Math.round(Number(raw.ppwm ?? raw.PPWM ?? 0)),
      },
      status: {
        buckMode: String(raw.buck_mode ?? raw.buckMode ?? "BUCK"),
        antiBackflow: raw.anti_backflow ?? raw.antiBackflow ?? true ? "正常" : "异常",
        driverEnabled: Boolean(raw.driver_enabled ?? raw.driverEnabled ?? true),
        errorCode: Number(raw.error_code ?? raw.errorCode ?? 0),
      },
      rawFields: [
        Number(raw.vin ?? raw.Vin ?? raw.VIN ?? 0),
        Number(raw.vout ?? raw.Vout ?? raw.VOUT ?? 0),
        Number(raw.iin ?? raw.Iin ?? raw.IIN ?? 0),
        Number(raw.iout ?? raw.Iout ?? raw.IOUT ?? 0),
        Number(raw.pin ?? raw.Pin ?? raw.PIN ?? raw.vin * raw.iin ?? 0),
        Number(raw.pout ?? raw.Pout ?? raw.POUT ?? raw.vout * raw.iout ?? 0),
      ],
    };
  }

  // ============================================================
  //  Public API (同 simulation source 接口)
  // ============================================================

  return {
    /** 开始连接并订阅数据 */
    start() {
      running = true;
      return connect();
    },

    /** 断开连接 */
    stop() {
      running = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (client) {
        try {
          client.unsubscribe(TELEMETRY_TOPIC);
          client.end(true);
        } catch (_) { /* ignore */ }
        client = null;
      }
      statusChange("disconnected");
    },

    /** 注册遥测数据回调 */
    onData(cb) {
      dataCallback = cb;
    },

    /** 注册状态变更回调（连接状态、日志） */
    onStatus(cb) {
      statusCallback = cb;
    },

    /** 下发命令到网关 */
    sendCommand(cmd) {
      if (!client || !client.connected) {
        console.warn("[MQTT] 未连接，无法发送命令:", cmd);
        return;
      }
      const payload = JSON.stringify({
        cmd: String(cmd),
        ts: Date.now(),
      });
      client.publish(COMMAND_TOPIC, payload, { qos: 1 }, (err) => {
        if (err) {
          console.error("[MQTT] 命令发送失败:", err.message);
        } else {
          console.log("[MQTT] 命令已发送:", cmd);
        }
      });
    },

    /** 获取当前 topic 信息（调试用） */
    getTopics() {
      return {
        telemetry: TELEMETRY_TOPIC,
        command: COMMAND_TOPIC,
      };
    },

    /** 是否已连接 */
    get connected() {
      return client ? client.connected : false;
    },
  };
}
