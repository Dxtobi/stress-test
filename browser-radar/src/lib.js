import { resolve } from "node:path";

const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

function intEnv(env, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(String(env[key] ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function boolEnv(env, key, fallback = false) {
  const raw = String(env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  custom: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  anthropic: "claude-3-5-haiku-latest",
};

const DEFAULT_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  anthropic: "https://api.anthropic.com/v1",
};

export function loadConfig(env = process.env) {
  const aiProvider = String(env.AI_PROVIDER || "openai").trim().toLowerCase();
  const aiModel = String(env.AI_MODEL || DEFAULT_MODELS[aiProvider] || DEFAULT_MODELS.openai).trim();

  return {
    host: String(env.HOST || "127.0.0.1").trim(),
    port: intEnv(env, "PORT", 4317, 1, 65535),
    dataDir: resolve(String(env.DATA_DIR || "./data").trim()),
    dashboardToken: String(env.DASHBOARD_TOKEN || "").trim(),
    ingestToken: String(env.INGEST_TOKEN || "").trim(),
    allowActiveScan: boolEnv(env, "ALLOW_ACTIVE_SCAN", false),
    scanMaxProbes: intEnv(env, "SCAN_MAX_PROBES", 12, 1, 40),
    scanTimeoutMs: intEnv(env, "SCAN_TIMEOUT_MS", 4000, 500, 30000),
    scanProbeDelayMs: intEnv(env, "SCAN_PROBE_DELAY_MS", 150, 0, 5000),
    rateLimitWindowMs: intEnv(env, "RATE_LIMIT_WINDOW_MS", 60_000, 1000, 3_600_000),
    rateLimitMax: intEnv(env, "RATE_LIMIT_MAX", 60, 1, 10_000),
    maxBodyBytes: intEnv(env, "MAX_BODY_BYTES", 12 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    maxFieldChars: intEnv(env, "MAX_FIELD_CHARS", 4000, 200, 100_000),
    maxPayloadChars: intEnv(env, "MAX_PAYLOAD_CHARS", 1_500_000, 2000, 12_000_000),
    aiProvider,
    aiModel,
    aiApiKey: String(env.AI_API_KEY || "").trim(),
    aiBaseUrl: String(env.AI_BASE_URL || DEFAULT_BASE_URLS[aiProvider] || DEFAULT_BASE_URLS.openai).trim().replace(/\/+$/, ""),
    aiTimeoutMs: intEnv(env, "AI_TIMEOUT_MS", 60_000, 1000, 300_000),
  };
}

export function createRateLimit(windowMs, max) {
  const buckets = new Map();
  return function allow(req, scope = "default") {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0]?.trim();
    const key = `${scope}:${forwarded || req.socket.remoteAddress || "unknown"}`;
    const now = Date.now();
    const timestamps = (buckets.get(key) || []).filter((time) => now - time < windowMs);
    if (timestamps.length >= max) {
      buckets.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    buckets.set(key, timestamps);
    if (buckets.size > 5000) {
      for (const [entryKey, entry] of buckets) {
        if (!entry.some((time) => now - time < windowMs)) buckets.delete(entryKey);
      }
    }
    return true;
  };
}

export function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^169\.254(?:\.\d{1,3}){2}$/.test(host)) return true;
  const private172 = host.match(/^172\.(\d{1,3})(?:\.\d{1,3}){2}$/);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  if (/^f[cd][0-9a-f:]+$/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f:]+$/i.test(host)) return true;
  return false;
}

export function normalizeTargetUrl(input) {
  try {
    const url = new URL(String(input || "").trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function safeJsonStringify(value, space = 0) {
  const seen = new WeakSet();
  return JSON.stringify(
    value,
    (_key, current) => {
      if (typeof current === "bigint") return current.toString();
      if (current instanceof Error) {
        return { name: current.name, message: current.message, stack: current.stack };
      }
      if (current && typeof current === "object") {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    },
    space
  ) ?? "";
}

export function sanitizeText(value, maxLength = 4000) {
  let text = value == null ? "" : typeof value === "string" ? value : safeJsonStringify(value);
  text = text.replace(/\u0000/g, "").replace(ANSI_PATTERN, "");
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 20)}...[truncated]`;
  return text;
}

export function truncate(value, maxLength) {
  const text = typeof value === "string" ? value : safeJsonStringify(value);
  if (text.length <= maxLength) return text;
  const head = Math.floor(maxLength * 0.6);
  const tail = maxLength - head - 24;
  return `${text.slice(0, head)}\n...[truncated ${text.length - maxLength} chars]...\n${text.slice(-tail)}`;
}

const SENSITIVE_KEY = /(auth|authorization|cookie|token|secret|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|session|csrf|signature|credential)/i;
const SENSITIVE_TEXT = /(Bearer\s+[A-Za-z0-9._~+/=-]+|AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/gi;

export function redactSensitive(value, depth = 0) {
  if (depth > 12) return "[depth limit]";
  if (typeof value === "string") return value.replace(SENSITIVE_TEXT, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, current] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(current, depth + 1);
    }
    return output;
  }
  return value;
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export async function parseJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes`);
      error.status = 413;
      error.code = "body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.status = 400;
    error.code = "invalid_json";
    throw error;
  }
}

export function detectContentType(extension) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
  };
  return types[extension] || "application/octet-stream";
}
