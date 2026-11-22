import { randomUUID } from "node:crypto";
import { normalizeTargetUrl, redactSensitive, safeJsonStringify, sanitizeText } from "./lib.js";

const COMMON_PROBES = [
  "/.env",
  "/.git/config",
  "/.well-known/security.txt",
  "/package.json",
  "/composer.json",
  "/swagger",
  "/swagger-ui.html",
  "/api-docs",
  "/openapi.json",
  "/actuator/env",
  "/phpinfo.php",
  "/backup.zip",
  "/admin",
  "/_panel",
  "/server-status",
  "/debug",
];

const SECRET_PATTERNS = [
  /DB_PASSWORD\s*[:=]\s*['"][^'"]+['"]/i,
  /DATABASE_URL\s*[:=]\s*['"][^'"]+['"]/i,
  /API_KEY\s*[:=]\s*['"][^'"]+['"]/i,
  /AIza[0-9A-Za-z_-]{20,}/,
  /sk-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function finding(severity, title, detail, evidence = "", recommendation = "") {
  return {
    id: randomUUID(),
    severity,
    title,
    detail,
    evidence: sanitizeText(redactSensitive(evidence), 1200),
    recommendation,
  };
}

function setCookieHeader(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

async function fetchLimited(url, config, init = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(config.scanTimeoutMs),
    headers: {
      "user-agent": "browser-radar-authorized-scanner/1.0",
      accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      ...(init.headers || {}),
    },
  });

  let bodySnippet = "";
  try {
    const reader = response.body?.getReader();
    if (reader) {
      let received = 0;
      const chunks = [];
      while (received < 256 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
      }
      await reader.cancel().catch(() => {});
      bodySnippet = Buffer.concat(chunks).toString("utf8");
    }
  } catch {
    bodySnippet = "";
  }

  return { response, bodySnippet };
}

function checkHeaders(response, target, findings) {
  const headers = response.headers;
  const csp = headers.get("content-security-policy");
  const hsts = headers.get("strict-transport-security");
  const frameOptions = headers.get("x-frame-options");
  const nosniff = headers.get("x-content-type-options");
  const referrer = headers.get("referrer-policy");
  const permissions = headers.get("permissions-policy");
  const allowOrigin = headers.get("access-control-allow-origin");
  const allowCredentials = headers.get("access-control-allow-credentials");
  const cookies = setCookieHeader(headers);

  if (!csp) {
    findings.push(finding("medium", "Content-Security-Policy missing", "No CSP response header was found.", "", "Add a restrictive CSP and monitor its report-only mode before enforcement."));
  }
  if (target.protocol === "https:" && !hsts) {
    findings.push(finding("low", "HSTS missing", "The HTTPS response does not advertise HSTS.", "", "Add Strict-Transport-Security with an appropriate max-age."));
  }
  if (!frameOptions && !csp?.includes("frame-ancestors")) {
    findings.push(finding("low", "Clickjacking protection missing", "No X-Frame-Options or CSP frame-ancestors directive was found.", "", "Set X-Frame-Options: DENY or SAMEORIGIN."));
  }
  if (!nosniff?.toLowerCase().includes("nosniff")) {
    findings.push(finding("low", "MIME sniffing protection missing", "X-Content-Type-Options is not set to nosniff.", "", "Set X-Content-Type-Options: nosniff."));
  }
  if (!referrer) {
    findings.push(finding("low", "Referrer-Policy missing", "No Referrer-Policy response header was found.", "", "Set Referrer-Policy to strict-origin-when-cross-origin or stricter."));
  }
  if (!permissions) {
    findings.push(finding("low", "Permissions-Policy missing", "No Permissions-Policy response header was found.", "", "Disable unused browser features such as camera, microphone, and geolocation."));
  }
  if (allowOrigin === "*" && allowCredentials?.toLowerCase() === "true") {
    findings.push(finding("high", "Unsafe CORS configuration", "Wildcard origin is combined with credentials.", `Access-Control-Allow-Origin: ${allowOrigin}\nAccess-Control-Allow-Credentials: ${allowCredentials}`, "Never combine wildcard origins with credentials; use an explicit allowlist."));
  }

  for (const cookie of cookies) {
    if (!/httponly/i.test(cookie)) {
      findings.push(finding("medium", "Cookie missing HttpOnly", "A response cookie is accessible to JavaScript.", cookie, "Add HttpOnly to session and authentication cookies."));
    }
    if (!/samesite/i.test(cookie)) {
      findings.push(finding("medium", "Cookie missing SameSite", "A response cookie has no SameSite attribute.", cookie, "Add SameSite=Lax or Strict."));
    }
    if (target.protocol === "https:" && !/secure/i.test(cookie)) {
      findings.push(finding("medium", "Cookie missing Secure", "A cookie on HTTPS is not marked Secure.", cookie, "Add the Secure attribute."));
    }
  }

  for (const header of ["server", "x-powered-by", "x-aspnet-version"]) {
    const value = headers.get(header);
    if (value) {
      findings.push(finding("low", `Technology disclosed via ${header}`, "A response header reveals implementation details.", `${header}: ${value}`, "Remove or genericize the header where possible."));
    }
  }
}

function checkBody(body, findings) {
  if (!body) return;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(body)) {
      findings.push(finding("critical", "Possible secret exposed in response body", "The response body appears to contain a credential or private key pattern.", body.match(pattern)?.[0] || "", "Remove the secret immediately, rotate it, and audit access logs."));
      break;
    }
  }
  if (/stack\s*trace|at\s+[\w.$]+\s+\([^)]*:\d+:\d+\)/i.test(body)) {
    findings.push(finding("medium", "Verbose stack trace", "The response body appears to include a stack trace.", "", "Return generic error pages and keep detailed traces in server logs."));
  }
  if (/directory\s+listing|index of \//i.test(body)) {
    findings.push(finding("medium", "Directory listing", "The response body appears to be a directory listing.", "", "Disable directory indexing."));
  }
}

export async function runSecurityScan(config, inputTarget) {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const target = normalizeTargetUrl(inputTarget);
  if (!target) throw new Error("Invalid target URL");

  const findings = [];
  const checks = [];
  const probes = [];

  let base;
  try {
    const result = await fetchLimited(target, config);
    base = result;
    const status = result.response.status;
    checks.push({ name: "base request", status, ok: status >= 200 && status < 400 });

    if (status >= 300 && status < 400) {
      const location = result.response.headers.get("location") || "";
      let external = false;
      try {
        external = location && normalizeTargetUrl(location)?.origin !== target.origin;
      } catch {
        external = true;
      }
      findings.push(finding("low", "Redirect observed", "The target redirected the base request.", `${status} -> ${location}`, "Confirm the redirect is intentional and does not send users to an unexpected origin." + (external ? " The redirect destination is outside the scanned origin and was not followed." : "")));
    }

    checkHeaders(result.response, target, findings);
    checkBody(result.bodySnippet, findings);
  } catch (error) {
    findings.push(finding("medium", "Base request failed", "The scanner could not retrieve the target page.", sanitizeText(error?.message || error, 500), "Confirm the target is reachable from the Browser Radar host."));
  }

  if (target.protocol === "http:") {
    findings.push(finding("low", "Plain HTTP target", "The scan target uses HTTP rather than HTTPS.", target.toString(), "Use HTTPS even on private networks where possible."));
  }

  const limit = Math.min(config.scanMaxProbes, COMMON_PROBES.length);
  for (const path of COMMON_PROBES.slice(0, limit)) {
    const probeUrl = new URL(path, target.origin);
    try {
      const result = await fetchLimited(probeUrl, config);
      const status = result.response.status;
      const contentType = result.response.headers.get("content-type") || "";
      probes.push({ path, status, contentType });
      if (status >= 200 && status < 300 && !path.includes("security.txt")) {
        findings.push(finding("high", `Sensitive path accessible: ${path}`, "A commonly restricted path returned a successful response.", `${status} ${contentType}\n${result.bodySnippet.slice(0, 400)}`, "Restrict or remove this path from public/private access."));
      } else if (status >= 300 && status < 400) {
        findings.push(finding("low", `Redirect on sensitive path: ${path}`, "A sensitive-looking path redirected.", `${status} -> ${result.response.headers.get("location") || ""}`, "Confirm the redirect does not expose protected content."));
      }
      checkBody(result.bodySnippet, findings);
    } catch (error) {
      probes.push({ path, status: 0, error: sanitizeText(error?.message || "request failed", 200) });
    }
    if (config.scanProbeDelayMs > 0) {
      await new Promise((done) => setTimeout(done, config.scanProbeDelayMs));
    }
  }

  const counts = findings.reduce(
    (acc, item) => {
      acc[item.severity] = (acc[item.severity] || 0) + 1;
      return acc;
    },
    { low: 0, medium: 0, high: 0, critical: 0 }
  );

  return {
    id: randomUUID(),
    target: target.toString(),
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    authorizationConfirmed: true,
    checks,
    probes,
    findings,
    counts,
    summary: safeJsonStringify(counts),
  };
}
