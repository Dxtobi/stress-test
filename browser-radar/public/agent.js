(function () {
  "use strict";

  if (window.__BROWSER_RADAR_LOADED__) return;
  window.__BROWSER_RADAR_LOADED__ = true;

  var script = document.currentScript;
  var defaults = {
    ingestUrl: "/api/ingest",
    ingestToken: "",
    source: "browser-radar-agent",
    sessionId: "",
    includeScreenshot: true,
    includeDomSnapshot: true,
    includeActionTrail: true,
    detectMalformedJson: true,
    slowRequestMs: 1500,
    maxActions: 50,
    maxQueue: 200,
    flushIntervalMs: 5000,
    maxScreenshotChars: 1_500_000,
  };
  var cfg = Object.assign({}, defaults, window.BROWSER_RADAR_CONFIG || {});

  ["ingestUrl", "ingestToken", "source", "sessionId", "slowRequestMs", "maxActions", "maxQueue", "flushIntervalMs", "maxScreenshotChars"].forEach(function (key) {
    if (!script) return;
    var raw = script.getAttribute("data-" + key.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); }));
    if (raw == null) return;
    cfg[key] = /^(slowRequestMs|maxActions|maxQueue|flushIntervalMs|maxScreenshotChars)$/.test(key) ? Number(raw) || defaults[key] : raw;
  });
  ["includeScreenshot", "includeDomSnapshot", "includeActionTrail", "detectMalformedJson"].forEach(function (key) {
    if (!script) return;
    var raw = script.getAttribute("data-" + key.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); }));
    if (raw == null) return;
    cfg[key] = raw !== "false" && raw !== "0";
  });

  var sessionId = String(cfg.sessionId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2)));
  var queue = [];
  var actions = [];
  var pendingScreenshot = "";
  var SENSITIVE_KEY = /(auth|authorization|cookie|token|secret|password|passwd|api[-_]?key|access[-_]?key|session|csrf|credential)/i;
  var SENSITIVE_TEXT = /(Bearer\s+[A-Za-z0-9._~+/=-]+|AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,})/gi;

  function truncate(value, max) {
    var text = typeof value === "string" ? value : String(value);
    return text.length > max ? text.slice(0, max - 20) + "...[truncated]" : text;
  }

  function redact(value, depth) {
    depth = depth || 0;
    if (depth > 8) return "[depth limit]";
    if (typeof value === "string") return value.replace(SENSITIVE_TEXT, "[REDACTED]");
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (Array.isArray(value)) return value.map(function (item) { return redact(item, depth + 1); });
    if (value && typeof value === "object") {
      var out = {};
      Object.keys(value).forEach(function (key) {
        out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(value[key], depth + 1);
      });
      return out;
    }
    return value;
  }

  function cleanUrl(value) {
    try {
      var url = new URL(String(value || ""), window.location.href);
      ["token", "key", "api_key", "apikey", "access_token", "refresh_token", "code", "session", "signature"].forEach(function (param) {
        url.searchParams.delete(param);
      });
      return truncate(url.toString(), 2000);
    } catch (_) {
      return truncate(String(value || ""), 500);
    }
  }

  function isOwnIngest(url) {
    return String(url || "").indexOf(cfg.ingestUrl) >= 0 || String(url || "").indexOf("/api/ingest") >= 0;
  }

  function buildPage() {
    return {
      url: cleanUrl(window.location.href),
      title: document.title || "",
      referrer: cleanUrl(document.referrer || ""),
      userAgent: navigator.userAgent || "",
      language: navigator.language || "",
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
    };
  }

  function describeElement(element) {
    if (!element || element.nodeType !== 1) return null;
    var tag = String(element.tagName || "").toLowerCase();
    var text = String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
    var detail = {
      tag: tag,
      id: element.id || "",
      classes: String(element.className || "").split(/\s+/).filter(Boolean).slice(0, 6),
      text: /^(input|textarea|select|password)$/.test(tag) ? "" : text,
      name: element.getAttribute("name") || "",
      type: element.getAttribute("type") || "",
    };
    if (element.getAttribute("href")) detail.href = cleanUrl(element.getAttribute("href"));
    if (tag === "img" && element.getAttribute("src")) detail.src = cleanUrl(element.getAttribute("src"));
    return detail;
  }

  function recordAction(type, extra) {
    if (!cfg.includeActionTrail) return;
    actions.push(Object.assign({ t: Date.now(), type: type }, extra || {}));
    while (actions.length > cfg.maxActions) actions.shift();
  }

  function domSnapshot() {
    if (!cfg.includeDomSnapshot) return "";
    try {
      var clone = document.documentElement.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll("script, style, noscript, svg"), function (node) { node.remove(); });
      Array.prototype.forEach.call(clone.querySelectorAll("*"), function (element) {
        Array.prototype.forEach.call(Array.from(element.attributes), function (attribute) {
          if (SENSITIVE_KEY.test(attribute.name) || /^(src|href)$/.test(attribute.name)) {
            if (SENSITIVE_KEY.test(attribute.name)) element.removeAttribute(attribute.name);
            else element.setAttribute(attribute.name, cleanUrl(attribute.value));
          }
        });
        if (/^(input|textarea|select)$/i.test(element.tagName)) {
          element.removeAttribute("value");
          element.textContent = "";
        }
      });
      return truncate(clone.outerHTML.replace(SENSITIVE_TEXT, "[REDACTED]"), 30_000);
    } catch (_) {
      return "";
    }
  }

  function enqueue(kind, payload, options) {
    options = options || {};
    var eventPayload = redact(Object.assign({}, payload || {}, { actionTrail: actions.slice(-cfg.maxActions) }));
    if (pendingScreenshot && (cfg.includeScreenshot || options.forceScreenshot)) {
      eventPayload.screenshot = pendingScreenshot;
      pendingScreenshot = "";
    }
    if (!eventPayload.domSnapshot && cfg.includeDomSnapshot && options.includeDom !== false) {
      eventPayload.domSnapshot = domSnapshot();
    }
    queue.push({
      kind: kind,
      source: cfg.source,
      sessionId: sessionId,
      page: buildPage(),
      payload: eventPayload,
      ts: Date.now(),
    });
    while (queue.length > cfg.maxQueue) queue.shift();
    if (queue.length >= 10 || options.immediate) flush();
  }

  function buildBatch(items) {
    return {
      kind: "browser.batch",
      source: cfg.source,
      sessionId: sessionId,
      page: buildPage(),
      events: items,
    };
  }

  async function flush() {
    if (!queue.length) return;
    var items = queue.splice(0, queue.length);
    var body = buildBatch(items);
    var headers = { "content-type": "application/json" };
    if (cfg.ingestToken) headers.authorization = "Bearer " + cfg.ingestToken;
    try {
      var res = await fetch(cfg.ingestUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(redact(body)),
        keepalive: true,
      });
      if (!res.ok) {
        // Requeue on transient failures, but keep the queue bounded.
        queue = items.concat(queue).slice(-cfg.maxQueue);
      }
    } catch (_) {
      queue = items.concat(queue).slice(-cfg.maxQueue);
    }
  }

  function captureScreenshot(dataUrl) {
    if (!dataUrl) return;
    var value = typeof dataUrl === "string" ? dataUrl : String(dataUrl.dataUrl || dataUrl);
    if (!value) return;
    pendingScreenshot = truncate(value, cfg.maxScreenshotChars);
    enqueue("browser.screenshot", { note: "Screenshot supplied by host integration", length: pendingScreenshot.length }, { forceScreenshot: true, immediate: true, includeDom: false });
  }

  function report(kind, payload, options) {
    enqueue(kind || "browser.custom", payload, options);
  }

  // Errors and console output.
  window.addEventListener("error", function (event) {
    enqueue("browser.unhandled_error", {
      message: event.message || "",
      filename: cleanUrl(event.filename || ""),
      lineno: event.lineno || 0,
      colno: event.colno || 0,
      stack: event.error && event.error.stack ? String(event.error.stack) : "",
    });
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    enqueue("browser.unhandled_rejection", {
      message: reason && reason.message ? reason.message : String(reason || ""),
      stack: reason && reason.stack ? String(reason.stack) : "",
    });
  });

  ["error", "warn"].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      try {
        enqueue("browser.console_" + level, { message: args.map(function (arg) { return truncate(redact(arg), 2000); }).join(" ") }, { includeDom: level === "error" });
      } catch (_) {
        // Never break host logging.
      }
      return original.apply(console, args);
    };
  });

  // Fetch instrumentation.
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      var rawUrl = typeof input === "string" ? input : input && input.url ? input.url : "";
      var method = (init && init.method) || (input && input.method) || "GET";
      var started = performance.now();
      return nativeFetch(input, init).then(function (response) {
        var duration = Math.round(performance.now() - started);
        if (!isOwnIngest(rawUrl)) {
          if (response.status >= 400) {
            enqueue("network.failed", { method: method, url: cleanUrl(rawUrl), status: response.status, statusText: response.statusText || "", durationMs: duration });
          } else if (duration > cfg.slowRequestMs) {
            enqueue("network.slow", { method: method, url: cleanUrl(rawUrl), status: response.status, durationMs: duration });
          }
          if (response.status >= 300 && response.status < 400) {
            var location = response.headers.get("location") || "";
            try {
              if (location && new URL(location, window.location.href).origin !== window.location.origin) {
                enqueue("security.unusual_redirect", { from: cleanUrl(rawUrl), to: cleanUrl(location), status: response.status }, { includeDom: false });
              }
            } catch (_) {}
          }
          var contentType = response.headers.get("content-type") || "";
          if (cfg.detectMalformedJson && contentType.indexOf("json") >= 0 && typeof response.clone === "function") {
            response.clone().text().then(function (text) {
              try {
                JSON.parse(text);
              } catch (error) {
                enqueue("security.malformed_response", { url: cleanUrl(rawUrl), contentType: contentType, parseError: String(error.message || error), preview: truncate(text, 600) }, { includeDom: false });
              }
            }).catch(function () {});
          }
        }
        return response;
      }).catch(function (error) {
        if (!isOwnIngest(rawUrl)) {
          enqueue("network.failed", { method: method, url: cleanUrl(rawUrl), status: 0, error: error && error.message ? error.message : String(error), durationMs: Math.round(performance.now() - started) });
        }
        throw error;
      });
    };
  }

  // XHR instrumentation.
  if (window.XMLHttpRequest) {
    var nativeOpen = XMLHttpRequest.prototype.open;
    var nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__brMeta = { method: method, url: url, started: performance.now() };
      return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      this.addEventListener("loadend", function () {
        var meta = self.__brMeta || {};
        if (isOwnIngest(meta.url)) return;
        var duration = Math.round(performance.now() - (meta.started || performance.now()));
        if (self.status >= 400 || self.status === 0) {
          enqueue("network.failed", { method: meta.method || "GET", url: cleanUrl(meta.url || ""), status: self.status, durationMs: duration });
        } else if (duration > cfg.slowRequestMs) {
          enqueue("network.slow", { method: meta.method || "GET", url: cleanUrl(meta.url || ""), status: self.status, durationMs: duration });
        }
      });
      return nativeSend.apply(this, arguments);
    };
  }

  // Performance observers.
  try {
    var resourceObserver = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (isOwnIngest(entry.name) || entry.duration <= cfg.slowRequestMs) return;
        enqueue("performance.slow_resource", { name: cleanUrl(entry.name), initiatorType: entry.initiatorType || "", durationMs: Math.round(entry.duration), transferSize: entry.transferSize || 0 }, { includeDom: false });
      });
    });
    resourceObserver.observe({ entryTypes: ["resource"] });
  } catch (_) {}

  try {
    var longTaskObserver = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        enqueue("performance.long_task", { durationMs: Math.round(entry.duration), startTime: Math.round(entry.startTime), attribution: entry.attribution ? entry.attribution.length : 0 }, { includeDom: false });
      });
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch (_) {}

  ["largest-contentful-paint", "layout-shift", "first-input"].forEach(function (type) {
    try {
      var observer = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          enqueue("performance.vital", { type: type, value: entry.value || 0, startTime: Math.round(entry.startTime || 0), rating: entry.rating || "" }, { includeDom: false });
        });
      });
      observer.observe({ type: type, buffered: true });
    } catch (_) {}
  });

  window.addEventListener("load", function () {
    try {
      var navigation = performance.getEntriesByType("navigation")[0];
      if (!navigation) return;
      enqueue("performance.navigation", {
        domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd - navigation.startTime),
        loadMs: Math.round(navigation.loadEventEnd - navigation.startTime),
        responseEndMs: Math.round(navigation.responseEnd - navigation.startTime),
        transferSize: navigation.transferSize || 0,
        type: navigation.type || "",
      }, { includeDom: false });
    } catch (_) {}
  });

  // Browser-side suspicion signals.
  document.addEventListener("securitypolicyviolation", function (event) {
    enqueue("security.csp_violation", {
      violatedDirective: event.violatedDirective || "",
      blockedURI: cleanUrl(event.blockedURI || ""),
      sourceFile: cleanUrl(event.sourceFile || ""),
      lineNumber: event.lineNumber || 0,
      disposition: event.disposition || "",
    }, { includeDom: false });
  });

  window.addEventListener("storage", function (event) {
    if (!event.key || !/(auth|token|session|jwt|cookie)/i.test(event.key)) return;
    enqueue("security.token_change", { key: event.key, oldValuePresent: !!event.oldValue, newValuePresent: !!event.newValue, note: "Changed in another same-origin tab; values are not collected." }, { includeDom: false });
  });

  try {
    var mutationObserver = new MutationObserver(function (records) {
      records.forEach(function (record) {
        Array.prototype.forEach.call(record.addedNodes || [], function (node) {
          if (!node || node.nodeType !== 1) return;
          var tag = String(node.tagName || "").toLowerCase();
          if (tag === "script" || tag === "iframe") {
            enqueue("security.suspicious_dom", { tag: tag, src: cleanUrl(node.getAttribute("src") || ""), parent: describeElement(node.parentElement) }, { includeDom: false });
          }
        });
      });
    });
    mutationObserver.observe(document.documentElement || document, { childList: true, subtree: true });
  } catch (_) {}

  // Action trail.
  document.addEventListener("click", function (event) {
    recordAction("click", { target: describeElement(event.target), x: event.clientX || 0, y: event.clientY || 0 });
  }, true);

  ["input", "change"].forEach(function (type) {
    document.addEventListener(type, function (event) {
      var element = event.target;
      recordAction(type, { target: describeElement(element) });
    }, true);
  });

  ["pushState", "replaceState"].forEach(function (method) {
    if (!window.history || typeof window.history[method] !== "function") return;
    var original = window.history[method].bind(window.history);
    window.history[method] = function () {
      recordAction("history." + method, { url: cleanUrl(arguments[2] || window.location.href) });
      return original.apply(window.history, arguments);
    };
  });
  window.addEventListener("popstate", function () { recordAction("history.popstate", { url: cleanUrl(window.location.href) }); });

  var lastScrollReport = 0;
  window.addEventListener("scroll", function () {
    var now = Date.now();
    if (now - lastScrollReport < 2000) return;
    lastScrollReport = now;
    recordAction("scroll", { x: window.scrollX, y: window.scrollY });
  }, { passive: true });

  // Public API and screenshot integration.
  window.BROWSER_RADAR = {
    config: cfg,
    sessionId: sessionId,
    report: report,
    captureScreenshot: captureScreenshot,
    flush: function () { return flush(); },
    queueSize: function () { return queue.length; },
  };

  document.addEventListener("browser-radar:screenshot", function (event) {
    captureScreenshot(event.detail && typeof event.detail === "object" ? event.detail.dataUrl || event.detail : event.detail);
  });

  setInterval(function () { flush().catch(function () {}); }, cfg.flushIntervalMs);
  window.addEventListener("pagehide", function () {
    if (!queue.length) return;
    if (typeof navigator.sendBeacon === "function" && !cfg.ingestToken) {
      navigator.sendBeacon(cfg.ingestUrl, new Blob([JSON.stringify(redact(buildBatch(queue.splice(0))) )], { type: "application/json" }));
    } else {
      flush().catch(function () {});
    }
  });
})();
