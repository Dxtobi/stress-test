import http from "node:http";
import { readFile, mkdir, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  loadConfig,
  createRateLimit,
  isPrivateHost,
  normalizeTargetUrl,
  safeJsonStringify,
  sanitizeText,
  truncate,
  parseCookies,
  parseJsonBody,
  detectContentType,
  redactSensitive,
} from "./src/lib.js";
import { storeEvent, getEvents, getEvent, getStats } from "./src/store.js";
import { analyzeEvent } from "./src/ai.js";
import { runSecurityScan } from "./src/scanner.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

const config = loadConfig(process.env);
const rateLimit = createRateLimit(config.rateLimitWindowMs, config.rateLimitMax);

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : safeJsonStringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(data);
}

function sendError(res, status, message, code = "request_failed") {
  send(res, status, { error: { code, message } });
}

function requireDashboardToken(req, res) {
  if (!config.dashboardToken) return true;
  const cookie = parseCookies(req.headers.cookie || "");
  const auth = String(req.headers.authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const provided = bearer || cookie.browser_radar_token || "";
  if (provided !== config.dashboardToken) {
    sendError(res, 401, "Dashboard token is required", "unauthorized");
    return false;
  }
  return true;
}

function ingestAllowed(req) {
  if (!config.ingestToken) return true;
  const auth = String(req.headers.authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return bearer === config.ingestToken;
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const absolute = resolve(PUBLIC_DIR, safe);
  if (absolute !== PUBLIC_DIR && !absolute.startsWith(PUBLIC_DIR + sep)) {
    return sendError(res, 403, "Forbidden", "forbidden");
  }
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return sendError(res, 404, "Not found", "not_found");
    const body = await readFile(absolute);
    send(res, 200, body, {
      "content-type": detectContentType(extname(absolute).toLowerCase()),
      "cache-control": "no-cache",
    });
  } catch {
    sendError(res, 404, "Not found", "not_found");
  }
}

async function handleIngest(req, res) {
  if (!ingestAllowed(req)) return sendError(res, 401, "Invalid ingest token", "unauthorized");
  if (!rateLimit(req, "ingest")) return sendError(res, 429, "Too many ingest requests", "rate_limited");

  const body = await parseJsonBody(req, config.maxBodyBytes);
  const incoming = Array.isArray(body?.events) ? body.events.slice(0, 100) : [body];
  const ids = [];

  for (const item of incoming) {
    const kind = sanitizeText(item?.kind || item?.type || "browser.event", 80) || "browser.event";
    const source = sanitizeText(item?.source || body?.source || "browser-radar-agent", 120) || "browser-radar-agent";
    const sessionId = sanitizeText(item?.sessionId || body?.sessionId || randomUUID(), 120) || randomUUID();
    const page = item?.page && typeof item.page === "object" ? item.page : body?.page && typeof body.page === "object" ? body.page : {};
    const payload = item?.payload && typeof item.payload === "object" ? item.payload : item?.payload != null ? item.payload : body?.payload && typeof body.payload === "object" ? body.payload : body;

    const event = {
      id: randomUUID(),
      kind,
      category: kind.includes("security") ? "security" : kind.includes("performance") ? "performance" : "browser",
      source,
      sessionId,
      page: {
        url: truncate(sanitizeText(page.url, 2000), config.maxFieldChars),
        title: truncate(sanitizeText(page.title, 500), config.maxFieldChars),
        referrer: truncate(sanitizeText(page.referrer, 2000), config.maxFieldChars),
        userAgent: truncate(sanitizeText(page.userAgent || req.headers["user-agent"] || "", 1000), config.maxFieldChars),
        language: truncate(sanitizeText(page.language, 100), config.maxFieldChars),
        viewport: page.viewport && typeof page.viewport === "object" ? page.viewport : null,
      },
      payload: truncate(safeJsonStringify(redactSensitive(payload), 2), config.maxPayloadChars),
      receivedAt: new Date().toISOString(),
      ipHash: createHash("sha256")
        .update(String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || ""))
        .digest("hex")
        .slice(0, 16),
      status: "new",
    };

    await storeEvent(config.dataDir, event);
    ids.push(event.id);
  }

  send(res, 201, { ok: true, ids, count: ids.length });
}

async function handleListEvents(req, res, url) {
  if (!requireDashboardToken(req, res)) return;
  const events = await getEvents(config.dataDir, {
    limit: Number(url.searchParams.get("limit")) || 50,
    category: url.searchParams.get("category") || "",
    search: url.searchParams.get("search") || "",
    status: url.searchParams.get("status") || "",
  });
  const stats = await getStats(config.dataDir);
  send(res, 200, { events, stats });
}

async function handleGetEvent(req, res, id) {
  if (!requireDashboardToken(req, res)) return;
  const event = await getEvent(config.dataDir, id);
  if (!event) return sendError(res, 404, "Event not found", "not_found");
  send(res, 200, { event });
}

async function handleAnalyze(req, res, id) {
  if (!requireDashboardToken(req, res)) return;
  if (!rateLimit(req, "ai")) return sendError(res, 429, "Too many analysis requests", "rate_limited");
  const event = await getEvent(config.dataDir, id);
  if (!event) return sendError(res, 404, "Event not found", "not_found");

  const body = await parseJsonBody(req, config.maxBodyBytes);
  const result = await analyzeEvent(config, event, {
    model: body?.model,
    question: body?.question,
  });
  send(res, 200, { analysis: result });
}

async function handleScan(req, res) {
  if (!requireDashboardToken(req, res)) return;
  if (!config.allowActiveScan) {
    return sendError(res, 403, "Active scanning is disabled. Set ALLOW_ACTIVE_SCAN=true only for authorized targets.", "scanning_disabled");
  }
  if (!rateLimit(req, "scan")) return sendError(res, 429, "Too many scan requests", "rate_limited");

  const body = await parseJsonBody(req, config.maxBodyBytes);
  const target = normalizeTargetUrl(sanitizeText(body?.target, 2000));
  if (!target) return sendError(res, 400, "A valid http(s) target URL is required", "invalid_target");
  if (target.hostname !== "localhost" && !isPrivateHost(target.hostname)) {
    return sendError(res, 403, "Active scanning is restricted to localhost/private-network targets", "target_not_allowed");
  }
  if (!String(body?.authorization || "").trim()) {
    return sendError(res, 400, "You must confirm authorization for this target", "authorization_required");
  }

  const scan = await runSecurityScan(config, target);
  const event = {
    id: randomUUID(),
    kind: "security.active_scan",
    category: "security",
    source: "browser-radar-scanner",
    sessionId: randomUUID(),
    page: {
      url: target.toString(),
      title: "Authorized active scan",
      referrer: "",
      userAgent: "browser-radar-scanner",
      language: "",
      viewport: null,
    },
    payload: scan,
    receivedAt: new Date().toISOString(),
    ipHash: createHash("sha256").update(String(req.socket.remoteAddress || "")).digest("hex").slice(0, 16),
    status: "new",
  };
  await storeEvent(config.dataDir, event);
  send(res, 201, { scan, eventId: event.id });
}

async function handleManifest(req, res) {
  if (!requireDashboardToken(req, res)) return;
  send(res, 200, {
    name: "Browser Radar",
    version: "1.0.0",
    aiConfigured: !!(config.aiApiKey && config.aiModel),
    aiProvider: config.aiProvider,
    aiModel: config.aiModel,
    ingestConfigured: !!config.ingestToken,
    dashboardProtected: !!config.dashboardToken,
    activeScanningEnabled: config.allowActiveScan,
    maxPayloadChars: config.maxPayloadChars,
    eventCount: (await getStats(config.dataDir)).totalEvents,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/app.js" || pathname === "/styles.css" || pathname === "/agent.js" || pathname === "/favicon.svg")) {
      return await serveStatic(req, res, pathname);
    }
    if (req.method === "GET" && pathname === "/api/manifest") return await handleManifest(req, res);
    if (req.method === "POST" && pathname === "/api/ingest") return await handleIngest(req, res);
    if (req.method === "GET" && pathname === "/api/events") return await handleListEvents(req, res, url);
    if (req.method === "GET" && pathname.startsWith("/api/events/")) return await handleGetEvent(req, res, decodeURIComponent(pathname.slice("/api/events/".length)));
    if (req.method === "POST" && pathname.startsWith("/api/events/") && pathname.endsWith("/analyze")) {
      return await handleAnalyze(req, res, decodeURIComponent(pathname.slice("/api/events/".length, -"/analyze".length)));
    }
    if (req.method === "POST" && pathname === "/api/security/scan") return await handleScan(req, res);

    sendError(res, 404, "Not found", "not_found");
  } catch (error) {
    const status = error?.status || 500;
    if (status >= 500) console.error("[browser-radar] request failed:", error);
    sendError(res, status, status >= 500 ? "Internal server error" : error.message, error?.code || "request_failed");
  }
});

await mkdir(config.dataDir, { recursive: true });
server.listen(config.port, config.host, () => {
  console.log(`Browser Radar listening on http://${config.host}:${config.port}`);
  console.log(`AI: ${config.aiProvider} / ${config.aiModel || "no model configured"}`);
  console.log(`Data: ${config.dataDir}`);
  if (config.allowActiveScan) console.warn("Active scanning is ENABLED (localhost/private targets only)");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
