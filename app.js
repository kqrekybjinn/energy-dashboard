import { cloud } from "./cloud.js";

const DB_NAME = "energy-dashboard-db";
const DB_VERSION = 1;

const state = {
  view: "dashboard",
};

const view = document.querySelector("#view");
const toast = document.querySelector("#toast");
let dbPromise = null;
let toastTimer = null;

boot();

async function boot() {
  bindGlobalEvents();
  render();
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
    <section class="panel">
      <h2>设置</h2>
      <p class="subtle">${cloud.configured ? "Supabase 已配置" : "Supabase 未配置"}</p>
    </section>
  `;
}

function showToast(message) {
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
