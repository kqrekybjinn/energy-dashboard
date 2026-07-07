import { CONFIG } from "./config.js";

export const CLOUD_API_VERSION = 1;

const SUPABASE_URL = CONFIG.supabaseUrl;
const SUPABASE_ANON_KEY = CONFIG.supabaseAnonKey;
const APP_URL = CONFIG.appUrl;

export const cloud = {
  configured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
  supabaseUrl: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  appUrl: APP_URL,
};
