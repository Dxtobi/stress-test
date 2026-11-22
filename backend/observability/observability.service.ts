import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { randomUUID } from "crypto";
import os from "os";

type LogLevel = "error" | "warn" | "info" | "debug" | "log";

interface PendingLog {
  id: string;
  level: LogLevel;
  source: string;
  message: string;
  context?: any;
  createdAt: Date;
}

interface StressOptions {
  duration?: number;
  concurrency?: number;
  target?: string;
  requestedBy?: string;
}

@Injectable()
export class ObservabilityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ObservabilityService.name);
  private readonly pending: PendingLog[] = [];
  private flushTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private originalConsole?: Partial<Record<LogLevel, (...args: unknown[]) => void>>;
  private stressRunning = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.prisma.stressTestRun.updateMany({
      where: { status: "running", startedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) } },
      data: { status: "interrupted", completedAt: new Date() },
    });
    this.originalConsole = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
    };

    for (const level of Object.keys(this.originalConsole) as LogLevel[]) {
      const original = this.originalConsole[level];
      if (!original) continue;
      console[level] = (...args: unknown[]) => {
        original(...args);
        this.capture(level, args);
      };
    }

    this.flushTimer = setInterval(() => void this.flush(), 1000);
    this.cleanupTimer = setInterval(() => void this.prune(), 24 * 60 * 60 * 1000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.flush();
  }

  async getOverview(): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [counts, latest, activeTest, database] = await Promise.all([
      this.prisma.observabilityLog.groupBy({
        by: ["level"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.observabilityLog.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
      this.prisma.stressTestRun.findFirst({ where: { status: "running" }, orderBy: { startedAt: "desc" } }),
      this.checkDatabase(),
    ]);

    return {
      timestamp: new Date().toISOString(),
      host: {
        hostname: os.hostname(),
        platform: process.platform,
        node: process.version,
        cpus: os.cpus().length,
        load: os.loadavg(),
        memory: {
          total: os.totalmem(),
          free: os.freemem(),
          used: os.totalmem() - os.freemem(),
        },
        uptime: os.uptime(),
        process: process.memoryUsage(),
      },
      database,
      counts: Object.fromEntries(counts.map((item) => [item.level, item._count._all])),
      latest,
      activeTest,
    };
  }

  async getLogs(query: { level?: string; source?: string; search?: string; page?: number; limit?: number }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(10, query.limit || 50));
    const where: any = {};
    if (query.level && query.level !== "all") where.level = query.level;
    if (query.source && query.source !== "all") where.source = query.source;
    if (query.search) where.message = { contains: query.search, mode: "insensitive" };
    const [data, total] = await Promise.all([
      this.prisma.observabilityLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
      this.prisma.observabilityLog.count({ where }),
    ]);
    return { data, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async getStressTests(limit = 20) {
    return this.prisma.stressTestRun.findMany({ orderBy: { startedAt: "desc" }, take: Math.min(limit, 100) });
  }

  async startStressTest(options: StressOptions) {
    if (this.stressRunning) throw new Error("A stress test is already running");
    const existing = await this.prisma.stressTestRun.findFirst({ where: { status: "running" } });
    if (existing) throw new Error("A stress test is already running");
    const duration = Math.min(60, Math.max(5, Math.floor(options.duration || 15)));
    const concurrency = Math.min(50, Math.max(1, Math.floor(options.concurrency || 10)));
    const target = this.safeTarget(options.target);
    const run = await this.prisma.stressTestRun.create({ data: { status: "running", target, duration, concurrency, requestedBy: options.requestedBy } });
    this.stressRunning = true;
    void this.executeStressTest(run.id, target, duration, concurrency);
    return run;
  }

  private async executeStressTest(id: string, target: string, duration: number, concurrency: number): Promise<void> {
    const latencies: number[] = [];
    let totalRequests = 0;
    let successful = 0;
    let failed = 0;
    const deadline = Date.now() + duration * 1000;
    const baseUrl = process.env.STRESS_TEST_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

    const worker = async () => {
      while (Date.now() < deadline) {
        const started = performance.now();
        try {
          const response = await fetch(`${baseUrl}${target}`, { signal: AbortSignal.timeout(10000) });
          const elapsed = performance.now() - started;
          totalRequests += 1;
          latencies.push(elapsed);
          if (response.ok) successful += 1;
          else failed += 1;
        } catch {
          totalRequests += 1;
          failed += 1;
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      latencies.sort((a, b) => a - b);
      const average = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0;
      const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : 0;
      await this.prisma.stressTestRun.update({
        where: { id },
        data: {
          status: "completed",
          completedAt: new Date(),
          totalRequests,
          successful,
          failed,
          avgLatencyMs: Number(average.toFixed(2)),
          p95LatencyMs: Number(p95.toFixed(2)),
          maxLatencyMs: Number((latencies[latencies.length - 1] || 0).toFixed(2)),
          errorRate: totalRequests ? Number((failed / totalRequests).toFixed(4)) : 0,
          result: { baseUrl, target, duration, concurrency },
        },
      });
    } catch (error) {
      await this.prisma.stressTestRun.update({ where: { id }, data: { status: "failed", completedAt: new Date(), result: { error: String(error) } } });
      this.logger.error(`Stress test failed: ${String(error)}`);
    } finally {
      this.stressRunning = false;
    }
  }

  private safeTarget(target?: string): string {
    const allowed = (process.env.STRESS_TEST_TARGETS || "/health?db=false,/api/public/stats")
      .split(",").map((value) => value.trim()).filter(Boolean);
    return target && allowed.includes(target) ? target : allowed[0];
  }

  private capture(level: LogLevel, args: unknown[]): void {
    if (this.pending.length >= 500) return;
    const rendered = args.map((value) => typeof value === "string" ? value : this.safeJson(value)).join(" ");
    const lower = rendered.toLowerCase();
    const normalized: LogLevel = level === "error" || lower.includes("error") || lower.includes("exception") ? "error" : level === "warn" || lower.includes("warn") ? "warn" : level;
    const source = rendered.match(/^\[([^\]]+)\]/)?.[1] || "application";
    this.pending.push({ id: randomUUID(), level: normalized, source: source.slice(0, 120), message: this.redact(rendered).slice(0, 4000), createdAt: new Date() });
  }

  private async flush(): Promise<void> {
    if (!this.pending.length) return;
    const entries = this.pending.splice(0, 100);
    try { await this.prisma.observabilityLog.createMany({ data: entries }); }
    catch (error) { this.originalConsole?.error?.("Observability flush failed", error); }
  }

  private async prune(): Promise<void> {
    await this.prisma.observabilityLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } } }).catch(() => undefined);
  }

  private async checkDatabase() {
    const started = Date.now();
    try { await this.prisma.$queryRaw`SELECT 1`; return { status: "ok", latencyMs: Date.now() - started }; }
    catch { return { status: "down", latencyMs: Date.now() - started }; }
  }

  private safeJson(value: unknown): string {
    try { return JSON.stringify(value); } catch { return "[unserializable]"; }
  }

  private redact(value: string): string {
    return value.replace(/(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,}]+/gi, "$1=[REDACTED]");
  }
}
