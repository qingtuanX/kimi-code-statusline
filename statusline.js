#!/usr/bin/env node
"use strict";

// Footer status line for kimi-code (~/.kimi-code/tui.toml -> [status_line] command).
//
// Renders one line under the input box:
//   <this session cost>  |  <provider key balance>
//
// kimi-code runs this command at most once per second and kills it after
// 300 ms, so this script must stay fast: it only touches local files and
// prints. The balance API call happens in statusline-refresh.js, spawned
// detached when the cached balance gets stale.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const KIMI_DIR = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
const SESSIONS_DIR = path.join(KIMI_DIR, "sessions");
const CACHE_DIR = path.join(KIMI_DIR, "statusline-cache");
const COST_CACHE = path.join(CACHE_DIR, "cost.json");
const BALANCE_CACHE = path.join(CACHE_DIR, "balance.json");
const LOCK_FILE = path.join(CACHE_DIR, "refresh.lock");
const CONFIG_FILE = path.join(KIMI_DIR, "statusline.config.json");
const REFRESH_SCRIPT = path.join(KIMI_DIR, "statusline-refresh.js");
const FIRST_PAYLOAD_FILE = path.join(CACHE_DIR, "first-payload.json");

const USAGE_KEYS = ["inputOther", "output", "inputCacheRead", "inputCacheCreation"];
const LOCK_TTL_MS = 30_000;
const BALANCE_STALE_MS = 10 * 60_000;

const DEFAULT_CONFIG = {
  currency: "¥",
  balance_refresh_seconds: 90,
  segments: ["model", "cost", "balance"],
  prices_per_million_tokens: {
    _default: { cache_hit: 0.2, cache_miss: 2, output: 3 },
  },
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${String(process.pid)}`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch {}
}

function emptyCounts() {
  return { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function listAgentWireFiles(sessionDir) {
  const out = [];
  const agentsDir = path.join(sessionDir, "agents");
  let agents;
  try {
    agents = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const wire = path.join(agentsDir, agent.name, "wire.jsonl");
    try {
      if (fs.statSync(wire).isFile()) out.push(wire);
    } catch {}
  }
  return out;
}

function resolveWireFiles(sessionId, cwd) {
  if (sessionId) {
    let wdDirs;
    try {
      wdDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const wd of wdDirs) {
      if (!wd.isDirectory() || !wd.name.startsWith("wd_")) continue;
      const wdPath = path.join(SESSIONS_DIR, wd.name);
      let sessions;
      try {
        sessions = fs.readdirSync(wdPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        const matches =
          s.name === sessionId ||
          s.name === `session_${sessionId}` ||
          s.name.endsWith(sessionId) ||
          sessionId.endsWith(s.name);
        if (matches) return listAgentWireFiles(path.join(wdPath, s.name));
      }
    }
  }
  // Fallback: newest non-archived session in the reported cwd.
  if (!cwd) return [];
  let best = null;
  let bestAt = -1;
  let wdDirs = [];
  try {
    wdDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const wd of wdDirs) {
    if (!wd.isDirectory() || !wd.name.startsWith("wd_")) continue;
    const wdPath = path.join(SESSIONS_DIR, wd.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(wdPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory() || !s.name.startsWith("session_")) continue;
      const statePath = path.join(wdPath, s.name, "state.json");
      const state = readJson(statePath, null);
      if (!state || state.archived === true) continue;
      if (cwd && state.cwd && path.resolve(state.cwd) !== path.resolve(cwd)) continue;
      const at = typeof state.updatedAt === "number" ? state.updatedAt : 0;
      if (at > bestAt) {
        bestAt = at;
        best = path.join(wdPath, s.name);
      }
    }
  }
  return best ? listAgentWireFiles(best) : [];
}

function scanWireFile(file, prev) {
  const fresh = { offset: 0, byModel: {} };
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return fresh;
  }
  const resumable = prev && typeof prev.offset === "number" && prev.offset <= size;
  let offset = resumable ? prev.offset : 0;
  const byModel = resumable && prev.byModel ? JSON.parse(JSON.stringify(prev.byModel)) : {};
  if (size === offset) return { offset, byModel };

  let buf;
  try {
    const fd = fs.openSync(file, "r");
    try {
      buf = Buffer.allocUnsafe(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { offset, byModel };
  }

  const text = buf.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { offset, byModel };

  for (const line of text.slice(0, lastNewline).split("\n")) {
    if (!line.includes('"usage.record"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || rec.type !== "usage.record") continue;
    if (rec.usageScope === "session") continue; // duplicate snapshot of a single turn
    const usage = rec.usage;
    if (!usage || typeof usage !== "object") continue;
    const model = typeof rec.model === "string" && rec.model.length > 0 ? rec.model : "unknown";
    const acc = byModel[model] || (byModel[model] = emptyCounts());
    for (const key of USAGE_KEYS) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value)) acc[key] += value;
    }
  }
  const consumed = Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");
  return { offset: offset + consumed, byModel };
}

function sessionCost(sessionId, cwd, config) {
  const files = resolveWireFiles(sessionId, cwd);
  const cache = readJson(COST_CACHE, null);
  const sameSession = cache && cache.sessionId === (sessionId ?? null);
  const fileStates = sameSession && cache.files && typeof cache.files === "object" ? cache.files : {};
  const present = new Set();
  const byModel = {};
  for (const file of files) {
    present.add(file);
    const state = scanWireFile(file, fileStates[file] ?? null);
    fileStates[file] = state;
    for (const [model, counts] of Object.entries(state.byModel)) {
      const acc = byModel[model] || (byModel[model] = emptyCounts());
      for (const key of USAGE_KEYS) acc[key] += counts[key] || 0;
    }
  }
  for (const file of Object.keys(fileStates)) {
    if (!present.has(file)) delete fileStates[file];
  }
  if (files.length > 0) {
    writeJsonAtomic(COST_CACHE, { sessionId: sessionId ?? null, at: Date.now(), files: fileStates });
  }
  return { byModel, total: priceUsage(byModel, config) };
}

function priceUsage(byModel, config) {
  const table =
    config && config.prices_per_million_tokens && typeof config.prices_per_million_tokens === "object"
      ? config.prices_per_million_tokens
      : DEFAULT_CONFIG.prices_per_million_tokens;
  const fallback = table._default && typeof table._default === "object" ? table._default : { cache_hit: 0, cache_miss: 0, output: 0 };
  let total = 0;
  for (const [model, counts] of Object.entries(byModel)) {
    const price = table[model] && typeof table[model] === "object" ? table[model] : fallback;
    const miss = num(price.cache_miss);
    const hit = num(price.cache_hit);
    const out = num(price.output);
    const creation = num(price.cache_creation) || miss;
    total +=
      (counts.inputOther * miss + counts.inputCacheRead * hit + counts.inputCacheCreation * creation + counts.output * out) / 1e6;
  }
  return total;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatMoney(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  if (abs === 0) return "0.00";
  if (abs >= 0.01) return value.toFixed(3);
  return value.toFixed(4);
}

function balanceText(config) {
  const symbol = typeof config.currency === "string" && config.currency.length > 0 ? config.currency : DEFAULT_CONFIG.currency;
  const balance = readJson(BALANCE_CACHE, null);
  if (!balance || typeof balance !== "object") return null;
  const total = balance.ok ? balance.total : balance.last_ok_total;
  const at = balance.ok ? balance.at : balance.last_ok_at;
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  const stale = Date.now() - (typeof at === "number" ? at : 0) > BALANCE_STALE_MS;
  return `${symbol}${formatMoney(total)}${stale ? "*" : ""}`;
}

function shortCwd(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let work = cwd.replace(/\\/g, "/");
  if (home.length > 0) {
    const normalizedHome = home.replace(/\\/g, "/");
    if (work === normalizedHome) return "~";
    if (work.startsWith(`${normalizedHome}/`)) work = `~${work.slice(normalizedHome.length)}`;
  }
  const segments = work.split("/").filter((s) => s.length > 0);
  if (segments.length <= 3) return work;
  return `…/${segments.slice(-3).join("/")}`;
}

function renderLine(payload, config, cost, symbol) {
  const configured =
    Array.isArray(config.segments) && config.segments.length > 0 ? config.segments : DEFAULT_CONFIG.segments;
  const parts = [];
  for (const segment of configured) {
    switch (segment) {
      case "model": {
        if (typeof payload.model === "string" && payload.model.trim().length > 0) parts.push(payload.model.trim());
        break;
      }
      case "mode": {
        const modes = [];
        if (payload.permissionMode === "auto" || payload.permissionMode === "yolo") modes.push(payload.permissionMode);
        if (payload.planMode === true) modes.push("plan");
        if (modes.length > 0) parts.push(modes.join(" "));
        break;
      }
      case "cwd": {
        if (typeof payload.cwd === "string" && payload.cwd.length > 0) parts.push(shortCwd(payload.cwd));
        break;
      }
      case "git": {
        if (typeof payload.gitBranch === "string" && payload.gitBranch.length > 0) parts.push(payload.gitBranch);
        break;
      }
      case "cost": {
        parts.push(`本次会话 ${symbol}${formatMoney(cost.total)}`);
        break;
      }
      case "balance": {
        const balance = balanceText(config);
        parts.push(balance === null ? "key 余额 --" : `key 余额 ${balance}`);
        break;
      }
    }
  }
  return parts.join("  ·  ");
}

function requestBalanceRefresh(config) {
  const intervalMs = Math.max(15, num(config.balance_refresh_seconds) || DEFAULT_CONFIG.balance_refresh_seconds) * 1000;
  const balance = readJson(BALANCE_CACHE, null);
  const now = Date.now();
  if (balance && typeof balance.at === "number" && now - balance.at < intervalMs) return;
  try {
    if (now - fs.statSync(LOCK_FILE).mtimeMs < LOCK_TTL_MS) return;
  } catch {}
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch {
    return;
  }
  try {
    const child = spawn(process.execPath, [REFRESH_SCRIPT], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {}
    });
    child.unref();
  } catch {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {}
  }
}

function captureFirstPayload(raw, payload) {
  try {
    if (fs.existsSync(FIRST_PAYLOAD_FILE)) return;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(FIRST_PAYLOAD_FILE, `${JSON.stringify({ at: Date.now(), raw, payload })}\n`);
  } catch {}
}

function main() {
  const raw = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {}
  if (!payload || typeof payload !== "object") payload = {};
  captureFirstPayload(raw.trim(), payload);

  const config = readJson(CONFIG_FILE, DEFAULT_CONFIG);
  const symbol = typeof config.currency === "string" && config.currency.length > 0 ? config.currency : DEFAULT_CONFIG.currency;
  const cost = sessionCost(
    typeof payload.sessionId === "string" ? payload.sessionId : null,
    typeof payload.cwd === "string" ? payload.cwd : null,
    config,
  );

  const line = renderLine(payload, config, cost, symbol);
  requestBalanceRefresh(config);
  process.stdout.write(`${line}\n`);
}

main();
