import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeJsonStringify } from "./lib.js";

let writeQueue = Promise.resolve();

function appendLine(file, value) {
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${safeJsonStringify(value)}\n`, "utf8");
  });
  return writeQueue;
}

async function readLines(file) {
  try {
    const raw = await readFile(file, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function eventFile(dataDir) {
  return join(dataDir, "events.ndjson");
}

function analysisFile(dataDir) {
  return join(dataDir, "analyses.ndjson");
}

export async function storeEvent(dataDir, event) {
  await appendLine(eventFile(dataDir), event);
  return event;
}

export async function storeAnalysis(dataDir, analysis) {
  await appendLine(analysisFile(dataDir), analysis);
  return analysis;
}

export async function getEvents(dataDir, options = {}) {
  const [events, analyses] = await Promise.all([readLines(eventFile(dataDir)), readLines(analysisFile(dataDir))]);
  const analysesByEvent = new Map();
  for (const analysis of analyses) {
    if (!analysis.eventId) continue;
    const current = analysesByEvent.get(analysis.eventId) || [];
    current.push(analysis);
    analysesByEvent.set(analysis.eventId, current);
  }

  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 500);
  const category = String(options.category || "").trim().toLowerCase();
  const status = String(options.status || "").trim().toLowerCase();
  const search = String(options.search || "").trim().toLowerCase();

  return events
    .reverse()
    .map((event) => ({ ...event, analyses: analysesByEvent.get(event.id) || [] }))
    .filter((event) => !category || String(event.category || "").toLowerCase() === category)
    .filter((event) => !status || String(event.status || "").toLowerCase() === status)
    .filter((event) => {
      if (!search) return true;
      return `${event.kind} ${event.page?.url} ${event.payload} ${event.source}`.toLowerCase().includes(search);
    })
    .slice(0, limit);
}

export async function getEvent(dataDir, id) {
  const safeId = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) return null;
  const [events, analyses] = await Promise.all([readLines(eventFile(dataDir)), readLines(analysisFile(dataDir))]);
  const event = events.find((entry) => entry.id === safeId);
  if (!event) return null;
  return {
    ...event,
    analyses: analyses.filter((analysis) => analysis.eventId === safeId),
  };
}

export async function getStats(dataDir) {
  const [events, analyses] = await Promise.all([readLines(eventFile(dataDir)), readLines(analysisFile(dataDir))]);
  const categories = {};
  for (const event of events) {
    const key = event.category || "other";
    categories[key] = (categories[key] || 0) + 1;
  }
  return {
    totalEvents: events.length,
    totalAnalyses: analyses.length,
    categories,
    lastEventAt: events.at(-1)?.receivedAt || null,
  };
}
