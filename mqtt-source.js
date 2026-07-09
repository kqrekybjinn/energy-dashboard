// =============================================================================
// mqtt-source.js  —  能源管理终端 MQTT 多通道数据源 v2
//
// 订阅 4 个节点 + system + voice + aggregate，汇总为统一数据帧。
// =============================================================================

// ---- helpers ----------------------------------------------------------------

const MQTT_CONFIG_KEY = "energy-dashboard-mqtt-config";
const DEFAULT_MQTT = {
  brokerUrl: "ws://192.168.137.1:8083/mqtt",
  deviceId: "rk3506",
  username: "",
  password: "",
};

function loadMqttConfig() {
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(MQTT_CONFIG_KEY) || "null") || {}; }
  catch { cfg = {}; }
  return {
    brokerUrl: cfg.brokerUrl || localStorage.getItem("mqtt_broker") || DEFAULT_MQTT.brokerUrl,
    deviceId: cfg.deviceId || localStorage.getItem("mqtt_device_id") || DEFAULT_MQTT.deviceId,
    username: cfg.username ?? localStorage.getItem("mqtt_username") ?? DEFAULT_MQTT.username,
    password: cfg.password ?? localStorage.getItem("mqtt_password") ?? DEFAULT_MQTT.password,
  };
}

function t(base, path) {
  const b = base.replace(/\/$/, "");
  return `${b}/${path.replace(/^\//, "")}`;
}

// ---- 空数据帧 ----------------------------------------------------------------

function emptyMPPT() {
  return {
    solar_voltage: 0, solar_current: 0, solar_power: 0,
    battery_voltage: 0, battery_current: 0, battery_power: 0,
    battery_soc: 0, battery_temp: 0,
    charge_mode: "OFF", pwm_duty: 0, efficiency: 0, error_code: 0,
  };
}

function emptyChannel(letter) {
  return {
    letter, enabled: false,
    label: `通道 ${letter.toUpperCase()}`,
    set_voltage: 0,
    set_current: 0,
    current_limit: 0,
    actual_voltage: 0, actual_current: 0, actual_power: 0,
    temperature: 0, error_code: 0,
  };
}

// ---- 字段标准化 ------------------------------------------------------------

function normalizeMPPT(raw) {
  return {
    solar_voltage:  raw.solar_voltage  ?? raw.solarVin   ?? raw.vin_solar  ?? 0,
    solar_current:  raw.solar_current  ?? raw.solarIin   ?? raw.iin_solar  ?? 0,
    solar_power:    raw.solar_power    ?? raw.solarPin   ?? raw.pin_solar  ?? 0,
    battery_voltage:raw.battery_voltage?? raw.batteryVout ?? raw.vout       ?? 0,
    battery_current:raw.battery_current?? raw.batteryIout ?? raw.iout       ?? 0,
    battery_power:  raw.battery_power  ?? raw.batteryPout?? raw.pout        ?? 0,
    battery_soc:    raw.battery_soc    ?? raw.soc        ?? raw.SOC        ?? raw.batterySOC ?? 0,
    battery_temp:   raw.battery_temp   ?? raw.temp       ?? raw.TEMP       ?? 0,
    charge_mode:    raw.charge_mode    ?? raw.mode       ?? raw.chargeMode ?? "OFF",
    pwm_duty:       raw.pwm_duty       ?? raw.duty       ?? raw.PWM        ?? 0,
    efficiency:     raw.efficiency     ?? raw.eff        ?? 0,
    error_code:     raw.error_code     ?? raw.error      ?? 0,
    ts:             raw.ts ?? Date.now(),
  };
}

function normalizeChannel(raw) {
  return {
    enabled:        raw.enabled        ?? raw.state     ?? raw.output    ?? false,
    label:          raw.label          ?? raw.name      ?? "",
    set_voltage:    raw.set_voltage    ?? raw.setV      ?? raw.target_voltage ?? 0,
    set_current:    raw.set_current    ?? raw.current_limit ?? raw.setI ?? raw.target_current ?? 0,
    current_limit:  raw.current_limit  ?? raw.set_current ?? raw.setI ?? raw.target_current ?? 0,
    actual_voltage: raw.actual_voltage ?? raw.voltage   ?? raw.Vout      ?? raw.v ?? 0,
    actual_current: raw.actual_current ?? raw.current   ?? raw.Iout      ?? raw.i ?? 0,
    actual_power:   raw.actual_power   ?? raw.power     ?? raw.Pout      ?? 0,
    temperature:    raw.temperature    ?? raw.temp      ?? 0,
    error_code:     raw.error_code     ?? raw.error     ?? 0,
    ts:             raw.ts ?? Date.now(),
  };
}

function normalizeSystem(raw) {
  return {
    cpu_pct:       raw.cpu_pct       ?? raw.cpu  ?? 0,
    mem_mb:        raw.mem_mb        ?? raw.mem  ?? 0,
    disk_mb:       raw.disk_mb       ?? raw.disk ?? 0,
    signal_dbm:    raw.signal_dbm    ?? raw.signal ?? raw.rssi ?? 0,
    network_type:  raw.network_type  ?? raw.net   ?? "LTE",
    uptime_s:      raw.uptime_s      ?? raw.uptime ?? 0,
    ts:            raw.ts ?? Date.now(),
  };
}

// ---- 主类 ------------------------------------------------------------------

export function createMQTTSource() {
  let client = null;
  let deviceId = "";
  let prefix = "energy";
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let started = false;
  let topics = [];
  let onData = null;
  let onStatus = null;

  const cache = {
    mppt: emptyMPPT(),
    channel_a: emptyChannel("a"),
    channel_b: emptyChannel("b"),
    channel_c: emptyChannel("c"),
    system: { cpu_pct: 0, mem_mb: 0, disk_mb: 0, signal_dbm: 0, network_type: "LTE", uptime_s: 0 },
    voice: null,
    aggregate: null,
  };

  function buildFrame() {
    return {
      mppt:       { ...cache.mppt },
      channel_a:  { ...cache.channel_a },
      channel_b:  { ...cache.channel_b },
      channel_c:  { ...cache.channel_c },
      system:     { ...cache.system },
      voice:      cache.voice ? { ...cache.voice } : null,
      aggregate:  cache.aggregate ? { ...cache.aggregate } : null,
    };
  }

  function emitFrame() { if (onData) onData(buildFrame()); }

  function dispatch(topic, payloadStr) {
    let obj;
    try { obj = JSON.parse(payloadStr); } catch (_) { return; }
    if (!obj || typeof obj !== "object") return;

    const rel = topic.replace(t(prefix, deviceId) + "/", "");

    if (rel === "mppt/telemetry") {
      cache.mppt = normalizeMPPT(obj);
      emitFrame();
    } else if (rel.startsWith("channel/") && rel.endsWith("/telemetry")) {
      const ch = rel.slice("channel/".length, -"/telemetry".length);
      const key = `channel_${ch}`;
      if (cache[key] !== undefined) {
        cache[key] = { ...normalizeChannel(obj), letter: ch };
        emitFrame();
      }
    } else if (rel === "system/status") {
      cache.system = { ...cache.system, ...normalizeSystem(obj) };
      emitFrame();
    } else if (rel === "system/voice/event") {
      cache.voice = obj;
      emitFrame();
    } else if (rel === "aggregate") {
      cache.aggregate = obj;
    }
  }

  function connect() {
    if (!deviceId) return;

    const cfg = loadMqttConfig();
    const brokerUrl = cfg.brokerUrl;
    const username = cfg.username || "";
    const password = cfg.password || "";

    reportStatus("connecting");

    const base = t(prefix, deviceId);
    topics = [
      `${base}/mppt/telemetry`,
      `${base}/channel/a/telemetry`,
      `${base}/channel/b/telemetry`,
      `${base}/channel/c/telemetry`,
      `${base}/system/status`,
      `${base}/system/voice/event`,
      `${base}/aggregate`,
    ];

    try {
      const options = {
        protocolVersion: 5,
        clientId: `web_${deviceId}_${Date.now()}`,
        clean: true, keepalive: 30,
        connectTimeout: 10000,
        reconnectPeriod: 0,
      };
      if (username) options.username = username;
      if (password) options.password = password;
      client = mqtt.connect(brokerUrl, {
        ...options,
      });
    } catch (e) {
      reportStatus("error", `mqtt.connect 失败: ${e.message}`);
      return;
    }

    client.on("connect", () => {
      reportStatus("connected");
      reconnectAttempt = 0;
      topics.forEach((tp) => client.subscribe(tp, { qos: 1 }, (err) => {
        if (err) console.warn("[mqtt] sub fail:", tp, err.message);
      }));
    });

    client.on("message", (tp, payload) => dispatch(tp, payload.toString()));

    client.on("error", (err) => {
      console.error("[mqtt] error:", err.message);
      reportStatus("error", err.message);
    });

    client.on("close", () => {
      if (started) { reportStatus("disconnected", "连接已断开，自动重连中…"); scheduleReconnect(); }
      else reportStatus("disconnected");
    });
  }

  function disconnect() {
    clearReconnect();
    if (client) { client.end(true); client = null; }
  }

  function scheduleReconnect() {
    clearReconnect();
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => { if (started) connect(); }, delay);
  }

  function clearReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function reportStatus(state, detail) {
    if (onStatus) onStatus({ state, detail: detail || "", ts: Date.now() });
  }

  // ---- Public API ----------------------------------------------------------

  return {
    start(id, pfx) {
      const cfg = loadMqttConfig();
      deviceId = id || cfg.deviceId || DEFAULT_MQTT.deviceId;
      prefix   = pfx || "energy";
      started  = true;
      disconnect();
      connect();
    },

    stop() { started = false; disconnect(); },

    /** 发送命令到指定节点: "mppt", "channel_a", "channel_b", "channel_c", "system" */
    sendCommand(node, cmd) {
      if (!client || !client.connected) {
        console.warn("[mqtt] sendCommand ignored — not connected");
        return;
      }
      const base = t(prefix, deviceId);
      let cmdTopic;
      if (node === "system") cmdTopic = `${base}/system/command`;
      else if (node === "mppt") cmdTopic = `${base}/mppt/command`;
      else if (node.startsWith("channel_")) cmdTopic = `${base}/${node.replace("_", "/")}/command`;
      else cmdTopic = `${base}/${node}/command`;

      client.publish(cmdTopic, JSON.stringify(cmd), { qos: 1 });
    },

    onData(cb) { onData = cb; },
    onStatus(cb) { onStatus = cb; },
    getTopics() { return [...topics]; },
    getCache() { return buildFrame(); },
  };
}
