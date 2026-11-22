const state = {
  manifest: null,
  events: [],
  selectedEvent: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

async function api(path, options = {}, retry = true) {
  const token = sessionStorage.getItem("browser_radar_token") || "";
  const headers = {
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && retry) {
    const entered = window.prompt("Enter the Browser Radar dashboard token:");
    if (entered === null) throw new Error("Dashboard token is required");
    sessionStorage.setItem("browser_radar_token", entered.trim());
    return api(path, options, false);
  }
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    throw new Error(typeof data === "string" ? data : data?.error?.message || "Request failed");
  }
  return data;
}

function renderManifest(manifest) {
  state.manifest = manifest;
  $("aiStatus").textContent = `AI: ${manifest.aiConfigured ? `${manifest.aiProvider} / ${manifest.aiModel}` : "not configured (heuristic only)"}`;
  $("scanStatus").textContent = `Scanner: ${manifest.activeScanningEnabled ? "enabled" : "disabled"}`;
  $("scanBtn").disabled = !manifest.activeScanningEnabled;
  $("scanForm").querySelector("p")?.remove();
  if (!manifest.activeScanningEnabled) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Set ALLOW_ACTIVE_SCAN=true on the server to enable active scanning for authorized targets.";
    $("scanForm").appendChild(note);
  }
  if (manifest.aiModel) $("modelInput").placeholder = `Override model (default: ${manifest.aiModel})`;

  const origin = window.location.origin;
  const snippet = `<!-- Browser Radar agent -->\n<script>\n  window.BROWSER_RADAR_CONFIG = {\n    ingestUrl: "${origin}/api/ingest",\n    ingestToken: "${manifest.ingestConfigured ? "YOUR_INGEST_TOKEN" : ""}",\n    source: "my-web-app",\n    sessionId: "",\n    includeScreenshot: true,\n    includeDomSnapshot: true,\n    includeActionTrail: true,\n    slowRequestMs: 1500\n  };\n<\/script>\n<script src="${origin}/agent.js" defer><\/script>`;
  $("snippet").textContent = snippet;
}

function renderStats(stats = {}) {
  const cards = [
    { label: "Events", value: stats.totalEvents ?? 0 },
    { label: "AI analyses", value: stats.totalAnalyses ?? 0 },
    { label: "Browser", value: stats.categories?.browser ?? 0 },
    { label: "Performance", value: stats.categories?.performance ?? 0 },
    { label: "Security", value: stats.categories?.security ?? 0 },
    { label: "Last event", value: stats.lastEventAt ? new Date(stats.lastEventAt).toLocaleTimeString() : "—" },
  ];
  $("stats").innerHTML = cards
    .map((card) => `<div class="stat"><strong>${escapeHtml(card.value)}</strong><span>${escapeHtml(card.label)}</span></div>`)
    .join("");
}

function renderEvents() {
  const list = $("eventList");
  if (!state.events.length) {
    list.innerHTML = '<p class="empty">No events match this filter.</p>';
    return;
  }
  list.innerHTML = state.events
    .map((event) => {
      const active = state.selectedEvent?.id === event.id ? " active" : "";
      const title = event.page?.url || event.source || "Unknown page";
      return `<button class="event-item${active}" data-event-id="${escapeHtml(event.id)}" role="listitem" type="button">
        <span class="event-kind">${escapeHtml(event.kind)}</span>
        <span class="event-url">${escapeHtml(title)}</span>
        <span class="event-time">${escapeHtml(new Date(event.receivedAt).toLocaleString())}</span>
        <span class="event-badges">
          <span class="badge category-${escapeHtml(event.category)}">${escapeHtml(event.category || "event")}</span>
          ${event.analyses?.length ? `<span class="badge">${event.analyses.length} AI</span>` : ""}
        </span>
      </button>`;
    })
    .join("");
}

function renderEventDetail(event) {
  state.selectedEvent = event;
  $("analysisPanel").hidden = false;
  $("analysisMeta").textContent = `Event: ${event.kind} — ${event.page?.url || "no URL"}`;
  $("analysisResult").innerHTML = '<p class="empty">No analysis yet.</p>';

  let parsed = event.payload;
  try {
    parsed = JSON.stringify(JSON.parse(event.payload), null, 2);
  } catch {
    // Keep the raw payload.
  }

  const prior = (event.analyses || [])
    .map(
      (analysis) => `<div class="analysis-card">
        <div class="analysis-head"><strong>${escapeHtml(analysis.provider)}</strong><span>${escapeHtml(analysis.model)}</span></div>
        <p>${escapeHtml(analysis.summary)}</p>
        ${analysis.warning ? `<p class="warn">${escapeHtml(analysis.warning)}</p>` : ""}
        ${analysis.error ? `<p class="warn">${escapeHtml(analysis.error)}</p>` : ""}
      </div>`
    )
    .join("");

  $("eventDetail").innerHTML = `
    <div class="detail-head">
      <div>
        <h3>${escapeHtml(event.kind)}</h3>
        <p>${escapeHtml(event.page?.url || "No URL captured")}</p>
      </div>
      <span class="badge category-${escapeHtml(event.category)}">${escapeHtml(event.category)}</span>
    </div>
    <dl class="meta">
      <div><dt>Received</dt><dd>${escapeHtml(new Date(event.receivedAt).toLocaleString())}</dd></div>
      <div><dt>Source</dt><dd>${escapeHtml(event.source)}</dd></div>
      <div><dt>Session</dt><dd>${escapeHtml(event.sessionId)}</dd></div>
      <div><dt>User agent</dt><dd>${escapeHtml(event.page?.userAgent || "—")}</dd></div>
    </dl>
    <h4>Payload</h4>
    <pre class="payload">${escapeHtml(parsed)}</pre>
    ${prior ? `<h4>Prior analyses</h4>${prior}` : ""}
  `;
}

function renderAnalysis(analysis) {
  const list = (title, items) =>
    items?.length
      ? `<div class="analysis-block"><h4>${title}</h4><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
      : "";

  $("analysisResult").innerHTML = `<div class="analysis-card">
    <div class="analysis-head">
      <strong>${escapeHtml(analysis.provider)} / ${escapeHtml(analysis.model)}</strong>
      <span class="severity sev-${escapeHtml(analysis.severity)}">${escapeHtml(analysis.severity)}</span>
    </div>
    ${analysis.warning ? `<p class="warn">${escapeHtml(analysis.warning)}</p>` : ""}
    ${analysis.error ? `<p class="warn">${escapeHtml(analysis.error)}</p>` : ""}
    <p class="summary">${escapeHtml(analysis.summary)}</p>
    ${list("Likely root causes", analysis.rootCauses)}
    ${list("Evidence", analysis.evidence)}
    ${list("Recommended actions", analysis.recommendedActions)}
    ${list("Follow-up questions", analysis.followUpQuestions)}
    <div class="analysis-block"><h4>Security assessment</h4><p>${escapeHtml(analysis.securityAssessment)}</p></div>
  </div>`;
}

function renderScan(scan) {
  const findings = (scan.findings || [])
    .map(
      (item) => `<div class="finding">
        <span class="severity sev-${escapeHtml(item.severity)}">${escapeHtml(item.severity)}</span>
        <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p>
        ${item.evidence ? `<pre>${escapeHtml(item.evidence)}</pre>` : ""}
        ${item.recommendation ? `<p class="recommend">${escapeHtml(item.recommendation)}</p>` : ""}</div>
      </div>`
    )
    .join("");

  $("scanResult").innerHTML = `<div class="scan-card">
    <div class="analysis-head"><strong>${escapeHtml(scan.target)}</strong><span>${scan.durationMs}ms</span></div>
    <p>Findings: ${Object.entries(scan.counts || {}).map(([key, value]) => `${key} ${value}`).join(" · ")}</p>
    ${findings || '<p class="empty">No findings.</p>'}
    <details><summary>Probed paths</summary><pre>${escapeHtml(JSON.stringify(scan.probes || [], null, 2))}</pre></details>
  </div>`;
}

async function loadEvents() {
  const query = new URLSearchParams({
    limit: "100",
    category: $("categoryFilter").value,
    search: $("searchInput").value,
  });
  const data = await api(`/api/events?${query}`);
  state.events = data.events || [];
  renderStats(data.stats);
  renderEvents();
  if (state.selectedEvent) {
    const refreshed = state.events.find((event) => event.id === state.selectedEvent.id);
    if (refreshed) renderEventDetail(refreshed);
  }
}

async function init() {
  try {
    renderManifest(await api("/api/manifest"));
    await loadEvents();
  } catch (error) {
    toast(error.message || "Could not initialize dashboard");
  }
}

$("eventList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-event-id]");
  if (!button) return;
  try {
    const data = await api(`/api/events/${encodeURIComponent(button.dataset.eventId)}`);
    renderEventDetail(data.event);
    renderEvents();
  } catch (error) {
    toast(error.message);
  }
});

$("refreshBtn").addEventListener("click", () => loadEvents().catch((error) => toast(error.message)));
$("categoryFilter").addEventListener("change", () => loadEvents().catch((error) => toast(error.message)));
let searchTimer;
$("searchInput").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadEvents().catch((error) => toast(error.message)), 250);
});

$("analyzeBtn").addEventListener("click", async () => {
  if (!state.selectedEvent) return toast("Select an event first");
  const button = $("analyzeBtn");
  button.disabled = true;
  button.textContent = "Analyzing…";
  try {
    const body = {
      question: $("questionInput").value,
      model: $("modelInput").value.trim() || undefined,
    };
    const data = await api(`/api/events/${encodeURIComponent(state.selectedEvent.id)}/analyze`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    renderAnalysis(data.analysis);
    await loadEvents();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Analyze with AI";
  }
});

$("scanForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!$("scanAuthorization").checked) return toast("Confirm authorization first");
  const button = $("scanBtn");
  button.disabled = true;
  button.textContent = "Scanning…";
  try {
    const data = await api("/api/security/scan", {
      method: "POST",
      body: JSON.stringify({
        target: $("scanTarget").value,
        authorization: "authorized",
      }),
    });
    renderScan(data.scan);
    await loadEvents();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Run defensive scan";
  }
});

$("copySnippetBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("snippet").textContent);
    toast("Agent snippet copied");
  } catch {
    toast("Clipboard unavailable; select the snippet manually");
  }
});

init();
