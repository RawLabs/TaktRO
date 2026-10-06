/**
 * TaktRO — Core Application Shell & Router (app.js)
 * Manages global session state, PIN auth, warp jump memory stack, global hotkeys, and help assistant.
 * Domain logic is modularized into: parts/, orders/, customers/, vehicles/, appointments/, staff/
 */

const state = {
  activeTask: null,
  taskStack: []
};

const taskFormCache = {};

// A warp frame retains the live view, rather than applying its fields to another
// workspace's markup. Each jump owns its frame, including repeated workspace visits.
const navigationContexts = {
  P: {
    capture: () => ({ results: partsSearchResults, index: partsActiveIndex, page: partsCatalogPage, pageSize: partsCatalogPageSize, partId: window.currentViewingPartId, loadedPart: window.currentLoadedPart, counterSale: window.activeCounterSale ? structuredClone(window.activeCounterSale) : null, fastMoving: window.isViewingFastMoving }),
    restore: saved => { partsSearchResults = saved.results; partsActiveIndex = saved.index; partsCatalogPage = saved.page; partsCatalogPageSize = saved.pageSize; window.currentViewingPartId = saved.partId; window.currentLoadedPart = saved.loadedPart; window.activeCounterSale = saved.counterSale; window.isViewingFastMoving = saved.fastMoving; }
  },
  V: {
    capture: () => ({ results: vehicleSearchResults, vehicle: activeVehicle, links: customerLinkResults, pendingLink: pendingVehicleCustomerLink }),
    restore: saved => { vehicleSearchResults = saved.results; activeVehicle = saved.vehicle; customerLinkResults = saved.links; pendingVehicleCustomerLink = saved.pendingLink; }
  },
  C: {
    capture: () => ({ results: customerSearchResults, customer: activeCustomer }),
    restore: saved => { customerSearchResults = saved.results; activeCustomer = saved.customer; }
  },
  O: {
    capture: () => ({ id: activeEditingRoId, customer: activeRoCustomer, rows: activeRoList, index: activeRoRowIndex, sort: {...roSortState}, page: roBoardPage, customers: roCustomerSearchResults, customerIndex: roCustActiveIndex, vehicles: roVehicleSearchResults, vehicleIndex: roVehActiveIndex }),
    restore: saved => { activeEditingRoId = saved.id; activeRoCustomer = saved.customer; activeRoList = saved.rows; activeRoRowIndex = saved.index; roSortState = saved.sort; roBoardPage = saved.page; roCustomerSearchResults = saved.customers; roCustActiveIndex = saved.customerIndex; roVehicleSearchResults = saved.vehicles; roVehActiveIndex = saved.vehicleIndex; }
  },
  A: {
    capture: () => ({ mode: activeApptViewMode, previousMode: previousApptViewMode, date: activeApptDate, index: activeApptRowIndex, id: activeEditingApptId, appointments: cachedAppointments, byDate: appointmentsByDateMap, range: lastLoadedApptRange, customers: apptCustomerSearchResults, customerIndex: apptCustActiveIndex, vehicles: apptVehicleSearchResults, vehicleIndex: apptVehActiveIndex }),
    restore: saved => { activeApptViewMode = saved.mode; previousApptViewMode = saved.previousMode; activeApptDate = saved.date; activeApptRowIndex = saved.index; activeEditingApptId = saved.id; cachedAppointments = saved.appointments; appointmentsByDateMap = saved.byDate; lastLoadedApptRange = saved.range; apptCustomerSearchResults = saved.customers; apptCustActiveIndex = saved.customerIndex; apptVehicleSearchResults = saved.vehicles; apptVehActiveIndex = saved.vehicleIndex; }
  },
  M: {
    capture: () => ({ setup: staffSetup, id: activeEmployeeAccessId }),
    restore: saved => { staffSetup = saved.setup; activeEmployeeAccessId = saved.id; }
  },
  K: { capture: () => vendorState, restore: saved => { vendorState = saved; } },
  B: { capture: () => managementSetupState, restore: saved => { managementSetupState = saved; } },
  J: { capture: () => jobCatalogActiveIndex, restore: saved => { jobCatalogActiveIndex = saved; } }
};

function captureTaskState(taskKey) {
  const container = document.getElementById('workspaceContent');
  if (!taskKey || !container) return null;
  const view = {
    taskKey,
    nodes: [...container.childNodes],
    title: document.getElementById('activeTaskTitle')?.textContent || '',
    focus: container.contains(document.activeElement) ? document.activeElement : null,
    scroll: [container, ...container.querySelectorAll('*')]
      .filter(element => element.scrollTop || element.scrollLeft)
      .map(element => ({element, top: element.scrollTop, left: element.scrollLeft})),
    editor: window.EditorStack?.activeEditor || null,
    context: navigationContexts[taskKey]?.capture()
  };
  taskFormCache[taskKey] = view;
  return view;
}

function restoreTaskState(taskKey, view = taskFormCache[taskKey]) {
  const container = document.getElementById('workspaceContent');
  if (!container || !view || view.taskKey !== taskKey) return false;
  container.replaceChildren(...view.nodes);
  const title = document.getElementById('activeTaskTitle');
  if (title) title.textContent = view.title;
  navigationContexts[taskKey]?.restore(view.context);
  if (window.EditorStack) EditorStack.activeEditor = view.editor;
  for (const saved of view.scroll) {
    saved.element.scrollTop = saved.top;
    saved.element.scrollLeft = saved.left;
  }
  if (view.focus?.isConnected && !view.focus.disabled) view.focus.focus({preventScroll: true});
  return true;
}

let sessionToken = null;
let activeEmployee = null;
const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 MINUTES IDLE AUTO-LOCK
let idleTimer = null;
let lastIdleRefreshAt = 0;
const IDLE_REFRESH_INTERVAL_MS = 15 * 1000;

const workspaceLegendDefinitions = {
  O: [['active', 'ACTIVE / PRIMARY'], ['focus', 'KEYBOARD FOCUS'], ['positive', 'COMPLETE / ON TRACK'], ['caution', 'HOLD / RISK'], ['danger', 'REMOVE / OVERDUE']],
  A: [['active', 'ACTIVE / PRIMARY'], ['focus', 'KEYBOARD FOCUS'], ['positive', 'AVAILABLE / RESCHEDULE'], ['caution', 'DEFER / CARRY-OVER'], ['danger', 'DELETE / OVERBOOK']],
  P: [['active', 'ACTIVE / PRIMARY'], ['focus', 'KEYBOARD FOCUS'], ['positive', 'AVAILABLE / POSTED'], ['info', 'RESERVED STOCK'], ['caution', 'REORDER'], ['danger', 'SHORTAGE / ADJUST']],
  C: [['active', 'ACTIVE / PRIMARY'], ['focus', 'KEYBOARD FOCUS'], ['positive', 'ACTIVE / LINKED'], ['caution', 'ACCOUNT ATTENTION'], ['danger', 'REMOVE / EXCEPTION']],
  V: [['active', 'ACTIVE / PRIMARY'], ['focus', 'KEYBOARD FOCUS'], ['positive', 'SHOP / LINKED ASSET'], ['info', 'VEHICLE INFORMATION'], ['caution', 'UNLINKED / REVIEW']],
  J: [['active', 'SELECTED / PRIMARY'], ['focus', 'KEYBOARD FOCUS'], ['positive', 'ACTIVE CODE'], ['caution', 'CUSTOM / REVIEW'], ['danger', 'DEACTIVATE']],
  M: [['active', 'ACTIVE / PRIMARY'], ['focus', 'KEYBOARD FOCUS'], ['positive', 'ACTIVE STAFF'], ['caution', 'ACCESS EXCEPTION'], ['danger', 'INACTIVE / REVOKED']],
  S: [['active', 'SELECTED / PRIMARY'], ['focus', 'KEYBOARD FOCUS'], ['caution', 'SETUP ATTENTION']]
};

function workspaceLegendPreferenceKey() {
  return `taktro-color-key-open:${activeEmployee?.id || 'default'}`;
}

function readWorkspaceLegendPreference() {
  try {
    const saved = localStorage.getItem(workspaceLegendPreferenceKey());
    return saved === null ? true : saved === 'true';
  } catch (_err) {
    return false;
  }
}

function updateWorkspaceLegend(taskKey = state.activeTask) {
  const rail = document.getElementById('workspaceLegendRail');
  const itemsEl = document.getElementById('workspaceLegendItems');
  if (!rail || !itemsEl) return;
  const items = workspaceLegendDefinitions[taskKey] || workspaceLegendDefinitions.S;
  rail.dataset.workspace = taskKey || '';
  itemsEl.innerHTML = items.map(([kind, label]) => `
    <span class="workspace-legend-item legend-${kind}"><span class="workspace-legend-swatch" aria-hidden="true"></span>${label}</span>
  `).join('');
  setWorkspaceLegendExpanded(readWorkspaceLegendPreference(), false);
}

function setWorkspaceLegendExpanded(expanded, persist = true) {
  const rail = document.getElementById('workspaceLegendRail');
  const itemsEl = document.getElementById('workspaceLegendItems');
  const toggle = document.getElementById('workspaceLegendToggle');
  const chevron = document.getElementById('workspaceLegendChevron');
  if (!itemsEl || !toggle) return;
  rail?.classList.toggle('is-expanded', expanded);
  itemsEl.classList.toggle('hidden', !expanded);
  toggle.setAttribute('aria-expanded', String(expanded));
  if (chevron) chevron.textContent = expanded ? '▼' : '▲';
  if (persist) {
    try { localStorage.setItem(workspaceLegendPreferenceKey(), String(expanded)); } catch (_err) {}
  }
}

function toggleWorkspaceLegend() {
  const toggle = document.getElementById('workspaceLegendToggle');
  if (!toggle) return;
  setWorkspaceLegendExpanded(toggle.getAttribute('aria-expanded') !== 'true');
}

function debounce(func, wait = 150) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func.apply(this, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

const inFlightApiRequests = new Map();
const apiCache = new Map();
const STABLE_CACHE_ROUTES = new Set([
  '/api/technicians',
  '/api/operational-config',
  '/api/job-codes',
  '/api/tax-profiles',
  '/api/fee-rules',
  '/api/payer-programs',
  '/api/customer-types'
]);

function clearSessionCaches() {
  apiCache.clear();
  inFlightApiRequests.clear();
}

function invalidateApiCache(path) {
  const cleanPath = String(path || '').split('?')[0];
  const targets = [cleanPath];
  if (cleanPath.startsWith('/api/management-setup') || cleanPath.startsWith('/api/operational-config')) {
    targets.push('/api/operational-config', '/api/fee-rules', '/api/tax-profiles', '/api/customer-types', '/api/payer-programs', '/api/technicians');
  } else if (cleanPath.startsWith('/api/technicians')) {
    targets.push('/api/technicians');
  } else if (cleanPath.startsWith('/api/job-codes')) {
    targets.push('/api/job-codes');
  }

  for (const key of apiCache.keys()) {
    for (const target of targets) {
      if (key.includes(target)) {
        apiCache.delete(key);
        break;
      }
    }
  }
}

async function api(path, options = {}, retries = 1) {
  const method = (options.method || 'GET').toUpperCase();
  const isGet = method === 'GET';

  if (!isGet) {
    invalidateApiCache(path);
  }

  const cacheKey = `${sessionToken || 'anonymous'}:${method}:${path}`;

  // Check GET cache for stable reference data
  if (isGet && STABLE_CACHE_ROUTES.has(path)) {
    const cached = apiCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < 60000)) {
      return JSON.parse(JSON.stringify(cached.data));
    }
  }

  const requestKey = `${sessionToken || 'anonymous'}:${method}:${path}:${options.body || ''}`;
  if (isGet && inFlightApiRequests.has(requestKey)) {
    return inFlightApiRequests.get(requestKey);
  }

  let currentPromise = null;
  currentPromise = (async () => {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
    try {
      const response = await fetch(path, { ...options, headers });
      const body = await response.json();
      if (!response.ok) {
        const error = new Error(body.error || 'Request failed');
        Object.assign(error, body, { status: response.status });
        throw error;
      }

      if (isGet && STABLE_CACHE_ROUTES.has(path)) {
        apiCache.set(cacheKey, { data: body, timestamp: Date.now() });
      }

      return body;
    } catch (err) {
      if (retries > 0 && (!err.status || err.status >= 500)) {
        // Remove from in-flight requests BEFORE retrying so retry spawns a new request
        if (inFlightApiRequests.get(requestKey) === currentPromise) {
          inFlightApiRequests.delete(requestKey);
        }
        await new Promise(res => setTimeout(res, 500));
        return api(path, options, retries - 1);
      }
      throw err;
    } finally {
      // Prevent an older request's finally from deleting a newer replacement promise entry
      if (inFlightApiRequests.get(requestKey) === currentPromise) {
        inFlightApiRequests.delete(requestKey);
      }
    }
  })();

  if (isGet) {
    inFlightApiRequests.set(requestKey, currentPromise);
  }

  return currentPromise;
}

function getPinInput() {
  return document.getElementById('employeePin') || document.getElementById('empPinInput');
}

function autoSubmitPin(inputEl) {
  if (inputEl && inputEl.value.trim().length === 4) {
    handleEmployeeLogin();
  }
}

async function handleEmployeeLogin(e) {
  if (e) e.preventDefault();
  const pinInput = getPinInput();
  const errorEl = document.getElementById('authError');
  if (!pinInput) return;
  const pin = pinInput.value.trim();

  if (!pin) return;
  if (errorEl) errorEl.textContent = '';

  try {
    clearSessionCaches(); // Clear caches BEFORE assigning new login session
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ pin }) });
    sessionToken = result.token;
    activeEmployee = result.employee;
    renderAuthenticatedState();
    await Promise.all([
      loadCustomJobCodes(),
      typeof loadRepairOrders === 'function' ? loadRepairOrders() : Promise.resolve()
    ]);
    resetIdleTimer();
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message || 'LOGIN FAILED.';
    if (pinInput) {
      pinInput.value = '';
      pinInput.focus();
    }
  }
}

function renderAuthenticatedState() {
  document.getElementById('authOverlay')?.classList.add('hidden');
  const badgeName = document.getElementById('userBadgeName');
  const badgePos = document.getElementById('userBadgePos');
  if (badgeName) badgeName.textContent = activeEmployee.name.toUpperCase();
  if (badgePos) badgePos.textContent = '';

  const headerUserDisplay = document.getElementById('headerUserDisplay');
  if (headerUserDisplay && activeEmployee) {
    headerUserDisplay.textContent = activeEmployee.name.toUpperCase();
  }

  const advisorBadge = document.querySelector('.advisor-badge');
  if (advisorBadge && activeEmployee) {
    advisorBadge.textContent = activeEmployee.name.toUpperCase();
  }

  document.querySelectorAll('.dash-card[data-permission]').forEach(card => {
    const requiredPerm = card.dataset.permission;
    if (hasPermission(requiredPerm)) {
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
  });
  document.querySelectorAll('[data-permission-any]').forEach(element => {
    const allowed = element.dataset.permissionAny.split(/\s+/).some(hasPermission);
    element.classList.toggle('hidden', !allowed);
  });
}

async function logoutEmployee() {
  if (window.ModalStack) window.ModalStack.reset();
  if (window.DropdownRegistry) window.DropdownRegistry.reset();
  if (window.EditorStack) window.EditorStack.reset();
  clearSessionCaches();
  if (sessionToken) {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
  }
  sessionToken = null;
  activeEmployee = null;
  customJobCodes = [];
  clearTimeout(idleTimer);

  const headerUserDisplay = document.getElementById('headerUserDisplay');
  if (headerUserDisplay) headerUserDisplay.textContent = 'NO USER LOGGED IN';
  const advisorBadge = document.querySelector('.advisor-badge');
  if (advisorBadge) advisorBadge.textContent = 'NO ADVISOR LOGGED IN';

  const overlay = document.getElementById('workspaceOverlay');
  if (overlay) overlay.classList.add('hidden');
  const contentEl = document.getElementById('workspaceContent');
  if (contentEl) contentEl.innerHTML = '';
  const helpModal = document.getElementById('helpModalOverlay');
  if (helpModal) helpModal.classList.add('hidden');

  state.activeTask = null;
  state.taskStack = [];
  Object.keys(taskFormCache).forEach(k => delete taskFormCache[k]);

  if (typeof activeCustomer !== 'undefined') activeCustomer = null;
  if (typeof activeVehicle !== 'undefined') activeVehicle = null;

  const pinInput = getPinInput();
  if (pinInput) pinInput.value = '';
  const errorEl = document.getElementById('authError');
  if (errorEl) errorEl.textContent = '';
  document.getElementById('authOverlay')?.classList.remove('hidden');
  requestAnimationFrame(() => getPinInput()?.focus());
}

function resetIdleTimer(force = false) {
  const now = Date.now();
  if (!force && idleTimer && now - lastIdleRefreshAt < IDLE_REFRESH_INTERVAL_MS) return;
  lastIdleRefreshAt = now;
  clearTimeout(idleTimer);
  if (sessionToken) {
    idleTimer = setTimeout(() => {
      logoutEmployee();
      alert('SESSION AUTO-LOCKED DUE TO 20 MINUTES INACTIVITY.');
    }, IDLE_TIMEOUT_MS);
  }
}

['pointerdown', 'keydown', 'scroll'].forEach(evt => {
  window.addEventListener(evt, () => { if (sessionToken) resetIdleTimer(false); }, { passive: true });
});

function hasPermission(key) {
  if (!activeEmployee) return false;
  return activeEmployee.permissions.includes(key);
}

function activateCardFromKeyboard(event, key) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectTask(key);
  }
}

function handleTypeaheadNavigation(event, options) {
  const { dropdown, results, activeIndex, setActiveIndex, render, select, valueForResult } = options;
  if (!dropdown || dropdown.classList.contains('hidden')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    dropdown.classList.add('hidden');
    return;
  }
  if (!results.length) return;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = (activeIndex + direction + results.length) % results.length;
    setActiveIndex(nextIndex);
    render();
    return;
  }

  let selectedIndex = activeIndex;
  if (/^[1-9]$/.test(event.key)) selectedIndex = Number(event.key) - 1;
  else if (event.key !== 'Enter' && event.key !== 'Tab') return;
  if (!results[selectedIndex]) return;
  event.preventDefault();
  select(valueForResult ? valueForResult(results[selectedIndex], selectedIndex) : selectedIndex);
}

const MODULE_LOGOS = {
  O: 'media/TaktRO_media_package_2026-08-16/TaktRO_media_package/02_APP/TaktRO_app_icon_512.png',
  A: 'media/TaktRO_media_package_2026-08-16/TaktRO_media_package/03_SOCIAL/TaktRO_social_square_1080.png',
  C: 'media/TaktRO_media_package_2026-08-16/TaktRO_media_package/03_SOCIAL/TaktRO_profile_800.png',
  V: 'media/TaktRO_media_package_2026-08-16/TaktRO_media_package/00_MASTER/TaktRO_source_selected.png',
  P: 'media/TaktRO_media_package_2026-08-16/TaktRO_media_package/01_WEB/TaktRO_logo_dark_600px.png',
  S: 'media/TaktRO_media_package_2026-08-16/TaktRO_media_package/01_WEB/TaktRO_logo_dark_400px.png',
  J: 'media/TaktRO_media_package_2026-08-16/TaktRO_media_package/00_MASTER/TaktRO_master_dark.png',
  M: 'media/TaktRO_media_package_2026-08-16/TaktRO_media_package/03_SOCIAL/TaktRO_profile_800.png',
  K: 'media/TaktRO_media_package_2026-08-16/TaktRO_media_package/01_WEB/TaktRO_logo_dark_800px.png',
  F: 'media/TaktRO_media_package_2026-08-16/TaktRO_media_package/04_PRINT/TaktRO_invoice_white_application_2400x700.png',
  DEFAULT: 'media/TaktRO_media_package_2026-08-16/TaktRO_media_package/01_WEB/TaktRO_logo_dark_400px.png'
};

function renderModuleLogoLoader(key = 'DEFAULT', message = "SYNCHRONIZING MODULE DATA...") {
  const logoSrc = MODULE_LOGOS[key] || MODULE_LOGOS['DEFAULT'];
  return `
    <div class="module-loader-overlay">
      <div class="logo-loader-container">
        <img src="${logoSrc}" alt="TaktRO Module Logo" class="taktro-pulse-logo">
      </div>
      <span style="font-size:12px; font-weight:800; color:var(--accent-amber); letter-spacing:1.5px; text-transform:uppercase;">${message}</span>
    </div>
  `;
}

function showModuleLoader(containerEl, key = 'DEFAULT', message = "SYNCHRONIZING MODULE DATA...") {
  if (containerEl) {
    containerEl.innerHTML = renderModuleLogoLoader(key, message);
  }
}

function selectTask(key, isWarpReturn = false, returnFrame = null) {
  const permissionMap = {
    O: 'repair_orders', A: 'appointments', C: 'customers', V: 'customers',
    P: 'parts', S: 'shop_setup', B: 'shop_setup', M: 'staff_admin', K: 'shop_setup', F: 'cashout'
  };

  if ((key === 'S' || key === 'B') && !hasPermission('shop_setup') && !hasPermission('staff_admin')) {
    alert('ACCESS NOT ASSIGNED TO YOUR POSITION.');
    return;
  }

  const requiredPermission = permissionMap[key];
  if (requiredPermission && !hasPermission(requiredPermission)) {
    alert('ACCESS NOT ASSIGNED TO YOUR POSITION.');
    return;
  }

  const contentEl = document.getElementById('workspaceContent');
  const titleEl = document.getElementById('activeTaskTitle');
  const overlay = document.getElementById('workspaceOverlay');
  const isOverlayOpen = overlay && !overlay.classList.contains('hidden');

  if (state.activeTask === 'A' && typeof cancelAppointmentAutosave === 'function') {
    cancelAppointmentAutosave();
  }

  if (isOverlayOpen && state.activeTask) {
    const previousView = captureTaskState(state.activeTask);
    if (!isWarpReturn && state.activeTask !== key && previousView) {
      state.taskStack.push(previousView);
    }
    if (window.EditorStack) EditorStack.reset();
  }

  state.activeTask = key;

  const workspaceNames = {
    O: 'repair-order', A: 'appointments', C: 'customers', V: 'vehicles',
    P: 'parts', S: 'settings', B: 'management-setup', J: 'job-codes', M: 'staff', K: 'management-setup', F: 'cashout'
  };
  contentEl.dataset.workspace = workspaceNames[key] || 'general';

  if (isWarpReturn && restoreTaskState(key, returnFrame || taskFormCache[key])) {
    overlay.classList.remove('hidden');
    updateWorkspaceLegend(key);
    return;
  }

  overlay.classList.remove('hidden');

  switch (key) {
    case 'O':
      titleEl.textContent = 'REPAIR ORDER WORKSPACE';
      contentEl.innerHTML = renderRoWriteupContent();
      break;
    case 'A':
      titleEl.textContent = 'APPOINTMENTS & SHOP TIME-POOL CAPACITY';
      contentEl.innerHTML = renderApptContent();
      break;
    case 'C':
      titleEl.textContent = 'CUSTOMER DIRECTORY & HISTORY';
      if (typeof loadConfiguredCustomerTypes === 'function') loadConfiguredCustomerTypes();
      contentEl.innerHTML = renderCustomerContent();
      requestAnimationFrame(() => document.getElementById('customerSearch')?.focus());
      break;
    case 'V':
      titleEl.textContent = 'VEHICLE LOOKUP';
      contentEl.innerHTML = renderVehicleContent();
      requestAnimationFrame(() => document.getElementById('vehicleSearch')?.focus());
      break;
    case 'P':
      titleEl.textContent = 'PARTS & INVENTORY CONTROL ENGINE';
      contentEl.innerHTML = renderPartsContent();
      break;
    case 'S':
      titleEl.textContent = 'SHOP SETTINGS';
      contentEl.innerHTML = renderSettingsContent();
      break;
    case 'B':
      titleEl.textContent = 'CANADIAN BUSINESS & SHOP MANAGEMENT SETUP';
      if (typeof renderManagementSetupLoading === 'function') {
        contentEl.innerHTML = renderManagementSetupLoading();
      }
      if (typeof loadManagementSetup === 'function') {
        loadManagementSetup();
      }
      break;
    case 'J':
      titleEl.textContent = 'JOB OP CODE SEARCH & CATALOG';
      contentEl.innerHTML = renderJobSearchContent();
      requestAnimationFrame(() => document.getElementById('jobSearchInput')?.focus());
      break;
    case 'M':
      titleEl.textContent = 'STAFF & ACCESS EXCEPTIONS';
      contentEl.innerHTML = renderStaffLoading();
      loadStaffWorkspace();
      break;
    case 'K':
      titleEl.textContent = 'VENDOR DIRECTORY';
      contentEl.innerHTML = renderVendorLoading();
      loadVendorWorkspace();
      break;
    case 'H':
      titleEl.textContent = 'REPAIR ORDER HISTORY & AUDIT SEARCH';
      if (typeof renderRoHistoryWorkspace === 'function') {
        contentEl.innerHTML = renderRoHistoryWorkspace();
      }
      break;
    case 'F':
      titleEl.textContent = 'FINAL CASHOUT & POSTING ENGINE';
      if (typeof renderRoHistoryWorkspace === 'function') {
        contentEl.innerHTML = renderRoHistoryWorkspace();
      }
      break;
  }
  updateWorkspaceLegend(key);
}

/* ==========================================================================
   UNIFIED INTERACTION & NAVIGATION LAYER (REGISTRIES & STACK ENGINES)
   ========================================================================== */

// 1. DROPDOWN REGISTRY
window.DropdownRegistry = {
  active: null,
  open(id, el, openerEl, closeFn) {
    const opener = openerEl || document.activeElement;
    if (window.ModalStack && window.ModalStack.stack.length > 0) {
      const topModal = window.ModalStack.stack[window.ModalStack.stack.length - 1];
      if (topModal.el && opener && !topModal.el.contains(opener)) {
        if (typeof closeFn === 'function') closeFn();
        return;
      }
    }
    if (this.active && this.active.id !== id) {
      this.close();
    }
    this.active = { id, el, openerEl: opener, closeFn };
  },
  close() {
    if (!this.active) return false;
    const { el, openerEl, closeFn } = this.active;
    if (!el || !document.body.contains(el) || el.classList.contains('hidden') || (typeof getComputedStyle === 'function' && getComputedStyle(el).display === 'none')) {
      this.active = null;
      return false;
    }
    this.active = null;
    if (typeof closeFn === 'function') closeFn();
    this.restoreFocus(openerEl);
    return true;
  },
  reset() {
    this.active = null;
  },
  restoreFocus(opener) {
    if (opener && document.body.contains(opener) && opener.offsetWidth > 0 && !opener.disabled && !opener.closest('[inert]')) {
      try { opener.focus(); } catch (_) {}
    } else {
      const heading = document.getElementById('activeTaskTitle');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        try { heading.focus(); } catch (_) {}
      }
    }
  }
};

// 2. MODAL STACK MANAGER
window.ModalStack = {
  stack: [],
  open(id, options = {}) {
    if (window.DropdownRegistry) window.DropdownRegistry.close();
    // Support options object as primary contract, with positional argument fallback for safety
    const opts = (typeof options === 'object' && options !== null && !(options instanceof HTMLElement))
      ? options
      : { modalEl: options, openerEl: arguments[2], closeFn: arguments[3], isDirtyFn: arguments[4] };

    const el = opts.modalEl || opts.el || document.getElementById(id);
    if (!el || !document.body.contains(el)) return;
    this.cleanStaleEntries();

    const opener = opts.openerEl || document.activeElement;
    const entry = {
      id,
      el,
      openerEl: opener,
      closeFn: opts.closeFn || (() => el.classList.add('hidden')),
      isDirtyFn: opts.isDirtyFn,
      isClosing: false,
      isPermanentOverlay: el.hasAttribute('data-permanent-overlay') || el.classList.contains('permanent-overlay')
    };

    const existingIdx = this.stack.findIndex(m => m.id === id);
    if (existingIdx !== -1) {
      this.stack[existingIdx] = entry;
    } else {
      this.stack.push(entry);
    }

    this.updateBackgroundInertState();
    this.setupFocusTrap(el);
  },
  cleanStaleEntries() {
    const prevCount = this.stack.length;
    this.stack = this.stack.filter(m => m.el && document.body.contains(m.el) && !m.el.classList?.contains('hidden'));
    if (this.stack.length !== prevCount) {
      this.updateBackgroundInertState();
    }
  },
  async close(id) {
    const idx = this.stack.findIndex(m => m.id === id);
    if (idx === -1) return false;
    const modal = this.stack[idx];
    if (modal.isClosing) return true;
    modal.isClosing = true;

    if (modal.isDirtyFn && (await modal.isDirtyFn())) {
      if (!confirm('DISCARD UNSAVED CHANGES?')) {
        modal.isClosing = false;
        return true;
      }
    }

    this.stack.splice(idx, 1);
    this.updateBackgroundInertState();
    if (typeof modal.closeFn === 'function') {
      await modal.closeFn();
    }
    this.restoreFocus(modal.openerEl);
    return true;
  },
  async popAndClose() {
    this.cleanStaleEntries();
    if (this.stack.length === 0) return false;
    const top = this.stack[this.stack.length - 1];
    return await this.close(top.id);
  },
  reset(isForcedNavigation = false) {
    const entriesToClose = [...this.stack].reverse();
    this.stack = [];
    this.updateBackgroundInertState();

    entriesToClose.forEach(modal => {
      if (modal.isClosing) return;
      modal.isClosing = true;
      try {
        if (modal.closeFn) {
          modal.closeFn();
        } else if (modal.el && document.body.contains(modal.el)) {
          if (modal.isPermanentOverlay) {
            modal.el.classList.add('hidden');
          } else {
            modal.el.remove();
          }
        }
      } catch (_) { /* safe teardown */ }
    });
  },
  updateBackgroundInertState() {
    const workspaceContent = document.getElementById('workspaceContent');
    if (this.stack.length > 0) {
      const top = this.stack[this.stack.length - 1];
      this.stack.forEach(m => {
        if (m.el) m.el.inert = (m.id !== top.id);
      });
      if (workspaceContent) workspaceContent.inert = true;
    } else {
      this.stack.forEach(m => { if (m.el) m.el.inert = false; });
      if (workspaceContent) workspaceContent.inert = false;
    }
  },
  setupFocusTrap(modalEl) {
    if (modalEl._hasFocusTrap) return;
    modalEl._hasFocusTrap = true;
    modalEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const focusables = Array.from(modalEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter(el => !el.disabled && el.offsetWidth > 0 && !el.closest('[inert]'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  },
  restoreFocus(opener) {
    DropdownRegistry.restoreFocus(opener);
  }
};

// 3. EDITOR SUBVIEW STACK
window.EditorStack = {
  activeEditor: null,
  register(id, options = {}) {
    const initial = options.initialSnapshot || (options.getNormalizedSnapshot ? options.getNormalizedSnapshot() : null);
    this.activeEditor = {
      id,
      cancelFn: options.cancelFn,
      getNormalizedSnapshot: options.getNormalizedSnapshot,
      initialSnapshot: JSON.parse(JSON.stringify(initial || {})),
      saveFn: options.saveFn,
      isAutosaving: false
    };
  },
  updateInitialSnapshot(newSnapshot) {
    if (this.activeEditor) {
      this.activeEditor.initialSnapshot = JSON.parse(JSON.stringify(newSnapshot || {}));
    }
  },
  setAutosaving(isSaving) {
    if (this.activeEditor) {
      this.activeEditor.isAutosaving = isSaving;
    }
  },
  isCurrentEditorDirty() {
    if (!this.activeEditor) return false;
    if (this.activeEditor.isAutosaving) return true;
    if (!this.activeEditor.getNormalizedSnapshot) return false;
    const current = this.activeEditor.getNormalizedSnapshot();
    return JSON.stringify(current) !== JSON.stringify(this.activeEditor.initialSnapshot);
  },
  async popAndCancel() {
    if (!this.activeEditor) return false;
    const ed = this.activeEditor;
    if (this.isCurrentEditorDirty()) {
      if (!confirm('DISCARD UNSAVED CHANGES?')) {
        return true;
      }
    }
    this.activeEditor = null;
    if (typeof ed.cancelFn === 'function') {
      await ed.cancelFn();
    }
    return true;
  },
  reset() {
    this.activeEditor = null;
  }
};

// 4. UNIFIED NAVIGATION ROUTER
async function requestNavigation(key, isWarpReturn = false) {
  if (window.EditorStack && window.EditorStack.isCurrentEditorDirty()) {
    if (!confirm('DISCARD UNSAVED CHANGES?')) {
      return false;
    }
    window.EditorStack.reset();
  }

  if (window.DropdownRegistry) window.DropdownRegistry.close();
  if (window.ModalStack && window.ModalStack.stack.length > 0) {
    window.ModalStack.reset();
  }

  return selectTask(key, isWarpReturn);
}

function popTaskStack() {
  const overlay = document.getElementById('workspaceOverlay');

  if (state.taskStack.length > 0) {
    const previousView = state.taskStack.pop();
    selectTask(previousView.taskKey, true, previousView);
  } else {
    if (state.activeTask) {
      captureTaskState(state.activeTask);
    }
    overlay.classList.add('hidden');
    state.activeTask = null;
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    requestAnimationFrame(() => {
      const dashboardTarget = document.querySelector('.dashboard .dash-card:not(.hidden)');
      if (dashboardTarget && typeof dashboardTarget.focus === 'function') dashboardTarget.focus();
    });
  }
}

async function handleGlobalEscape(e) {
  // Synchronous preventDefault/stopPropagation BEFORE any await!
  if (e) {
    if (e.repeat) return;
    e.preventDefault();
    e.stopPropagation();
  }

  // Tier 1: Dropdown Registry
  if (window.DropdownRegistry && window.DropdownRegistry.close()) {
    return;
  }

  // Tier 2: Modal Stack Manager
  if (window.ModalStack && (await window.ModalStack.popAndClose())) {
    return;
  }

  // Tier 3: Editor Subview Stack
  if (window.EditorStack && (await window.EditorStack.popAndCancel())) {
    return;
  }

  // Tier 3.5: Domain Subview Navigation (Appointments Day View / Staff / Vendor subviews)
  if (state.activeTask === 'A' && typeof handleAppointmentsEscapeNav === 'function' && handleAppointmentsEscapeNav()) {
    return;
  }
  if (state.activeTask === 'M' && typeof handleStaffEscapeNav === 'function' && handleStaffEscapeNav()) {
    return;
  }

  // Tier 4: Task Memory Stack
  const overlay = document.getElementById('workspaceOverlay');
  const isOverlayOpen = overlay && !overlay.classList.contains('hidden');

  if (state.taskStack.length > 0) {
    popTaskStack();
    return;
  }

  // Tier 5: Workspace Overlay -> Dashboard
  if (isOverlayOpen) {
    if (state.activeTask) captureTaskState(state.activeTask);
    overlay.classList.add('hidden');
    state.activeTask = null;
    if (window.WorkspaceLifecycle) window.WorkspaceLifecycle.unmountActive();
    return;
  }

  // Tier 6: Main Dashboard Layer -> Security Lock
  logoutEmployee();
}

function registerAllCommandContracts() {
  if (!window.CommandRegistry) return;

  // 1. GLOBAL / SHELL COMMANDS
  CommandRegistry.register({
    id: 'global.help',
    label: 'CONTEXT HELP',
    permission: null,
    workspace: 'global',
    layer: 'global',
    hotkey: 'ALT+?',
    keycapVariant: 'nav',
    execute: () => toggleHelpModal(),
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'global.color_key',
    label: 'COLOR KEY',
    permission: null,
    workspace: 'global',
    layer: 'global',
    hotkey: 'ALT+K',
    keycapVariant: 'nav',
    execute: () => toggleWorkspaceLegend(),
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'global.escape',
    label: 'BACK / RETURN / CLOSE',
    permission: null,
    workspace: 'global',
    layer: 'global',
    hotkey: 'ESC',
    keycapVariant: 'nav',
    execute: () => handleGlobalEscape(),
    feedback: { success: null }
  });

  // 2. WORKSPACE WARP COMMANDS
  const warpWorkspaces = [
    { id: 'dash.warp_orders', key: 'SHIFT+O', task: 'O', label: 'REPAIR ORDERS BOARD', perm: 'repair_orders' },
    { id: 'dash.warp_appts', key: 'SHIFT+A', task: 'A', label: 'APPOINTMENTS SCHEDULE', perm: 'appointments' },
    { id: 'dash.warp_cust', key: 'SHIFT+C', task: 'C', label: 'CUSTOMER DIRECTORY', perm: 'customers' },
    { id: 'dash.warp_veh', key: 'SHIFT+V', task: 'V', label: 'VEHICLE LOOKUP', perm: 'customers' },
    { id: 'dash.warp_parts', key: 'SHIFT+P', task: 'P', label: 'PARTS & INVENTORY', perm: 'parts' },
    { id: 'dash.warp_settings', key: 'SHIFT+S', task: 'S', label: 'SHOP SETTINGS', perm: 'shop_setup' },
    { id: 'dash.warp_vendors', key: 'SHIFT+K', task: 'K', label: 'VENDOR DIRECTORY', perm: 'shop_setup' },
    { id: 'dash.warp_jobcodes', key: 'SHIFT+J', task: 'J', label: 'JOB OP CODE CATALOG', perm: 'shop_setup' },
    { id: 'dash.warp_staff', key: 'SHIFT+M', task: 'M', label: 'STAFF & ACCESS', perm: 'staff_admin' }
  ];

  warpWorkspaces.forEach(w => {
    CommandRegistry.register({
      id: w.id,
      label: w.label,
      permission: w.perm,
      workspace: 'global',
      layer: 'global',
      hotkey: w.key,
      keycapVariant: 'warp',
      execute: () => requestNavigation(w.task),
      feedback: { success: `Navigating to ${w.label}` }
    });
  });

  CommandRegistry.register({
    id: 'appt.add_line', label: 'ADD APPOINTMENT LINE', permission: 'appointments',
    workspace: 'A', layer: 'editor', hotkey: 'ALT+A', keycapVariant: 'command',
    isEnabled: () => Boolean(document.getElementById('apptLinesWorkspaceBody')),
    execute: () => addApptLine()
  });
  CommandRegistry.register({
    id: 'appt.service_history', label: 'APPOINTMENT SERVICE HISTORY', permission: 'appointments',
    workspace: 'A', layer: 'editor', hotkey: 'ALT+H', keycapVariant: 'command',
    execute: () => openApptServiceHistoryModal()
  });

  // 3. REPAIR ORDER WORKSPACE COMMANDS
  CommandRegistry.register({
    id: 'ro.create_new',
    label: 'NEW REPAIR ORDER',
    permission: 'repair_orders',
    workspace: 'O',
    layer: 'workspace',
    hotkey: 'ALT+N',
    keycapVariant: 'inverse',
    isEnabled: () => typeof createNewRoSession === 'function',
    execute: () => createNewRoSession(),
    feedback: { success: 'Initiating new RO write-up' }
  });

  CommandRegistry.register({
    id: 'ro.add_line',
    label: 'ADD WORK LINE',
    permission: 'repair_orders',
    workspace: 'O',
    layer: 'editor',
    hotkey: 'ALT+A',
    keycapVariant: 'command',
    isEnabled: () => Boolean(document.getElementById('roLinesWorkspaceBody')) && !document.getElementById('roStatusSelect')?.disabled && typeof addNewRoLine === 'function',
    execute: () => addNewRoLine(),
    feedback: { success: 'Work line added' }
  });

  CommandRegistry.register({
    id: 'ro.add_part',
    label: 'ADD PART FROM INVENTORY',
    permission: 'repair_orders',
    workspace: 'O',
    layer: 'editor',
    hotkey: 'ALT+P',
    keycapVariant: 'command',
    isEnabled: () => Boolean(document.getElementById('roLinesWorkspaceBody')) && !document.getElementById('roStatusSelect')?.disabled && typeof openRoAddPartModal === 'function',
    execute: () => openRoAddPartModal(),
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'ro.save',
    label: 'SAVE REPAIR ORDER',
    permission: 'repair_orders',
    workspace: 'O',
    layer: 'editor',
    hotkey: 'ALT+S',
    keycapVariant: 'command',
    isEnabled: () => Boolean(document.getElementById('roLinesWorkspaceBody')) && !document.getElementById('roStatusSelect')?.disabled && typeof saveRepairOrder === 'function',
    execute: () => saveRepairOrder(),
    feedback: { success: 'Repair Order saved' }
  });

  CommandRegistry.register({
    id: 'ro.invoice',
    label: 'INVOICE & CLOSE RO',
    permission: 'repair_orders',
    workspace: 'O',
    layer: 'editor',
    hotkey: 'ALT+I',
    keycapVariant: 'command',
    isEnabled: () => Boolean(document.getElementById('roLinesWorkspaceBody')) && !document.getElementById('roStatusSelect')?.disabled && typeof invoiceRepairOrder === 'function',
    execute: () => invoiceRepairOrder(),
    feedback: { success: 'Repair Order invoiced' }
  });

  CommandRegistry.register({
    id: 'ro.back', label: 'BACK TO BOARD', permission: 'repair_orders', workspace: 'O', layer: 'editor',
    execute: () => escBackToBoard()
  });
  CommandRegistry.register({
    id: 'ro.generate', label: 'GENERATE RO', permission: 'repair_orders', workspace: 'O', layer: 'editor', hotkey: 'ALT+G',
    isEnabled: () => Boolean(document.getElementById('btnGenerateRo')) && !document.getElementById('roStatusSelect')?.disabled,
    execute: () => generateRoFromWriteup()
  });

  // 4. APPOINTMENT WORKSPACE COMMANDS
  CommandRegistry.register({
    id: 'vehicles.add_vehicle',
    label: 'ADD VEHICLE / EQUIPMENT',
    permission: 'customers',
    workspace: 'V',
    layer: 'workspace',
    hotkey: 'ALT+A',
    keycapVariant: 'inverse',
    isEnabled: () => typeof openAddVehicle === 'function',
    execute: () => openAddVehicle(),
    feedback: { success: 'Opening Add Vehicle / Equipment modal' }
  });

  CommandRegistry.register({
    id: 'appt.book_new',
    label: 'BOOK APPOINTMENT',
    permission: 'appointments',
    workspace: 'A',
    layer: 'workspace',
    hotkey: 'ALT+A',
    keycapVariant: 'inverse',
    isEnabled: () => typeof openNewApptDialog === 'function',
    execute: () => openNewApptDialog(),
    feedback: { success: 'Opening appointment write-up' }
  });

  CommandRegistry.register({
    id: 'appt.convert_ro',
    label: 'CONVERT TO RO',
    permission: 'appointments',
    workspace: 'A',
    layer: 'workspace',
    hotkey: 'ALT+O',
    keycapVariant: 'command',
    isEnabled: () => typeof handleApptConvertKey === 'function',
    execute: () => handleApptConvertKey(),
    feedback: { success: 'Converting appointment to Repair Order' }
  });

  CommandRegistry.register({
    id: 'appt.confirm_save',
    label: 'CONFIRM / SAVE APPOINTMENT',
    permission: 'appointments',
    workspace: 'A',
    layer: 'editor',
    hotkey: 'ALT+C',
    keycapVariant: 'command',
    isEnabled: () => typeof confirmAppointmentFromEditor === 'function',
    execute: () => confirmAppointmentFromEditor(),
    feedback: { success: 'Appointment saved' }
  });

  // 5. PARTS WORKSPACE COMMANDS
  CommandRegistry.register({
    id: 'parts.add_stock',
    label: 'ADD STOCK PART',
    permission: 'parts',
    workspace: 'P',
    layer: 'workspace',
    hotkey: 'ALT+A',
    keycapVariant: 'command',
    isEnabled: () => typeof openNewStockPartModal === 'function',
    execute: () => openNewStockPartModal(),
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'parts.add_passthrough',
    label: 'ADD PASS-THROUGH PART',
    permission: 'parts',
    workspace: 'P',
    layer: 'workspace',
    hotkey: 'ALT+P',
    keycapVariant: 'command',
    isEnabled: () => typeof openNewPassThroughPartModal === 'function',
    execute: () => openNewPassThroughPartModal(),
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'parts.counter_sale',
    label: 'INVOICE COUNTER SALE',
    permission: 'parts',
    workspace: 'P',
    layer: 'workspace',
    hotkey: 'ALT+I',
    keycapVariant: 'command',
    isEnabled: () => typeof openPartsInvoiceCounterSaleModal === 'function',
    execute: ({ element } = {}) => openPartsInvoiceCounterSaleModal(element?.dataset.partId ? Number(element.dataset.partId) : null),
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'parts.apply_ro',
    label: 'APPLY TO RO',
    permission: 'parts',
    workspace: 'P',
    layer: 'workspace',
    hotkey: 'ALT+O',
    keycapVariant: 'command',
    isEnabled: () => typeof openPartsApplyToRoModal === 'function',
    execute: ({ element } = {}) => openPartsApplyToRoModal(element?.dataset.partId ? Number(element.dataset.partId) : null),
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'parts.receive_stock',
    label: 'RECEIVE STOCK',
    permission: 'parts',
    workspace: 'P',
    layer: 'workspace',
    hotkey: 'ALT+R',
    keycapVariant: 'command',
    isEnabled: () => typeof openQuickReceiveModal === 'function',
    execute: () => openQuickReceiveModal(),
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'parts.breakout',
    label: 'BREAKOUT',
    permission: 'parts',
    workspace: 'P',
    layer: 'workspace',
    hotkey: 'ALT+B',
    keycapVariant: 'command',
    isEnabled: () => Boolean(window.currentViewingPartId) && typeof openBulkBreakoutModal === 'function',
    execute: () => window.currentViewingPartId ? openBulkBreakoutModal(window.currentViewingPartId) : false,
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'parts.edit_details',
    label: 'EDIT PART DETAILS',
    permission: 'parts',
    workspace: 'P',
    layer: 'workspace',
    hotkey: 'ALT+E',
    keycapVariant: 'command',
    isEnabled: () => Boolean(window.currentViewingPartId) && typeof openEditPartDetails === 'function',
    execute: () => window.currentViewingPartId ? openEditPartDetails(window.currentViewingPartId) : false,
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'parts.back', label: 'BACK TO PARTS', permission: 'parts', workspace: 'P', layer: 'workspace',
    execute: () => searchParts('')
  });
  CommandRegistry.register({
    id: 'parts.adjust_qty', label: 'ADJUST QTY', permission: 'parts', workspace: 'P', layer: 'workspace', hotkey: 'ALT+Q',
    isEnabled: () => Boolean(window.currentViewingPartId),
    execute: () => openPartsAdjustStockModal(window.currentViewingPartId)
  });

  // 6. CUSTOMER & VEHICLE COMMANDS
  CommandRegistry.register({
    id: 'cust.create_new',
    label: 'NEW CUSTOMER',
    permission: 'customers',
    workspace: 'C',
    layer: 'workspace',
    hotkey: 'ALT+A',
    keycapVariant: 'inverse',
    isEnabled: () => typeof openNewCustomerForm === 'function',
    execute: () => openNewCustomerForm(),
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'cust.edit',
    label: 'EDIT CUSTOMER',
    permission: 'customers',
    workspace: 'C',
    layer: 'workspace',
    hotkey: 'ALT+E',
    keycapVariant: 'inverse',
    isEnabled: () => typeof editCustomerCard === 'function',
    execute: () => editCustomerCard(),
    feedback: { success: null }
  });

  CommandRegistry.register({
    id: 'cust.save',
    label: 'SAVE PROFILE',
    permission: 'customers',
    workspace: 'C',
    layer: 'editor',
    hotkey: 'ALT+S',
    keycapVariant: 'command',
    isEnabled: () => typeof saveCustomerCard === 'function',
    execute: () => saveCustomerCard(),
    feedback: { success: 'Customer profile saved' }
  });

  // Appointments Extra Navigation & Views
  CommandRegistry.register({
    id: 'appt.view_day', label: 'DAY VIEW', permission: 'appointments', workspace: 'A', layer: 'workspace', hotkey: 'ALT+D', keycapVariant: 'command',
    isEnabled: () => typeof setApptViewMode === 'function', execute: () => setApptViewMode('day')
  });
  CommandRegistry.register({
    id: 'appt.view_week', label: 'WEEK VIEW', permission: 'appointments', workspace: 'A', layer: 'workspace', hotkey: 'ALT+W', keycapVariant: 'command',
    isEnabled: () => typeof setApptViewMode === 'function', execute: () => setApptViewMode('week')
  });
  CommandRegistry.register({
    id: 'appt.view_month', label: 'MONTH VIEW', permission: 'appointments', workspace: 'A', layer: 'workspace', hotkey: 'ALT+M', keycapVariant: 'command',
    isEnabled: () => typeof setApptViewMode === 'function', execute: () => setApptViewMode('month')
  });
  CommandRegistry.register({
    id: 'appt.prev_date', label: 'PREVIOUS DATE', permission: 'appointments', workspace: 'A', layer: 'workspace', hotkey: 'ALT+B', keycapVariant: 'command',
    isEnabled: () => typeof shiftApptDate === 'function', execute: () => shiftApptDate(-1)
  });
  CommandRegistry.register({
    id: 'appt.next_date', label: 'NEXT DATE', permission: 'appointments', workspace: 'A', layer: 'workspace', hotkey: 'ALT+F', keycapVariant: 'command',
    isEnabled: () => typeof shiftApptDate === 'function', execute: () => shiftApptDate(1)
  });
  CommandRegistry.register({
    id: 'appt.today_date', label: 'TODAY', permission: 'appointments', workspace: 'A', layer: 'workspace', hotkey: 'ALT+T', keycapVariant: 'command',
    isEnabled: () => typeof setApptDateToToday === 'function', execute: () => setApptDateToToday()
  });

  // Repair Order Service History
  CommandRegistry.register({
    id: 'ro.service_history', label: 'SERVICE HISTORY', permission: 'repair_orders', workspace: 'O', layer: 'global', hotkey: 'ALT+H', keycapVariant: 'command',
    isEnabled: () => typeof openRoServiceHistoryModal === 'function', execute: () => openRoServiceHistoryModal()
  });

  // Vendor & Job Code Commands
  CommandRegistry.register({
    id: 'setup.add_vendor', label: 'ADD VENDOR', permission: 'shop_setup', workspace: 'K', layer: 'workspace', hotkey: 'ALT+A', keycapVariant: 'command',
    isEnabled: () => typeof openVendorWorkspaceEditor === 'function', execute: () => openVendorWorkspaceEditor()
  });

  CommandRegistry.register({
    id: 'setup.add_jobcode', label: 'ADD JOB CODE', permission: 'shop_setup', workspace: 'J', layer: 'workspace', hotkey: 'ALT+A', keycapVariant: 'command',
    isEnabled: () => typeof openCustomJobCodeForm === 'function', execute: () => openCustomJobCodeForm()
  });

  CommandRegistry.register({
    id: 'setup.save_draft', label: 'SAVE SETUP DRAFT', permission: 'shop_setup', workspace: 'B', layer: 'workspace', hotkey: 'ALT+S', keycapVariant: 'command',
    isEnabled: () => typeof saveManagementSetup === 'function', execute: () => saveManagementSetup('SAVE_DRAFT')
  });

  CommandRegistry.register({
    id: 'setup.publish', label: 'PUBLISH SETUP', permission: 'shop_setup', workspace: 'B', layer: 'workspace', hotkey: 'ALT+P', keycapVariant: 'inverse',
    isEnabled: () => typeof saveManagementSetup === 'function', execute: () => saveManagementSetup('PUBLISH')
  });
}

document.addEventListener('DOMContentLoaded', () => {
  registerAllCommandContracts();
});

function initHotkeys() {
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'employeePin' || e.target.id === 'empPinInput') return;
    if (e.defaultPrevented) return;

    const isFormControl = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(e.target.tagName) || e.target.isContentEditable;
    const isModalOpen = window.ModalStack && window.ModalStack.stack.length > 0;
    const isEditorDirty = window.EditorStack && window.EditorStack.isCurrentEditorDirty();

    const key = e.key.toUpperCase();
    const combo = `${e.altKey ? 'ALT+' : ''}${e.shiftKey ? 'SHIFT+' : ''}${key}`;

    if (e.key === 'Escape') {
      handleGlobalEscape(e);
      return;
    }

    if (combo === 'ALT+K' && !isFormControl && !isModalOpen && state.activeTask) {
      e.preventDefault();
      toggleWorkspaceLegend();
      return;
    }

    if (combo === 'ALT+?' && !isFormControl && !isModalOpen) {
      e.preventDefault();
      toggleHelpModal();
      return;
    }

    // Custom Interactive Element Keyboard Activation (Enter/Space on <tr tabindex="0">, etc.)
    if ((e.key === 'Enter' || e.key === ' ') && !isFormControl) {
      const target = e.target;
      const isNativeControl = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
      if (!isNativeControl && (target.getAttribute('tabindex') === '0' || target.getAttribute('role') === 'button')) {
        const nestedControl = e.target.closest('button, a, input, select, textarea');
        if (!nestedControl || nestedControl === target) {
          e.preventDefault();
          target.click();
          return;
        }
      }
    }

    // 4. GLOBAL WARP JUMP: Shift + Key (O, A, C, V, P, S, B, H, K, F, J, M)
    // Suppressed if inside form control, open modal, or dirty editor (unless confirmed)
    if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !isFormControl && !isModalOpen && ['O', 'A', 'C', 'V', 'P', 'S', 'B', 'H', 'K', 'F', 'J', 'M'].includes(key)) {
      e.preventDefault();
      requestNavigation(key);
      return;
    }

    const overlay = document.getElementById('workspaceOverlay');
    const isOverlayOpen = overlay && !overlay.classList.contains('hidden');

    if (isOverlayOpen && state.activeTask && !isModalOpen && (!isFormControl || e.altKey)) {
      if (state.activeTask === 'A' && !isFormControl && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const dirMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
        if (typeof handleApptArrowNav === 'function') {
          handleApptArrowNav(dirMap[e.key]);
        }
        return;
      }

      const isEditor = (state.activeTask === 'O' && document.getElementById('roLinesWorkspaceBody')) || (state.activeTask === 'A' && document.getElementById('apptFullWriteupForm'));
      const activeLayer = isEditor ? 'editor' : 'workspace';
      if (window.CommandRegistry && window.CommandRegistry.handleHotkey(combo, state.activeTask, activeLayer)) {
        e.preventDefault();
        return;
      }

      if (/^[0-9]$/.test(e.key) && !isFormControl) {
        const num = e.key === '0' ? 10 : parseInt(e.key, 10);
        if (state.activeTask === 'O') {
          expandRoByNumber(num);
        } else if (state.activeTask === 'V') {
          openVehicleByNumber(num);
        } else if (state.activeTask === 'C') {
          openCustomerByNumber(num);
        } else if (state.activeTask === 'P') {
          const part = partsSearchResults[num - 1];
          if (part) openPartsDetail(part.id);
        } else if (state.activeTask === 'M') {
          openEmployeeAccessByNumber(num);
        } else if (state.activeTask === 'K') {
          if (vendorState && vendorState.vendors && vendorState.vendors[num - 1]) {
            openVendorWorkspaceEditor(vendorState.vendors[num - 1].id);
          }
        }
        return;
      }
    }

    if (isFormControl || isModalOpen || isEditorDirty) return;

    if (state.activeTask === 'S' && e.altKey && ['B', 'J', 'M', 'K'].includes(key)) {
      e.preventDefault();
      requestNavigation(key);
      return;
    }

  });
}

function renderSettingsContent() {
  const settings = [];
  if (hasPermission('shop_setup')) {
    settings.push(`
      <button type="button" class="settings-card" data-action="app.settings" data-task="B">
        <span class="settings-key">ALT+B</span>
        <strong>CANADIAN BUSINESS &amp; SHOP MANAGEMENT</strong>
        <span>CRA business number, tax registrations, base labor rates, shop fees, and customer types.</span>
      </button>`);
    settings.push(`
      <button type="button" class="settings-card" data-action="app.settings" data-task="J">
        <span class="settings-key">ALT+J</span>
        <strong>JOB OP CODES</strong>
        <span>Maintain shop operation codes, descriptions, default hours, and parts allowances.</span>
      </button>`);
  }
  if (hasPermission('staff_admin')) {
    settings.push(`
      <button type="button" class="settings-card" data-action="app.settings" data-task="M">
        <span class="settings-key">ALT+M</span>
        <strong>STAFF &amp; ACCESS</strong>
        <span>Add employees, reset PINs, assign positions, and manage access exceptions.</span>
      </button>`);
  }
  return `
    <div class="settings-shell">
      <div class="settings-intro">
        <h3>SHOP SETTINGS</h3>
        <p>Administrative tools are kept separate from daily service-counter work.</p>
      </div>
      <div class="settings-grid">${settings.join('')}</div>
    </div>`;
}

let jobCatalogActiveIndex = 0;
let jobCatalogRenderTimer = null;

function queueJobCatalogRender(value) {
  jobCatalogActiveIndex = 0;
  clearTimeout(jobCatalogRenderTimer);
  jobCatalogRenderTimer = setTimeout(() => {
    jobCatalogRenderTimer = null;
    renderJobCatalogResults(value);
  }, 80);
}

function renderJobSearchContent() {
  const canManageCodes = hasPermission('shop_setup');
  return `
    <div style="font-family:var(--font-mono); display:flex; flex-direction:column; gap:14px;">
      <div class="ui-command-panel">
        <div><strong class="ui-copy">JOB OP CODE CATALOG</strong><div style="font-size:10px; color:var(--text-dim); margin-top:3px;">HOUSE SCHEMA: GROUP–SYSTEM–ACTION · DEFAULT HOURS ARE EDITABLE SHOP ESTIMATES</div></div>
        ${canManageCodes ? '<button class="primary-action-btn" data-action="app.openCustomJobCodeForm">+ ADD CUSTOM CODE</button>' : ''}
      </div>
      <input id="jobSearchInput" type="text" placeholder="Type Op Code, Description, or Category to filter..." style="width:100%; padding:8px 12px; font-size:12px;" data-input-action="app.queueJobCatalogRender" data-keydown-action="app.handleJobCatalogKeydown">
      <div id="jobCatalogTableContainer">
        ${renderJobCatalogResults('')}
      </div>
    </div>
  `;
}

function renderJobCatalogResults(query = '') {
  const container = document.getElementById('jobCatalogTableContainer');
  const q = query.trim().toUpperCase();
  const filtered = getJobOpcodeCatalog().filter(item =>
    !q || item.code.includes(q) || item.concern.includes(q) || item.category.includes(q)
  );
  jobCatalogActiveIndex = Math.min(jobCatalogActiveIndex, Math.max(0, filtered.length - 1));

  const html = `
    <table class="ui-table">
      <thead>
        <tr class="ui-table-head">
          <th style="padding:10px; width:100px;">OP CODE</th>
          <th style="width:140px;">CATEGORY</th>
          <th>VERBATIM DESCRIPTION</th>
          <th style="text-align:right; width:80px;">HOURS</th>
          <th style="text-align:right; width:90px;">PARTS ($)</th>
          <th style="text-align:right; width:90px;">LABOR ($)</th>
          <th style="text-align:right; width:100px; padding-right:12px;">TOTAL ($)</th>
          <th style="width:110px;">SOURCE</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map((item, index) => {
          const isCustomAndSetup = item.custom && hasPermission('shop_setup');
          const sourceActionHtml = isCustomAndSetup
            ? `SHOP · <button type="button" class="action-link" data-action="app.edit-job" data-action-param="${escapeHtml(item.id)}">EDIT</button>`
            : `${item.custom ? 'SHOP' : 'TAKTRO'} · <button type="button" class="action-link" data-action="app.openStandardJobCodeDetails" data-action-param="${escapeHtml(item.code)}">VIEW</button>`;

          return `
            <tr class="job-catalog-row ${index === jobCatalogActiveIndex ? 'is-selected' : ''}" data-job-index="${index}" data-custom-id="${item.custom ? item.id : ''}" data-action="app.job-row" data-code="${escapeHtml(item.code)}">
              <td style="padding:10px 12px;">${UIComponent.Keycap(item.code, "index", {style: "background:var(--surface-raised); color:var(--text-main); border:1px solid var(--border-bright); font-weight:700; padding:2px 6px; border-radius:3px;"})}</td>
              <td style="color:var(--text-muted); font-size:11px;">${escapeHtml(item.category)}</td>
              <td style="color:var(--text-main); font-weight:600;">${escapeHtml(item.concern)}</td>
              <td style="text-align:right; font-weight:600; color:var(--text-muted);">${item.hrs}</td>
              <td style="text-align:right; color:var(--text-muted);">$${item.parts}</td>
              <td style="text-align:right; color:var(--text-muted);">$${(parseFloat(item.hrs) * 150).toFixed(2)}</td>
              <td style="text-align:right; padding-right:12px; font-weight:700; color:var(--accent-emerald);">$${(parseFloat(item.parts) + (parseFloat(item.hrs) * 150)).toFixed(2)}</td>
              <td class="ui-label-dim">${sourceActionHtml}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  if (container) container.innerHTML = html;
  return html;
}

function selectJobCatalogRow(index) {
  const rows = [...document.querySelectorAll('.job-catalog-row')];
  if (!rows.length) return;
  jobCatalogActiveIndex = Math.max(0, Math.min(rows.length - 1, index));
  rows.forEach((row, rowIndex) => row.classList.toggle('is-selected', rowIndex === jobCatalogActiveIndex));
  rows[jobCatalogActiveIndex]?.scrollIntoView({ block: 'nearest' });
}

function handleJobCatalogKeydown(event) {
  const rows = [...document.querySelectorAll('.job-catalog-row')];
  if (!rows.length) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    selectJobCatalogRow(jobCatalogActiveIndex + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    selectJobCatalogRow(jobCatalogActiveIndex - 1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    selectJobCatalogRow(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    selectJobCatalogRow(rows.length - 1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const row = rows[jobCatalogActiveIndex];
    if (!row) return;
    const customId = Number(row.dataset.customId || 0);
    if (customId && hasPermission('shop_setup')) {
      openCustomJobCodeForm(customId);
    } else {
      const code = row.querySelector('kbd')?.textContent?.trim();
      if (code) openStandardJobCodeDetails(code);
    }
  }
}

function openCustomJobCodeForm(jobId = 0) {
  const container = document.getElementById('jobCatalogTableContainer');
  if (!container) return;
  const existing = customJobCodes.find(item => item.id === jobId);
  container.innerHTML = `
    <form data-submit-action="app.saveCustomJobCode" data-submit-hotkey="ALT+S" style="background:var(--surface-panel); border:1px solid var(--border-mid); padding:16px; display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      <input id="customJobId" type="hidden" value="${existing?.id || ''}">
      <label class="ui-label-muted">OP CODE<input id="customJobCode" required maxlength="24" value="${escapeHtml(existing?.code || '')}" placeholder="e.g. FL-WASH-SERV" class="ui-block-mt-5"></label>
      <label class="ui-label-muted">CATEGORY<input id="customJobCategory" required maxlength="40" value="${escapeHtml(existing?.category || '')}" placeholder="e.g. FLEET ACCESSORY" class="ui-block-mt-5"></label>
      <label style="font-size:10px; color:var(--text-muted); grid-column:1 / -1;">CUSTOMER-FACING DESCRIPTION<input id="customJobDescription" required maxlength="120" value="${escapeHtml(existing?.concern || '')}" class="ui-block-mt-5"></label>
      <label class="ui-label-muted">DEFAULT HOURS<input id="customJobHours" required type="number" min="0" step="0.10" value="${existing?.hrs || '1.00'}" class="ui-block-mt-5"></label>
      <label class="ui-label-muted">DEFAULT PARTS $<input id="customJobParts" required type="number" min="0" step="0.01" value="${existing?.parts || '0.00'}" class="ui-block-mt-5"></label>
      ${existing ? `<div style="grid-column:1 / -1; font-size:10px; color:var(--text-dim);">LAST MODIFIED BY ${escapeHtml(existing.modifiedBy)} · ${escapeHtml(existing.updatedAt || '')}</div>` : ''}
      <div style="grid-column:1 / -1; display:flex; justify-content:flex-end; gap:8px;">${existing ? '<button type="button" class="secondary-action-btn action-danger" data-action="app.deactivateCustomJobCode">DEACTIVATE</button>' : ''}<button type="button" class="secondary-action-btn" data-action="app.renderJobCatalogResults">${UIComponent.Keycap("ESC", "command")} CANCEL</button><button class="primary-action-btn">${UIComponent.Keycap("S", "inverse", {className: "kbd-invert"})} SAVE CUSTOM CODE</button></div>
    </form>`;
  document.getElementById('customJobCode')?.focus();
}

function openStandardJobCodeDetails(code) {
  const container = document.getElementById('jobCatalogTableContainer');
  if (!container) return;
  const item = getJobOpcodeCatalog().find(x => x.code === code);
  if (!item) return;

  const laborVal = parseFloat(item.hrs) * 150;
  const partsVal = parseFloat(item.parts);
  const totalVal = laborVal + partsVal;

  container.innerHTML = `
    <div style="background:var(--surface-panel); border:1px solid var(--border-mid); padding:16px; font-family:var(--font-mono); display:flex; flex-direction:column; gap:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-soft); padding-bottom:10px;">
        <span style="font-size:16px; font-weight:800; color:var(--accent-amber);">
          <span style="background:var(--surface-raised); color:var(--text-main); border:1px solid var(--border-bright); font-weight:700; padding:2px 6px; border-radius:3px; margin-right:8px;">${escapeHtml(item.code)}</span>
          JOB OP CODE DETAILS
        </span>
        <span style="background:rgba(var(--accent-steel-rgb), 0.15); color:var(--accent-steel); padding:2px 6px; border-radius:3px; font-size:10px; font-weight:800;">${item.custom ? 'SHOP CUSTOM' : 'TAKTRO STANDARD'}</span>
      </div>
      
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
        <div>
          <span class="ui-label-dim">CATEGORY:</span>
          <div style="color:var(--text-main); font-weight:600; margin-top:4px;">${escapeHtml(item.category)}</div>
        </div>
        <div>
          <span class="ui-label-dim">SOURCE PROVIDER:</span>
          <div style="color:var(--text-main); font-weight:600; margin-top:4px;">${item.custom ? 'LOCAL SHOP DATABASE' : 'SYSTEM BUILT-IN'}</div>
        </div>
      </div>

      <div>
        <span class="ui-label-dim">CUSTOMER-FACING VERBATIM DESCRIPTION:</span>
        <div style="color:var(--text-main); font-weight:600; margin-top:4px; font-size:12px; background:var(--surface-input); padding:8px; border-radius:4px; border:1px solid var(--border-soft); line-height:1.4;">${escapeHtml(item.concern)}</div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:12px; background:var(--surface-input); padding:12px; border-radius:4px; border:1px solid var(--border-mid);">
        <div>
          <span class="ui-label-dim">EST. HOURS:</span>
          <strong style="color:var(--text-main); font-size:14px; display:block; margin-top:4px;">${item.hrs} hrs</strong>
        </div>
        <div>
          <span class="ui-label-dim">EST. LABOR ($150/hr):</span>
          <strong style="color:var(--text-main); font-size:14px; display:block; margin-top:4px;">$${laborVal.toFixed(2)}</strong>
        </div>
        <div>
          <span class="ui-label-dim">EST. PARTS ALLOWANCE:</span>
          <strong style="color:var(--text-muted); font-size:14px; display:block; margin-top:4px;">$${partsVal.toFixed(2)}</strong>
        </div>
        <div>
          <span class="ui-label-dim">TOTAL ESTIMATE:</span>
          <strong style="color:var(--accent-emerald); font-size:16px; font-weight:800; display:block; margin-top:4px;">$${totalVal.toFixed(2)}</strong>
        </div>
      </div>

      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:6px;">
        <button type="button" class="primary-action-btn" data-action="app.renderJobCatalogResults" autofocus>${UIComponent.Keycap("ESC", "inverse", {className: "kbd-invert"})} BACK TO CATALOG</button>
      </div>
    </div>
  `;
}

async function saveCustomJobCode(event) {
  event.preventDefault();
  const code = document.getElementById('customJobCode').value.trim().toUpperCase().replace(/\s+/g, '-');
  const jobId = Number(document.getElementById('customJobId').value) || 0;
  const catalog = getJobOpcodeCatalog();
  if (catalog.some(item => item.code === code && item.id !== jobId)) {
    alert(`OP code ${code} already exists.`);
    return;
  }
  const hours = Math.max(0, Number(document.getElementById('customJobHours').value) || 0);
  const payload = {
    id: jobId,
    code,
    description: document.getElementById('customJobDescription').value.trim().toUpperCase(),
    category: document.getElementById('customJobCategory').value.trim().toUpperCase(),
    default_hours: hours,
    default_parts: Math.max(0, Number(document.getElementById('customJobParts').value) || 0),
    active: true
  };
  try {
    await api('/api/job-codes', { method: 'POST', body: JSON.stringify(payload) });
    await loadCustomJobCodes();
    renderJobCatalogResults(code);
  } catch (err) {
    alert('Custom job code error: ' + err.message);
  }
}

async function deactivateCustomJobCode() {
  const jobId = Number(document.getElementById('customJobId').value) || 0;
  const existing = customJobCodes.find(item => item.id === jobId);
  if (!existing || !confirm(`Deactivate ${existing.code}? Historical RO lines will not be changed.`)) return;
  try {
    await api('/api/job-codes', { method: 'POST', body: JSON.stringify({
      id: existing.id, code: existing.code, description: existing.concern,
      category: existing.category, default_hours: Number(existing.hrs),
      default_parts: Number(existing.parts), active: false
    }) });
    await loadCustomJobCodes();
    renderJobCatalogResults('');
  } catch (err) {
    alert('Custom job code error: ' + err.message);
  }
}

function toggleHelpModal() {
  const overlay = document.getElementById('helpModalOverlay');
  if (!overlay) return;

  const isHidden = overlay.classList.contains('hidden');
  if (isHidden) {
    overlay.classList.remove('hidden');
    renderHelpModal();
  } else {
    overlay.classList.add('hidden');
  }
}

function renderHelpModal() {
  const contentEl = document.getElementById('helpModalContent');
  if (!contentEl) return;

  const contextMap = {
    O: { name: 'REPAIR ORDER WORKSPACE', identity: 'RO', tips: ['Press <strong>N</strong> for a new RO; <strong>1–9</strong> loads a board row', '<strong>Alt+A</strong> adds a work line; <strong>Alt+S</strong> saves', 'Use <strong>C / W / I / G</strong> for Customer, Warranty, Internal, or Goodwill', 'Select parts from inventory so stock reservations remain tied to this RO', 'Confirm the screen identity says <strong>RO</strong> before entering live repair work'] },
    A: { name: 'APPOINTMENTS & SHOP CAPACITY', identity: 'APPT', tips: ['Press <strong>A</strong> to book; arrows move the active yellow row', '<strong>D / W / M</strong> switches Day, Week, or Month', '<strong>B / F / T</strong> moves Back, Forward, or Today', '<strong>O</strong> converts the selected appointment to a persistent RO', 'Technician over-capacity requires an explicit Carry-over / Overnight decision'] },
    C: { name: 'CUSTOMER DIRECTORY', identity: 'CUSTOMER', tips: ['Search name, phone, email, company, fleet data, or linked plate', '<strong>1–9</strong> opens a result; <strong>N</strong> creates and <strong>E</strong> edits', 'Customer Type is separate from repair-line pay type', 'Fleet-only fields appear only for fleet/business situations', 'Canadian province, postal-code, phone, tax-exempt, and PO details are supported'] },
    V: { name: 'VEHICLE & EQUIPMENT LOOKUP', identity: 'VEHICLE', tips: ['Search owner, VIN, plate, year/make/model, equipment, or notes', '<strong>1–9</strong> or Enter opens the active result; <strong>A</strong> adds a vehicle', 'Use VIN Decode as assistance, then verify the returned vehicle details', 'Press <strong>C</strong> from a vehicle card to connect its customer', '<strong>ORPHAN</strong> means the vehicle is not linked to a customer'] },
    P: { name: 'PARTS & INVENTORY CONTROL', identity: 'PARTS', tips: ['Search part number, bin, supplier, brand, or description', '<strong>I</strong> OTC sale · <strong>R</strong> receive · <strong>C</strong> count · <strong>J</strong> adjust', '<strong>O</strong> reserves a part to an RO', '<strong>1–9</strong> opens the numbered result', 'Available quantity means On Hand minus Reserved'] },
    S: { name: 'SHOP SETTINGS', identity: 'SETUP', tips: ['Press <strong>ALT+B</strong> for Canadian Business & Shop Management', 'Press <strong>ALT+J</strong> for Job Op Codes', 'Press <strong>ALT+M</strong> for Staff & Access', 'Administrative setup is intentionally separated from counter work'] },
    K: { name: 'CANADIAN BUSINESS, RATES & VENDORS', identity: 'SETUP', tips: ['Maintain business identity once for shop documents', 'Set C/W/I base rates; Goodwill uses an approved <strong>G</strong> program', 'Customer Type adjustments remain separate from repair-line pay type', 'Add only vendor details and contacts that are operationally useful', '<strong>SAVE DRAFT</strong> keeps work inactive; <strong>TEST & PUBLISH</strong> activates the revision'] },
    J: { name: 'JOB OP CODE CATALOG', identity: 'JOB CODES', tips: ['Type to filter by code, description, or category', 'Use Up/Down arrows; the active row has an amber left marker', 'Enter selects a code when opened from a write-up', 'Manager-created shop codes retain their source'] },
    M: { name: 'STAFF & ACCESS', identity: 'STAFF', tips: ['Click a staff name or press <strong>1–9</strong> to open the profile', 'Staff number is used for technician/advisor preassignment', 'Inactive/ex-staff records remain for historical attribution', 'Private employee details require management access'] }
  };

  const currentContext = contextMap[state.activeTask] || { name: 'MAIN DASHBOARD', identity: 'HOME', tips: ['Press the displayed single key to open a department', 'Use <strong>Shift+Key</strong> to jump between workspaces', '<strong>ESC</strong> returns through your workspace history', '<strong>?</strong> opens this contextual help'] };

  contentEl.innerHTML = `
    <div style="font-family:var(--font-mono); color:var(--text-main); display:flex; flex-direction:column; gap:16px;">
      <div class="help-context-card">
        <div class="help-context-heading"><span>${currentContext.identity}</span><strong>YOU ARE IN: ${currentContext.name}</strong></div>
        <ul>
          ${currentContext.tips.map(tip => `<li>${tip}</li>`).join('')}
        </ul>
      </div>

      <div class="help-panel">
        <strong>WARP DESTINATIONS</strong>
        <div class="help-key-grid">
          <div>${UIComponent.Keycap("SHIFT+O", "warp")} Repair Orders Board</div>
          <div>${UIComponent.Keycap("SHIFT+A", "warp")} Appointments</div>
          <div>${UIComponent.Keycap("SHIFT+C", "warp")} Customer Directory</div>
          <div>${UIComponent.Keycap("SHIFT+V", "warp")} Vehicle Directory</div>
          <div>${UIComponent.Keycap("SHIFT+P", "warp")} Parts &amp; Inventory Engine</div>
          <div>${UIComponent.Keycap("SHIFT+S", "warp")} Shop Settings</div>
          <div>${UIComponent.Keycap("SHIFT+K", "warp")} Canadian Rates &amp; Vendors</div>
          <div>${UIComponent.Keycap("SHIFT+J", "warp")} Job Op Code Catalog</div>
          <div>${UIComponent.Keycap("SHIFT+M", "warp")} Staff &amp; Access</div>
        </div>
      </div>

      <div class="help-panel">
        <strong>ACTIVE SCREEN COMMANDS</strong>
        <div class="help-key-grid">
          <div>${UIComponent.Keycap("ALT+S", "command")} Save Record / Draft</div>
          <div>${UIComponent.Keycap("ALT+A", "command")} Add Line / Stock Part</div>
          <div>${UIComponent.Keycap("ALT+P", "command")} Pass-Through Part</div>
          <div>${UIComponent.Keycap("ALT+I", "command")} Invoice / OTC Sale</div>
          <div>${UIComponent.Keycap("ALT+N", "command")} New Record / Form</div>
          <div>${UIComponent.Keycap("1\u20139", "index")} Select Row / Record</div>
        </div>
      </div>

      <div class="help-panel">
        <strong>GLOBAL NAVIGATION</strong>
        <div class="help-key-grid">
          <div>${UIComponent.Keycap("ESC", "nav")} Close / Cancel / Back</div>
          <div>${UIComponent.Keycap("ENTER", "nav")} Activate / Select Row</div>
          <div>${UIComponent.Keycap("TAB", "nav")} Next Form Field</div>
          <div>${UIComponent.Keycap("ARROWS", "nav")} Navigate List / Rows</div>
          <div>${UIComponent.Keycap("ALT+K", "nav")} Toggle Color Key</div>
          <div>${UIComponent.Keycap("ALT+?", "nav")} Open Help Menu</div>
        </div>
      </div>

      <details class="help-panel" open>
        <summary>COLOR &amp; PAY-TYPE KEY</summary>
        <div class="help-color-grid">
          <span class="help-swatch amber">AMBER</span><span>Active selection or primary action</span>
          <span class="help-swatch cyan">CYAN</span><span>Current edit focus</span>
          <span class="help-swatch green">GREEN</span><span>Available, confirmed, or positive completion</span>
          <span class="help-swatch yellow">YELLOW</span><span>Caution, defer, hold, or carry-over</span>
          <span class="help-swatch red">RED</span><span>Destructive action, exception, or over-capacity</span>
        </div>
        <div class="help-pay-grid"><span><b>C</b> CUSTOMER</span><span><b>W</b> WARRANTY</span><span><b>I</b> INTERNAL</span><span><b>G</b> GOODWILL</span></div>
        <p>Color reinforces the written label; it never replaces it.</p>
      </details>

      <details class="help-panel">
        <summary>LEAN WORKFLOW RULES</summary>
        <ul class="help-rule-list">
          <li>Enter customer, vehicle, concern, and job information once; reuse the stored record.</li>
          <li>Use the yellow active row and consistent arrows before opening or changing a record.</li>
          <li>Keep rare fields collapsed until the customer, vendor, payer, or job actually needs them.</li>
          <li>Manager overrides must remain visible and auditable.</li>
          <li>Confirm the workspace identity—APPT, RO, PARTS, CUSTOMER, or SETUP—before committing.</li>
        </ul>
      </details>

    </div>
  `;
}

function escapeHtml(value) {
  return UIComponent.escapeHtml(String(value));
}

function startClock() {
  const clockEl = document.getElementById('liveClock');
  const dateEl = document.getElementById('todayDateDisplay');
  const updateClock = () => {
    const now = new Date();
    if (clockEl) clockEl.textContent = now.toTimeString().split(' ')[0];
    if (dateEl) {
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const weekday = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][now.getDay()];
      dateEl.textContent = `${weekday} ${year}-${month}-${day}`;
    }
  };
  updateClock();
  setInterval(updateClock, 1000);
}

document.addEventListener('DOMContentLoaded', () => {
  startClock();
  initHotkeys();
});

// Normalize stored operational text when editing finishes. CSS provides the
// immediate uppercase presentation without rewriting value/selection on every
// keystroke, keeping the typing path lightweight.
document.addEventListener('change', (e) => {
  if (!e.target) return;
  const tag = e.target.tagName;
  const type = (e.target.type || '').toLowerCase();
  if ((tag === 'INPUT' && (type === 'text' || type === 'search' || type === '')) || tag === 'TEXTAREA') {
    if (!e.target.dataset.noUppercase && e.target.id !== 'employeePin' && e.target.id !== 'empPinInput' && type !== 'email' && type !== 'password') {
      const start = e.target.selectionStart;
      const end = e.target.selectionEnd;
      const upper = e.target.value.toUpperCase();
      if (e.target.value !== upper) {
        e.target.value = upper;
        if (start !== null && end !== null) {
          e.target.setSelectionRange(start, end);
        }
      }
    }
  }
});

document.addEventListener('click', (e) => {
  const dropdownIds = ['roCustSearchResults', 'roVehSearchResults', 'apptCustSearchResults', 'apptVehSearchResults'];
  dropdownIds.forEach(id => {
    const dropdown = document.getElementById(id);
    const input = document.getElementById(id.startsWith('appt') ? (id.includes('Cust') ? 'apptCust' : 'apptVeh') : (id.includes('Cust') ? 'roCustInput' : 'roVehInput'));
    if (dropdown && !dropdown.classList.contains('hidden')) {
      if (!dropdown.contains(e.target) && e.target !== input) {
        dropdown.classList.add('hidden');
      }
    }
  });

  document.querySelectorAll('.ro-opcode-dropdown').forEach(dd => {
    if (!dd.classList.contains('hidden')) {
      const input = dd.previousElementSibling;
      if (!dd.contains(e.target) && e.target !== input) {
        dd.classList.add('hidden');
      }
    }
  });
});

// -------------------------------------------------------------
// DEVELOPER DIAGNOSTIC SUITE & INCIDENT CAPTURE
// -------------------------------------------------------------
function toggleDiagDrawer() {
  const drawer = document.getElementById('diagDrawerOverlay');
  if (!drawer) return;
  const isHidden = drawer.classList.contains('hidden');
  drawer.classList.toggle('hidden', !isHidden);
  if (isHidden) {
    refreshDiagStatus();
  }
}

async function refreshDiagStatus() {
  try {
    const res = await api('/api/dev/diagnostics/status');
    const healthVal = document.getElementById('diagHealthVal');
    const baselineVal = document.getElementById('diagBaselineVal');
    const changedVal = document.getElementById('diagChangedVal');
    const dot = document.getElementById('diagStatusDot');
    const drawerDot = document.getElementById('diagDrawerDot');

    if (healthVal) healthVal.textContent = res.health || 'PASS';
    if (baselineVal) baselineVal.textContent = res.baseline_commit || 'none';
    if (changedVal) changedVal.textContent = `${res.changed_files_count || 0} files`;

    const statusClass = res.health === 'FAIL' ? 'status-fail' : (res.health === 'WARN' || res.changed_files_count > 0 ? 'status-warn' : 'status-pass');
    if (dot) dot.className = `diag-status-dot ${statusClass}`;
    if (drawerDot) drawerDot.className = `diag-status-dot ${statusClass}`;
  } catch (err) {}
}

async function captureDiagIncident() {
  const input = document.getElementById('diagSymptomInput');
  const symptom = input ? input.value.trim() : '';
  if (!symptom) {
    alert('PLEASE ENTER A BRIEF DESCRIPTION OF WHAT WENT WRONG.');
    if (input) input.focus();
    return;
  }

  const btn = document.getElementById('btnCaptureIncident');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ GENERATING CAPSULE...';
  }

  try {
    const flightRecorder = typeof window.getTaktROFlightRecorderSnapshot === 'function' ? window.getTaktROFlightRecorderSnapshot() : {};
    const res = await api('/api/dev/diagnostics/incident', {
      method: 'POST',
      body: JSON.stringify({
        symptom: symptom,
        flight_recorder: flightRecorder
      })
    });

    const capsuleBox = document.getElementById('diagLastCapsuleBox');
    const capsulePath = document.getElementById('diagCapsulePath');
    if (capsuleBox && capsulePath) {
      capsulePath.textContent = res.capsule_path || '.taktro/incidents/INC-latest.md';
      capsuleBox.classList.remove('hidden');
    }

    if (input) input.value = '';
    alert(`INCIDENT CAPSULE CAPTURED SUCCESSFULLY!\n\nFile: ${res.capsule_path}\n\nYou can now copy the capsule path to Codex/Claude!`);
    refreshDiagStatus();
  } catch (err) {
    alert('Incident Capture Error: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ CAPTURE INCIDENT CAPSULE';
    }
  }
}

async function runDiagAudit() {
  try {
    const res = await api('/api/dev/diagnostics/audit', { method: 'POST' });
    alert(`SYSTEM AUDIT RESULT:\nStatus: ${res.status || 'PASS'}\nErrors: ${res.errors || 0}, Warnings: ${res.warnings || 0}`);
    refreshDiagStatus();
  } catch (err) {
    alert('Audit Error: ' + err.message);
  }
}

async function runDiagDiff() {
  try {
    const res = await api('/api/dev/diagnostics/diff');
    const modCount = res.file_changes?.modified?.length || 0;
    const addCount = res.file_changes?.added?.length || 0;
    alert(`DIFFERENTIAL DIAGNOSIS:\nModified Files: ${modCount}\nAdded Files: ${addCount}`);
  } catch (err) {
    alert('Diff Error: ' + err.message);
  }
}

async function runDiagTests() {
  try {
    const res = await api('/api/dev/diagnostics/tests', { method: 'POST' });
    alert(`AUDITOR UNIT TESTS:\n\n${res.output || 'Passed cleanly!'}`);
  } catch (err) {
    alert('Tests Error: ' + err.message);
  }
}

function copyCodexPacket() {
  const path = document.getElementById('diagCapsulePath')?.textContent || '.taktro/incidents/INC-latest.md';
  const textToCopy = `Please inspect the diagnostic incident capsule at ${path} and repair the issue according to the embedded Codebase Contract rules.`;
  navigator.clipboard.writeText(textToCopy).then(() => {
    alert('COPIED CODEX PACKET PROMPT TO CLIPBOARD!');
  }).catch(() => {
    prompt('Copy Codex Packet Prompt:', textToCopy);
  });
}

async function confirmSetBaseline() {
  if (confirm('SET CURRENT STATE AS KNOWN GOOD BASELINE?\n\nWarning: Only do this when the build is known-good.')) {
    try {
      await api('/api/dev/diagnostics/baseline', { method: 'POST' });
      alert('BASELINE SNAPSHOT RECORDED SUCCESSFULLY!');
      refreshDiagStatus();
    } catch (err) {
      alert('Baseline Error: ' + err.message);
    }
  }
}

setTimeout(refreshDiagStatus, 1000);

// -------------------------------------------------------------
// DRAGGABLE WINDOW UTILITY
// -------------------------------------------------------------
function makeElementDraggable(elmnt, header) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  if (header) {
    header.onmousedown = dragMouseDown;
  } else {
    elmnt.onmousedown = dragMouseDown;
  }

  function dragMouseDown(e) {
    if (['BUTTON', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    e = e || window.event;
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
    elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
    elmnt.style.bottom = 'auto';
    elmnt.style.right = 'auto';
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
  }
}

window.makeElementDraggable = makeElementDraggable;
window.openStandardJobCodeDetails = openStandardJobCodeDetails;

document.addEventListener('DOMContentLoaded', () => {
  const drawer = document.getElementById('diagDrawerOverlay');
  const header = document.getElementById('diagDrawerHeader');
  if (drawer && header) {
    makeElementDraggable(drawer, header);
  }
});


document.addEventListener('DOMContentLoaded', () => {
  const actions = {
    "app.navigate": param => requestNavigation(param),
    "app.help": () => toggleHelpModal(),
    "app.login": (_, element, event) => handleEmployeeLogin(event),
    "app.pin": (_, element) => autoSubmitPin(element),
    'app.toggleDiagDrawer': () => toggleDiagDrawer(),
    'app.captureDiagIncident': () => captureDiagIncident(),
    'app.runDiagAudit': () => runDiagAudit(),
    'app.runDiagDiff': () => runDiagDiff(),
    'app.runDiagTests': () => runDiagTests(),
    'app.copyCodexPacket': () => copyCodexPacket(),
    'app.confirmSetBaseline': () => confirmSetBaseline(),
    "app.settings": (_, element, event) => { const card = event.target.closest('.settings-card'); if (card && element.contains(card) && card.dataset.task) requestNavigation(card.dataset.task); },
    "app.job-row": (_, element) => { selectJobCatalogRow(Number(element.dataset.jobIndex)); return element.dataset.customId && hasPermission('shop_setup') ? openCustomJobCodeForm(Number(element.dataset.customId)) : openStandardJobCodeDetails(element.dataset.code); },
    "app.openCustomJobCodeForm": (param, element, event) => openCustomJobCodeForm(),
    "app.queueJobCatalogRender": (param, element, event) => queueJobCatalogRender(element.value),
    "app.handleJobCatalogKeydown": (param, element, event) => handleJobCatalogKeydown(event),
    "app.edit-job": (param, element, event) => openCustomJobCodeForm(Number(param)),
    "app.openStandardJobCodeDetails": (param, element, event) => openStandardJobCodeDetails(param),
    "app.saveCustomJobCode": (param, element, event) => saveCustomJobCode(event),
    "app.deactivateCustomJobCode": (param, element, event) => deactivateCustomJobCode(),
    "app.renderJobCatalogResults": (param, element, event) => renderJobCatalogResults(''),
  };
  for (const [name, handler] of Object.entries(actions)) {
    const permission = ['app.openCustomJobCodeForm', 'app.edit-job', 'app.saveCustomJobCode', 'app.deactivateCustomJobCode'].includes(name) ? 'shop_setup' : null;
    EventDelegator.registerAction(name, handler, {permission});
  }
});
