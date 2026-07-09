import assert from "node:assert/strict";
import { DEFAULT_MQTT_CONFIG, commandTopic, hasChannelStructureChange, normalizeMqttConfig } from "../protocol.js";

assert.equal(
  DEFAULT_MQTT_CONFIG.brokerUrl,
  "wss://w0378faf.ala.cn-shenzhen.emqxsl.cn:8084/mqtt",
  "GitHub Pages must default to EMQX Cloud WSS"
);
assert.equal(DEFAULT_MQTT_CONFIG.deviceId, "rk3506");
assert.equal(DEFAULT_MQTT_CONFIG.username, "rk3506");
assert.equal(DEFAULT_MQTT_CONFIG.password, "", "Do not commit the EMQX password into static assets");

assert.equal(commandTopic("energy", "rk3506", "channel_a"), "energy/rk3506/channel/a/command");
assert.equal(commandTopic("energy", "rk3506", "channel_b"), "energy/rk3506/channel/b/command");
assert.equal(commandTopic("energy", "rk3506", "channel_c"), "energy/rk3506/channel/c/command");
assert.equal(commandTopic("energy", "rk3506", "mppt"), "energy/rk3506/mppt/command");
assert.equal(commandTopic("energy", "rk3506", "system"), "energy/rk3506/system/command");

assert.deepEqual(
  normalizeMqttConfig({ brokerUrl: "ws://192.168.137.1:8083/mqtt", deviceId: "rk3506", username: "", password: "" }),
  DEFAULT_MQTT_CONFIG,
  "legacy local default should migrate to EMQX Cloud defaults"
);

assert.equal(
  normalizeMqttConfig({ brokerUrl: "ws://custom-broker:8083/mqtt", deviceId: "abc" }).brokerUrl,
  "ws://custom-broker:8083/mqtt",
  "custom broker settings must not be overwritten"
);

assert.equal(
  hasChannelStructureChange({ enabled: false, set_voltage: 12, set_current: 1 }, { enabled: true, set_voltage: 12, set_current: 1 }),
  true,
  "channel enabled changes must trigger a dashboard rerender"
);
assert.equal(
  hasChannelStructureChange({ enabled: true, set_voltage: 12, set_current: 1 }, { enabled: true, set_voltage: 13.7, set_current: 1 }),
  true,
  "setpoint changes must trigger a dashboard rerender"
);
assert.equal(
  hasChannelStructureChange({ enabled: true, set_voltage: 12, set_current: 1, actual_voltage: 11.9 }, { enabled: true, set_voltage: 12, set_current: 1, actual_voltage: 12.1 }),
  false,
  "fast-changing actual measurements should not force a full rerender"
);

console.log("protocol tests passed");
