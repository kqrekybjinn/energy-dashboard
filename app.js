import { cloud, CLOUD_API_VERSION } from "./cloud.js";

const DB_NAME = "energy-dashboard-db";
const DB_VERSION = 1;
const APP_VERSION_KEY = "energy-dashboard-app-version";
const SW_CACHE_PREFIX = "energy-dashboard-";

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
  // MPPT device state
  deviceConnected: false,
  deviceIP: "192.168.5.63",
  devicePort: 2333,
  sampleCount: 300,
  streaming: false,
  chartMode: "wave", // "wave" | "raw"
  // Live data
  status: {
    buckMode: "BUCK",
    antiBackflow: "正常",
    driverEnabled: true,
    errorCode: 0,
  },
  pwm: { pwmc: 0, pwm: 0, ppwm: 0 },
  metrics: {
    vin: 0, iin: 0, pin: 0,
    vout: 0, iout: 0, pout: 0,
    efficiency: 0,
  },
  calibration: {
    invd: 50.0, outvd: 50.0,
    rnfa: 0.002, rnfb: 0.002,
    incd: 10.0,
  },
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
  if (!state.cloudConfigured) {
    state.cloudReady = true;
    return;
  }
  cloud.handleAuthRedirect();
  if (!cloud.session?.access_token) {
    state.cloudReady = true;
    return;
  }
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
  if (action === "sign-in-provider") {
    await signInProvider(target.dataset.provider || "github");
  }
  if (action === "sign-out") {
    await signOutCloud();
  }
  if (action === "save-profile") {
    await saveProfile();
  }
  if (action === "refresh-app") {
    await refreshAppAssets();
  }

  // Device
  if (action === "device-connect") {
    await toggleDeviceConnection();
  }
  if (action === "stream-toggle") {
    toggleStreaming();
  }
  if (action === "chart-wave") {
    state.chartMode = "wave";
    render();
  }
  if (action === "chart-raw") {
    state.chartMode = "raw";
    render();
  }
  if (action === "device-restart") {
    sendCommand("ESPRESTART");
    showToast("已发送重启指令");
  }
  if (action === "device-fwupdate") {
    sendCommand("FWUPDATE");
    const url = `http://${state.deviceIP}`;
    window.open(url, "_blank");
    showToast("已打开设备网页");
  }
  if (action === "send-command") {
    sendCustomCommand();
  }
  if (action === "send-calib") {
    sendCalibration(target.dataset.calib);
  }
}

function handleViewInput(event) {
  const target = event.target;
  if (!target) return;

  if (target.id === "deviceIP") {
    state.deviceIP = target.value.trim();
  }
  if (target.id === "devicePort") {
    state.devicePort = Number(target.value) || 2333;
  }
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
//  DASHBOARD — MPPT Monitor
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

  if (state.chartMode === "wave" && state.streaming) {
    initChart();
  }
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
        ${renderPwmBar("PWMC", p.pwmc, 255)}
        ${renderPwmBar("PWM", p.pwm, 255)}
        ${renderPwmBar("PPWM", p.ppwm, 255)}
      </div>
    </section>
  `;
}

function renderPwmBar(label, value, max) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return `
    <div class="pwm-row">
      <span class="pwm-label">${label}</span>
      <div class="pwm-track">
        <div class="pwm-fill" style="width:${pct.toFixed(0)}%"></div>
      </div>
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
          <span class="metric-value">${m.vin.toFixed(2)} <small>V</small></span>
        </div>
        <div class="metric-card">
          <span class="metric-label">输入电流</span>
          <span class="metric-value">${m.iin.toFixed(3)} <small>A</small></span>
        </div>
        <div class="metric-card">
          <span class="metric-label">输入功率</span>
          <span class="metric-value">${m.pin.toFixed(2)} <small>W</small></span>
        </div>
        <div class="metric-card">
          <span class="metric-label">输出电压</span>
          <span class="metric-value">${m.vout.toFixed(2)} <small>V</small></span>
        </div>
        <div class="metric-card">
          <span class="metric-label">输出电流</span>
          <span class="metric-value">${m.iout.toFixed(3)} <small>A</small></span>
        </div>
        <div class="metric-card">
          <span class="metric-label">输出功率</span>
          <span class="metric-value">${m.pout.toFixed(2)} <small>W</small></span>
        </div>
        <div class="metric-card wide">
          <span class="metric-label">效率</span>
          <span class="metric-value">${m.efficiency.toFixed(1)} <small>%</small></span>
        </div>
      </div>
    </section>
  `;
}

function renderConnectionPanel() {
  const btnLabel = state.deviceConnected ? "断开连接" : "连接设备";
  const btnClass = state.deviceConnected ? "danger-button" : "button";
  return `
    <section class="panel">
      <h2>设备连接</h2>
      <div class="form-grid">
        <div class="field-row">
          <div class="field">
            <label for="deviceIP">目标 IP</label>
            <input id="deviceIP" type="text" value="${escapeHtml(state.deviceIP)}" ${state.deviceConnected ? "disabled" : ""} />
          </div>
          <div class="field field-sm">
            <label for="devicePort">端口</label>
            <input id="devicePort" type="number" value="${state.devicePort}" ${state.deviceConnected ? "disabled" : ""} />
          </div>
        </div>
        <div class="field">
          <label for="sampleCount">图表采样数 (300–10000)</label>
          <input id="sampleCount" type="number" value="${state.sampleCount}" min="300" max="10000" step="100" />
        </div>
        <div class="actions">
          <button class="${btnClass}" type="button" data-action="device-connect">${btnLabel}</button>
          ${state.streaming ? `<button class="button" type="button" data-action="stream-toggle">⏹ 停止</button>` : `<button class="button" type="button" data-action="stream-toggle" ${!state.deviceConnected ? "disabled" : ""}>▶ 开始采集</button>`}
        </div>
      </div>
    </section>
  `;
}

function renderCalibrationPanel() {
  const c = state.calibration;
  return `
    <section class="panel">
      <h2>参数校准</h2>
      <div class="form-grid">
        ${renderCalibRow("invd", "校准输入电压 (V)", c.invd, 120, 0.5)}
        ${renderCalibRow("outvd", "校准输出电压 (V)", c.outvd, 120, 0.1)}
        ${renderCalibRow("rnfa", "输入采样电阻 (Ω)", c.rnfa, 1, 0.001, 4)}
        ${renderCalibRow("rnfb", "输出采样电阻 (Ω)", c.rnfb, 1, 0.001, 4)}
        ${renderCalibRow("incd", "ADS712 电流校准", c.incd, 100, 0.5)}
      </div>
    </section>
  `;
}

function renderCalibRow(key, label, value, max, step, decimals = 3) {
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
        <button class="button" type="button" data-action="device-restart">重启 ESP32</button>
        <button class="button" type="button" data-action="device-fwupdate">升级固件</button>
      </div>
      <div class="command-row">
        <input id="cmdInput" type="text" placeholder="自定义命令..." />
        <button class="button small-button" type="button" data-action="send-command">发送</button>
      </div>
    </section>
  `;
}

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
  const channels = state.channels.length ? state.channels : defaultChannels();
  if (!state.channels.length) {
    state.channels = defaultChannels();
  }
  return `
    <div class="wave-container">
      <canvas id="waveChart"></canvas>
    </div>
    <div class="chart-legend">
      ${state.channels.map((ch, i) => `
        <label class="legend-item">
          <input type="checkbox" class="channel-toggle" data-index="${i}" checked />
          <span class="legend-dot" style="background:${ch.color}"></span>
          ${escapeHtml(ch.name)}
        </label>
      `).join("")}
    </div>
  `;
}

function renderRawView() {
  const lines = state.rawLines.slice(-50);
  return `
    <div class="raw-console">
      ${lines.map((line) => `<div class="raw-line">${line}</div>`).join("") || '<div class="raw-line subtle">等待数据...</div>'}
    </div>
  `;
}

// ============================================================
//  Chart.js initialization
// ============================================================

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
  const channels = state.channels.length ? state.channels : defaultChannels();
  const n = state.sampleCount;

  const labels = [];
  for (let i = -n; i < 0; i++) labels.push(i);

  const datasets = channels.map((ch) => ({
    label: ch.name,
    data: ch.data.length ? ch.data : new Array(n).fill(null),
    borderColor: ch.color,
    backgroundColor: ch.color + "22",
    borderWidth: 1.5,
    pointRadius: 0,
    fill: false,
    tension: 0.1,
  }));

  chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { display: true, title: { text: "采样点", display: false } },
        y: { display: true, title: { text: "值", display: false }, beginAtZero: false },
      },
      plugins: {
        legend: { display: false },
      },
    },
  });

  // Bind legend toggles
  document.querySelectorAll(".channel-toggle").forEach((cb) => {
    cb.addEventListener("change", () => {
      const index = Number(cb.dataset.index);
      if (chart && chart.data.datasets[index]) {
        chart.data.datasets[index].hidden = !cb.checked;
        chart.update();
      }
    });
  });
}

function destroyChart() {
  if (chart) {
    chart.destroy();
    chart = null;
  }
  if (chartTimer) {
    cancelAnimationFrame(chartTimer);
    chartTimer = null;
  }
}

function updateChart() {
  if (!chart || state.chartMode !== "wave") return;

  const channels = state.channels;
  for (let i = 0; i < channels.length; i++) {
    const ds = chart.data.datasets[i];
    if (!ds) continue;
    const data = channels[i].data;
    // Right-align data: pad start with nulls
    const padded = new Array(state.sampleCount - data.length).fill(null).concat(data.slice(-state.sampleCount));
    ds.data = padded.slice(-state.sampleCount);
  }
  chart.update();
}

// ============================================================
//  Data source (simulation)
// ============================================================

function createSimulationSource() {
  let running = false;
  let timer = null;
  let callback = null;
  let t = 0;

  return {
    start() {
      running = true;
      t = 0;
      this._tick();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    onData(cb) {
      callback = cb;
    },
    sendCommand(cmd) {
      console.log("[SIM] Command sent:", cmd);
    },
    _tick() {
      if (!running) return;
      t += 1;

      // Simulate solar panel behavior: Vin varies with a slow wave + noise
      const vinBase = 55 + 10 * Math.sin(t * 0.01);
      const vin = vinBase + (Math.random() - 0.5) * 2;
      const iin = Math.max(0.1, 2.5 + 1.5 * Math.sin(t * 0.008) + (Math.random() - 0.5) * 0.3);
      const pin = vin * iin;

      // Output: buck converter
      const vout = 28 + (Math.random() - 0.5) * 0.3;
      const iout = Math.max(0, (pin * 0.92) / vout + (Math.random() - 0.5) * 0.5);
      const pout = vout * iout;
      const efficiency = pin > 0 ? (pout / pin) * 100 : 0;

      const pwmc = Math.min(255, Math.round(efficiency * 2.55));
      const pwm = Math.min(255, Math.round((vin / 65) * 255));
      const ppwm = Math.min(255, Math.round((vout / 30) * 255));

      const packet = {
        metrics: { vin, iin, pin, vout, iout, pout, efficiency },
        pwm: { pwmc, pwm, ppwm },
        status: {
          buckMode: vin > vout ? "BUCK" : "BOOST",
          antiBackflow: "正常",
          driverEnabled: true,
          errorCode: 0,
        },
        rawFields: [vin, vout, iin, iout, pin, pout],
      };

      if (callback) callback(packet);

      const interval = Math.max(50, 1000 / (state.sampleCount / 10));
      timer = setTimeout(() => this._tick(), interval);
    },
  };
}

async function toggleDeviceConnection() {
  if (state.deviceConnected) {
    // Disconnect
    if (state.streaming) toggleStreaming();
    if (dataSource) {
      dataSource.stop();
      dataSource = null;
    }
    state.deviceConnected = false;
    render();
    showToast("已断开连接");
  } else {
    // Connect (simulation mode for now)
    dataSource = createSimulationSource();
    dataSource.onData(onDeviceData);
    state.deviceConnected = true;
    showToast("已连接设备（模拟模式）");
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
      // Auto-connect
      dataSource = createSimulationSource();
      dataSource.onData(onDeviceData);
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

function onDeviceData(packet) {
  state.metrics = packet.metrics;
  state.pwm = packet.pwm;
  state.status = packet.status;

  // Push to channel data arrays
  const fields = packet.rawFields;
  const channelKeys = ["vin", "vout", "iin", "iout", "pin", "pout"];
  for (let i = 0; i < Math.min(fields.length, state.channels.length); i++) {
    state.channels[i].data.push(fields[i]);
    // Trim to sampleCount * 2 to prevent unbounded growth
    if (state.channels[i].data.length > state.sampleCount * 2) {
      state.channels[i].data = state.channels[i].data.slice(-state.sampleCount);
    }
  }

  // Raw text line with colors
  const colors = ["#FD42AC", "#398AD9", "#FF33FF", "#5BEC8D", "#FF5C5C", "#FFFF00"];
  const labels = ["Vin", "Vout", "Iin", "Iout", "Pin", "Pout"];
  const rawHtml = fields
    .map((v, i) => `<span style="color:${colors[i]}">${labels[i]}:${Number(v).toFixed(3)}</span>`)
    .join(" ");
  state.rawLines.push(rawHtml);
  if (state.rawLines.length > 200) state.rawLines = state.rawLines.slice(-100);

  // Update chart at ~10fps
  if (!chartTimer && state.chartMode === "wave") {
    chartTimer = requestAnimationFrame(() => {
      chartTimer = null;
      updateChart();
      // Also update metric/PWM displays without full re-render
      updateLiveDisplays();
    });
  }

  if (state.chartMode === "raw") {
    updateRawConsole();
  }
}

function updateLiveDisplays() {
  // Efficiently update metric values and PWM bars without full re-render
  const m = state.metrics;
  updateElText("#metric-vin", `${m.vin.toFixed(2)} V`);
  updateElText("#metric-iin", `${m.iin.toFixed(3)} A`);
  updateElText("#metric-pin", `${m.pin.toFixed(2)} W`);
  updateElText("#metric-vout", `${m.vout.toFixed(2)} V`);
  updateElText("#metric-iout", `${m.iout.toFixed(3)} A`);
  updateElText("#metric-pout", `${m.pout.toFixed(2)} W`);
  updateElText("#metric-eff", `${m.efficiency.toFixed(1)} %`);
  updatePwmBar("PWMC", state.pwm.pwmc);
  updatePwmBar("PWM", state.pwm.pwm);
  updatePwmBar("PPWM", state.pwm.ppwm);
}

function updateElText(selector, text) {
  const el = document.querySelector(selector);
  if (el) el.textContent = text;
}

function updatePwmBar(label, value) {
  const row = document.querySelector(`.pwm-row[data-label="${label}"]`);
  if (!row) return;
  const fill = row.querySelector(".pwm-fill");
  const val = row.querySelector(".pwm-value");
  if (fill) fill.style.width = `${Math.min(100, (value / 255) * 100)}%`;
  if (val) val.textContent = value;
}

function updateRawConsole() {
  const container = document.querySelector(".raw-console");
  if (!container) return;
  const lines = state.rawLines.slice(-50);
  container.innerHTML = lines.map((line) => `<div class="raw-line">${line}</div>`).join("") || '<div class="raw-line subtle">等待数据...</div>';
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
  const cmdMap = {
    invd: "INVD", outvd: "OUTVD",
    rnfa: "RNFA", rnfb: "RNFB",
    incd: "INCD",
  };
  const cmd = cmdMap[key] + value;
  if (dataSource) dataSource.sendCommand(cmd);
  state.calibration[key] = value;
  showToast(`已发送: ${cmd}`);
}

// ============================================================
//  DATA tab (placeholder)
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
//  SETTINGS tab
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
  const subtitle = state.cloudUser
    ? state.cloudUser.email || "账号已连接"
    : state.cloudConfigured
      ? "登录后可同步能耗数据"
      : "当前为本地模式，数据保存在本机";
  const badge = state.cloudUser ? "已登录" : state.cloudConfigured ? "可登录" : "本地";

  return `
    <section class="panel account-hero">
      <div class="account-main">
        <div class="account-avatar">${escapeHtml(getAvatarText(label))}</div>
        <div>
          <h2>${escapeHtml(label)}</h2>
          <p class="subtle">${escapeHtml(subtitle)}</p>
        </div>
      </div>
      <span class="type-pill ${state.cloudUser ? "good" : ""}">${escapeHtml(badge)}</span>
    </section>
  `;
}

function renderAccountPanel() {
  if (!state.cloudConfigured) {
    return `
      <section class="panel">
        <h2>账号</h2>
        <div class="setting-list">
          <div class="setting-row">
            <div>
              <strong>本地模式</strong>
              <p class="subtle">云端尚未配置。填写 <code>config.js</code> 后可启用登录和云同步。</p>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  if (!state.cloudUser) {
    return `
      <section class="panel form-grid">
        <h2>登录</h2>
        <p class="subtle">使用 GitHub 账号登录后可同步能耗数据到云端。</p>
        <div class="actions">
          <button class="button" type="button" data-action="sign-in-provider" data-provider="github">
            使用 GitHub 登录
          </button>
        </div>
      </section>
    `;
  }

  return `
    <section class="panel">
      <h2>账号</h2>
      <div class="setting-list">
        <div class="setting-row">
          <div>
            <strong>邮箱</strong>
            <p class="subtle">${escapeHtml(state.cloudUser.email || state.cloudUser.id)}</p>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <strong>云端接口版本</strong>
            <p class="subtle">${escapeHtml(String(CLOUD_API_VERSION))}</p>
          </div>
          <button class="danger-button" type="button" data-action="sign-out">退出登录</button>
        </div>
      </div>
    </section>
  `;
}

function renderProfileForm() {
  if (!state.cloudConfigured || !state.cloudUser) return "";

  const profile = state.cloudProfile || {};
  return `
    <section class="panel form-grid">
      <h2>个人资料</h2>
      <div class="field">
        <label for="profileUsername">用户名</label>
        <input id="profileUsername" type="text" placeholder="用户名" value="${escapeHtml(profile.username || "")}" />
      </div>
      <div class="field">
        <label for="profileDisplay">昵称</label>
        <input id="profileDisplay" type="text" placeholder="昵称" value="${escapeHtml(profile.display_name || "")}" />
      </div>
      <div class="field">
        <label for="profileBio">简介</label>
        <input id="profileBio" type="text" placeholder="介绍一下自己" value="${escapeHtml(profile.bio || "")}" />
      </div>
      <div class="actions">
        <button class="button" type="button" data-action="save-profile">保存</button>
      </div>
    </section>
  `;
}

// ============================================================
//  Auth actions
// ============================================================

async function signInProvider(provider) {
  try {
    cloud.signInWithOAuth(provider);
  } catch (error) {
    console.error(error);
    showToast(`登录失败：${error.message || error}`);
  }
}

async function signOutCloud() {
  await cloud.signOut();
  state.cloudUser = null;
  state.cloudProfile = null;
  showToast("已退出登录");
  render();
}

async function saveProfile() {
  try {
    if (!state.cloudUser) throw new Error("请先登录");
    const username = cleanText(document.querySelector("#profileUsername")?.value || "");
    if (!username) throw new Error("用户名不能为空");
    const displayName = cleanText(document.querySelector("#profileDisplay")?.value || "");
    if (!displayName) throw new Error("昵称不能为空");
    const profile = {
      id: state.cloudUser.id,
      username,
      display_name: displayName,
      bio: cleanText(document.querySelector("#profileBio")?.value || ""),
    };
    state.cloudProfile = await cloud.upsertProfile(profile);
    showToast("个人资料已保存");
    render();
  } catch (error) {
    console.error(error);
    showToast(`保存失败：${error.message || error}`);
  }
}

// ============================================================
//  Version check
// ============================================================

function renderVersionPanel() {
  const version = state.appVersion;
  const label = version.current || version.latest || "未知";
  const status = version.checking
    ? "正在检查更新"
    : version.updateAvailable
      ? `发现新版本 ${version.latest}`
      : version.error
        ? "版本检查失败"
        : "已是最新版本";

  return `
    <section class="panel version-card" aria-label="版本">
      <div>
        <span class="version-label">当前版本</span>
        <strong>${escapeHtml(label)}</strong>
        <p class="subtle">${escapeHtml(status)}</p>
      </div>
      ${version.updateAvailable ? `<button class="button small-button" type="button" data-action="refresh-app">立即更新</button>` : ""}
    </section>
  `;
}

async function checkAppVersion() {
  state.appVersion.checking = true;
  state.appVersion.error = "";
  rerenderVersion();
  try {
    const response = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`version.json ${response.status}`);
    const manifest = await response.json();
    const latest = String(manifest.version || "").trim();
    if (!latest) throw new Error("version.json 缺少 version 字段");
    const current = localStorage.getItem(APP_VERSION_KEY) || "";
    if (!current) {
      localStorage.setItem(APP_VERSION_KEY, latest);
      state.appVersion.current = latest;
      state.appVersion.latest = latest;
      state.appVersion.updateAvailable = false;
    } else {
      state.appVersion.current = current;
      state.appVersion.latest = latest;
      state.appVersion.updateAvailable = current !== latest;
    }
  } catch (error) {
    console.warn("版本检查失败", error);
    state.appVersion.error = error.message || "无法读取版本信息";
  } finally {
    state.appVersion.checking = false;
    rerenderVersion();
  }
}

function rerenderVersion() {
  if (state.view === "settings") render();
}

async function refreshAppAssets() {
  const latest = state.appVersion.latest;
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith(SW_CACHE_PREFIX)).map((key) => caches.delete(key)),
      );
    }
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if (latest) localStorage.setItem(APP_VERSION_KEY, latest);
    showToast("正在更新应用");
    window.setTimeout(() => window.location.reload(), 300);
  } catch (error) {
    console.error("更新失败", error);
    showToast("更新失败，请稍后重试");
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    console.warn("Service worker registration failed", error);
  });
}

// ============================================================
//  Utilities
// ============================================================

function showToast(message) {
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getAvatarText(label) {
  const trimmed = String(label || "").trim();
  if (!trimmed) return "?";
  return trimmed.slice(0, 1).toUpperCase();
}

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}
