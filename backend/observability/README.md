# Observability Plugin

This folder is a portable NestJS + Prisma admin observability module. It provides:

- Buffered application log capture with error, warning, info, debug, and normal levels.
- Secret redaction before logs are persisted.
- Paginated, searchable admin log history.
- Host, Node, process, and database health metrics.
- Bounded read-only HTTP stress tests with average, p95, maximum latency, success, and error rate.

## Install In Another NestJS Application

1. Copy `src/observability/` into the target backend.
2. Copy the `ObservabilityLog` and `StressTestRun` models from `prisma/schema.prisma`.
3. Copy the migration SQL or create an equivalent Prisma migration.
4. Import `ObservabilityModule` in `AppModule`.
5. Expose `ObservabilityController` behind the target application's admin guard.
6. Copy the admin page and add its route/navigation entry.
7. Run `npx prisma generate` and `npx prisma migrate deploy`.

Optional environment variables:

```text
STRESS_TEST_BASE_URL=http://127.0.0.1:3000
STRESS_TEST_TARGETS=/health?db=false,/api/public/stats
```

The stress runner only permits targets listed in `STRESS_TEST_TARGETS`, caps tests at
60 seconds and 50 concurrent workers, and should not be configured with payment,
wallet, authentication, or write endpoints.

The module captures console output after application startup. For nginx, Docker,
systemd, or PM2 logs, use the companion host-level log forwarder under `ops/`.
