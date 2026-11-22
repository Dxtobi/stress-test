# BlishCrown stress-test tooling

Standalone copy of the backend stress-test section extracted from the BlishCrown backend. The original application was not modified.

## What is included

- `backend/observability/` — the NestJS Observability module that owns the protected stress-test endpoints and the bounded stress runner.
- `backend/prisma/` — the `StressTestRun` / `ObservabilityLog` Prisma models and the original migration SQL.
- `admin-ui/StressTest.svelte` — the admin "Controlled stress test" section extracted into a standalone component with its history table.
- `tools/load-pulse/` — the standalone browser-based Load Pulse / Ramp Test console served by the backend, plus its controller and rate-limit guard.
- `browser-radar/` — a standalone backend + browser dashboard for AI-assisted error, performance, security-event, and authorized-scan analysis. See [browser-radar/README.md](browser-radar/README.md).

## Browser Radar

```bash
cd browser-radar
cp .env.example .env
npm start
```

It runs at <http://127.0.0.1:4317> with no npm dependencies. Configure `AI_PROVIDER`, `AI_MODEL`, and `AI_API_KEY` for real analysis; OpenAI, Gemini, Anthropic, and OpenAI-compatible endpoints are supported.

The server-side runner is intentionally conservative:

- Read-only, allowlisted endpoints only (`STRESS_TEST_TARGETS`).
- 5–60 second duration cap.
- 1–50 concurrent workers cap.
- One active run at a time.
- Records total requests, successes, failures, average/p95/max latency, and error rate.
- Interrupted runs are marked stale after 10 minutes on module startup.

## Server-side integration

1. Copy `backend/observability/` into the target NestJS backend as `src/observability/`.
2. Copy the models from `backend/prisma/stress-test.prisma` into the target `schema.prisma`.
3. Copy or adapt `backend/prisma/migrations/20260909120000_add_observability/migration.sql`.
4. Import `ObservabilityModule` into the target `AppModule`.
5. Keep the stress-test endpoints behind the target app's admin guard. The copied controller uses the host app's `AdminAuthGuard`, `AdminRoles`, and `CurrentUser` decorator.
6. Run `npx prisma generate` and `npx prisma migrate deploy`.
7. Configure the environment variables below.

```bash
cp .env.example .env
```

```text
STRESS_TEST_BASE_URL=http://127.0.0.1:3000
STRESS_TEST_TARGETS=/health?db=false,/api/public/stats
```

The host application must also provide whatever secrets its admin auth and response encryption use. No secrets are stored in this repository.

## Admin UI integration

`admin-ui/StressTest.svelte` is self-contained except for Svelte itself. Point it at the same backend that serves `/_panel/api/observability/*`. It reads the admin token from `sessionStorage.blish_admin_token`; change the `apiBase` value if your panel uses a different prefix.

## Browser Load Pulse console

To use the standalone console:

1. Copy `tools/load-pulse/load-pulse.html` into the backend's `public/` directory.
2. Copy `tools/load-pulse/load-pulse.controller.ts` into `src/` and register `LoadPulseController`.
3. Optionally register `tools/load-pulse/load-test-throttler.guard.ts` as a throttler override for the route.
4. Open `/load-pulse` on the backend host.

The console offers single-shot checks, a fixed-concurrency load test, and a ramp test that steps through concurrency levels to find a practical ceiling.

## Safety

Run stress tests only during a maintenance window or against staging. Never allow payment, wallet, authentication, or write endpoints in `STRESS_TEST_TARGETS`.

## Original source paths

- `backend/src/observability/`
- `backend/prisma/schema.prisma` (`StressTestRun`, `ObservabilityLog`)
- `backend/prisma/migrations/20260909120000_add_observability/migration.sql`
- `backend/admin-ui/src/pages/Observability.svelte` (`Controlled stress test` and `Stress test history` sections)
- `backend/public/load-pulse.html`
- `backend/src/load-pulse.controller.ts`
- `backend/src/load-test-throttler.guard.ts`
