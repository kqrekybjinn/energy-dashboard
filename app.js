import { cloud, CLOUD_API_VERSION } from "./cloud.js";
import { createMqttSource } from "./mqtt-source.js";

const DB_NAME = "energy-dashboard-db";
const DB_VERSION = 1;
const APP_VERSION_KEY = "energy-dashboard-app-version";
const SW_CACHE_PREFIX = "energy-dashboard-";
const MQTT_CONFIG_KEY = "energy-dashboard-mqtt-config";

function loadMqttConfig() {
  try {
    return JSON.parse(localStorage.getItem(MQTT_CONFIG_KEY) || "null") || {};
  } catch {
    return {};
  }
}

function saveMqttConfig(cfg) {
  localStorage.setItem(MQTT_CONFIG_KEY, JSON.stringify(cfg));
}

const state = {
  view: "dashboard",
  cloudConfigured: cloud.configured,
  cloudUser: null,
  cloudProfile: null,
  cloudReady: false,
  appVersion: {
    current: localStorage.getItem(APP_VERSION_KEY) || "",
    latest: "",
    checking: true,
    updateAvailable: false,
    error: "",
  },
  // Data source
  sourceMode: "sim", // "sim" | "mqtt"
  deviceConnected: false,
  streaming: false,
  sampleCount: 300,
  chartMode: "wave", // "wave" | "raw"
  // MQTT config (persisted)
  mqtt: {
    brokerUrl: loadMqttConfig().brokerUrl || "wss://broker.emqx.io:8084/mqtt",
    deviceId: loadMqttConfig().deviceId || "",
    username: loadMqttConfig().username || "",
    password: loadMqttConfig().password || "",
  },
  // MQTT connection status
  mqttStatus: { state: "idle", detail: "" },
  mqttLogs: [],
  // Live data
  status: { buckMode: "BUCK", antiBackflow: "正常", driverEnabled: true, errorCode: 0 },
  pwm: { pwmc: 0, pwm: 0, ppwm: 0 },
  metrics: { vin: 0, iin: 0, pin: 0, vout: 0, iout: 0, pout: 0, efficiency: 0, temp: 0 },
  calibration: { invd: 50.0, outvd: 50.0, rnfa: 0.002, rnfb: 0.002, incd: 10.0 },
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
    state.cloudUser = null;
    state.cloudProfile = null;
  } finally {
    state.cloudReady = true;
  }
}

// ============================================================
//  Global events
// ============================================================

function bindGlobalEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    });
  });
  view.addEventListener("click", handleViewClick);
  view.addEventListener("input", handleViewInput);
}

async function handleViewClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  // Auth
  if (action === "sign-in-provider") await signInProvider(target.dataset.provider || "github");
  if (action === "sign-out") await signOutCloud();
  if (action === "save-profile") await saveProfile();
  if (action === "refresh-app") await refreshAppAssets();

  // Device
  if (action === "device-connect") await toggleDeviceConnection();
  if (action === "stream-toggle") toggleStreaming();
  if (action === "chart-wave") { state.chartMode = "wave"; render(); }
  if (action === "chart-raw") { state.chartMode = "raw"; render(); }
  if (action === "device-restart") { dataSource?.sendCommand("RESTART"); showToast("已发送重启指令"); }
  if (action === "device-fwupdate") { dataSource?.sendCommand("FWUPDATE"); showToast("已发送固件升级指令"); }
  if (action === "send-command") sendCustomCommand();
  if (action === "send-calib") sendCalibration(target.dataset.calib);

  // MQTT config
  if (action === "mqtt-save") saveMqttConfigToState();
  if (action === "source-mode") {
    state.sourceMode = target.dataset.mode;
    if (state.deviceConnected) {
      disconnectDevice();
      showToast(`已切换到 ${state.sourceMode === "mqtt" ? "MQTT" : "模拟"} 模式，请重新连接`);
    }
    render();
  }
}

function handleViewInput(event) {
  const target = event.target;
  if (!target) return;
  if (target.id === "sampleCount") {
    state.sampleCount = Number(target.value) || 300;
  }
}

// ============================================================
//  Render dispatch
// ============================================================

function render() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.view);
  });
  if (state.view === "dashboard") renderDashboard();
  if (state.view === "data") renderData();
  if (state.view === "settings") renderSettings();
}

// ============================================================
//  DASHBOARD
// ============================================================

function renderDashboard() {
  view.innerHTML = `
    <div class="dashboard-grid">
      <div class="dash-left">
        ${renderStatusPanel()}
        ${renderPwmPanel()}
        ${renderMetricsPanel()}
        ${renderConnectionPanel()}
        ${renderCalibrationPanel()}
        ${renderFunctionsPanel()}
      </div>
      <div class="dash-right">
        ${renderChartPanel()}
      </div>
    </div>
  `;
  if (state.chartMode === "wave" && state.streaming) initChart();
}

function renderStatusPanel() {
  const s = state.status;
  return `
    <section class="panel">
      <h2>运行状态</h2>
      <div class="status-grid">
        <div class="status-item">
          <span class="status-label">BUCK 模式</span>
          <span class="status-value">${escapeHtml(s.buckMode)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">防逆流</span>
          <span class="status-value ${s.antiBackflow === '正常' ? 'good' : 'danger'}">${escapeHtml(s.antiBackflow)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">驱动</span>
          <span class="status-value ${s.driverEnabled ? 'good' : ''}">${s.driverEnabled ? 'EN' : 'DIS'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">错误码</span>
          <span class="status-value ${s.errorCode === 0 ? '' : 'danger'}">${s.errorCode}</span>
        </div>
      </div>
    </section>
  `;
}

function renderPwmPanel() {
  const p = state.pwm;
  return `
    <section class="panel">
      <h2>PWM 值</h2>
      <div class="pwm-list">
        ${bar("PWMC", p.pwmc)}${bar("PWM", p.pwm)}${bar("PPWM", p.ppwm)}
      </div>
    </section>
  `;
}

function bar(label, value) {
  const pct = Math.min(100, Math.max(0, (value / 255) * 100));
  return `
    <div class="pwm-row" data-label="${label}">
      <span class="pwm-label">${label}</span>
      <div class="pwm-track"><div class="pwm-fill" style="width:${pct.toFixed(0)}%"></div></div>
      <span class="pwm-value">${value}</span>
    </div>
  `;
}

function renderMetricsPanel() {
  const m = state.metrics;
  return `
    <section class="panel">
      <h2>实时数据</h2>
      <div class="metrics-grid">
        <div class="metric-card">
          <span class="metric-label">输入电压</span>
          <span class="metric-value" id="metric-vin">${m.vin.toFixed(2)} <small>V</small></span>
        </div>
        <div class="metric-card">
          <span class="metric-label">输入电流</span>
          <span class="metric-value" id="metric-iin">${m.iin.toFixed(3)} <small>A</small></span>
        </div>
        <div class="metric-card">
          <span class="metric-label">输入功率</span>
          <span class="metric-value" id="metric-pin">${m.pin.toFixed(2)} <small>W</small></span>
        </div>
        <div class="metric-card">
          <span class="metric-label">输出电压</span>
          <span class="metric-value" id="metric-vout">${m.vout.toFixed(2)} <small>V</small></span>
        </div>
        <div class="metric-card">
          <span class="metric-label">输出电流</span>
          <span class="metric-value" id="metric-iout">${m.iout.toFixed(3)} <small>A</small></span>
        </div>
        <div class="metric-card">
          <span class="metric-label">输出功率</span>
          <span class="metric-value" id="metric-pout">${m.pout.toFixed(2)} <small>W</small></span>
        </div>
        <div class="metric-card wide">
          <span class="metric-label">效率</span>
          <span class="metric-value" id="metric-eff">${m.efficiency.toFixed(1)} <small>%</small></span>
        </div>
        ${m.temp > 0 ? `
        <div class="metric-card wide">
          <span class="metric-label">温度</span>
          <span class="metric-value" id="metric-temp">${m.temp.toFixed(1)} <small>°C</small></span>
        </div>` : ""}
      </div>
    </section>
  `;
}

// ============================================================
//  Connection panel — 双模式：模拟 / MQTT
// ============================================================

function renderConnectionPanel() {
  const btnLabel = state.deviceConnected ? "断开连接" : "连接设备";
  const btnClass = state.deviceConnected ? "danger-button" : "button";

  return `
    <section class="panel">
      <h2>设备连接</h2>

      <div class="source-tabs">
        <button class="tab-pill ${state.sourceMode === 'sim' ? 'active' : ''}" type="button" data-action="source-mode" data-mode="sim">模拟数据</button>
        <button class="tab-pill ${state.sourceMode === 'mqtt' ? 'active' : ''}" type="button" data-action="source-mode" data-mode="mqtt">MQTT 网关</button>
      </div>

      ${state.sourceMode === "mqtt" ? renderMqttConfig() : renderSimInfo()}

      <div class="field" style="margin-top:8px;">
        <label for="sampleCount">图表采样数 (300–10000)</label>
        <input id="sampleCount" type="number" value="${state.sampleCount}" min="300" max="10000" step="100" />
      </div>

      <div class="actions">
        <button class="${btnClass}" type="button" data-action="device-connect">${btnLabel}</button>
        ${state.streaming ? `<button class="button" type="button" data-action="stream-toggle">⏹ 停止</button>` : `<button class="button" type="button" data-action="stream-toggle" ${!state.deviceConnected ? "disabled" : ""}>▶ 开始采集</button>`}
      </div>
    </section>
  `;
}

function renderSimInfo() {
  return `
    <div class="sim-notice">
      <p class="subtle">使用本地模拟数据源。数据基于正弦波 + 噪声模拟太阳能板行为。</p>
    </div>
  `;
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
        <label for="mqttBroker">Broker 地址 (WSS)</label>
        <input id="mqttBroker" type="text" value="${escapeHtml(m.brokerUrl)}" placeholder="wss://broker.emqx.io:8084/mqtt" ${state.deviceConnected ? "disabled" : ""} />
      </div>
      <div class="field">
        <label for="mqttDeviceId">设备 ID</label>
        <input id="mqttDeviceId" type="text" value="${escapeHtml(m.deviceId)}" placeholder="rk3506-gateway-001" ${state.deviceConnected ? "disabled" : ""} />
      </div>
      <div class="field-row">
        <div class="field">
          <label for="mqttUsername">用户名 (可选)</label>
          <input id="mqttUsername" type="text" value="${escapeHtml(m.username)}" ${state.deviceConnected ? "disabled" : ""} />
        </div>
        <div class="field">
          <label for="mqttPassword">密码 (可选)</label>
          <input id="mqttPassword" type="password" value="${escapeHtml(m.password)}" ${state.deviceConnected ? "disabled" : ""} />
        </div>
      </div>

      <div class="mqtt-topics">
        <div><strong>遥测 Topic</strong> <code>energy/${escapeHtml(m.deviceId || "{id}")}/telemetry</code></div>
        <div><strong>命令 Topic</strong> <code>energy/${escapeHtml(m.deviceId || "{id}")}/command</code></div>
        ${statusBadge ? `<div class="mqtt-status-row">${statusBadge}</div>` : ""}
      </div>

      <div class="actions">
        <button class="button small-button" type="button" data-action="mqtt-save" ${state.deviceConnected ? "disabled" : ""}>保存配置</button>
      </div>
    </div>
  `;
}

// ============================================================
//  Calibration / Functions
// ============================================================

function renderCalibrationPanel() {
  const c = state.calibration;
  return `
    <section class="panel">
      <h2>参数校准</h2>
      <div class="form-grid">
        ${calib("invd", "校准输入电压 (V)", c.invd, 120, 0.5, 3)}
        ${calib("outvd", "校准输出电压 (V)", c.outvd, 120, 0.1, 3)}
        ${calib("rnfa", "输入采样电阻 (Ω)", c.rnfa, 1, 0.001, 4)}
        ${calib("rnfb", "输出采样电阻 (Ω)", c.rnfb, 1, 0.001, 4)}
        ${calib("incd", "ADS712 电流校准", c.incd, 100, 0.5, 1)}
      </div>
    </section>
  `;
}

function calib(key, label, value, max, step, decimals) {
  return `
    <div class="calib-row">
      <label class="calib-label">${label}</label>
      <input class="calib-input" id="calib_${key}" type="number" value="${value}" step="${step}" max="${max}" />
      <button class="button small-button" type="button" data-action="send-calib" data-calib="${key}">发送</button>
    </div>
  `;
}

function renderFunctionsPanel() {
  return `
    <section class="panel">
      <h2>功能</h2>
      <div class="func-grid">
        <button class="button" type="button" data-action="device-restart">重启网关</button>
        <button class="button" type="button" data-action="device-fwupdate">升级固件</button>
      </div>
      <div class="command-row">
        <input id="cmdInput" type="text" placeholder="自定义命令..." />
        <button class="button small-button" type="button" data-action="send-command">发送</button>
      </div>
    </section>
  `;
}

// ============================================================
//  Chart
// ============================================================

function renderChartPanel() {
  return `
    <section class="panel chart-panel">
      <div class="chart-toolbar">
        <h2>可视化图表</h2>
        <div class="chart-tabs">
          <button class="tab-pill ${state.chartMode === 'wave' ? 'active' : ''}" type="button" data-action="chart-wave">波形图</button>
          <button class="tab-pill ${state.chartMode === 'raw' ? 'active' : ''}" type="button" data-action="chart-raw">原始数据</button>
        </div>
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
  return `
    <div class="raw-console">${lines.map((l) => `<div class="raw-line">${l}</div>`).join("") || '<div class="raw-line subtle">等待数据...</div>'}</div>
  `;
}

function defaultChannels() {
  return [
    { name: "Vin", color: "#FD42AC", data: [] },
    { name: "Vout", color: "#398AD9", data: [] },
    { name: "Iin", color: "#FF33FF", data: [] },
    { name: "Iout", color: "#5BEC8D", data: [] },
    { name: "Pin", color: "#FF5C5C", data: [] },
    { name: "Pout", color: "#FFFF00", data: [] },
  ];
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
    label: ch.name, data: ch.data.length ? ch.data.slice(-n) : new Array(n).fill(null),
    borderColor: ch.color, backgroundColor: ch.color + "22",
    borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.1,
  }));

  chart = new Chart(ctx, {
    type: "line", data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: {
        x: { display: true },
        y: { display: true, beginAtZero: false },
      },
      plugins: { legend: { display: false } },
    },
  });

  document.querySelectorAll(".channel-toggle").forEach((cb) => {
    cb.addEventListener("change", () => {
      const i = Number(cb.dataset.index);
      if (chart?.data.datasets[i]) {
        chart.data.datasets[i].hidden = !cb.checked;
        chart.update();
      }
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
  return {
    start() { running = true; t = 0; this._tick(); },
    stop() { running = false; if (timer) clearTimeout(timer); timer = null; },
    onData(fn) { cb = fn; },
    sendCommand(cmd) { console.log("[SIM] CMD:", cmd); },
    _tick() {
      if (!running) return;
      t++;
      const vin = 55 + 10 * Math.sin(t * 0.01) + (Math.random() - 0.5) * 2;
      const iin = Math.max(0.1, 2.5 + 1.5 * Math.sin(t * 0.008) + (Math.random() - 0.5) * 0.3);
      const pin = vin * iin;
      const vout = 28 + (Math.random() - 0.5) * 0.3;
      const iout = Math.max(0, (pin * 0.92) / vout + (Math.random() - 0.5) * 0.5);
      const pout = vout * iout;
      const efficiency = pin > 0 ? (pout / pin) * 100 : 0;
      if (cb) cb({
        metrics: { vin, iin, pin, vout, iout, pout, efficiency, temp: 42 + (Math.random() - 0.5) * 5 },
        pwm: { pwmc: Math.min(255, Math.round(efficiency * 2.55)), pwm: Math.min(255, Math.round((vin / 65) * 255)), ppwm: Math.min(255, Math.round((vout / 30) * 255)) },
        status: { buckMode: vin > vout ? "BUCK" : "BOOST", antiBackflow: "正常", driverEnabled: true, errorCode: 0 },
        rawFields: [vin, vout, iin, iout, pin, pout],
      });
      timer = setTimeout(() => this._tick(), Math.max(50, 1000 / (state.sampleCount / 10)));
    },
  };
}

function createDataSource() {
  if (state.sourceMode === "mqtt") {
    return createMqttSource({
      brokerUrl: state.mqtt.brokerUrl,
      deviceId: state.mqtt.deviceId,
      username: state.mqtt.username,
      password: state.mqtt.password,
    });
  }
  return createSimulationSource();
}

function disconnectDevice() {
  if (state.streaming) toggleStreamingSilent();
  if (dataSource) { dataSource.stop(); dataSource = null; }
  state.deviceConnected = false;
  state.mqttStatus = { state: "idle", detail: "" };
}

async function toggleDeviceConnection() {
  if (state.deviceConnected) {
    disconnectDevice();
    render();
    showToast("已断开连接");
  } else {
    dataSource = createDataSource();
    dataSource.onData(onDeviceData);
    if (dataSource.onStatus) dataSource.onStatus(onMqttStatus);

    if (state.sourceMode === "mqtt") {
      try {
        await dataSource.start();
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
}

function toggleStreaming() {
  if (state.streaming) {
    state.streaming = false;
    if (dataSource) dataSource.stop();
    destroyChart();
    render();
    showToast("已停止采集");
  } else {
    if (!state.deviceConnected) {
      dataSource = createDataSource();
      dataSource.onData(onDeviceData);
      if (dataSource.onStatus) dataSource.onStatus(onMqttStatus);
      if (state.sourceMode === "mqtt") {
        dataSource.start().then(() => {
          state.deviceConnected = true;
        }).catch((err) => {
          showToast(`连接失败: ${err.message}`);
        });
      }
      state.deviceConnected = true;
    }
    state.streaming = true;
    state.channels = defaultChannels();
    state.rawLines = [];
    dataSource.start();
    render();
    showToast("开始采集数据");
  }
}

function toggleStreamingSilent() {
  state.streaming = false;
  if (dataSource) dataSource.stop();
  destroyChart();
}

function onMqttStatus(event) {
  if (event.type === "status") {
    state.mqttStatus = { state: event.state, detail: event.detail || "" };
    if (event.state === "disconnected" && !state.deviceConnected) {
      state.mqttStatus = { state: "idle", detail: "" };
    }
  }
  if (event.type === "log") {
    state.mqttLogs.push(`[${event.level}] ${event.message}`);
    if (state.mqttLogs.length > 50) state.mqttLogs = state.mqttLogs.slice(-30);
  }
}

function onDeviceData(packet) {
  state.metrics = packet.metrics;
  state.pwm = packet.pwm;
  state.status = packet.status;

  const fields = packet.rawFields;
  for (let i = 0; i < Math.min(fields.length, state.channels.length); i++) {
    state.channels[i].data.push(fields[i]);
    if (state.channels[i].data.length > state.sampleCount * 2) {
      state.channels[i].data = state.channels[i].data.slice(-state.sampleCount);
    }
  }

  const colors = ["#FD42AC", "#398AD9", "#FF33FF", "#5BEC8D", "#FF5C5C", "#FFFF00"];
  const labels = ["Vin", "Vout", "Iin", "Iout", "Pin", "Pout"];
  const rawHtml = fields.map((v, i) => `<span style="color:${colors[i]}">${labels[i]}:${Number(v).toFixed(3)}</span>`).join(" ");
  state.rawLines.push(rawHtml);
  if (state.rawLines.length > 200) state.rawLines = state.rawLines.slice(-100);

  if (!chartTimer && state.chartMode === "wave") {
    chartTimer = requestAnimationFrame(() => { chartTimer = null; updateChart(); updateLiveDisplays(); });
  }
  if (state.chartMode === "raw") updateRawConsole();
}

function updateLiveDisplays() {
  const m = state.metrics;
  updateElText("#metric-vin", `${m.vin.toFixed(2)} V`);
  updateElText("#metric-iin", `${m.iin.toFixed(3)} A`);
  updateElText("#metric-pin", `${m.pin.toFixed(2)} W`);
  updateElText("#metric-vout", `${m.vout.toFixed(2)} V`);
  updateElText("#metric-iout", `${m.iout.toFixed(3)} A`);
  updateElText("#metric-pout", `${m.pout.toFixed(2)} W`);
  updateElText("#metric-eff", `${m.efficiency.toFixed(1)} %`);
  updateElText("#metric-temp", `${m.temp.toFixed(1)} °C`);
  const rows = document.querySelectorAll(".pwm-row");
  rows.forEach((r) => {
    const label = r.dataset.label;
    const val = state.pwm[label.toLowerCase()] ?? 0;
    const fill = r.querySelector(".pwm-fill");
    const tv = r.querySelector(".pwm-value");
    if (fill) fill.style.width = `${Math.min(100, (val / 255) * 100)}%`;
    if (tv) tv.textContent = val;
  });
}

function updateElText(sel, text) { const el = document.querySelector(sel); if (el) el.textContent = text; }

function updateRawConsole() {
  const container = document.querySelector(".raw-console");
  if (!container) return;
  const lines = state.rawLines.slice(-50);
  container.innerHTML = lines.map((l) => `<div class="raw-line">${l}</div>`).join("") || '<div class="raw-line subtle">等待数据...</div>';
  container.scrollTop = container.scrollHeight;
}

function sendCustomCommand() {
  const input = document.querySelector("#cmdInput");
  if (!input?.value.trim()) return;
  if (dataSource) dataSource.sendCommand(input.value.trim());
  showToast(`已发送: ${input.value.trim()}`);
  input.value = "";
}

function sendCalibration(key) {
  const input = document.querySelector(`#calib_${key}`);
  if (!input) return;
  const value = Number(input.value);
  if (isNaN(value)) return;
  const cmdMap = { invd: "INVD", outvd: "OUTVD", rnfa: "RNFA", rnfb: "RNFB", incd: "INCD" };
  const cmd = (cmdMap[key] || key.toUpperCase()) + value;
  if (dataSource) dataSource.sendCommand(cmd);
  state.calibration[key] = value;
  showToast(`已发送: ${cmd}`);
}

function saveMqttConfigToState() {
  state.mqtt.brokerUrl = document.querySelector("#mqttBroker")?.value.trim() || state.mqtt.brokerUrl;
  state.mqtt.deviceId = document.querySelector("#mqttDeviceId")?.value.trim() || "";
  state.mqtt.username = document.querySelector("#mqttUsername")?.value.trim() || "";
  state.mqtt.password = document.querySelector("#mqttPassword")?.value || "";
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
    ${renderAccountHero()}
    ${renderAccountPanel()}
    ${renderProfileForm()}
    ${renderVersionPanel()}
  `;
}

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
      <span class="type-pill ${state.cloudUser ? "good" : ""}">${escapeHtml(badge)}</span>
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
      <div class="field"><label for="profileUsername">用户名</label><input id="profileUsername" type="text" value="${escapeHtml(p.username || "")}" /></div>
      <div class="field"><label for="profileDisplay">昵称</label><input id="profileDisplay" type="text" value="${escapeHtml(p.display_name || "")}" /></div>
      <div class="field"><label for="profileBio">简介</label><input id="profileBio" type="text" value="${escapeHtml(p.bio || "")}" /></div>
      <div class="actions"><button class="button" type="button" data-action="save-profile">保存</button></div>
    </section>
  `;
}

// ============================================================
//  Auth
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
    state.cloudProfile = await cloud.upsertProfile({ id: state.cloudUser.id, username: u, display_name: d, bio: cleanText(document.querySelector("#profileBio")?.value || "") });
    showToast("个人资料已保存"); render();
  } catch (e) { showToast(`保存失败：${e.message}`); }
}

// ============================================================
//  Version
// ============================================================

function renderVersionPanel() {
  const v = state.appVersion;
  return `
    <section class="panel version-card"><div><span class="version-label">当前版本</span><strong>${escapeHtml(v.current || v.latest || "未知")}</strong><p class="subtle">${v.checking ? "正在检查更新" : v.updateAvailable ? `发现新版本 ${v.latest}` : v.error ? "版本检查失败" : "已是最新版本"}</p></div>${v.updateAvailable ? `<button class="button small-button" type="button" data-action="refresh-app">立即更新</button>` : ""}</section>
  `;
}

async function checkAppVersion() {
  state.appVersion.checking = true; state.appVersion.error = ""; rerenderVersion();
  try {
    const r = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
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
function escapeHtml(v) { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function getAvatarText(l) { const t = String(l || "").trim(); return t ? t.slice(0, 1).toUpperCase() : "?"; }
function cleanText(v) { return String(v || "").trim().replace(/\s+/g, " "); }
