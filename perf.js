/**
 * TaktRO Browser-Side Responsiveness Monitor (perf.js)
 * Tracks user input latency, long tasks (>50ms), API performance, screen rendering durations,
 * and displays a floating developer dashboard.
 */

(function() {
  if (window.__TAKTRO_PERF_INITIALIZED) return;
  window.__TAKTRO_PERF_INITIALIZED = true;

  // Opt-in Diagnostic Check: Normal operation has 0 overhead unless explicitly enabled
  window.TAKTRO_DIAG_ENABLED = Boolean(
    window.TAKTRO_DIAG_ENABLED ||
    location.search.includes('diag=1') ||
    localStorage.getItem('taktro_diag') === '1'
  );

  window.toggleDiagMode = function(enable) {
    window.TAKTRO_DIAG_ENABLED = typeof enable === 'boolean' ? enable : !window.TAKTRO_DIAG_ENABLED;
    localStorage.setItem('taktro_diag', window.TAKTRO_DIAG_ENABLED ? '1' : '0');
    console.log(`[PERF] Diagnostic Mode is now ${window.TAKTRO_DIAG_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    if (window.TAKTRO_DIAG_ENABLED) location.reload();
  };

  if (!window.TAKTRO_DIAG_ENABLED) {
    window.FLIGHT_RECORDER = { keys: [], apiCalls: [], routeChanges: [], uiTimings: [], errors: [], anomalies: [], activeWorkspace: 'GENERAL' };
    window.recordFlightKey = () => {};
    window.recordFlightApi = () => {};
    window.recordFlightRoute = () => {};
    window.recordFlightUiTiming = () => {};
    window.recordFlightError = () => {};
    window.queuePerfLog = () => {};
    return; // ZERO key listeners, ZERO PerformanceObservers, ZERO fetch wrappers, ZERO POST logs!
  }

  // Live performance stats
  const stats = {
    lastKeyLatency: 0,
    typingHistory: [], // Holds last 10 keystrokes
    worstKeypaint: 0,
    longTasksCount: 0,
    lastActionName: 'None',
    lastActionDuration: 0,
    worstActionName: 'None',
    worstActionDuration: 0,
    lastApiUrl: 'None',
    lastApiDuration: 0,
    apiHistory: {}
  };

  // Performance Targets
  const TARGETS = {
    typing: 50,      // Max keystroke latency in ms
    action: 150      // Max UI transition/render in ms
  };

  // -------------------------------------------------------------
  // ROLLING FLIGHT RECORDER (In-Memory Black Box Buffer)
  // -------------------------------------------------------------
  let currentInteractionId = 'I-' + Math.floor(1000 + Math.random() * 9000);
  const SESSION_START_TIME = new Date().toISOString();

  function nextInteractionId() {
    currentInteractionId = 'I-' + Math.floor(1000 + Math.random() * 9000);
    return currentInteractionId;
  }

  const FLIGHT_RECORDER = {
    sessionStartISO: SESSION_START_TIME,
    keys: [],           // max 50
    apiCalls: [],       // max 50
    routeChanges: [],   // max 30
    uiTimings: [],      // max 20
    errors: [],         // max 20
    anomalies: [],      // max 20
    activeWorkspace: 'GENERAL',
    focusedElementId: '',
    lastKey: ''
  };

  function recordFlightKey(key, isFormInput = false) {
    const interId = nextInteractionId();
    FLIGHT_RECORDER.lastKey = key;
    FLIGHT_RECORDER.focusedElementId = document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '';
    FLIGHT_RECORDER.keys.push({
      interactionId: interId,
      key: key,
      isFormInput: isFormInput,
      timestamp: Date.now(),
      isoTime: new Date().toISOString()
    });
    if (FLIGHT_RECORDER.keys.length > 50) FLIGHT_RECORDER.keys.shift();
  }

  function recordFlightApi(route, status, durationMs) {
    const now = Date.now();

    // Check for existing duplicate anomaly within 500ms and collapse count
    const lastAnomaly = FLIGHT_RECORDER.anomalies[FLIGHT_RECORDER.anomalies.length - 1];
    if (lastAnomaly && lastAnomaly.type === 'POSSIBLE_DUPLICATE_FETCH' && lastAnomaly.route === route && (now - lastAnomaly.timestamp) < 500) {
      lastAnomaly.count = (lastAnomaly.count || 1) + 1;
      lastAnomaly.timestamp = now;
      lastAnomaly.message = `Endpoint ${route} called ${lastAnomaly.count}x within 500ms`;
    } else {
      const recentDuplicate = FLIGHT_RECORDER.apiCalls.find(c => c.route === route && (now - c.timestamp) < 500);
      if (recentDuplicate) {
        FLIGHT_RECORDER.anomalies.push({
          type: 'POSSIBLE_DUPLICATE_FETCH',
          message: `Endpoint ${route} called multiple times within 500ms`,
          route: route,
          count: 2,
          timestamp: now
        });
        if (FLIGHT_RECORDER.anomalies.length > 20) FLIGHT_RECORDER.anomalies.shift();
      }
    }

    let confidence = 'HIGH';
    if (durationMs > 30000) {
      confidence = 'LOW_STALE_TIMER';
      FLIGHT_RECORDER.anomalies.push({
        type: 'EXTREME_OUTLIER_STALE_TIMER',
        message: `Duration ${durationMs.toFixed(0)}ms exceeds 30s threshold — suspect stale timer`,
        route: route,
        durationMs: durationMs,
        confidence: 'LOW',
        timestamp: now
      });
      if (FLIGHT_RECORDER.anomalies.length > 20) FLIGHT_RECORDER.anomalies.shift();
    }

    FLIGHT_RECORDER.apiCalls.push({
      interactionId: currentInteractionId,
      route: route,
      status: status,
      durationMs: durationMs,
      confidence: confidence,
      timestamp: now,
      isoTime: new Date().toISOString()
    });
    if (FLIGHT_RECORDER.apiCalls.length > 50) FLIGHT_RECORDER.apiCalls.shift();
  }

  function recordFlightRouteChange(workspaceName) {
    const interId = nextInteractionId();
    FLIGHT_RECORDER.activeWorkspace = workspaceName;
    FLIGHT_RECORDER.routeChanges.push({
      interactionId: interId,
      workspace: workspaceName,
      timestamp: Date.now(),
      isoTime: new Date().toISOString()
    });
    if (FLIGHT_RECORDER.routeChanges.length > 30) FLIGHT_RECORDER.routeChanges.shift();
  }

  window.getTaktROFlightRecorderSnapshot = function() {
    return {
      sessionStartISO: FLIGHT_RECORDER.sessionStartISO,
      capturedAt: new Date().toISOString(),
      activeWorkspace: FLIGHT_RECORDER.activeWorkspace,
      focusedElementId: FLIGHT_RECORDER.focusedElementId,
      lastKey: FLIGHT_RECORDER.lastKey,
      lastInteractionId: currentInteractionId,
      recentAnomalyCount: FLIGHT_RECORDER.anomalies.length,
      keys: FLIGHT_RECORDER.keys.slice(-25),
      apiCalls: FLIGHT_RECORDER.apiCalls.slice(-25),
      routeChanges: FLIGHT_RECORDER.routeChanges.slice(-15),
      uiTimings: FLIGHT_RECORDER.uiTimings.slice(-15),
      anomalies: FLIGHT_RECORDER.anomalies.slice(-15),
      errors: FLIGHT_RECORDER.errors.slice(-15)
    };
  };

  window.recordFlightApiCall = recordFlightApi;
  window.recordFlightRouteChange = recordFlightRouteChange;

  // 1. Keydown to Paint Latency Tracker
  let lastKeydownTime = 0;
  window.addEventListener('keydown', (e) => {
    if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;

    recordFlightKey(e.key, ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName));
    lastKeydownTime = performance.now();
    requestAnimationFrame(() => {
      setTimeout(() => {
        const latency = performance.now() - lastKeydownTime;
        stats.lastKeyLatency = latency;
        stats.typingHistory.push(latency);
        if (stats.typingHistory.length > 10) {
          stats.typingHistory.shift();
        }
        if (latency > stats.worstKeypaint) {
          stats.worstKeypaint = latency;
        }

        if (latency > TARGETS.typing) {
          queuePerfLog('KEY_HANDLER', `Key [${e.key}]`, latency);
        }
        updateHud();
      }, 0);
    });
  }, true);

  // 2. Performance Observer for Long Tasks (Main thread blocked > 50ms)
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        stats.longTasksCount++;
        queuePerfLog('LONG_TASK', 'Main Thread Blocked', entry.duration);
        console.error(`[PERF] Long Task Detected! Main thread blocked for ${entry.duration.toFixed(1)}ms.`);
        updateHud();
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch (err) {
    console.warn("[PERF] Long Tasks Observer not supported in this browser.");
  }

  // Performance Log Batcher
  let perfLogQueue = [];
  let flushTimer = null;

  function queuePerfLog(category, label, duration, details = {}) {
    perfLogQueue.push({ category, label, duration, details, timestamp: Date.now() });
    if (perfLogQueue.length >= 50) {
      flushPerfLogs();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushPerfLogs, 3000);
    }
  }

  async function flushPerfLogs() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!perfLogQueue.length) return;

    const payload = perfLogQueue.splice(0, 100);
    try {
      await originalFetch('/api/perf/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: payload })
      });
    } catch (_) {
      // Re-queue on network error
      perfLogQueue.unshift(...payload);
    }
  }

  window.addEventListener('beforeunload', () => {
    if (perfLogQueue.length) {
      navigator.sendBeacon('/api/perf/log', JSON.stringify({ events: perfLogQueue }));
    }
  });

  // 3. API Fetch Interceptor
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const start = performance.now();
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || 'unknown';
    const cleanUrl = url.split('?')[0];

    if (cleanUrl.includes('/api/perf/log')) {
      return originalFetch.apply(this, args);
    }

    try {
      const response = await originalFetch.apply(this, args);
      const duration = performance.now() - start;
      recordApiCall(cleanUrl, duration);
      return response;
    } catch (err) {
      const duration = performance.now() - start;
      recordApiCall(`${cleanUrl} (Failed)`, duration);
      throw err;
    }
  };

  function recordApiCall(url, duration) {
    stats.lastApiUrl = url;
    stats.lastApiDuration = duration;
    stats.apiHistory[url] = stats.apiHistory[url] || [];
    stats.apiHistory[url].push(duration);
    if (stats.apiHistory[url].length > 5) {
      stats.apiHistory[url].shift();
    }
    
    queuePerfLog('API_CALL', url, duration);

    if (duration > 150) {
      console.warn(`[PERF] Slow API Call: ${url} took ${duration.toFixed(1)}ms`);
    }
    updateHud();
  }

  function recordAction(label, duration) {
    stats.lastActionName = label;
    stats.lastActionDuration = duration;
    if (duration > stats.worstActionDuration) {
      stats.worstActionName = label;
      stats.worstActionDuration = duration;
    }

    queuePerfLog('UI_ACTION', label, duration);

    if (duration > TARGETS.action) {
      console.warn(`[PERF] Slow UI Action [${label}] took ${duration.toFixed(1)}ms (Target: <${TARGETS.action}ms)`);
    }
    updateHud();
  }

  // Generic function patching mechanism
  function patchFunction(obj, name, label) {
    if (!obj || typeof obj[name] !== 'function') return;
    const original = obj[name];
    obj[name] = function(...args) {
      const start = performance.now();
      const result = original.apply(this, args);

      if (result instanceof Promise) {
        return result.then((val) => {
          requestAnimationFrame(() => {
            setTimeout(() => {
              recordAction(label, performance.now() - start);
            }, 0);
          });
          return val;
        }).catch((err) => {
          requestAnimationFrame(() => {
            setTimeout(() => {
              recordAction(`${label} (Failed)`, performance.now() - start);
            }, 0);
          });
          throw err;
        });
      } else {
        requestAnimationFrame(() => {
          setTimeout(() => {
            recordAction(label, performance.now() - start);
          }, 0);
        });
        return result;
      }
    };
  }

  // Hook into DOMContentLoaded to intercept global functions loaded by other scripts (Opt-In only)
  window.addEventListener('DOMContentLoaded', () => {
    if (!window.TAKTRO_DIAG_ENABLED) return;

    // Allow a tiny delay so files like appointments.js finish defining globals
    setTimeout(() => {
      const patches = [
        { obj: window, name: 'selectTask', label: 'Task Route Transition' },
        { obj: window, name: 'shiftApptDate', label: 'Appt Date Shift' },
        { obj: window, name: 'onApptDateSelect', label: 'Appt Date Picker Select' },
        { obj: window, name: 'renderApptDayView', label: 'Appt Day Rebuild' },
        { obj: window, name: 'recalculateApptTotals', label: 'Appt Totals Calc' },
        { obj: window, name: 'recalculateRoTotals', label: 'RO Totals Calc' },
        { obj: window, name: 'searchApptCustomers', label: 'Appt Cust Search' },
        { obj: window, name: 'searchApptVehicles', label: 'Appt Veh Search' },
        { obj: window, name: 'searchRoCustomers', label: 'RO Cust Search' },
        { obj: window, name: 'searchRoVehicles', label: 'RO Veh Search' },
        { obj: window, name: 'saveRepairOrder', label: 'RO Database Save' },
        { obj: window, name: 'queueHistorySearch', label: 'Prior History Search' }
      ];

      patches.forEach(({ obj, name, label }) => {
        patchFunction(obj, name, label);
      });
      console.log("[PERF] Diagnostic performance hooks successfully injected.");
    }, 100);
  });

  window.toggleDiagMode = function(enable) {
    window.TAKTRO_DIAG_ENABLED = typeof enable === 'boolean' ? enable : !window.TAKTRO_DIAG_ENABLED;
    localStorage.setItem('taktro_diag', window.TAKTRO_DIAG_ENABLED ? '1' : '0');
    console.log(`[PERF] Diagnostic Mode is now ${window.TAKTRO_DIAG_ENABLED ? 'ENABLED' : 'DISABLED'}`);
  };

  // 5. Floating UI Heads Up Display (HUD)
  let hudContainer = null;
  let isHudMinimized = true;

  function injectHudElement() {
    if (document.getElementById('perf-hud')) return;

    hudContainer = document.createElement('div');
    hudContainer.id = 'perf-hud';
    hudContainer.style.cssText = `
      position: fixed;
      bottom: 12px;
      left: 12px;
      z-index: 99990;
      background: rgba(8, 9, 11, 0.94);
      border: 1px solid var(--border-bright, #363d4e);
      border-radius: 4px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.85);
      color: var(--text-main, #e6e9ef);
      font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace);
      font-size: 11px;
      line-height: 1.4;
      padding: 0;
      width: 145px;
      overflow: hidden;
      user-select: none;
      transition: width 0.15s, height 0.15s;
    `;

    document.body.appendChild(hudContainer);
    updateHud();

    // Add CSS transitions styles to document
    const style = document.createElement('style');
    style.textContent = `
      #perf-hud .hud-btn {
        background: transparent;
        border: none;
        color: var(--accent-amber, #d9a74a);
        cursor: pointer;
        font-family: inherit;
        font-size: 10px;
        font-weight: bold;
        padding: 0 4px;
      }
      #perf-hud .hud-btn:hover {
        background: rgba(255,255,255,0.08);
        border-radius: 2px;
      }
      #perf-hud .latency-good { color: #62d6b2; }
      #perf-hud .latency-warn { color: #d9a74a; }
      #perf-hud .latency-fail { color: #fc8181; }
    `;
    document.head.appendChild(style);
  }

  function getLatencyClass(val, target) {
    if (val <= target) return 'latency-good';
    if (val <= target * 2) return 'latency-warn';
    return 'latency-fail';
  }  window.togglePerfHud = function() {
    isHudMinimized = !isHudMinimized;
    updateHud();
    if (typeof window.makeElementDraggable === 'function' && hudContainer) {
      const header = hudContainer.querySelector('.hud-header-drag') || hudContainer;
      window.makeElementDraggable(hudContainer, header);
    }
  };

  window.resetPerfStats = function() {
    stats.lastKeyLatency = 0;
    stats.typingHistory = [];
    stats.worstKeypaint = 0;
    stats.longTasksCount = 0;
    stats.lastActionName = 'None';
    stats.lastActionDuration = 0;
    stats.worstActionName = 'None';
    stats.worstActionDuration = 0;
    stats.lastApiUrl = 'None';
    stats.lastApiDuration = 0;
    updateHud();
  };

  function updateHud() {
    if (!hudContainer) return;

    if (isHudMinimized) {
      const avgTyping = stats.typingHistory.length > 0
        ? (stats.typingHistory.reduce((a,b)=>a+b, 0) / stats.typingHistory.length)
        : 0;
      const keyClass = getLatencyClass(avgTyping, TARGETS.typing);

      hudContainer.style.width = '145px';
      hudContainer.style.height = '24px';
      hudContainer.innerHTML = `
        <div class="hud-header-drag" style="display:flex; justify-content:space-between; align-items:center; height:24px; padding:0 8px; cursor:move; user-select:none;" title="Click and drag to move, or click ▲ to expand">
          <span style="font-weight:bold; color:var(--accent-amber);">PERF: <span class="${keyClass}">${avgTyping ? avgTyping.toFixed(0) + 'ms' : '—'}</span></span>
          <button class="hud-btn" data-action="perf.window.togglePerfHud">▲</button>
        </div>
      `;
      if (typeof window.makeElementDraggable === 'function') {
        window.makeElementDraggable(hudContainer, hudContainer.querySelector('.hud-header-drag'));
      }
      return;
    }

    const avgTyping = stats.typingHistory.length > 0
      ? (stats.typingHistory.reduce((a,b)=>a+b, 0) / stats.typingHistory.length)
      : 0;

    const currentKeypaintClass = getLatencyClass(stats.lastKeyLatency, TARGETS.typing);
    const avgKeypaintClass = getLatencyClass(avgTyping, TARGETS.typing);
    const worstKeypaintClass = getLatencyClass(stats.worstKeypaint, TARGETS.typing);
    const actionClass = getLatencyClass(stats.lastActionDuration, TARGETS.action);
    const worstActionClass = getLatencyClass(stats.worstActionDuration, TARGETS.action);
    const longTasksClass = stats.longTasksCount > 0 ? 'latency-fail' : 'latency-good';

    hudContainer.style.width = '320px';
    hudContainer.style.height = 'auto';

    hudContainer.innerHTML = `
      <!-- HUD HEADER -->
      <div class="hud-header-drag" style="background: rgba(27, 30, 38, 0.95); border-bottom: 1px solid var(--border-bright, #363d4e); display: flex; justify-content: space-between; padding: 4px 8px; align-items: center; cursor:move; user-select:none;" title="Click and drag to move">
        <span style="color: var(--accent-amber); font-weight: 800;">⚡ TaktRO PERFORMANCE MONITOR</span>
        <div>
          <button class="hud-btn" data-action="perf.window.resetPerfStats">RESET</button>
          <button class="hud-btn" data-action="perf.window.togglePerfHud">▼</button>
        </div>
      </div>

      <!-- HUD STATS LIST -->
      <div style="padding: 8px; display: flex; flex-direction: column; gap: 4px;">
        <!-- KEYPRESS RESPONSE -->
        <div style="display:flex; justify-content:space-between;">
          <span>Last Typing Paint:</span>
          <strong class="${currentKeypaintClass}">${stats.lastKeyLatency ? stats.lastKeyLatency.toFixed(1) + ' ms' : '—'}</strong>
        </div>
        <div style="display:flex; justify-content:space-between;">
          <span>Rolling Typing Avg:</span>
          <strong class="${avgKeypaintClass}">${avgTyping ? avgTyping.toFixed(1) + ' ms' : '—'}</strong>
        </div>
        <div style="display:flex; justify-content:space-between;">
          <span>Worst Typing Paint:</span>
          <strong class="${worstKeypaintClass}">${stats.worstKeypaint ? stats.worstKeypaint.toFixed(1) + ' ms' : '—'}</strong>
        </div>

        <!-- LINE BREAK -->
        <div style="border-top:1px dashed var(--border-color, #222630); margin: 4px 0;"></div>

        <!-- ACTIONS & RENDER -->
        <div style="display:flex; flex-direction:column; gap:2px;">
          <div style="display:flex; justify-content:space-between;">
            <span>Last UI Action:</span>
            <strong class="${actionClass}">${stats.lastActionDuration ? stats.lastActionDuration.toFixed(1) + ' ms' : '—'}</strong>
          </div>
          <div style="color:var(--accent-cyan); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-left:8px;" title="${stats.lastActionName}">
            ↳ ${stats.lastActionName}
          </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:2px; margin-top:2px;">
          <div style="display:flex; justify-content:space-between;">
            <span>Worst UI Action:</span>
            <strong class="${worstActionClass}">${stats.worstActionDuration ? stats.worstActionDuration.toFixed(1) + ' ms' : '—'}</strong>
          </div>
          <div style="color:var(--accent-crimson); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-left:8px;" title="${stats.worstActionName}">
            ↳ ${stats.worstActionName}
          </div>
        </div>

        <!-- LINE BREAK -->
        <div style="border-top:1px dashed var(--border-color, #222630); margin: 4px 0;"></div>

        <!-- API CALLS -->
        <div style="display:flex; flex-direction:column; gap:2px;">
          <div style="display:flex; justify-content:space-between;">
            <span>Last API Fetch:</span>
            <strong style="color: #73b8f0;">${stats.lastApiDuration ? stats.lastApiDuration.toFixed(1) + ' ms' : '—'}</strong>
          </div>
          <div style="color:var(--text-muted); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-left:8px;" title="${stats.lastApiUrl}">
            ↳ ${stats.lastApiUrl}
          </div>
        </div>

        <!-- LINE BREAK -->
        <div style="border-top:1px dashed var(--border-color, #222630); margin: 4px 0;"></div>

        <!-- SYSTEM LONG TASKS -->
        <div style="display:flex; justify-content:space-between;">
          <span style="font-weight:bold;">Long Tasks (>50ms Blocks):</span>
          <strong class="${longTasksClass}">${stats.longTasksCount}</strong>
        </div>
      </div>
    `;

    if (typeof window.makeElementDraggable === 'function') {
      window.makeElementDraggable(hudContainer, hudContainer.querySelector('.hud-header-drag'));
    }
  }


document.addEventListener('DOMContentLoaded', () => {
  const actions = {
    "perf.window.togglePerfHud": (param, element, event) => window.togglePerfHud(),
    "perf.window.resetPerfStats": (param, element, event) => window.resetPerfStats(),
  };
  for (const [name, handler] of Object.entries(actions)) {
    EventDelegator.registerAction(name, handler);
  }
});
})();
