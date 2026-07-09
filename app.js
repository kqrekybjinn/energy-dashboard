import { cloud, CLOUD_API_VERSION } from "./cloud.js";
import { createMQTTSource } from "./mqtt-source.js";
import { DEFAULT_MQTT_CONFIG, normalizeMqttConfig } from "./protocol.js";

const DB_NAME = "energy-dashboard-db";
const DB_VERSION = 1;
const APP_VERSION_KEY = "energy-dashboard-app-version";
const SW_CACHE_PREFIX = "energy-dashboard-";
const MQTT_CONFIG_KEY = "energy-dashboard-mqtt-config";
function loadMqttConfig() {
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(MQTT_CONFIG_KEY) || "null") || {}; }
  catch { cfg = {}; }
  cfg = {
    brokerUrl: cfg.brokerUrl || localStorage.getItem("mqtt_broker") || DEFAULT_MQTT_CONFIG.brokerUrl,
    deviceId: cfg.deviceId || localStorage.getItem("mqtt_device_id") || DEFAULT_MQTT_CONFIG.deviceId,
    username: cfg.username ?? localStorage.getItem("mqtt_username") ?? DEFAULT_MQTT_CONFIG.username,
    password: cfg.password ?? localStorage.getItem("mqtt_password") ?? DEFAULT_MQTT_CONFIG.password,
  };
  return normalizeMqttConfig(cfg);
}
function saveMqttConfig(cfg) {
  localStorage.setItem(MQTT_CONFIG_KEY, JSON.stringify(cfg));
  localStorage.setItem("mqtt_broker", cfg.brokerUrl || "");
  localStorage.setItem("mqtt_device_id", cfg.deviceId || "");
  localStorage.setItem("mqtt_username", cfg.username || "");
  localStorage.setItem("mqtt_password", cfg.password || "");
}

// ---- 默认空帧 ---------------------------------------------------------------

function emptyMPPT() { return { solar_voltage:0, solar_current:0, solar_power:0, battery_voltage:0, battery_current:0, battery_power:0, battery_soc:0, battery_temp:0, charge_mode:"OFF", pwm_duty:0, efficiency:0, error_code:0 }; }
function emptyChannel(letter) { return { letter, enabled:false, label:`通道 ${letter.toUpperCase()}`, set_voltage:0, set_current:0, current_limit:0, actual_voltage:0, actual_current:0, actual_power:0, temperature:0, error_code:0 }; }

// ---- 应用状态 ---------------------------------------------------------------

const state = {
  view: "dashboard",
  cloudConfigured: cloud.configured,
  cloudUser: null, cloudProfile: null, cloudReady: false,
  appVersion: { current: localStorage.getItem(APP_VERSION_KEY) || "", latest: "", checking: true, updateAvailable: false, error: "" },

  // Data source
  sourceMode: "mqtt",      // "sim" | "mqtt"
  deviceConnected: false,
  streaming: false,
  sampleCount: 300,
  chartMode: "wave",       // "wave" | "raw"
  selectedNode: "mppt",    // 波形图当前选中的节点

  // Multi-channel live data
  mppt: emptyMPPT(),
  channel_a: emptyChannel("a"),
  channel_b: emptyChannel("b"),
  channel_c: emptyChannel("c"),
  system: { cpu_pct:0, mem_mb:0, disk_mb:0, signal_dbm:0, network_type:"LTE", uptime_s:0 },
  voice: null,

  // Per-node time-series for waveform chart
  nodeSeries: { mppt:[], channel_a:[], channel_b:[], channel_c:[] },

  // MQTT config
  mqtt: {
    brokerUrl: loadMqttConfig().brokerUrl || DEFAULT_MQTT_CONFIG.brokerUrl,
    deviceId: loadMqttConfig().deviceId || DEFAULT_MQTT_CONFIG.deviceId,
    username: loadMqttConfig().username ?? DEFAULT_MQTT_CONFIG.username,
    password: loadMqttConfig().password ?? DEFAULT_MQTT_CONFIG.password,
  },
  mqttStatus: { state:"idle", detail:"" },
  mqttLogs: [],

  // Chart channels (derived from selectedNode)
  channels: [],
  rawLines: [],
};

const view = document.querySelector("#view");
const toast = document.querySelector("#toast");
let dbPromise = null;
let toastTimer = null;
let dataSource = null;
let chart = null;
let chartTimer = null;

boot();

async function boot() {
  bindGlobalEvents();
  await initCloud();
  registerServiceWorker();
  checkAppVersion();
  render();
}

// ============================================================
//  Cloud init
// ============================================================

async function initCloud() {
  if (!state.cloudConfigured) { state.cloudReady = true; return; }
  cloud.handleAuthRedirect();
  if (!cloud.session?.access_token) { state.cloudReady = true; return; }
  try {
    const user = await cloud.getUser();
    state.cloudUser = user;
    state.cloudProfile = await cloud.getMyProfile(user.id);
  } catch (error) {
    console.warn("云端会话失效", error);
    cloud.clearSession();
    state.cloudUser = null; state.cloudProfile = null;
  } finally { state.cloudReady = true; }
}

// ============================================================
//  Global events
// ============================================================

function bindGlobalEvents() {
  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.addEventListener("click", () => { state.view = btn.dataset.view; render(); });
  });
  view.addEventListener("click", handleViewClick);
  view.addEventListener("input", handleViewInput);
}

async function handleViewClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const a = target.dataset.action;

  // Auth
  if (a === "sign-in-provider") await signInProvider(target.dataset.provider || "github");
  if (a === "sign-out") await signOutCloud();
  if (a === "save-profile") await saveProfile();
  if (a === "refresh-app") await refreshAppAssets();

  // Device
  if (a === "device-connect") await toggleDeviceConnection();
  if (a === "stream-toggle") toggleStreaming();
  if (a === "chart-wave") { state.chartMode = "wave"; render(); }
  if (a === "chart-raw") { state.chartMode = "raw"; render(); }

  // Node selection for chart
  if (a === "select-node") {
    state.selectedNode = target.dataset.node;
    rebuildChannels();
    render();
  }

  // Channel control
  if (a === "ch-toggle") sendChannelToggle(target.dataset.channel);
  if (a === "ch-set-voltage") sendChannelSetVoltage(target.dataset.channel);
  if (a === "ch-set-current") sendChannelSetCurrent(target.dataset.channel);
  if (a === "mppt-set-mode") sendMpptSetMode(target.dataset.mode);

  // System
  if (a === "system-restart") { dataSource?.sendCommand("system", { cmd:"restart" }); showToast("已发送重启指令"); }
  if (a === "system-fwupdate") { dataSource?.sendCommand("system", { cmd:"firmware_update" }); showToast("已发送固件升级指令"); }

  // MQTT config
  if (a === "mqtt-save") saveMqttConfigToState();
  if (a === "source-mode") {
    state.sourceMode = target.dataset.mode;
    if (state.deviceConnected) { disconnectDevice(); showToast(`已切换到 ${state.sourceMode==="mqtt"?"MQTT":"模拟"} 模式，请重新连接`); }
    render();
  }
}

function handleViewInput(event) {
  const t = event.target;
  if (t.id === "sampleCount") state.sampleCount = Number(t.value) || 300;
}

// ============================================================
//  Render dispatch
// ============================================================

function render() {
  document.querySelectorAll(".tab-button").forEach((b) => b.classList.toggle("is-active", b.dataset.view === state.view));
  if (state.view === "dashboard") renderDashboard();
  if (state.view === "data") renderData();
  if (state.view === "settings") renderSettings();
}

// ============================================================
//  DASHBOARD — 多节点面板 + 波形图
// ============================================================

function renderDashboard() {
  view.innerHTML = `
    <div class="dashboard-grid">
      <div class="dash-left">
        ${renderDeviceBar()}
        ${renderNodeCardMPPT()}
        ${renderNodeCardChannel("a")}
        ${renderNodeCardChannel("b")}
        ${renderNodeCardChannel("c")}
        ${renderSystemBar()}
      </div>
      <div class="dash-right">
        ${renderChartPanel()}
      </div>
    </div>
  `;
  if (state.chartMode === "wave" && state.streaming) initChart();
}

// ---- 设备连接条 -------------------------------------------------------------

function renderDeviceBar() {
  const dot = state.deviceConnected ? '<span class="conn-dot on"></span>' : '<span class="conn-dot"></span>';
  const label = state.deviceConnected
    ? (state.sourceMode === "mqtt" ? `MQTT · ${escapeHtml(state.mqtt.deviceId)}` : "模拟数据")
    : "未连接";
  const btnLabel = state.streaming ? "⏹ 停止" : state.deviceConnected ? "▶ 开始" : "连接";
  const btnAction = state.streaming ? "stream-toggle" : state.deviceConnected ? "stream-toggle" : "device-connect";

  return `
    <section class="panel device-bar">
      <div class="device-bar-left">${dot}<span class="device-bar-label">${label}</span></div>
      <div class="device-bar-right">
        ${state.deviceConnected ? `<span class="device-bar-samples">${state.sampleCount} 点</span>` : ""}
        <button class="button small-button" type="button" data-action="${btnAction}">${btnLabel}</button>
      </div>
    </section>
  `;
}

// ---- MPPT 节点卡片 ---------------------------------------------------------

function renderNodeCardMPPT() {
  const m = state.mppt;
  const selected = state.selectedNode === "mppt" ? " node-card--selected" : "";
  const soc = m.battery_soc || 0;
  const socColor = soc > 60 ? "var(--good)" : soc > 20 ? "#d97706" : "var(--danger)";

  return `
    <section class="panel node-card${selected}" data-action="select-node" data-node="mppt">
      <div class="node-card-header">
        <span class="node-icon">☀</span>
        <span class="node-title">MPPT 太阳能</span>
        <span class="node-mode ${m.charge_mode==='MPPT'?'good':''}">${escapeHtml(m.charge_mode)}</span>
      </div>
      <div class="node-metrics-row">
        <div class="node-metric">
          <span class="nm-label">光伏</span>
          <span class="nm-value" id="live-mppt-sv">${m.solar_voltage.toFixed(1)}<small>V</small> ${m.solar_current.toFixed(2)}<small>A</small></span>
        </div>
        <div class="node-metric">
          <span class="nm-label">功率</span>
          <span class="nm-value" id="live-mppt-sp">${m.solar_power.toFixed(1)}<small>W</small></span>
        </div>
      </div>
      <div class="node-metrics-row">
        <div class="node-metric">
          <span class="nm-label">电池</span>
          <span class="nm-value" id="live-mppt-bv">${m.battery_voltage.toFixed(1)}<small>V</small> ${m.battery_current.toFixed(2)}<small>A</small></span>
        </div>
        <div class="node-metric">
          <span class="nm-label">功率</span>
          <span class="nm-value" id="live-mppt-bp">${m.battery_power.toFixed(1)}<small>W</small></span>
        </div>
      </div>
      <div class="soc-bar">
        <div class="soc-fill" id="live-mppt-soc-fill" style="width:${Math.min(100,soc)}%;background:${socColor}"></div>
        <span class="soc-text" id="live-mppt-soc">SOC ${soc.toFixed(0)}%</span>
      </div>
      <div class="node-extra">
        <span>温度 <span id="live-mppt-temp">${m.battery_temp.toFixed(1)}</span>°C</span>
        <span>效率 <span id="live-mppt-eff">${m.efficiency.toFixed(1)}</span>%</span>
        <span>PWM ${m.pwm_duty}</span>
        ${m.error_code !== 0 ? `<span class="danger">错误 ${m.error_code}</span>` : ""}
      </div>
      <div class="node-actions">
        <button class="button small-button" type="button" data-action="mppt-set-mode" data-mode="MPPT">MPPT</button>
        <button class="button small-button" type="button" data-action="mppt-set-mode" data-mode="FLOAT">浮充</button>
        <button class="danger-button" type="button" data-action="mppt-set-mode" data-mode="OFF">关闭</button>
      </div>
    </section>
  `;
}

// ---- 通道节点卡片 -----------------------------------------------------------

function renderNodeCardChannel(letter) {
  const ch = state[`channel_${letter}`];
  const selected = state.selectedNode === `channel_${letter}` ? " node-card--selected" : "";
  const isAC = ch.type === "ac_switch" || /交流/.test(ch.label || "");
  const statusBadge = ch.enabled
    ? '<span class="node-mode good">已开启</span>'
    : '<span class="node-mode">已关闭</span>';

  return `
    <section class="panel node-card${selected}" data-action="select-node" data-node="channel_${letter}">
      <div class="node-card-header">
        <span class="node-icon ch-icon-${letter}">⚡</span>
        <span class="node-title">${escapeHtml(ch.label || `通道 ${letter.toUpperCase()}`)}</span>
        ${statusBadge}
      </div>
      ${ch.enabled ? `
      <div class="node-metrics-row">
        <div class="node-metric">
          <span class="nm-label">实际电压</span>
          <span class="nm-value" id="live-ch${letter}-v">${ch.actual_voltage.toFixed(2)}<small>V</small></span>
        </div>
        <div class="node-metric">
          <span class="nm-label">${isAC ? "额定电压" : "设定电压"}</span>
          <span class="nm-value">${ch.set_voltage.toFixed(2)}<small>V</small></span>
        </div>
      </div>
      <div class="node-metrics-row">
        <div class="node-metric">
          <span class="nm-label">电流</span>
          <span class="nm-value" id="live-ch${letter}-c">${ch.actual_current.toFixed(3)}<small>A</small></span>
        </div>
        <div class="node-metric">
          <span class="nm-label">功率</span>
          <span class="nm-value" id="live-ch${letter}-p">${ch.actual_power.toFixed(2)}<small>W</small></span>
        </div>
      </div>
      <div class="node-extra">
        <span>温度 <span id="live-ch${letter}-temp">${ch.temperature.toFixed(1)}</span>°C</span>
        ${ch.error_code !== 0 ? `<span class="danger">错误 ${ch.error_code}</span>` : ""}
      </div>
      ` : `<div class="node-metric"><span class="nm-value subtle">通道未开启</span></div>`}
      <div class="node-actions">
        ${isAC ? "" : `
        <div class="voltage-setter">
          <input class="voltage-input" id="voltage_${letter}" type="number" value="${ch.set_voltage || 5.0}" step="0.1" min="0" max="${letter === "b" ? 60 : 30}" />
          <span class="voltage-unit">V</span>
          <button class="button small-button" type="button" data-action="ch-set-voltage" data-channel="${letter}">设定</button>
        </div>
        <div class="voltage-setter">
          <input class="voltage-input" id="current_${letter}" type="number" value="${ch.set_current || ch.current_limit || 1.0}" step="0.1" min="0" max="${letter === "b" ? 3 : 5}" />
          <span class="voltage-unit">A</span>
          <button class="button small-button" type="button" data-action="ch-set-current" data-channel="${letter}">限流</button>
        </div>
        `}
        <button class="${ch.enabled ? 'danger-button' : 'button'} small-button" type="button" data-action="ch-toggle" data-channel="${letter}">
          ${ch.enabled ? '关闭' : '开启'}
        </button>
      </div>
    </section>
  `;
}

// ---- 系统状态条 -------------------------------------------------------------

function renderSystemBar() {
  const s = state.system;
  const sigBars = s.signal_dbm >= -70 ? "▂▄▆█" : s.signal_dbm >= -85 ? "▂▄▆_" : s.signal_dbm >= -100 ? "▂▄__" : "▂___";
  const uptime = fmtUptime(s.uptime_s);

  return `
    <section class="panel sys-bar">
      <div class="sys-bar-row">
        <span class="sys-item">📶 ${sigBars} ${s.signal_dbm} dBm</span>
        <span class="sys-item">📡 ${escapeHtml(s.network_type)}</span>
        <span class="sys-item">⏱ ${uptime}</span>
        <span class="sys-item">🖥 CPU ${s.cpu_pct.toFixed(0)}%</span>
        <span class="sys-item">💾 ${s.mem_mb}MB</span>
      </div>
      <div class="sys-actions">
        <button class="button small-button" type="button" data-action="system-restart">重启网关</button>
        <button class="button small-button" type="button" data-action="system-fwupdate">升级固件</button>
      </div>
    </section>
  `;
}

function fmtUptime(s) {
  if (!s || s <= 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ============================================================
//  Chart — 动态切换节点数据源
// ============================================================

function nodeSeriesConfig(node) {
  if (node === "mppt") return [
    { key:"solar_voltage",  name:"光伏电压", color:"#FD42AC", unit:"V" },
    { key:"solar_current",  name:"光伏电流", color:"#FF33FF", unit:"A" },
    { key:"solar_power",    name:"光伏功率", color:"#FF5C5C", unit:"W" },
    { key:"battery_voltage",name:"电池电压", color:"#398AD9", unit:"V" },
    { key:"battery_current",name:"电池电流", color:"#5BEC8D", unit:"A" },
    { key:"battery_power",  name:"电池功率", color:"#FFFF00", unit:"W" },
  ];
  // Channel nodes
  return [
    { key:"actual_voltage", name:"实际电压", color:"#398AD9", unit:"V" },
    { key:"set_voltage",    name:"设定电压", color:"#FD42AC", unit:"V", dash:[6,3] },
    { key:"actual_current", name:"实际电流", color:"#5BEC8D", unit:"A" },
    { key:"actual_power",   name:"实际功率", color:"#FF5C5C", unit:"W" },
  ];
}

function rebuildChannels() {
  const cfg = nodeSeriesConfig(state.selectedNode);
  const series = state.nodeSeries[state.selectedNode] || [];
  state.channels = cfg.map((c) => ({
    ...c,
    data: series.map((f) => f[c.key] ?? null),
  }));
}

function defaultChannels() {
  const cfg = nodeSeriesConfig(state.selectedNode);
  return cfg.map((c) => ({ ...c, data: [] }));
}

function renderChartPanel() {
  const nodeNames = {
    mppt: "☀ MPPT",
    channel_a: "⚡ 通道 A", channel_b: "⚡ 通道 B", channel_c: "⚡ 通道 C",
  };

  return `
    <section class="panel chart-panel">
      <div class="chart-toolbar">
        <h2>可视化图表</h2>
        <div class="chart-tabs">
          <button class="tab-pill ${state.chartMode==='wave'?'active':''}" type="button" data-action="chart-wave">波形图</button>
          <button class="tab-pill ${state.chartMode==='raw'?'active':''}" type="button" data-action="chart-raw">原始数据</button>
        </div>
      </div>
      <div class="node-selector">
        ${Object.entries(nodeNames).map(([k,v]) =>
          `<button class="tab-pill node-pill ${state.selectedNode===k?'active':''}" type="button" data-action="select-node" data-node="${k}">${v}</button>`
        ).join("")}
      </div>
      ${state.chartMode === 'wave' ? renderWaveView() : renderRawView()}
    </section>
  `;
}

function renderWaveView() {
  if (!state.channels.length) state.channels = defaultChannels();
  return `
    <div class="wave-container"><canvas id="waveChart"></canvas></div>
    <div class="chart-legend">
      ${state.channels.map((ch, i) => `
        <label class="legend-item">
          <input type="checkbox" class="channel-toggle" data-index="${i}" checked />
          <span class="legend-dot" style="background:${ch.color}"></span>${escapeHtml(ch.name)}
        </label>
      `).join("")}
    </div>
  `;
}

function renderRawView() {
  const lines = state.rawLines.slice(-50);
  return `<div class="raw-console">${lines.map((l) => `<div class="raw-line">${l}</div>`).join("") || '<div class="raw-line subtle">等待数据...</div>'}</div>`;
}

function initChart() {
  destroyChart();
  const canvas = document.querySelector("#waveChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const chs = state.channels.length ? state.channels : defaultChannels();
  const n = state.sampleCount;
  const labels = []; for (let i = -n; i < 0; i++) labels.push(i);

  const datasets = chs.map((ch) => ({
    label: ch.name,
    data: ch.data.length ? ch.data.slice(-n) : new Array(n).fill(null),
    borderColor: ch.color, backgroundColor: ch.color + "22",
    borderWidth: 1.5, borderDash: ch.dash || [],
    pointRadius: 0, fill: false, tension: 0.1,
  }));

  chart = new Chart(ctx, {
    type: "line", data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { display: true }, y: { display: true, beginAtZero: false } },
      plugins: { legend: { display: false } },
    },
  });

  document.querySelectorAll(".channel-toggle").forEach((cb) => {
    cb.addEventListener("change", () => {
      const i = Number(cb.dataset.index);
      if (chart?.data.datasets[i]) { chart.data.datasets[i].hidden = !cb.checked; chart.update(); }
    });
  });
}

function destroyChart() {
  if (chart) { chart.destroy(); chart = null; }
  if (chartTimer) { cancelAnimationFrame(chartTimer); chartTimer = null; }
}

function updateChart() {
  if (!chart || state.chartMode !== "wave") return;
  const chs = state.channels;
  for (let i = 0; i < chs.length; i++) {
    const ds = chart.data.datasets[i];
    if (!ds) continue;
    ds.data = chs[i].data.slice(-state.sampleCount);
  }
  chart.update();
}

// ============================================================
//  Data sources
// ============================================================

function createSimulationSource() {
  let running = false, timer = null, cb = null, t = 0;

  function tickMPPT() {
    const sv = 18.2 + 1.4 * Math.sin(t * 0.01) + (Math.random() - 0.5) * 0.3;
    const si = Math.max(0.1, 1.4 + 1.1 * Math.sin(t * 0.008) + (Math.random() - 0.5) * 0.2);
    const sp = sv * si;
    const soc = Math.min(100, Math.max(0, 72 + 5 * Math.sin(t * 0.002)));
    const bv = 12.0 + soc * 0.048 + Math.sin(t * 0.003) * 0.08;
    const bi = Math.max(0.1, (sp * 0.92) / bv);
    const bp = bv * bi;
    const eff = sp > 0 ? Math.min(98, (bp / sp) * 100) : 0;
    return {
      solar_voltage: sv, solar_current: si, solar_power: sp,
      battery_voltage: bv, battery_current: bi, battery_power: bp,
      battery_soc: soc, battery_temp: 28 + Math.sin(t * 0.002) * 2 + (Math.random() - 0.5) * 0.8,
      charge_mode: t % 100 < 95 ? "MPPT" : "FLOAT",
      pwm_duty: Math.min(255, Math.round(eff * 2.55)),
      efficiency: eff, error_code: 0,
    };
  }

  function tickChannel(enabled, baseV, label, type = "dc_supply", limitA = 1.0) {
    if (!enabled) return { letter:"", enabled:false, label, type, set_voltage:baseV, set_current:limitA, current_limit:limitA, actual_voltage:0, actual_current:0, actual_power:0, temperature:0, error_code:0 };
    const av = baseV + (Math.random() - 0.5) * 0.2;
    const ac = type === "ac_switch" ? 0.45 + Math.random() * 0.25 : Math.min(limitA, 0.4 + Math.random() * limitA);
    return {
      letter:"", enabled:true, label, type, set_voltage: baseV, set_current: limitA, current_limit: limitA,
      actual_voltage: av, actual_current: ac, actual_power: av * ac,
      temperature: 35 + (Math.random() - 0.5) * 10, error_code: 0,
    };
  }

  return {
    start() { running = true; t = 0; this._tick(); },
    stop() { running = false; if (timer) clearTimeout(timer); timer = null; },
    onData(fn) { cb = fn; },
    sendCommand(node, cmd) { console.log("[SIM] CMD →", node, cmd); },
    _tick() {
      if (!running) return;
      t++;
      const frame = {
        mppt: tickMPPT(),
        channel_a: tickChannel(t % 30 > 15, 12, "直流电源A", "dc_supply", 1.8),
        channel_b: tickChannel(t % 50 > 30, 24, "直流电源B", "dc_supply", 0.9),
        channel_c: tickChannel(t % 40 > 10, 220, "交流输出", "ac_switch"),
        system: {
          cpu_pct: 20 + Math.random() * 15,
          mem_mb: Math.round(80 + Math.random() * 30),
          disk_mb: Math.round(400 + Math.random() * 50),
          signal_dbm: Math.round(-70 + Math.random() * 15),
          network_type: "LTE",
          uptime_s: t * 10,
        },
        voice: null,
        aggregate: null,
      };
      if (cb) cb(frame);
      timer = setTimeout(() => this._tick(), Math.max(50, 1000 / (state.sampleCount / 10)));
    },
  };
}

function createDataSource() {
  if (state.sourceMode === "mqtt") {
    return createMQTTSource();
  }
  return createSimulationSource();
}

function disconnectDevice() {
  if (state.streaming) toggleStreamingSilent();
  if (dataSource) { dataSource.stop(); dataSource = null; }
  state.deviceConnected = false;
  state.mqttStatus = { state:"idle", detail:"" };
}

async function toggleDeviceConnection() {
  if (state.deviceConnected) {
    disconnectDevice();
    render();
    showToast("已断开连接");
    return;
  }

  dataSource = createDataSource();
  dataSource.onData(onDeviceData);
  if (dataSource.onStatus) dataSource.onStatus(onMqttStatus);

  if (state.sourceMode === "mqtt") {
    try {
      dataSource.start(state.mqtt.deviceId);
      state.deviceConnected = true;
      showToast("MQTT 已连接");
    } catch (err) {
      showToast(`连接失败: ${err.message}`);
      dataSource.stop();
      dataSource = null;
    }
  } else {
    state.deviceConnected = true;
    showToast("已连接（模拟模式）");
  }
  render();
}

function toggleStreaming() {
  if (state.streaming) {
    state.streaming = false;
    destroyChart();
    render();
    showToast("已停止记录，实时数据继续更新");
    return;
  }

  if (!state.deviceConnected) {
    dataSource = createDataSource();
    dataSource.onData(onDeviceData);
    if (dataSource.onStatus) dataSource.onStatus(onMqttStatus);
    if (state.sourceMode === "mqtt") {
      dataSource.start(state.mqtt.deviceId);
    }
    state.deviceConnected = true;
  }

  state.streaming = true;
  state.nodeSeries = { mppt:[], channel_a:[], channel_b:[], channel_c:[] };
  state.channels = defaultChannels();
  state.rawLines = [];
  render();
  showToast("开始记录波形");
}

function toggleStreamingSilent() {
  state.streaming = false;
  if (dataSource) dataSource.stop();
  destroyChart();
}

function onMqttStatus(event) {
  state.mqttStatus = { state: event.state, detail: event.detail || "" };
  if (event.state === "disconnected" && !state.deviceConnected) {
    state.mqttStatus = { state:"idle", detail:"" };
  }
}

// ---- 统一数据回调 -----------------------------------------------------------

function onDeviceData(frame) {
  // Update multi-channel state
  if (frame.mppt)      state.mppt      = { ...state.mppt, ...frame.mppt };
  if (frame.channel_a) state.channel_a = { ...state.channel_a, ...frame.channel_a, letter:"a" };
  if (frame.channel_b) state.channel_b = { ...state.channel_b, ...frame.channel_b, letter:"b" };
  if (frame.channel_c) state.channel_c = { ...state.channel_c, ...frame.channel_c, letter:"c" };
  if (frame.system)    state.system    = { ...state.system, ...frame.system };
  if (frame.voice)     state.voice     = frame.voice;

  if (state.streaming) {
    // Push to per-node time series
    for (const node of ["mppt","channel_a","channel_b","channel_c"]) {
      const f = frame[node];
      if (!f) continue;
      state.nodeSeries[node].push({ ...f });
      if (state.nodeSeries[node].length > state.sampleCount * 2) {
        state.nodeSeries[node] = state.nodeSeries[node].slice(-state.sampleCount);
      }
    }

    // Rebuild chart channels from selected node's series
    rebuildChannels();

    // Raw log line
    const series = state.nodeSeries[state.selectedNode];
    if (series.length) {
      const last = series[series.length - 1];
      const cfg = nodeSeriesConfig(state.selectedNode);
      const rawHtml = cfg.map((c, i) =>
        `<span style="color:${c.color}">${c.name}:${Number(last[c.key]??0).toFixed(2)}${c.unit}</span>`
      ).join(" ");
      state.rawLines.push(rawHtml);
      if (state.rawLines.length > 200) state.rawLines = state.rawLines.slice(-100);
    }
  }

  // Throttled chart + UI update
  if (!chartTimer) {
    chartTimer = requestAnimationFrame(() => {
      chartTimer = null;
      if (state.streaming) updateChart();
      updateLiveDisplays();
    });
  }
}

function updateLiveDisplays() {
  const m = state.mppt;

  // MPPT card — 用 innerHTML 写入带 <small> 的复合值
  updateElHtml("#live-mppt-sv", `${m.solar_voltage.toFixed(1)}<small>V</small> ${m.solar_current.toFixed(2)}<small>A</small>`);
  updateElHtml("#live-mppt-sp", `${m.solar_power.toFixed(1)}<small>W</small>`);
  updateElHtml("#live-mppt-bv", `${m.battery_voltage.toFixed(1)}<small>V</small> ${m.battery_current.toFixed(2)}<small>A</small>`);
  updateElHtml("#live-mppt-bp", `${m.battery_power.toFixed(1)}<small>W</small>`);
  updateElText("#live-mppt-soc", `SOC ${m.battery_soc.toFixed(0)}%`);
  updateElText("#live-mppt-eff", m.efficiency.toFixed(1));
  updateElText("#live-mppt-temp", m.battery_temp.toFixed(1));

  // SOC bar fill
  const socFill = document.querySelector("#live-mppt-soc-fill");
  if (socFill) {
    const soc = Math.min(100, Math.max(0, m.battery_soc || 0));
    socFill.style.width = soc + "%";
    const socColor = soc > 60 ? "var(--good)" : soc > 20 ? "#d97706" : "var(--danger)";
    socFill.style.background = socColor;
  }

  // Channel cards — only update if streaming (elements exist from render)
  for (const l of ["a","b","c"]) {
    const ch = state[`channel_${l}`];
    if (!ch || !ch.enabled) continue;
    updateElHtml(`#live-ch${l}-v`, `${ch.actual_voltage.toFixed(2)}<small>V</small>`);
    updateElHtml(`#live-ch${l}-c`, `${ch.actual_current.toFixed(3)}<small>A</small>`);
    updateElHtml(`#live-ch${l}-p`, `${ch.actual_power.toFixed(2)}<small>W</small>`);
    updateElText(`#live-ch${l}-temp`, ch.temperature.toFixed(1));
  }
}

function updateElHtml(sel, html) { const el = document.querySelector(sel); if (el) el.innerHTML = html; }

function updateElText(sel, text) { const el = document.querySelector(sel); if (el) el.textContent = text; }

// ---- 通道命令 ---------------------------------------------------------------

function sendChannelToggle(letter) {
  const ch = state[`channel_${letter}`];
  if (!ch) return;
  const node = `channel_${letter}`;
  const cmd = { cmd: "set_enabled", value: !ch.enabled };
  if (dataSource) dataSource.sendCommand(node, cmd);
  showToast(`通道 ${letter.toUpperCase()}: ${ch.enabled ? "关闭" : "开启"}`);
}

function sendChannelSetVoltage(letter) {
  const input = document.querySelector(`#voltage_${letter}`);
  if (!input) return;
  const value = Number(input.value);
  const max = letter === "b" ? 60 : 30;
  if (isNaN(value) || value < 0 || value > max) { showToast(`电压范围 0-${max}V`); return; }
  const node = `channel_${letter}`;
  const cmd = { cmd: "set_voltage", value };
  if (dataSource) dataSource.sendCommand(node, cmd);
  state[`channel_${letter}`].set_voltage = value;
  showToast(`通道 ${letter.toUpperCase()}: 设定 ${value.toFixed(1)}V`);
}

function sendChannelSetCurrent(letter) {
  const input = document.querySelector(`#current_${letter}`);
  if (!input) return;
  const value = Number(input.value);
  const max = letter === "b" ? 3 : 5;
  if (isNaN(value) || value < 0 || value > max) { showToast(`限流范围 0-${max}A`); return; }
  const node = `channel_${letter}`;
  const cmd = { cmd: "set_current", value };
  if (dataSource) dataSource.sendCommand(node, cmd);
  state[`channel_${letter}`].set_current = value;
  state[`channel_${letter}`].current_limit = value;
  showToast(`通道 ${letter.toUpperCase()}: 限流 ${value.toFixed(1)}A`);
}

function sendMpptSetMode(mode) {
  if (dataSource) dataSource.sendCommand("mppt", { cmd: "set_charge_mode", value: mode });
  showToast(`MPPT 模式: ${mode}`);
}

// ---- MQTT 配置保存 ----------------------------------------------------------

function saveMqttConfigToState() {
  state.mqtt.brokerUrl = document.querySelector("#mqttBroker")?.value.trim() || state.mqtt.brokerUrl;
  state.mqtt.deviceId   = document.querySelector("#mqttDeviceId")?.value.trim() || "";
  state.mqtt.username   = document.querySelector("#mqttUsername")?.value.trim() || "";
  state.mqtt.password   = document.querySelector("#mqttPassword")?.value || "";
  saveMqttConfig(state.mqtt);
  showToast("MQTT 配置已保存");
}

// ============================================================
//  DATA tab
// ============================================================

function renderData() {
  view.innerHTML = `
    <section class="panel">
      <h2>数据</h2>
      <p class="subtle">数据管理页面 - 开发中</p>
    </section>
  `;
}

// ============================================================
//  SETTINGS
// ============================================================

function renderSettings() {
  view.innerHTML = `
    ${renderDeviceConfigPanel()}
    ${renderAccountHero()}
    ${renderAccountPanel()}
    ${renderProfileForm()}
    ${renderVersionPanel()}
  `;
}

function renderDeviceConfigPanel() {
  const btnLabel = state.deviceConnected ? "断开连接" : "连接设备";
  const btnClass = state.deviceConnected ? "danger-button" : "button";

  return `
    <section class="panel">
      <h2>设备连接</h2>
      <div class="source-tabs">
        <button class="tab-pill ${state.sourceMode==='sim'?'active':''}" type="button" data-action="source-mode" data-mode="sim">模拟数据</button>
        <button class="tab-pill ${state.sourceMode==='mqtt'?'active':''}" type="button" data-action="source-mode" data-mode="mqtt">MQTT 网关</button>
      </div>
      ${state.sourceMode === "mqtt" ? renderMqttConfig() : renderSimInfo()}
      <div class="field" style="margin-top:8px;">
        <label for="sampleCount">图表采样数 (300–10000)</label>
        <input id="sampleCount" type="number" value="${state.sampleCount}" min="300" max="10000" step="100" />
      </div>
      <div class="actions">
        <button class="${btnClass}" type="button" data-action="device-connect">${btnLabel}</button>
        ${state.streaming ? `<button class="button" type="button" data-action="stream-toggle">⏹ 停止采集</button>` : `<button class="button" type="button" data-action="stream-toggle" ${!state.deviceConnected?"disabled":""}>▶ 开始采集</button>`}
      </div>
    </section>
  `;
}

function renderSimInfo() {
  return `<div class="sim-notice"><p class="subtle">使用本地模拟数据源。模拟 4 节点（MPPT + 3 通道）真实波形。</p></div>`;
}

function renderMqttConfig() {
  const m = state.mqtt;
  const ms = state.mqttStatus;
  let statusBadge = "";
  if (ms.state === "connected") statusBadge = '<span class="mqtt-badge good">● 已连接</span>';
  else if (ms.state === "connecting" || ms.state === "reconnecting") statusBadge = '<span class="mqtt-badge warn">◉ ' + escapeHtml(ms.detail || "连接中") + '</span>';
  else if (ms.state === "error") statusBadge = '<span class="mqtt-badge danger">✕ ' + escapeHtml(ms.detail || "错误") + '</span>';
  else if (ms.state === "offline") statusBadge = '<span class="mqtt-badge warn">○ 离线</span>';

  return `
    <div class="form-grid mqtt-config">
      <div class="field">
        <label for="mqttBroker">Broker 地址 (WS/WSS)</label>
        <input id="mqttBroker" type="text" value="${escapeHtml(m.brokerUrl)}" placeholder="ws://192.168.137.1:8083/mqtt" ${state.deviceConnected?"disabled":""} />
      </div>
      <div class="field">
        <label for="mqttDeviceId">设备 ID</label>
        <input id="mqttDeviceId" type="text" value="${escapeHtml(m.deviceId)}" placeholder="rk3506" ${state.deviceConnected?"disabled":""} />
      </div>
      <div class="field-row">
        <div class="field">
          <label for="mqttUsername">用户名</label>
          <input id="mqttUsername" type="text" value="${escapeHtml(m.username)}" ${state.deviceConnected?"disabled":""} />
        </div>
        <div class="field">
          <label for="mqttPassword">密码</label>
          <input id="mqttPassword" type="password" value="${escapeHtml(m.password)}" ${state.deviceConnected?"disabled":""} />
        </div>
      </div>
      <div class="mqtt-topics">
        <div><strong>订阅</strong> <code>energy/${escapeHtml(m.deviceId||"{id}")}/mppt/telemetry</code> <code>channel/+/telemetry</code> …</div>
        ${statusBadge ? `<div class="mqtt-status-row">${statusBadge}</div>` : ""}
      </div>
      <div class="actions">
        <button class="button small-button" type="button" data-action="mqtt-save" ${state.deviceConnected?"disabled":""}>保存配置</button>
      </div>
    </div>
  `;
}

// ============================================================
//  Account / Profile / Version
// ============================================================

function renderAccountHero() {
  const label = state.cloudUser
    ? (state.cloudProfile?.display_name || state.cloudProfile?.username || state.cloudUser.email || "已登录")
    : "本地模式";
  const subtitle = state.cloudUser ? state.cloudUser.email || "账号已连接" : state.cloudConfigured ? "登录后可同步能耗数据" : "当前为本地模式，数据保存在本机";
  const badge = state.cloudUser ? "已登录" : state.cloudConfigured ? "可登录" : "本地";
  return `
    <section class="panel account-hero">
      <div class="account-main">
        <div class="account-avatar">${escapeHtml(getAvatarText(label))}</div>
        <div><h2>${escapeHtml(label)}</h2><p class="subtle">${escapeHtml(subtitle)}</p></div>
      </div>
      <span class="type-pill ${state.cloudUser?"good":""}">${escapeHtml(badge)}</span>
    </section>
  `;
}

function renderAccountPanel() {
  if (!state.cloudConfigured) {
    return `<section class="panel"><h2>账号</h2><div class="setting-list"><div class="setting-row"><div><strong>本地模式</strong><p class="subtle">云端尚未配置。</p></div></div></div></section>`;
  }
  if (!state.cloudUser) {
    return `<section class="panel form-grid"><h2>登录</h2><p class="subtle">使用 GitHub 账号登录后可同步能耗数据到云端。</p><div class="actions"><button class="button" type="button" data-action="sign-in-provider" data-provider="github">使用 GitHub 登录</button></div></section>`;
  }
  return `
    <section class="panel"><h2>账号</h2><div class="setting-list">
      <div class="setting-row"><div><strong>邮箱</strong><p class="subtle">${escapeHtml(state.cloudUser.email || state.cloudUser.id)}</p></div></div>
      <div class="setting-row"><div><strong>云端接口版本</strong><p class="subtle">${CLOUD_API_VERSION}</p></div><button class="danger-button" type="button" data-action="sign-out">退出登录</button></div>
    </div></section>
  `;
}

function renderProfileForm() {
  if (!state.cloudConfigured || !state.cloudUser) return "";
  const p = state.cloudProfile || {};
  return `
    <section class="panel form-grid"><h2>个人资料</h2>
      <div class="field"><label for="profileUsername">用户名</label><input id="profileUsername" type="text" value="${escapeHtml(p.username||"")}" /></div>
      <div class="field"><label for="profileDisplay">昵称</label><input id="profileDisplay" type="text" value="${escapeHtml(p.display_name||"")}" /></div>
      <div class="field"><label for="profileBio">简介</label><input id="profileBio" type="text" value="${escapeHtml(p.bio||"")}" /></div>
      <div class="actions"><button class="button" type="button" data-action="save-profile">保存</button></div>
    </section>
  `;
}

function renderVersionPanel() {
  const v = state.appVersion;
  return `
    <section class="panel version-card"><div><span class="version-label">当前版本</span><strong>${escapeHtml(v.current||v.latest||"未知")}</strong><p class="subtle">${v.checking?"正在检查更新":v.updateAvailable?`发现新版本 ${v.latest}`:v.error?"版本检查失败":"已是最新版本"}</p></div>${v.updateAvailable?`<button class="button small-button" type="button" data-action="refresh-app">立即更新</button>`:""}</section>
  `;
}

// ============================================================
//  Auth / Version / SW
// ============================================================

async function signInProvider(provider) {
  try { cloud.signInWithOAuth(provider); } catch (e) { showToast(`登录失败：${e.message}`); }
}
async function signOutCloud() {
  await cloud.signOut(); state.cloudUser = null; state.cloudProfile = null; showToast("已退出登录"); render();
}
async function saveProfile() {
  try {
    if (!state.cloudUser) throw new Error("请先登录");
    const u = cleanText(document.querySelector("#profileUsername")?.value || "");
    const d = cleanText(document.querySelector("#profileDisplay")?.value || "");
    if (!u) throw new Error("用户名不能为空");
    if (!d) throw new Error("昵称不能为空");
    state.cloudProfile = await cloud.upsertProfile({ id:state.cloudUser.id, username:u, display_name:d, bio:cleanText(document.querySelector("#profileBio")?.value||"") });
    showToast("个人资料已保存"); render();
  } catch (e) { showToast(`保存失败：${e.message}`); }
}

async function checkAppVersion() {
  state.appVersion.checking = true; state.appVersion.error = ""; rerenderVersion();
  try {
    const r = await fetch(`./version.json?t=${Date.now()}`, { cache:"no-store" });
    if (!r.ok) throw new Error(`version.json ${r.status}`);
    const latest = String((await r.json()).version || "").trim();
    if (!latest) throw new Error("version.json 缺少 version 字段");
    const cur = localStorage.getItem(APP_VERSION_KEY) || "";
    if (!cur) { localStorage.setItem(APP_VERSION_KEY, latest); state.appVersion.current = latest; state.appVersion.latest = latest; }
    else { state.appVersion.current = cur; state.appVersion.latest = latest; state.appVersion.updateAvailable = cur !== latest; }
  } catch (e) { state.appVersion.error = e.message; }
  finally { state.appVersion.checking = false; rerenderVersion(); }
}
function rerenderVersion() { if (state.view === "settings") render(); }

async function refreshAppAssets() {
  const latest = state.appVersion.latest;
  try {
    if ("caches" in window) { const keys = await caches.keys(); await Promise.all(keys.filter((k) => k.startsWith(SW_CACHE_PREFIX)).map((k) => caches.delete(k))); }
    if ("serviceWorker" in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map((r) => r.unregister())); }
    if (latest) localStorage.setItem(APP_VERSION_KEY, latest);
    showToast("正在更新应用"); setTimeout(() => location.reload(), 300);
  } catch (e) { showToast("更新失败"); }
}
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

// ============================================================
//  Utils
// ============================================================

function showToast(msg) {
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = msg; toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}
function escapeHtml(v) { return String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function getAvatarText(l) { const t = String(l||"").trim(); return t ? t.slice(0,1).toUpperCase() : "?"; }
function cleanText(v) { return String(v||"").trim().replace(/\s+/g," "); }
