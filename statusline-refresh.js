#!/usr/bin/env node
"use strict";

// Background balance refresher for the kimi-code footer status line.
// Spawned detached by statusline.js when the cached balance goes stale.
// Reads the provider credentials from ~/.kimi-code/config.toml and calls the
// DeepSeek-compatible balance endpoint, then writes ~/.kimi-code/statusline-cache/balance.json.

const fs = require("fs");
const os = require("os");
const path = require("path");

const KIMI_DIR = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
const CONFIG_TOML = path.join(KIMI_DIR, "config.toml");
const CACHE_DIR = path.join(KIMI_DIR, "statusline-cache");
const BALANCE_CACHE = path.join(CACHE_DIR, "balance.json");
const LOCK_FILE = path.join(CACHE_DIR, "refresh.lock");
const FETCH_TIMEOUT_MS = 8000;

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote && line[i - 1] !== "\\") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseProviders(toml) {
  const providers = {};
  let current = null;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;
    const section = /^\[providers\.([^\]]+)\]$/.exec(line);
    if (section) {
      current = {};
      providers[section[1]] = current;
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    if (current === null) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/.exec(line);
    if (kv) current[kv[1]] = kv[2];
  }
  return providers;
}

function pickProvider(providers) {
  for (const [id, provider] of Object.entries(providers)) {
    const baseUrl = typeof provider.base_url === "string" ? provider.base_url : "";
    if (!/deepseek/i.test(id) && !/deepseek/i.test(baseUrl)) continue;
    const apiKey =
      typeof provider.api_key === "string" && provider.api_key.length > 0
        ? provider.api_key
        : typeof provider.api_key_env === "string" && provider.api_key_env.length > 0
          ? process.env[provider.api_key_env] ?? ""
          : "";
    if (baseUrl.length === 0 || apiKey.length === 0) continue;
    return { id, baseUrl, apiKey };
  }
  return null;
}

async function fetchBalance(provider) {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/user/balance`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${provider.apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const body = await response.json();
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const info = infos.find((item) => item?.currency === "CNY") ?? infos[0];
  const total = Number(info?.total_balance);
  if (!Number.isFinite(total)) throw new Error("no balance_infos in response");
  return { total, currency: typeof info?.currency === "string" ? info.currency : "CNY" };
}

async function main() {
  const previous = readJson(BALANCE_CACHE, null);
  const carried = {
    last_ok_total: typeof previous?.last_ok_total === "number" ? previous.last_ok_total : undefined,
    last_ok_at: typeof previous?.last_ok_at === "number" ? previous.last_ok_at : undefined,
    last_ok_currency: typeof previous?.last_ok_currency === "string" ? previous.last_ok_currency : undefined,
  };
  if (previous?.ok === true && typeof previous.total === "number" && carried.last_ok_total === undefined) {
    carried.last_ok_total = previous.total;
    carried.last_ok_at = previous.at;
    carried.last_ok_currency = previous.currency;
  }

  const provider = pickProvider(parseProviders(readText(CONFIG_TOML)));
  if (provider === null) {
    writeJsonAtomic(BALANCE_CACHE, {
      at: Date.now(),
      ok: false,
      error: "no deepseek provider with base_url + api_key in config.toml",
      ...carried,
    });
    return;
  }

  try {
    const { total, currency } = await fetchBalance(provider);
    const at = Date.now();
    writeJsonAtomic(BALANCE_CACHE, {
      at,
      ok: true,
      provider: provider.id,
      currency,
      total,
      last_ok_total: total,
      last_ok_at: at,
      last_ok_currency: currency,
    });
  } catch (error) {
    writeJsonAtomic(BALANCE_CACHE, {
      at: Date.now(),
      ok: false,
      provider: provider.id,
      error: error instanceof Error ? error.message : String(error),
      ...carried,
    });
  }
}

main()
  .catch(() => {})
  .finally(() => {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {}
  });
