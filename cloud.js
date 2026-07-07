import { CONFIG } from "./config.js";

export const CLOUD_API_VERSION = 1;

const SESSION_KEY = "energy-dashboard-session";
const OAUTH_PROVIDERS = new Set(["github"]);

function normalizeConfig(config) {
  const appUrl = String(config.appUrl || "");
  return {
    supabaseUrl: String(config.supabaseUrl || "").replace(/\/$/, ""),
    supabaseAnonKey: String(config.supabaseAnonKey || ""),
    appUrl: appUrl ? appUrl.replace(/\/?$/, "/") : "",
  };
}

const normalizedConfig = normalizeConfig(CONFIG);

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function saveSession(session) {
  if (!session) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function assertConfigured(config) {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error("还没有配置 Supabase，请先填写 config.js");
  }
}

function getCurrentUrl(locationLike) {
  if (!locationLike?.origin) return "";
  const pathname = String(locationLike.pathname || "/").replace(/\/index\.html$/, "/");
  return `${locationLike.origin}${pathname}`;
}

function buildOAuthSignInUrl(config, provider, locationLike = globalThis.location) {
  assertConfigured(config);
  if (!OAUTH_PROVIDERS.has(provider)) throw new Error("不支持的登录方式");
  const url = new URL(`${config.supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set("provider", provider);
  url.searchParams.set("redirect_to", getCurrentUrl(locationLike));
  return url.toString();
}

function normalizeAuthSession(session, fallbackRefreshToken = "") {
  const expiresIn = Number(session.expires_in || 3600);
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token || fallbackRefreshToken || "",
    expires_at: session.expires_at
      ? Number(session.expires_at) * 1000
      : Date.now() + expiresIn * 1000,
  };
}

function isSessionExpiring(session) {
  if (!session.expires_at) return false;
  return Number(session.expires_at) <= Date.now() + 60_000;
}

async function readResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      data?.msg ||
      data?.message ||
      data?.error_description ||
      data?.hint ||
      response.statusText;
    throw new Error(message);
  }
  return data;
}

async function authFetch(config, path, options) {
  const headers = {
    apikey: config.supabaseAnonKey,
    "Content-Type": "application/json",
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${config.supabaseUrl}/auth/v1${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return readResponse(response);
}

async function restFetch(config, path, options) {
  assertConfigured(config);
  const headers = {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${options.token || config.supabaseAnonKey}`,
    "Content-Type": "application/json",
  };
  if (options.prefer) headers.Prefer = options.prefer;
  const response = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return readResponse(response);
}

async function refreshSession(config, refreshToken) {
  const session = await authFetch(config, "/token?grant_type=refresh_token", {
    method: "POST",
    body: { refresh_token: refreshToken },
  });
  return normalizeAuthSession(session, refreshToken);
}

async function getValidSession(config) {
  const session = loadSession();
  if (!session?.access_token) throw new Error("请先登录");
  if (!isSessionExpiring(session)) return session;
  if (!session.refresh_token) return session;
  const refreshed = await refreshSession(config, session.refresh_token);
  saveSession(refreshed);
  return refreshed;
}

export const cloud = {
  get configured() {
    return Boolean(normalizedConfig.supabaseUrl && normalizedConfig.supabaseAnonKey);
  },

  get session() {
    return loadSession();
  },

  set session(value) {
    saveSession(value);
  },

  clearSession() {
    localStorage.removeItem(SESSION_KEY);
  },

  handleAuthRedirect() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    const expiresIn = Number(hash.get("expires_in") || 3600);
    if (!accessToken) return false;
    saveSession(
      normalizeAuthSession(
        {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: expiresIn,
        },
        refreshToken,
      ),
    );
    history.replaceState(null, "", location.pathname + location.search);
    return true;
  },

  signInWithOAuth(provider) {
    const url = buildOAuthSignInUrl(normalizedConfig, provider);
    location.href = url;
  },

  async getUser() {
    assertConfigured(normalizedConfig);
    const session = await getValidSession(normalizedConfig);
    const result = await authFetch(normalizedConfig, "/user", {
      method: "GET",
      token: session.access_token,
    });
    return result;
  },

  async signOut() {
    if (!this.configured || !this.session?.access_token) {
      this.clearSession();
      return;
    }
    try {
      await authFetch(normalizedConfig, "/logout", {
        method: "POST",
        token: this.session.access_token,
      });
    } finally {
      this.clearSession();
    }
  },

  async getMyProfile(userId) {
    const rows = await restFetch(
      normalizedConfig,
      `/profiles?id=eq.${encodeURIComponent(userId)}&select=*`,
      {
        method: "GET",
        token: this.session?.access_token,
      },
    );
    return rows?.[0] || null;
  },

  async upsertProfile(profile) {
    if (!profile?.id) throw new Error("请先登录");
    const session = await getValidSession(normalizedConfig);
    const rows = await restFetch(normalizedConfig, "/profiles?on_conflict=id", {
      method: "POST",
      token: session.access_token,
      prefer: "resolution=merge-duplicates,return=representation",
      body: [
        {
          id: profile.id,
          username: profile.username,
          display_name: profile.display_name || profile.username,
          avatar_url: profile.avatar_url || null,
          bio: profile.bio || null,
          updated_at: new Date().toISOString(),
        },
      ],
    });
    return rows?.[0] || null;
  },
};
