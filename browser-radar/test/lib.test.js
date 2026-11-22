import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  isPrivateHost,
  normalizeTargetUrl,
  redactSensitive,
  safeJsonStringify,
  sanitizeText,
} from "../src/lib.js";
import { storeEvent, getEvents, getEvent, storeAnalysis, getStats } from "../src/store.js";

test("loadConfig applies defaults and bounds", () => {
  const config = loadConfig({ PORT: "99999", AI_PROVIDER: "gemini" });
  assert.equal(config.port, 65535);
  assert.equal(config.aiProvider, "gemini");
  assert.equal(config.aiModel, "gemini-2.0-flash");
  assert.equal(config.allowActiveScan, false);
});

test("private host detection covers local ranges", () => {
  assert.equal(isPrivateHost("localhost"), true);
  assert.equal(isPrivateHost("127.0.0.1"), true);
  assert.equal(isPrivateHost("10.1.2.3"), true);
  assert.equal(isPrivateHost("172.20.4.5"), true);
  assert.equal(isPrivateHost("192.168.1.1"), true);
  assert.equal(isPrivateHost("blishcrown.com"), false);
});

test("normalizeTargetUrl rejects non-http and credential URLs", () => {
  assert.equal(normalizeTargetUrl("file:///etc/passwd"), null);
  assert.equal(normalizeTargetUrl("http://user:pass@127.0.0.1"), null);
  assert.equal(normalizeTargetUrl("http://127.0.0.1:3000/path#x")?.pathname, "/path");
});

test("redaction removes sensitive keys and token patterns", () => {
  const result = redactSensitive({
    authorization: "Bearer abc.def.ghi",
    nested: { apiKey: "secret", message: "Bearer sk-abcdefghijklmnop" },
    safe: "hello",
  });
  assert.equal(result.authorization, "[REDACTED]");
  assert.equal(result.nested.apiKey, "[REDACTED]");
  assert.match(result.nested.message, /REDACTED/);
  assert.equal(result.safe, "hello");
});

test("safeJsonStringify handles circular values and errors", () => {
  const circular = { name: "example" };
  circular.self = circular;
  assert.match(safeJsonStringify(circular), /Circular/);
  assert.match(safeJsonStringify(new Error("boom")), /boom/);
});

test("sanitizeText strips control bytes and truncates", () => {
  assert.equal(sanitizeText("a\u0000b", 20), "ab");
  assert.match(sanitizeText("x".repeat(100), 30), /truncated/);
});

test("event store roundtrip, filters, analyses, and stats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-radar-test-"));
  try {
    await storeEvent(dir, {
      id: "evt-1",
      kind: "browser.unhandled_error",
      category: "browser",
      source: "test",
      sessionId: "session-1",
      page: { url: "http://localhost/app" },
      payload: "TypeError: boom",
      receivedAt: new Date().toISOString(),
      status: "new",
    });
    await storeEvent(dir, {
      id: "evt-2",
      kind: "security.csp_violation",
      category: "security",
      source: "test",
      sessionId: "session-1",
      page: { url: "http://localhost/app" },
      payload: "script-src",
      receivedAt: new Date().toISOString(),
      status: "new",
    });
    await storeAnalysis(dir, { eventId: "evt-1", provider: "local-heuristic", summary: "heuristic", createdAt: new Date().toISOString() });

    const all = await getEvents(dir, { limit: 10 });
    assert.equal(all.length, 2);
    assert.equal(all[0].id, "evt-2");
    assert.equal(all[1].analyses.length, 1);

    const securityOnly = await getEvents(dir, { limit: 10, category: "security" });
    assert.equal(securityOnly.length, 1);
    assert.equal(securityOnly[0].id, "evt-2");

    const event = await getEvent(dir, "evt-1");
    assert.equal(event.analyses[0].provider, "local-heuristic");

    const stats = await getStats(dir);
    assert.equal(stats.totalEvents, 2);
    assert.equal(stats.totalAnalyses, 1);
    assert.equal(stats.categories.security, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
