# Stress Test & Browser Radar

A standalone toolbox for measuring backend capacity, diagnosing browser issues with AI, and gathering defensive security signals.

This repository was extracted from the BlishCrown backend without modifying the original application. It contains three related tools:

1. **Backend Observability / Stress Runner** — a NestJS module with protected admin endpoints that runs bounded, read-only HTTP stress tests and records results.
2. **Load Pulse** — a standalone browser console for quick capacity checks, fixed-concurrency load tests, and ramp tests.
3. **Browser Radar** — a standalone Node backend + browser dashboard that collects errors, network/performance details, user-action trails, DOM snapshots, screenshot hooks, and security events, then sends them to an AI provider for analysis.

---

## Table of contents

- [Repository layout](#repository-layout)
- [1. Backend Observability / Stress Runner](#1-backend-observability--stress-runner)
  - [What it does](#what-it-does)
  - [Install into a NestJS app](#install-into-a-nestjs-app)
  - [Configuration](#configuration)
  - [Admin API](#admin-api)
- [2. Load Pulse browser console](#2-load-pulse-browser-console)
  - [Install](#install)
  - [Usage](#usage)
- [3. Browser Radar](#3-browser-radar)
  - [What it does](#what-it-does-1)
  - [Quick start](#quick-start)
  - [AI provider setup](#ai-provider-setup)
  - [Dashboard usage](#dashboard-usage)
  - [Browser agent setup](#browser-agent-setup)
  - [Screenshots](#screenshots)
  - [Security events and authorized scanning](#security-events-and-authorized-scanning)
  - [API reference](#api-reference)
  - [Storage](#storage)
  - [Tests](#tests)
- [Safety](#safety)
- [Original source paths](#original-source-paths)

---

## Repository layout

```text
stress-test/
├── README.md                         # This guide
├── .env.example                      # Backend stress-test env template
├── .gitignore
├── backend/
│   ├── observability/
│   │   ├── observability.controller.ts
│   │   ├── observability.module.ts
│   │   ├── observability.service.ts
│   │   └── README.md                 # Module-specific notes
│   └── prisma/
│       ├── stress-test.prisma        # Models to copy into schema.prisma
│       └── migrations/
│           └── 20260909120000_add_observability/migration.sql
├── admin-ui/
│   └── StressTest.svelte             # Admin "Controlled stress test" UI
├── tools/
│   └── load-pulse/
│       ├── load-pulse.html           # Standalone browser capacity console
│       ├── load-pulse.controller.ts  # NestJS controller that serves it
│       └── load-test-throttler.guard.ts
└── browser-radar/
    ├── README.md                     # Detailed Browser Radar guide
    ├── package.json
    ├── .env.example
    ├── server.js                     # Zero-dependency Node server
    ├── src/
    │   ├── ai.js                     # Provider-agnostic AI analysis
    │   ├── lib.js                    # Config, validation, redaction, helpers
    │   ├── scanner.js                # Opt-in authorized active scanner
    │   └── store.js                  # NDJSON event/analysis storage
    ├── public/
    │   ├── index.html                # Browser dashboard
    │   ├── app.js                    # Dashboard logic
    │   ├── styles.css
    │   ├── agent.js                  # Browser telemetry collector
    │   └── favicon.svg
    └── test/
        └── lib.test.js
```

---

## 1. Backend Observability / Stress Runner

### What it does

The `backend/observability/` module is a portable NestJS + Prisma module that:

- Captures buffered application logs with secret redaction.
- Exposes paginated, searchable admin log history.
- Reports host, Node, process, and database health.
- Runs bounded, read-only HTTP stress tests.
- Records latency average, p95, max, success count, failure count, and error rate.
- Prevents overlapping runs.
- Marks interrupted runs stale on module startup.

The runner is intentionally conservative:

- Read-only, allowlisted endpoints only (`STRESS_TEST_TARGETS`).
- 5–60 second duration cap.
- 1–50 concurrent workers cap.
- One active run at a time.
- No payment, wallet, auth, or write endpoints should ever be allowlisted.

### Install into a NestJS app

1. Copy `backend/observability/` into the target backend as `src/observability/`.
2. Copy the `ObservabilityLog` and `StressTestRun` models from `backend/prisma/stress-test.prisma` into your `prisma/schema.prisma`.
3. Copy or adapt `backend/prisma/migrations/20260909120000_add_observability/migration.sql`.
4. Import `ObservabilityModule` in your root `AppModule`:

```ts
import { Module } from "@nestjs/common";
import { ObservabilityModule } from "./observability/observability.module";

@Module({
  imports: [ObservabilityModule],
})
export class AppModule {}
```

5. Keep the controller behind your app's admin guard. The copied controller expects `AdminAuthGuard`, `AdminRoles`, and `CurrentUser` from the host app:

```text
src/admin/admin-auth.guard.ts
src/auth/decorators/current-user.decorator.ts
```

6. Generate and migrate:

```bash
npx prisma generate
npx prisma migrate deploy
```

### Configuration

Copy the root template and set the values for your environment:

```bash
cp .env.example .env
```

```text
STRESS_TEST_BASE_URL=http://127.0.0.1:3000
STRESS_TEST_TARGETS=/health?db=false,/api/public/stats
```

`STRESS_TEST_TARGETS` is a comma-separated allowlist of safe, read-only paths. The host application must also provide its own admin JWT/auth secrets. No secrets are stored in this repository.

### Admin API

The controller exposes these routes under the host app's admin prefix:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/_panel/api/observability/overview` | Health overview and active test |
| `GET` | `/_panel/api/observability/logs` | Searchable log history |
| `GET` | `/_panel/api/observability/stress-tests` | Stress-test run history |
| `POST` | `/_panel/api/observability/stress-tests` | Start a bounded read-only stress test |

All routes require `ADMIN` or `SUPER_ADMIN` in the host application.

---

## 2. Load Pulse browser console

`tools/load-pulse/load-pulse.html` is a self-contained browser page for quick capacity checks. It runs entirely from the user's browser and does not need Node or npm.

### Install

1. Copy `tools/load-pulse/load-pulse.html` into your backend's `public/` directory.
2. Copy `tools/load-pulse/load-pulse.controller.ts` into `src/`.
3. Register `LoadPulseController` in a NestJS module.
4. Optionally register `tools/load-pulse/load-test-throttler.guard.ts` as a throttler override so whitelisted test IPs are not rate-limited.
5. Open `/load-pulse` on the backend host.

### Usage

The console provides:

- **Single shot** — one request to verify reachability and latency.
- **Load test** — fixed concurrency for a chosen duration.
- **Ramp test** — steps through concurrency levels to find a practical ceiling.

Use it for quick sanity checks. Use the Observability stress runner for recorded, admin-protected test history.

---

## 3. Browser Radar

Browser Radar is the newest tool in this repo. It is a standalone backend system for browser issues: a small Node server, a browser dashboard, and a browser agent you install on any page you want to monitor.

See also: [`browser-radar/README.md`](browser-radar/README.md).

### What it does

Browser Radar collects and stores:

- `console.error` and `console.warn` messages.
- Uncaught exceptions and unhandled promise rejections.
- Failed and slow network requests from `fetch` and `XMLHttpRequest`.
- Navigation timing, slow resources, long tasks, and vitals.
- Click/input/history/scroll action trail for lightweight session replay.
- Sanitized DOM snapshots with input values and sensitive attributes removed.
- Screenshots supplied by your own capture integration.
- Defensive browser signals: CSP violations, malformed JSON responses, unusual cross-origin redirects, cross-tab token changes, and injected scripts/iframes.

It then lets you select any event and ask an AI provider to diagnose it. The AI prompt treats telemetry as untrusted evidence and returns structured JSON with summary, severity, root causes, evidence, recommended actions, security assessment, and follow-up questions.

### Quick start

Requirements: Node 18 or newer. No npm dependencies are required.

```bash
cd browser-radar
cp .env.example .env
npm start
```

Open:

```text
http://127.0.0.1:4317
```

Run tests:

```bash
npm test
```

### AI provider setup

Edit `browser-radar/.env`.

Supported providers:

| Provider | `AI_PROVIDER` | Default base URL |
| --- | --- | --- |
| OpenAI | `openai` | `https://api.openai.com/v1` |
| Gemini | `gemini` | `https://generativelanguage.googleapis.com/v1beta` |
| Anthropic | `anthropic` | `https://api.anthropic.com/v1` |
| Any OpenAI-compatible API | `custom` | Set `AI_BASE_URL` yourself |

Examples:

```bash
# OpenAI
AI_PROVIDER=openai
AI_MODEL=gpt-4o-mini
AI_API_KEY=sk-...
AI_BASE_URL=https://api.openai.com/v1
```

```bash
# Gemini
AI_PROVIDER=gemini
AI_MODEL=gemini-2.0-flash
AI_API_KEY=...
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
```

```bash
# Anthropic
AI_PROVIDER=anthropic
AI_MODEL=claude-3-5-haiku-latest
AI_API_KEY=...
AI_BASE_URL=https://api.anthropic.com/v1
```

```bash
# Local / OpenAI-compatible endpoint
AI_PROVIDER=custom
AI_MODEL=llama3.1
AI_API_KEY=local-key
AI_BASE_URL=http://127.0.0.1:11434/v1
```

If `AI_API_KEY` is empty, the dashboard still works and returns a clearly labeled local heuristic summary.

### Dashboard usage

The dashboard at `http://127.0.0.1:4317` has these sections:

1. **Overview cards** — total events, analyses, and category counts.
2. **Captured events** — filter by category or search; select an event to inspect it.
3. **AI analysis** — enter an optional model override and focus question, then click **Analyze with AI**.
4. **Authorized security scan** — run the opt-in scanner after confirming authorization.
5. **Install the browser agent** — copy the generated snippet for your target app.

If `DASHBOARD_TOKEN` is set in `.env`, the dashboard prompts for it on first load and stores it in `sessionStorage` for the tab.

### Browser agent setup

Add the generated snippet to any page you want to monitor:

```html
<script>
  window.BROWSER_RADAR_CONFIG = {
    ingestUrl: "https://your-host/api/ingest",
    ingestToken: "YOUR_INGEST_TOKEN_OR_EMPTY",
    source: "my-web-app",
    sessionId: "",
    includeScreenshot: true,
    includeDomSnapshot: true,
    includeActionTrail: true,
    slowRequestMs: 1500
  };
</script>
<script src="https://your-host/agent.js" defer></script>
```

The dashboard generates this with the correct `ingestUrl` for your running server.

If `INGEST_TOKEN` is set, the agent sends it as `Authorization: Bearer <token>`. Use a low-privilege token here; do not reuse an admin, dashboard, or AI key.

You can also report business-specific events manually:

```js
window.BROWSER_RADAR.report("checkout.failed", {
  orderId: "abc123",
  step: "payment"
});

window.BROWSER_RADAR.flush();
```

### Screenshots

Ordinary page JavaScript cannot take a native screenshot. Provide one from your own capture layer:

```js
window.BROWSER_RADAR.captureScreenshot(dataUrl);
```

or:

```js
document.dispatchEvent(
  new CustomEvent("browser-radar:screenshot", { detail: { dataUrl } })
);
```

The screenshot is attached to the next captured event. Input values, tokens, and sensitive fields are not collected.

### Security events and authorized scanning

Browser Radar separates two kinds of security information:

1. **Defensive event logging** — always available from the agent: CSP violations, suspicious DOM insertions, malformed responses, unusual redirects, and token changes in other tabs.
2. **Active scanning** — disabled by default. Enable with:

```bash
ALLOW_ACTIVE_SCAN=true
```

Active scan restrictions:

- Only `http://` and `https://` URLs.
- Only localhost or private-network hosts.
- No credentials in the URL.
- Redirects are reported but never followed.
- Fixed, capped list of common sensitive paths.
- Requires explicit authorization confirmation in the dashboard.
- Every scan is stored as a `security.active_scan` event.

Use active scanning only on systems you own or have written permission to test.

### API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/manifest` | Current tool configuration/status |
| `POST` | `/api/ingest` | Ingest one event or a `browser.batch` envelope |
| `GET` | `/api/events` | List/filter events; query `limit`, `category`, `status`, `search` |
| `GET` | `/api/events/:id` | Get one event with prior analyses |
| `POST` | `/api/events/:id/analyze` | Run AI analysis; body `question`, optional `model` |
| `POST` | `/api/security/scan` | Authorized active scan; body `target`, `authorization` |

Static dashboard files are served from `/`. API routes respect `DASHBOARD_TOKEN`, and ingest respects `INGEST_TOKEN`.

### Storage

Browser Radar appends newline-delimited JSON to `DATA_DIR`:

```text
browser-radar/data/events.ndjson
browser-radar/data/analyses.ndjson
```

No database is needed. Rotate or clean these files as required.

### Tests

```bash
cd browser-radar
npm test
```

The tests cover config parsing, private-host detection, URL validation, redaction, circular JSON handling, sanitization, and the NDJSON store roundtrip.

---

## Safety

- Run backend stress tests only during a maintenance window or against staging.
- Never allow payment, wallet, authentication, or write endpoints in `STRESS_TEST_TARGETS`.
- Keep Browser Radar's `INGEST_TOKEN` low-privilege; it is visible to any page that loads the agent script.
- Keep `DASHBOARD_TOKEN` separate from `INGEST_TOKEN` and your AI key.
- Sensitive keys and token-like values are redacted by the agent and again by the server, but avoid pointing the agent at pages where users enter highly sensitive data unless you accept local storage of telemetry.
- Enable `ALLOW_ACTIVE_SCAN` only for authorized testing.

---

## Original source paths

These files were copied/extracted from the original BlishCrown backend:

- `backend/src/observability/`
- `backend/prisma/schema.prisma` (`StressTestRun`, `ObservabilityLog`)
- `backend/prisma/migrations/20260909120000_add_observability/migration.sql`
- `backend/admin-ui/src/pages/Observability.svelte`
- `backend/public/load-pulse.html`
- `backend/src/load-pulse.controller.ts`
- `backend/src/load-test-throttler.guard.ts`

Browser Radar is new tooling built for this repo and does not modify those original source locations.
