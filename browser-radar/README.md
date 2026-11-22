# Browser Radar

Standalone backend + browser dashboard for AI-assisted analysis of browser issues. It collects errors, network failures, performance signals, user-action trails, DOM snapshots, screenshots (via a host hook), and defensive security signals, then lets you send any captured event to a configurable AI provider.

It also includes an **opt-in** active security scanner for localhost/private-network targets you are authorized to test.

## Run

```bash
cd browser-radar
cp .env.example .env
npm start
```

Open <http://127.0.0.1:4317>.

If `DASHBOARD_TOKEN` is set, the dashboard prompts for it on first load and stores it in `sessionStorage` for the tab. If `INGEST_TOKEN` is set, the browser agent must send it as `Authorization: Bearer <token>`.

No npm dependencies are required. Node 18+ is enough.

## AI configuration

`AI_PROVIDER` accepts:

- `openai` — OpenAI Chat Completions
- `custom` — any OpenAI-compatible endpoint; set `AI_BASE_URL`
- `gemini` — Google Gemini `generateContent`
- `anthropic` — Anthropic Messages API

Examples:

```bash
# OpenAI
AI_PROVIDER=openai
AI_MODEL=gpt-4o-mini
AI_API_KEY=sk-...
AI_BASE_URL=https://api.openai.com/v1

# Gemini
AI_PROVIDER=gemini
AI_MODEL=gemini-2.0-flash
AI_API_KEY=...
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta

# Anthropic
AI_PROVIDER=anthropic
AI_MODEL=claude-3-5-haiku-latest
AI_API_KEY=...
AI_BASE_URL=https://api.anthropic.com/v1

# Any OpenAI-compatible local/remote model
AI_PROVIDER=custom
AI_MODEL=llama3.1
AI_API_KEY=local-key
AI_BASE_URL=http://127.0.0.1:11434/v1
```

Without an API key, analysis still works but returns a labeled local heuristic summary so the dashboard remains useful.

The AI prompt explicitly treats captured event data as untrusted evidence and asks the model to return structured JSON: summary, severity, root causes, evidence, recommended actions, security assessment, and follow-up questions.

## Browser agent

Add this to any page you want to monitor:

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

The dashboard generates this snippet for you with the correct `ingestUrl`.

### What it collects

- `console.error` / `console.warn` messages
- Uncaught exceptions and unhandled promise rejections
- Failed requests, slow requests, malformed JSON responses, unusual cross-origin redirects
- Navigation timing, slow resources, long tasks, LCP/CLS/FID-style vitals
- Click/input/history/scroll action trail (no typed values)
- CSP violations, suspicious injected `<script>`/`<iframe>` nodes, cross-tab auth-token changes
- Sanitized DOM snapshot with input values and sensitive attributes removed
- Screenshot supplied by your host integration

Sensitive keys and token-like strings are redacted client-side and again server-side. Values of password/token fields are never collected.

### Screenshots

Browsers cannot take native screenshots from ordinary page JavaScript. Provide one from your own capture layer:

```js
window.BROWSER_RADAR.captureScreenshot(dataUrl);

// or
document.dispatchEvent(
  new CustomEvent("browser-radar:screenshot", { detail: { dataUrl } })
);
```

The dashboard's install section explains this too.

### Manual reports

```js
window.BROWSER_RADAR.report("checkout.failed", {
  orderId: "abc123",
  step: "payment"
});

window.BROWSER_RADAR.flush();
```

## Defensive security events

The agent logs browser-side suspicion signals: CSP violations, malformed responses, token changes in other tabs, unusual redirects, and injected scripts/iframes.

The server-side active scanner is separate and disabled by default. To enable it:

```bash
ALLOW_ACTIVE_SCAN=true
```

In the dashboard, enter a target, confirm authorization, and run the scan. Restrictions:

- Only `http://` and `https://` URLs.
- Only localhost/private-network hosts.
- No credentials in the URL.
- Redirects are reported but never followed.
- Fixed, capped list of common sensitive paths.
- Every scan is stored as a `security.active_scan` event.

Use this only on systems you own or have written permission to test.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/manifest` | Current tool configuration/status |
| `POST` | `/api/ingest` | Ingest one event or a `browser.batch` envelope |
| `GET` | `/api/events` | List/filter events; query `limit`, `category`, `status`, `search` |
| `GET` | `/api/events/:id` | Get one event with prior analyses |
| `POST` | `/api/events/:id/analyze` | Run AI analysis; body `question`, optional `model` |
| `POST` | `/api/security/scan` | Authorized active scan; body `target`, `authorization` |

All endpoints except static files and ingest respect `DASHBOARD_TOKEN`. Ingest respects `INGEST_TOKEN`.

## Storage

Events and analyses are appended to newline-delimited JSON files in `DATA_DIR`:

- `events.ndjson`
- `analyses.ndjson`

There is no database to install. Rotate/clean these files as needed.

## Safety

- Do not point the agent at pages where users enter secrets if you cannot accept the telemetry being stored locally.
- Keep the ingest token low-privilege; it is visible to any page that loads the agent script.
- Run active scans only during authorized testing windows.
