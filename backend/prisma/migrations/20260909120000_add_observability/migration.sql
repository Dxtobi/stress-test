CREATE TABLE "observability_logs" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "observability_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stress_test_runs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "concurrency" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "total_requests" INTEGER NOT NULL DEFAULT 0,
    "successful" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "avg_latency_ms" DOUBLE PRECISION,
    "p95_latency_ms" DOUBLE PRECISION,
    "max_latency_ms" DOUBLE PRECISION,
    "error_rate" DOUBLE PRECISION,
    "result" JSONB,
    "requested_by" TEXT,
    CONSTRAINT "stress_test_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "observability_logs_level_created_at_idx" ON "observability_logs"("level", "created_at" DESC);
CREATE INDEX "observability_logs_source_created_at_idx" ON "observability_logs"("source", "created_at" DESC);
CREATE INDEX "observability_logs_created_at_idx" ON "observability_logs"("created_at" DESC);
CREATE INDEX "stress_test_runs_status_started_at_idx" ON "stress_test_runs"("status", "started_at" DESC);
CREATE INDEX "stress_test_runs_started_at_idx" ON "stress_test_runs"("started_at" DESC);
