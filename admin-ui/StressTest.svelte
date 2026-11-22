<script>
  import { onMount } from "svelte";

  export let apiBase = "/_panel/api";
  export let tokenKey = "blish_admin_token";

  let tests = [];
  let activeTest = null;
  let loading = true;
  let testing = false;
  let duration = 15;
  let concurrency = 10;
  let target = "/health?db=false";
  let error = "";

  onMount(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  });

  async function request(method, path, body) {
    const token = sessionStorage.getItem(tokenKey) || "";
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const contentType = res.headers.get("content-type") || "";
    const data = contentType.includes("json") ? await res.json() : await res.text();
    if (!res.ok) {
      throw new Error(typeof data === "string" ? data : data.message || data.error || "Request failed");
    }
    return data;
  }

  async function load() {
    try {
      const [history, overview] = await Promise.all([
        request("GET", "/observability/stress-tests"),
        request("GET", "/observability/overview"),
      ]);
      tests = Array.isArray(history) ? history : [];
      activeTest = overview?.activeTest || null;
      error = "";
    } catch (e) {
      error = e.message || "Could not load stress-test data";
    } finally {
      loading = false;
    }
  }

  async function startTest() {
    testing = true;
    error = "";
    try {
      await request("POST", "/observability/stress-tests", {
        duration: Number(duration),
        concurrency: Number(concurrency),
        target,
      });
      await load();
    } catch (e) {
      error = e.message || "Could not start stress test";
    } finally {
      testing = false;
    }
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
</script>

<section class="stress-test">
  <div class="stress-test__header">
    <div>
      <h2>Controlled stress test</h2>
      <p>Read-only endpoints only. Maximum 60 seconds and 50 workers.</p>
    </div>
  </div>

  <div class="stress-test__body">
    <label>
      Endpoint
      <input bind:value={target} list="stress-test-targets" placeholder="/health?db=false" />
      <datalist id="stress-test-targets">
        <option value="/health?db=false"></option>
        <option value="/api/public/stats"></option>
      </datalist>
    </label>

    <div class="stress-test__grid">
      <label>
        Duration (5-60s)
        <input type="number" min="5" max="60" bind:value={duration} />
      </label>
      <label>
        Concurrency (1-50)
        <input type="number" min="1" max="50" bind:value={concurrency} />
      </label>
    </div>

    <button on:click={startTest} disabled={testing || !!activeTest}>
      {testing || activeTest ? "Test running…" : "Start read-only test"}
    </button>

    {#if error}
      <p class="stress-test__error">{error}</p>
    {/if}

    <p class="stress-test__warning">
      Run this during a maintenance window. It measures capacity; it does not test payments,
      wallets, or writes.
    </p>
  </div>

  <div class="stress-test__history">
    <h3>Stress test history</h3>
    <div class="stress-test__table-wrap">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Target</th>
            <th>Requests</th>
            <th>Success</th>
            <th>Errors</th>
            <th>Avg</th>
            <th>P95</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {#if loading}
            <tr><td colspan="8">Loading…</td></tr>
          {:else if !tests.length}
            <tr><td colspan="8">No tests recorded</td></tr>
          {:else}
            {#each tests as test}
              <tr>
                <td>{test.status}</td>
                <td>{test.target}</td>
                <td>{test.totalRequests}</td>
                <td>{test.successful}</td>
                <td>{test.failed}</td>
                <td>{test.avgLatencyMs || 0}ms</td>
                <td>{test.p95LatencyMs || 0}ms</td>
                <td>{formatDate(test.startedAt)}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </div>
</section>

<style>
  .stress-test {
    border: 1px solid #2a2f3a;
    border-radius: 10px;
    overflow: hidden;
    font-family: inherit;
  }
  .stress-test__header {
    padding: 12px 16px;
    border-bottom: 1px solid #2a2f3a;
  }
  .stress-test__header h2,
  .stress-test__history h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }
  .stress-test__header p {
    margin: 4px 0 0;
    font-size: 11px;
    opacity: 0.65;
  }
  .stress-test__body {
    padding: 16px;
    display: grid;
    gap: 12px;
  }
  .stress-test__grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  label {
    display: grid;
    gap: 6px;
    font-size: 11px;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid #343b49;
    border-radius: 6px;
    background: #151922;
    color: inherit;
    font-size: 12px;
  }
  button {
    justify-self: start;
    padding: 8px 14px;
    border: 1px solid #8a3038;
    border-radius: 6px;
    background: #5a1f25;
    color: #fff;
    cursor: pointer;
    font-size: 12px;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .stress-test__error {
    margin: 0;
    font-size: 11px;
    color: #ff8087;
  }
  .stress-test__warning {
    margin: 0;
    font-size: 10px;
    color: #e0a838;
  }
  .stress-test__history {
    padding: 14px 16px 16px;
    border-top: 1px solid #2a2f3a;
  }
  .stress-test__table-wrap {
    overflow-x: auto;
    margin-top: 10px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.6;
    padding: 8px;
    border-bottom: 1px solid #2a2f3a;
  }
  td {
    padding: 8px;
    border-bottom: 1px solid #232833;
  }
</style>
