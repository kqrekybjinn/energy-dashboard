export const MQTT_PREFIX = "energy";

export const DEFAULT_MQTT_CONFIG = {
  brokerUrl: "wss://w0378faf.ala.cn-shenzhen.emqxsl.cn:8084/mqtt",
  deviceId: "rk3506",
  username: "rk3506",
  password: "",
};

export const DASHBOARD_RUNTIME_DEFAULTS = {
  autoConnect: true,
  autoRecord: true,
};

const LEGACY_DEFAULT_MQTT_CONFIG = {
  brokerUrl: "ws://192.168.137.1:8083/mqtt",
  deviceId: "rk3506",
  username: "",
  password: "",
};

export function normalizeMqttConfig(input = {}) {
  const cfg = {
    brokerUrl: input.brokerUrl || DEFAULT_MQTT_CONFIG.brokerUrl,
    deviceId: input.deviceId || DEFAULT_MQTT_CONFIG.deviceId,
    username: input.username ?? DEFAULT_MQTT_CONFIG.username,
    password: input.password ?? DEFAULT_MQTT_CONFIG.password,
  };
  const isLegacyDefault =
    cfg.brokerUrl === LEGACY_DEFAULT_MQTT_CONFIG.brokerUrl &&
    cfg.deviceId === LEGACY_DEFAULT_MQTT_CONFIG.deviceId &&
    cfg.username === LEGACY_DEFAULT_MQTT_CONFIG.username &&
    cfg.password === LEGACY_DEFAULT_MQTT_CONFIG.password;
  return isLegacyDefault ? { ...DEFAULT_MQTT_CONFIG } : cfg;
}

export function topic(prefix, deviceId, path) {
  const base = `${String(prefix || MQTT_PREFIX).replace(/\/$/, "")}/${String(deviceId || DEFAULT_MQTT_CONFIG.deviceId).replace(/^\/|\/$/g, "")}`;
  const cleanPath = String(path || "").replace(/^\//, "");
  return cleanPath ? `${base}/${cleanPath}` : base;
}

export function commandTopic(prefix, deviceId, node) {
  if(node === "system") return topic(prefix, deviceId, "system/command");
  if(node === "mppt") return topic(prefix, deviceId, "mppt/command");
  if(String(node).startsWith("channel_")) return topic(prefix, deviceId, `${String(node).replace("_", "/")}/command`);
  return topic(prefix, deviceId, `${node}/command`);
}

export function hasChannelStructureChange(before = {}, after = {}) {
  return Boolean(before.enabled) !== Boolean(after.enabled) ||
    Number(before.set_voltage ?? 0) !== Number(after.set_voltage ?? 0) ||
    Number(before.set_current ?? before.current_limit ?? 0) !== Number(after.set_current ?? after.current_limit ?? 0) ||
    Number(before.current_limit ?? before.set_current ?? 0) !== Number(after.current_limit ?? after.set_current ?? 0);
}
