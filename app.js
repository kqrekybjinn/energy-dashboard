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
};

const view = document.querySelector("#view");
const toast = document.querySelector("#toast");
let dbPromise = null;
let toastTimer = null;

boot();

async function boot() {
  bindGlobalEvents();
  await initCloud();
  registerServiceWorker();
  checkAppVersion();
  render();
}

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

function bindGlobalEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    });
  });
  view.addEventListener("click", handleViewClick);
}

async function handleViewClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  if (action === "sign-in-provider") {
    const provider = target.dataset.provider || "github";
    await signInProvider(provider);
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
}

function render() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.view);
  });

  if (state.view === "dashboard") renderDashboard();
  if (state.view === "data") renderData();
  if (state.view === "settings") renderSettings();
}

function renderDashboard() {
  view.innerHTML = `
    <section class="panel">
      <h2>仪表盘</h2>
      <p class="subtle">能源管理终端 - 开发中</p>
    </section>
  `;
}

function renderData() {
  view.innerHTML = `
    <section class="panel">
      <h2>数据</h2>
      <p class="subtle">数据管理页面 - 开发中</p>
    </section>
  `;
}

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

// --- Auth actions ---

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

// --- Version ---

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

// --- Utilities ---

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
