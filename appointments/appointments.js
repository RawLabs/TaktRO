/**
 * TaktRO — Appointments & Shop Capacity Domain Module (appointments/appointments.js)
 * TPS/Kaizen Philosophy: Single-entry intake, full write-up at appointment booking,
 * day/week/month capacity planning with clean stacked day cards week view,
 * keyboard hotkeys (D/W/M, Arrow Keys ←/→/↑/↓, P for PREV, N for NEXT, O for Convert, A for Add line, Enter ↵, ESC),
 * active state highlights, day view row navigation, '/' category opcode hierarchy search (BR/ -> Brake list), and direct convert-to-RO print & sign workflow.
 */

function getTodayIsoDate() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

let activeApptViewMode = 'week'; // 'day', 'week', 'month'
let previousApptViewMode = 'week'; // Remembers view mode before entering Day view
let activeApptDate = getTodayIsoDate();
let activeApptRowIndex = 0; // Row selection index for Day View table
let activeEditingApptId = null; // ID of appointment currently loaded in write-up editor
let shopDailyCapacityHours = 40.0; // Default daily shop capacity fallback
let shopLaborRate = 150.0;
let shopOpenWeekdays = [1, 2, 3, 4, 5];
let shopConfigSource = 'SAFE_DEFAULTS';
let cachedAppointments = [];
let cachedAppointmentTechnicians = [];

function getDailyShopCapacity(isoDate) {
  if (!isoDate) return 0;
  const d = new Date(`${isoDate}T00:00:00`);
  if (isNaN(d.getTime())) return 0;

  if (!shopOpenWeekdays.includes(d.getDay())) {
    return 0;
  }

  if (!cachedAppointmentTechnicians || cachedAppointmentTechnicians.length === 0) {
    return shopDailyCapacityHours || 40.0;
  }

  const dayName = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()];
  let totalCapacity = 0;

  cachedAppointmentTechnicians.forEach(tech => {
    const rawWorkDays = tech.work_days || 'MON,TUE,WED,THU,FRI';
    const workDaysList = rawWorkDays.split(',').map(s => s.trim().toUpperCase());

    if (workDaysList.includes(dayName)) {
      const hours = typeof tech.daily_productive_hours === 'number' && tech.daily_productive_hours >= 0
        ? tech.daily_productive_hours
        : 8.0;
      totalCapacity += hours;
    }
  });

  return totalCapacity;
}


let apptCustomerSearchTimer = null;
let apptCustomerSearchResults = [];
let apptCustActiveIndex = 0;

let apptVehicleSearchTimer = null;
let historySearchTimer = null;
let apptVehicleSearchResults = [];
let apptVehActiveIndex = 0;



function renderApptContent() {
  requestAnimationFrame(() => loadAppointments());
  return `
    <div class="appt-workspace">

      <!-- TOP: CONTROLS, DYNAMIC STATE HIGHLIGHT & HOTKEY LEGEND -->
      <div class="appt-workspace-main">
        <div id="apptControlHeader" class="appt-control-header">
          ${renderApptControlBarHtml()}
        </div>

        <!-- MAIN SCHEDULE & CAPACITY CONTAINER WITH ZOOM TRANSITION -->
        <div id="apptScheduleContainer" class="ui-flex-1">
          <div class="appt-loading">LOADING SHOP SCHEDULE &amp; CAPACITY DATA…</div>
        </div>

      </div>

      <!-- BOTTOM: SHOP CAPACITY TOTALS BAR -->
      <div id="apptCapacityBar" class="appt-capacity-bar">
        <div>
          <strong class="u-text-main">SHOP WORKLOAD CAPACITY</strong>
          <div id="apptCapacitySubtext" class="appt-capacity-subtext">TODAY CAPACITY: ${getDailyShopCapacity(activeApptDate).toFixed(1)} HRS (${(cachedAppointmentTechnicians || []).length} ACTIVE TECHS)</div>
        </div>
        <div id="apptCapacityVisual" class="u-align-center"></div>
        <div class="u-align-right" id="apptCapacityMetric">
          <div class="appt-capacity-value">0.0 / ${shopDailyCapacityHours.toFixed(1)} HOURS BOOKED</div>
        </div>
      </div>

    </div>
  `;
}

function renderApptControlBarHtml() {
  const isDay = activeApptViewMode === 'day';
  const isWeek = activeApptViewMode === 'week';
  const isMonth = activeApptViewMode === 'month';
  const isDeferred = activeApptViewMode === 'deferred';
  const deferredCount = cachedAppointments.filter(a => a.status === 'DEFERRED').length;

  return `
    <div class="ui-row-10">
      <strong class="ui-copy">APPOINTMENTS &amp; SHOP CAPACITY</strong>
      <span class="u-text-dim">|</span>
      <div class="appt-view-switcher">
        <button class="secondary-action-btn ui-menu-choice ui-button-compact ${isDay ? 'is-active' : ''}" aria-pressed="${isDay}" data-action="appt.view-day">${UIComponent.Keycap("D", "command")} DAY</button>
        <button class="secondary-action-btn ui-menu-choice ui-button-compact ${isWeek ? 'is-active' : ''}" aria-pressed="${isWeek}" data-action="appt.view-week">${UIComponent.Keycap("W", "command")} WEEK</button>
        <button class="secondary-action-btn ui-menu-choice ui-button-compact ${isMonth ? 'is-active' : ''}" aria-pressed="${isMonth}" data-action="appt.view-month">${UIComponent.Keycap("M", "command")} MONTH</button>
        <button class="secondary-action-btn ui-menu-choice ui-button-compact ${isDeferred ? 'is-active' : ''}" aria-pressed="${isDeferred}" data-action="appt.view-deferred">${UIComponent.Keycap("R", "command")} DEFERRED ${deferredCount > 0 ? `(${deferredCount})` : ''}</button>
      </div>

      <div class="appt-date-bar">
        <button class="secondary-action-btn ui-button-small" data-action="appt.previous-date">${UIComponent.Keycap("B", "command")} BACK</button>
        <input type="date" id="apptDatePicker" class="appt-date-input" value="${activeApptDate}" data-change-action="appt.onApptDateSelect">
        <button class="secondary-action-btn ui-button-small" data-action="appt.setApptDateToToday">${UIComponent.Keycap("T", "command")} TODAY</button>
        <button class="secondary-action-btn ui-button-small" data-action="appt.next-date">${UIComponent.Keycap("F", "command")} FWD</button>
      </div>

      <div class="appt-actions-toolbar">
        <button class="primary-action-btn" data-action="appt.openNewApptDialog">${UIComponent.Keycap("ALT+A", "inverse")} BOOK APPT</button>
      </div>
    </div>
  `;
}

let appointmentsByDateMap = new Map();
let apptLoadSequence = 0;
let lastLoadedApptRange = { start: '', end: '' };

function getVisibleApptDateRange() {
  if (activeApptViewMode === 'deferred') {
    return { start: '1970-01-01', end: '2099-12-31' };
  }
  const current = activeApptDate || new Date().toISOString().split('T')[0];
  if (activeApptViewMode === 'day') {
    return { start: current, end: current };
  } else if (activeApptViewMode === 'week') {
    const weekDays = getWeekDays(current);
    return { start: weekDays[0], end: weekDays[6] };
  } else {
    const parts = current.split('-');
    const year = parseInt(parts[0], 10) || new Date().getFullYear();
    const month = (parseInt(parts[1], 10) || 1) - 1;
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const start = new Date(firstDay);
    start.setDate(start.getDate() - ((firstDay.getDay() + 6) % 7));
    const end = new Date(lastDay);
    end.setDate(end.getDate() + ((7 - lastDay.getDay()) % 7));
    return {
      start: start.toISOString().split('T')[0],
      end: end.toISOString().split('T')[0]
    };
  }
}

function isRangeCovered(requested, loaded) {
  if (!loaded.start || !loaded.end) return false;
  return requested.start >= loaded.start && requested.end <= loaded.end;
}

function indexAppointmentsByDate(appts) {
  const map = new Map();
  appts.forEach(a => {
    if (a.status === 'CANCELLED') return;
    const d = a.appointment_date || (a.created_at ? a.created_at.slice(0, 10) : '');
    if (d) {
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(a);
    }
  });
  appointmentsByDateMap = map;
}

function getApptsForDate(dateStr) {
  return appointmentsByDateMap.get(dateStr) || [];
}

async function loadAppointments(forceRefresh = false) {
  const range = getVisibleApptDateRange();
  if (!forceRefresh && isRangeCovered(range, lastLoadedApptRange) && cachedAppointments.length > 0) {
    renderApptScheduleView();
    return;
  }

  const seq = ++apptLoadSequence;
  try {
    const apiUrl = activeApptViewMode === 'deferred'
      ? '/api/appointments?status=DEFERRED'
      : `/api/appointments?start_date=${range.start}&end_date=${range.end}`;

    const [, res, techRes] = await Promise.all([
      loadOperationalConfig(),
      api(apiUrl),
      api('/api/technicians')
    ]);
    if (seq !== apptLoadSequence) return;

    cachedAppointments = res.appointments || [];
    cachedAppointmentTechnicians = techRes.technicians || [];
    lastLoadedApptRange = range;
    indexAppointmentsByDate(cachedAppointments);
    renderApptScheduleView();
  } catch (err) {
    if (seq !== apptLoadSequence) return;
    console.error('Failed to load appointments:', err);
    const container = document.getElementById('apptScheduleContainer');
    if (container) container.innerHTML = `<div class="appt-load-error">FAILED TO LOAD SCHEDULE: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadOperationalConfig() {
  try {
    const result = await api('/api/operational-config');
    const config = result.config || {};
    shopDailyCapacityHours = Math.max(0, Number(config.daily_capacity_hours) || 0);
    shopLaborRate = Math.max(0, Number(config.labor_rate) || 0);
    shopOpenWeekdays = Array.isArray(config.open_weekdays) ? config.open_weekdays.map(Number) : [1, 2, 3, 4, 5];
    shopConfigSource = config.source || 'SAFE_DEFAULTS';
  } catch (err) {
    console.error('Failed to load operational shop configuration:', err);
  }
}

function isShopOpenDate(isoDate) {
  return shopOpenWeekdays.includes(new Date(`${isoDate}T00:00:00`).getDay());
}

function cleanApptVehicleDisplay(vehicleInfo) {
  const words = String(vehicleInfo || '').trim().split(/\s+/);
  const codeIndex = words.findIndex((word, index) => index >= 3 && word.includes('/'));
  return (codeIndex > 0 ? words.slice(0, codeIndex) : words).join(' ');
}

function appointmentTechnicianName(technicianId) {
  if (!technicianId) return 'UNASSIGNED';
  const tech = cachedAppointmentTechnicians.find(t => Number(t.id) === Number(technicianId));
  if (!tech) return 'UNASSIGNED';
  const numStr = Number(tech.id) >= 1000 ? String(tech.id) : String(tech.id).padStart(3, '0');
  return `[${numStr}] ${tech.name}`;
}

function renderApptServiceLines(appt) {
  const lines = parseApptLines(appt.lines_json);
  if (!lines.length) return `<span>${escapeHtml(appt.concern || 'GENERAL SERVICE')}</span>`;
  return lines.map(line => {
    const pay = String(line.pay || 'C').toUpperCase();
    const payClass = ['C', 'W', 'I', 'G'].includes(pay) ? pay.toLowerCase() : 'c';
    return `<span class="appt-service-line"><strong class="appt-pay-flag appt-pay-flag--${payClass}">${escapeHtml(pay)}</strong><strong class="u-text-main">${escapeHtml(line.op_code || 'NO CODE')}</strong></span>`;
  }).join('');
}

function generateTechnicianOptions(selectedId) {
  const options = ['<option value="">UNASSIGNED</option>'];
  cachedAppointmentTechnicians.forEach(tech => {
    const numStr = Number(tech.id) >= 1000 ? String(tech.id) : String(tech.id).padStart(3, '0');
    options.push(`<option value="${tech.id}" ${Number(selectedId) === Number(tech.id) ? 'selected' : ''}>[${numStr}] ${escapeHtml(tech.name)}</option>`);
  });
  return options.join('');
}

function setApptViewMode(mode) {
  if (activeApptViewMode !== 'day' && mode === 'day') {
    previousApptViewMode = activeApptViewMode;
  }
  activeApptViewMode = mode;
  activeApptRowIndex = 0;
  renderApptControlHeader();
  loadAppointments();
}

function renderApptControlHeader() {
  const header = document.getElementById('apptControlHeader');
  if (!header) return;

  // Partial DOM update: render template fully only if it hasn't been mounted yet
  if (!header.querySelector('.appt-date-nav')) {
    header.innerHTML = renderApptControlBarHtml();
    return;
  }

  // Update date picker value
  const picker = header.querySelector('#apptDatePicker');
  if (picker && picker.value !== activeApptDate) {
    picker.value = activeApptDate;
  }

  // Update view mode switcher button states
  const buttons = header.querySelectorAll('.appt-view-switcher button');
  const modes = ['day', 'week', 'month', 'deferred'];
  buttons.forEach((btn, idx) => {
    const mode = modes[idx];
    const isActive = activeApptViewMode === mode;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
}

function setApptDateToToday() {
  activeApptDate = getTodayIsoDate();
  activeApptRowIndex = 0;
  const picker = document.getElementById('apptDatePicker');
  if (picker) picker.value = activeApptDate;
  loadAppointments();
}

function onApptDateSelect(dateVal) {
  if (!dateVal) return;
  activeApptDate = dateVal;
  activeApptRowIndex = 0;
  loadAppointments();
}

function shiftApptDate(delta) {
  const curr = new Date(activeApptDate + 'T00:00:00');
  curr.setDate(curr.getDate() + delta);
  const year = curr.getFullYear();
  const month = String(curr.getMonth() + 1).padStart(2, '0');
  const day = String(curr.getDate()).padStart(2, '0');
  activeApptDate = `${year}-${month}-${day}`;
  activeApptRowIndex = 0;
  const picker = document.getElementById('apptDatePicker');
  if (picker) picker.value = activeApptDate;
  loadAppointments();
}

function handleApptArrowNav(dir) {
  if (activeApptViewMode === 'day') {
    const dayAppts = getApptsForDate(activeApptDate);

    if (dir === 'down') {
      if (dayAppts.length > 0) {
        updateApptDayRowSelection(Math.min(dayAppts.length - 1, activeApptRowIndex + 1));
      }
    } else if (dir === 'up') {
      if (dayAppts.length > 0) {
        updateApptDayRowSelection(Math.max(0, activeApptRowIndex - 1));
      }
    } else if (dir === 'left') {
      shiftApptDate(-1);
    } else if (dir === 'right') {
      shiftApptDate(1);
    }
  } else {
    if (dir === 'left') shiftApptDate(-1);
    else if (dir === 'right') shiftApptDate(1);
    else if (dir === 'up') shiftApptDate(-7);
    else if (dir === 'down') shiftApptDate(7);
  }
}

function updateApptDayRowSelection(nextIndex) {
  if (nextIndex === activeApptRowIndex) return;
  const previous = document.querySelector(`.appt-day-row[data-appt-row-index="${activeApptRowIndex}"]`);
  const next = document.querySelector(`.appt-day-row[data-appt-row-index="${nextIndex}"]`);
  previous?.classList.remove('is-selected');
  next?.classList.add('is-selected');
  activeApptRowIndex = nextIndex;
  next?.scrollIntoView({ block: 'nearest' });
}

function handleApptEnterKey() {
  if (activeApptViewMode === 'week' || activeApptViewMode === 'month') {
    previousApptViewMode = activeApptViewMode;
    activeApptViewMode = 'day';
    activeApptRowIndex = 0;
    const picker = document.getElementById('apptDatePicker');
    if (picker) picker.value = activeApptDate;
    renderApptScheduleView();
  } else if (activeApptViewMode === 'day') {
    const dayAppts = getApptsForDate(activeApptDate);
    if (dayAppts.length > 0 && dayAppts[activeApptRowIndex]) {
      openApptWriteupEditor(dayAppts[activeApptRowIndex].id);
    }
  }
}

function handleApptConvertKey() {
  if (activeEditingApptId) {
    convertApptToRo(activeEditingApptId);
  } else if (activeApptViewMode === 'day') {
    const dayAppts = getApptsForDate(activeApptDate);
    if (dayAppts.length > 0 && dayAppts[activeApptRowIndex]) {
      convertApptToRo(dayAppts[activeApptRowIndex].id);
    }
  }
}

function handleAppointmentsEscapeNav() {
  const form = document.getElementById('apptCust');
  if (form) {
    cancelAppointmentAutosave();
    activeEditingApptId = null;
    requestNavigation('A');
    loadAppointments();
    return true;
  }

  if (activeApptViewMode === 'day') {
    activeApptViewMode = previousApptViewMode || 'week';
    renderApptScheduleView();
    return true;
  }

  return false;
}

function renderApptScheduleView() {
  renderApptControlHeader();

  const container = document.getElementById('apptScheduleContainer');
  if (!container) return;

  if (activeApptViewMode === 'day') {
    renderApptDayView(container);
  } else if (activeApptViewMode === 'week') {
    renderApptWeekView(container);
  } else if (activeApptViewMode === 'month') {
    renderApptMonthView(container);
  } else if (activeApptViewMode === 'deferred') {
    renderApptDeferredView(container);
  }
}

/* ==========================================================================
   1. DAY VIEW
   ========================================================================== */
function renderApptDayView(container) {
  const dayAppts = getApptsForDate(activeApptDate);

  if (activeApptRowIndex >= dayAppts.length) {
    activeApptRowIndex = Math.max(0, dayAppts.length - 1);
  }

  let totalHrs = 0;
  dayAppts.forEach(a => { totalHrs += parseFloat(a.estimated_hours || a.total_hours || 1.0); });

  const dayCapacity = getDailyShopCapacity(activeApptDate);
  const availHrs = Math.max(0, dayCapacity - totalHrs);
  const utilPct = dayCapacity > 0 ? Math.min(100, Math.round((totalHrs / dayCapacity) * 100)) : 0;

  updateCapacityBar(totalHrs, dayCapacity, `FOR SELECTED DATE: ${activeApptDate}${dayCapacity ? '' : ' — SHOP CLOSED'}`);

  let tableRows = '';
  if (dayAppts.length === 0) {
    tableRows = `<tr><td colspan="7" class="empty-state-cell">NO APPOINTMENTS BOOKED FOR ${activeApptDate}.</td></tr>`;
  } else {
    tableRows = dayAppts.map((a, idx) => {
      const hrs = parseFloat(a.estimated_hours || a.total_hours || 1.0);
      const isConverted = a.status === 'CONVERTED';
      const isRowSelected = idx === activeApptRowIndex;

      const statusBadge = isConverted
        ? `<span class="appt-status-chip appt-status-chip--converted">CONVERTED TO RO</span>`
        : `<span class="appt-status-chip appt-status-chip--scheduled">SCHEDULED</span>`;

      const actionBtns = isConverted
        ? `<div class="ui-row-end-6">
             <span class="appt-converted-label">CONVERTED</span>
             <button class="secondary-action-btn action-caution action-compact" data-action="appt.promptApptManageModal" data-action-param="${escapeHtml(a.id)}" title="Reschedule, defer, or permanently delete appointment">MANAGE</button>
           </div>`
        : `<div class="ui-row-end-6">
             <button class="secondary-action-btn action-compact" data-action="appt.printApptWriteup" data-action-param="${escapeHtml(a.id)}" title="Print Confirmation Slip">${UIComponent.Keycap("P", "command")} PRINT</button>
             <button class="secondary-action-btn action-compact" data-action="appt.convertApptToRo" data-action-param="${escapeHtml(a.id)}" title="Open as Repair Order">${UIComponent.Keycap("O", "command")} OPEN RO</button>
             <button class="secondary-action-btn action-caution action-compact" data-action="appt.promptApptManageModal" data-action-param="${escapeHtml(a.id)}" title="Reschedule, defer, or permanently delete appointment">MANAGE</button>
           </div>`;

      return `
        <tr tabindex="0" class="appt-day-row ${isRowSelected ? 'is-selected' : ''}" data-appt-row-index="${idx}" data-action="appt.openApptWriteupEditor" data-action-param="${escapeHtml(a.id)}">
          <td class="appt-day-row-time">
            <span class="appt-day-row-marker">▶</span>
            <div>DROP ${escapeHtml(a.drop_off_time || '—')}</div>
            <div class="u-text-main">PT ${escapeHtml(a.promised_time || '—')}</div>
          </td>
          <td class="appt-customer-name">
            ${escapeHtml(a.customer_name)}
            ${a.po_number ? `<div class="ui-note-dim">PO: ${escapeHtml(a.po_number)}</div>` : ''}
          </td>
          <td class="u-text-main">
            <strong>${escapeHtml(cleanApptVehicleDisplay(a.vehicle_info))}</strong>
            <div class="appt-vehicle-meta">${a.license_plate ? `PLATE ${escapeHtml(a.license_plate)}` : ''}${a.vin ? `${a.license_plate ? ' · ' : ''}VIN …${escapeHtml(a.vin.slice(-8))}` : ''}</div>
          </td>
          <td class="u-text-main">
            ${renderApptServiceLines(a)}
          </td>
          <td class="appt-tech">
            ${escapeHtml(appointmentTechnicianName(a.preassigned_technician_id))}
            ${a.preassigned_technician_id ? `<div class="appt-tech-hours ${Number(a.technician_assigned_hours || 0) > Number(a.technician_daily_limit || 8) ? 'is-overbooked' : ''}">${Number(a.technician_assigned_hours || 0).toFixed(1)} / ${Number(a.technician_daily_limit || 8).toFixed(1)} HRS</div>` : ''}
            ${a.requires_carry_over ? '<div class="appt-overnight">⚠ OVERNIGHT</div>' : ''}
          </td>
          <td class="appt-hours-cell">${hrs.toFixed(1)}</td>
          <td class="appt-actions-cell">
            ${actionBtns}
          </td>
        </tr>
      `;
    }).join('');
  }

  // Optimize: Partial DOM updates if elements are already mounted
  const tblBody = document.getElementById('apptDayTableBody');
  if (tblBody) {
    tblBody.innerHTML = tableRows;
    const titleEl = document.getElementById('apptDayToolbarTitle');
    const bookedEl = document.getElementById('apptDayToolbarBooked');
    const openEl = document.getElementById('apptDayToolbarOpen');
    const fillEl = document.getElementById('apptDayToolbarMeterFill');

    if (titleEl) titleEl.textContent = `DAY SCHEDULE — ${activeApptDate}`;
    if (bookedEl) bookedEl.innerHTML = `BOOKED: <strong class="u-text-main">${totalHrs.toFixed(1)} HRS</strong> of ${dayCapacity.toFixed(1)} HRS`;
    if (openEl) openEl.textContent = `+${availHrs.toFixed(1)} HRS OPEN`;
    if (fillEl) {
      fillEl.style.cssText = `--capacity-percent:${utilPct}%; --capacity-color:${utilPct > 90 ? 'var(--accent-crimson)' : utilPct > 75 ? 'var(--accent-amber)' : 'var(--accent-emerald)'};`;
    }
    return;
  }

  container.innerHTML = `
    <div class="ui-stack-12">

      <!-- DAY HEADER: DATE + CAPACITY + COMPACT NAV HINTS -->
      <div class="appt-day-toolbar">
        <div>
          <strong class="ui-heading-amber" id="apptDayToolbarTitle">DAY SCHEDULE — ${activeApptDate}</strong>
          <span class="appt-day-booked" id="apptDayToolbarBooked">BOOKED: <strong class="u-text-main">${totalHrs.toFixed(1)} HRS</strong> of ${dayCapacity.toFixed(1)} HRS</span>
        </div>
        <div class="ui-row-8">
          <span class="ui-label-dim">
            ${UIComponent.Keycap("\u2191\u2193", "command", {className: "ui-help-key"})} navigate &nbsp;
            ${UIComponent.Keycap("\u21b5", "command", {className: "ui-help-key"})} edit &nbsp;
            ${UIComponent.Keycap("P", "command", {className: "ui-help-key"})} print &nbsp;
            ${UIComponent.Keycap("B", "command", {className: "ui-help-key"})} back &nbsp;
            ${UIComponent.Keycap("F", "command", {className: "ui-help-key"})} fwd
          </span>
          <div class="appt-open-hours" id="apptDayToolbarOpen">
            +${availHrs.toFixed(1)} HRS OPEN
          </div>
          <div class="capacity-meter">
            <div class="capacity-meter-fill" id="apptDayToolbarMeterFill" style="--capacity-percent:${utilPct}%; --capacity-color:${utilPct > 90 ? 'var(--accent-crimson)' : utilPct > 75 ? 'var(--accent-amber)' : 'var(--accent-emerald)'};"></div>
          </div>
        </div>
      </div>

      <!-- DAY SCHEDULE TABLE -->
      <table class="ui-table">
        <thead>
          <tr class="appt-day-head">
            <th class="appt-day-head-drop">DROP / PT</th>
            <th class="appt-day-head-customer">CUSTOMER</th>
            <th class="appt-day-head-vehicle">VEHICLE</th>
            <th>SERVICE — C/W/I/G / JOB CODES</th>
            <th class="appt-day-head-tech">TECH PREASSIGN</th>
            <th class="appt-day-head-hours">HRS</th>
            <th class="appt-day-head-actions"></th>
          </tr>
        </thead>
        <tbody id="apptDayTableBody">
          ${tableRows}
        </tbody>
      </table>
    </div>
  `;
}

function selectApptRow(idx) {
  activeApptRowIndex = idx;
  renderApptScheduleView();
}

/* ==========================================================================
   2. WEEK VIEW (CLEAN STACKED DAY CARDS — NO OVERLAPPING TIME BLOCKS)
   ========================================================================== */
function renderApptWeekView(container) {
  const weekDays = getWeekDays(activeApptDate);

  let weekTotalBooked = 0;
  let weekTotalCapacity = 0;
  const daysData = weekDays.map(dayStr => {
    const dayAppts = getApptsForDate(dayStr);
    let dayHrs = 0;
    dayAppts.forEach(a => { dayHrs += parseFloat(a.estimated_hours || a.total_hours || 1.0); });
    weekTotalBooked += dayHrs;
    const capacity = getDailyShopCapacity(dayStr);
    weekTotalCapacity += capacity;
    const openHrs = Math.max(0, capacity - dayHrs);
    const utilPct = capacity > 0 ? Math.min(100, Math.round((dayHrs / capacity) * 100)) : 0;
    return { dateStr: dayStr, dayAppts, dayHrs, openHrs, utilPct, capacity };
  });

  updateCapacityBar(weekTotalBooked, weekTotalCapacity, `WEEK OF ${weekDays[0]} TO ${weekDays[6]}`);

  container.innerHTML = `
    <div class="appt-week">

      <div class="appt-week-grid">
        ${daysData.map(d => {
          const isToday = d.dateStr === getTodayIsoDate();
          const isSelected = d.dateStr === activeApptDate;
          const dayLabel = new Date(d.dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }).toUpperCase();

          // Render Stacked Appointment Cards
          const apptCardsHtml = d.dayAppts.length === 0
            ? `<div class="appt-week-empty">NO APPOINTMENTS</div>`
            : d.dayAppts.map(a => {
                const durationHrs = Math.max(0.5, parseFloat(a.estimated_hours || a.total_hours || 1.0));
                const isConverted = a.status === 'CONVERTED';

                return `
                  <div class="appt-week-entry ${isConverted ? 'is-converted' : ''}" data-action="appt.openApptWriteupEditor" data-action-param="${escapeHtml(a.id)}" title="Click to view/edit appointment write-up">
                    <div class="appt-week-entry-meta">
                      <span>${escapeHtml(a.promised_time)}</span>
                      <span>${durationHrs.toFixed(1)}h</span>
                    </div>
                    <div class="appt-week-entry-customer">${escapeHtml(a.customer_name)}</div>
                    <div class="appt-week-entry-vehicle">${escapeHtml(a.vehicle_info)}</div>
                    <div class="appt-week-entry-concern">
                      ${escapeHtml(a.concern || 'SERVICE WRITE-UP')}
                    </div>
                  </div>
                `;
              }).join('');

          return `
            <div class="appt-week-day ${isSelected ? 'is-selected' : ''} ${isToday ? 'is-today' : ''}" data-action="appt.selectApptDateAndDayView" data-action-param="${escapeHtml(d.dateStr)}">

              <!-- DAY CARD HEADER -->
              <div class="appt-week-day-header">
                <div class="ui-flex-between">
                  <strong class="appt-week-day-label">${dayLabel}</strong>
                  ${isSelected ? '<span class="appt-week-state appt-week-state--selected">[ENTER ↵]</span>' : isToday ? '<span class="appt-week-state appt-week-state--today">TODAY</span>' : ''}
                </div>

                <!-- PROMINENT OPEN HOURS REMAINING BADGE -->
                <div class="appt-week-open">
                  +${d.openHrs.toFixed(1)} HRS OPEN
                </div>
              </div>

              <!-- STACKED APPOINTMENT CARDS CONTAINER -->
              <div class="appt-week-list">
                ${apptCardsHtml}
              </div>

              <!-- FOOTER QUICK BOOK BUTTON -->
              <div class="appt-week-footer">
                <button class="secondary-action-btn appt-week-open-button" data-action="appt.selectApptDateAndDayView" data-action-param="${escapeHtml(d.dateStr)}">OPEN DAY SCHEDULE</button>
              </div>

            </div>
          `;
        }).join('')}
      </div>

    </div>
  `;
}

/* ==========================================================================
   3. MONTH VIEW (ZOOM OUT TO FULL MONTH MATRIX WITH ARROW DAY HIGHLIGHT)
   ========================================================================== */
function renderApptMonthView(container) {
  const yearMonth = activeApptDate.slice(0, 7);
  const [yearStr, monthStr] = yearMonth.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10) - 1;

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const totalDays = lastDay.getDate();
  const startDayOfWeek = firstDay.getDay(); // 0 = Sun

  const monthLabel = firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();

  let monthTotalBooked = 0;
  let monthOpenDays = 0;
  let monthTotalCapacity = 0;

  const cells = [];
  // Empty leading cells
  for (let i = 0; i < startDayOfWeek; i++) {
    cells.push('<div class="appt-month-blank"></div>');
  }

  // Days of month
  for (let d = 1; d <= totalDays; d++) {
    const dayIso = `${yearStr}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayAppts = getApptsForDate(dayIso);

    let dayHrs = 0;
    dayAppts.forEach(a => { dayHrs += parseFloat(a.estimated_hours || a.total_hours || 1.0); });
    monthTotalBooked += dayHrs;

    const dayCapacity = getDailyShopCapacity(dayIso);
    if (dayCapacity > 0) monthOpenDays += 1;
    monthTotalCapacity += dayCapacity;
    const openHrs = Math.max(0, dayCapacity - dayHrs);
    const utilPct = dayCapacity > 0 ? Math.min(100, Math.round((dayHrs / dayCapacity) * 100)) : 0;
    const isToday = dayIso === getTodayIsoDate();
    const isSelected = dayIso === activeApptDate;

    cells.push(`
      <div class="appt-month-day ${isSelected ? 'is-selected' : ''} ${isToday ? 'is-today' : ''}" data-action="appt.selectApptDateAndDayView" data-action-param="${escapeHtml(dayIso)}">
        <div class="ui-flex-between">
          <strong class="appt-month-day-number">${d}</strong>
          ${isSelected ? '<span class="appt-month-selected">[ENTER ↵]</span>' : dayAppts.length > 0 ? `<span class="appt-month-count">${dayAppts.length} APPT${dayAppts.length > 1 ? 'S' : ''}</span>` : ''}
        </div>

        <div class="ui-mt-4">
          <!-- PROMINENT REMAINING OPEN HOURS IN MONTH MATRIX -->
          <div class="appt-month-open">
            ${dayCapacity > 0 ? `+${openHrs.toFixed(1)}h open` : 'SHOP CLOSED'}
          </div>
          <div class="appt-month-booked">
            <span>${dayHrs.toFixed(1)}h booked</span>
          </div>
          <div class="appt-month-meter">
            <div class="appt-month-meter-fill" style="--capacity-percent:${utilPct}%; --capacity-color:${utilPct > 90 ? 'var(--accent-crimson)' : utilPct > 75 ? 'var(--accent-amber)' : 'var(--accent-emerald)'};"></div>
          </div>
        </div>
      </div>
    `);
  }

  updateCapacityBar(monthTotalBooked, monthTotalCapacity, `MONTH OF ${monthLabel}`);

  container.innerHTML = `
    <div class="appt-month">
      <div class="appt-month-toolbar">
        <strong class="appt-month-title">MONTHLY AVAILABILITY CALENDAR — ${monthLabel}</strong>
        <span class="ui-label-dim">NAVIGATE: ${UIComponent.Keycap("\u2190", "command")} ${UIComponent.Keycap("\u2192", "command")} DAY | ${UIComponent.Keycap("\u2191", "command")} ${UIComponent.Keycap("\u2193", "command")} WEEK | ${UIComponent.Keycap("ENTER \u21b5", "command")} OPEN DAY | ${UIComponent.Keycap("P", "command")} PREV | ${UIComponent.Keycap("N", "command")} NEXT | ${UIComponent.Keycap("ESC", "command")} BACK</span>
      </div>

      <div class="appt-month-weekdays">
        <div>SUN</div><div>MON</div><div>TUE</div><div>WED</div><div>THU</div><div>FRI</div><div>SAT</div>
      </div>

      <div class="appt-month-grid">
        ${cells.join('')}
      </div>
    </div>
  `;
}

function updateCapacityBar(bookedHrs, capacityHrs, periodText) {
  const capSubtext = document.getElementById('apptCapacitySubtext');
  const capMetric = document.getElementById('apptCapacityBar');
  if (capSubtext) capSubtext.textContent = periodText;
  if (capMetric) {
    const utilization = capacityHrs > 0 ? Math.min(100, (bookedHrs / capacityHrs) * 100) : 0;
    const capacityColor = utilization > 90 ? 'var(--accent-crimson)' : utilization > 75 ? 'var(--accent-amber)' : 'var(--accent-emerald)';
    const visualEl = capMetric.querySelector('#apptCapacityVisual');
    if (visualEl) {
      visualEl.innerHTML = `
        <div class="appt-capacity-label"><span>CAPACITY USED</span><span>${utilization.toFixed(0)}%</span></div>
        <div class="appt-capacity-meter">
          <div class="appt-capacity-meter-fill" style="--capacity-percent:${utilization}%; --capacity-color:${capacityColor};"></div>
        </div>`;
    }
    const metricEl = capMetric.querySelector('#apptCapacityMetric');
    if (metricEl) {
      const openHrs = Math.max(0, capacityHrs - bookedHrs);
      metricEl.innerHTML = `
        <div class="appt-capacity-value">+${openHrs.toFixed(1)} OPEN HOURS REMAINING TO BOOK</div>
        <div class="appt-capacity-booked">${bookedHrs.toFixed(1)} / ${capacityHrs.toFixed(1)} TOTAL HOURS BOOKED</div>
      `;
    }
  }
}

function selectApptDateAndDayView(dateIso) {
  if (activeApptViewMode !== 'day') {
    previousApptViewMode = activeApptViewMode;
  }
  activeApptDate = dateIso;
  activeApptViewMode = 'day';
  activeApptRowIndex = 0;
  const picker = document.getElementById('apptDatePicker');
  if (picker) picker.value = activeApptDate;
  loadAppointments();
}

function openNewApptDialog() {
  openApptWriteupEditor();
}

function openNewApptForDate(dateIso) {
  activeApptDate = dateIso;
  openNewApptDialog();
}

function getWeekDays(isoDateStr) {
  const curr = new Date(isoDateStr + 'T00:00:00');
  const day = curr.getDay(); // 0 = Sun, 1 = Mon
  const diffToMon = curr.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(curr.setDate(diffToMon));

  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const dayNum = String(d.getDate()).padStart(2, '0');
    week.push(`${year}-${month}-${dayNum}`);
  }
  return week;
}

function parseApptLines(jsonStr) {
  if (!jsonStr) return [];
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/* ==========================================================================
   4. APPOINTMENT WRITE-UP EDITOR (DISTINCT FROM REPAIR ORDER WRITE-UP EDITOR)
   ========================================================================== */
function getApptEditorNormalizedSnapshot() {
  const form = document.getElementById('apptFullWriteupForm');
  if (!form) return {};
  const data = {};
  Array.from(form.querySelectorAll('input, select, textarea')).forEach(el => {
    if (!el.id && !el.name) return;
    const k = el.id || el.name;
    data[k] = el.type === 'checkbox' ? Boolean(el.checked) : el.value.trim();
  });
  return data;
}

function openApptWriteupEditor(apptId = null) {
  cancelAppointmentAutosave();
  activeEditingApptId = apptId;
  const appt = apptId ? cachedAppointments.find(a => a.id === apptId) : null;

  const contentEl = document.getElementById('workspaceContent');
  const titleEl = document.getElementById('activeTaskTitle');
  titleEl.textContent = appt ? `APPOINTMENT WRITE-UP RECORD #${appt.id}` : 'APPOINTMENT WRITE-UP EDITOR';

  const isConverted = appt && appt.status === 'CONVERTED';

  contentEl.innerHTML = `
    <div class="appt-editor">

      <!-- TOP CONTROL BAR -->
      <div style="display:flex; justify-content:space-between; align-items:center; background:var(--surface-panel); padding:10px 16px; border-radius:4px; border:1px solid var(--border-mid); margin-bottom:12px;">
        <button class="secondary-action-btn" data-action="appt.requestNavigation">${UIComponent.Keycap("ESC", "command")} Schedule</button>
        <div style="display:flex; align-items:center; gap:12px;">
          <span id="apptAutoSaveStatus" class="appt-autosave-status" style="margin-right:8px;"></span>
          ${appt ? `
            <button class="secondary-action-btn" data-action="appt.printApptWriteupFromEditor">${UIComponent.Keycap("ALT+P", "command")} PRINT CONFIRMATION</button>
            <button class="primary-action-btn" data-action="appt.triggerApptConvertFromEditor">${UIComponent.Keycap("ALT+O", "inverse", {className: "kbd-invert"})} CONVERT TO RO</button>
          ` : ''}
          <span class="u-text-dim">|</span>
          <strong style="color:var(--accent-amber); font-size:15px; font-weight:800; letter-spacing:0.05em; text-transform:uppercase;">${appt ? `APPOINTMENT WRITE-UP RECORD #${appt.id}` : 'NEW APPOINTMENT'}</strong>
        </div>
      </div>

      <!-- INTAKE GRID (RESPONSIVE GRID) -->
      <form id="apptFullWriteupForm" class="appt-editor-form" data-submit-action="appt.submitNewAppt" style="display:flex; flex-direction:column; gap:12px;">

        <div style="background:var(--surface-panel); padding:12px 14px; border-radius:4px; border:1px solid var(--border-mid);">
          
          <!-- ROW 1: Customer | Vehicle | Mileage -->
          <div style="display:grid; grid-template-columns: 2fr 2fr 1fr; gap:12px; margin-bottom:10px;">
            <div style="position:relative;">
              <label class="field-label">CUSTOMER NAME / PHONE *</label>
              <input type="text" id="apptCust" class="appt-record-input ${appt ? 'is-readonly' : ''}" value="${escapeHtml(appt?.customer_name || '')}" required placeholder="Search customer..." ${appt ? 'readonly' : 'autofocus'} data-input-action="appt.customer-search" data-keydown-action="appt.handleApptCustSearchKeydown" autocomplete="off" style="width:100%; padding:6px 8px; font-size:11px;">
              <div id="apptCustSearchResults" class="hidden typeahead-dropdown"></div>
            </div>
            <div style="position:relative;">
              <label class="field-label">VEHICLE (YR MAKE MODEL) *</label>
              <input type="text" id="apptVeh" class="appt-record-input ${appt ? 'is-readonly' : ''}" value="${escapeHtml(appt?.vehicle_info || '')}" required placeholder="e.g. 2022 Ford F-150" ${appt ? 'readonly' : ''} data-input-action="appt.vehicle-search" data-keydown-action="appt.handleApptVehSearchKeydown" autocomplete="off" style="width:100%; padding:6px 8px; font-size:11px;">
              <div id="apptVehSearchResults" class="hidden typeahead-dropdown"></div>
            </div>
            <div>
              <label class="field-label">MILEAGE IN</label>
              <input type="text" id="apptMiles" value="${escapeHtml(appt?.mileage || '')}" placeholder="Mileage..." style="width:100%; padding:6px 8px; font-size:11px;">
            </div>
          </div>

          <!-- ROW 2: Date/Times | License | VIN -->
          <div style="display:grid; grid-template-columns: 2fr 1fr 1fr; gap:12px; margin-bottom:10px;">
            <div>
              <label class="field-label">DATE / DROP-OFF / PROMISED TIME *</label>
              <div class="appt-time-fields" style="display:flex; gap:4px;">
                <input type="date" id="apptDateInput" class="appt-date-input" value="${appt?.appointment_date || activeApptDate}" style="width:40%; padding:6px 4px; font-size:10px;">
                <select id="apptDropOffTimeInput" class="ui-dark-select appt-time-select" title="Drop-off time" style="width:30%; padding:6px 2px; font-size:10px; font-weight:700;">
                  ${generateShopPromisedTimeOptions(7, 17, 15, appt?.drop_off_time || '8:00 AM')}
                </select>
                <select id="apptTimeInput" class="ui-dark-select appt-time-select" title="Promised time" style="width:30%; padding:6px 2px; font-size:10px; font-weight:700;">
                  ${generateShopPromisedTimeOptions(8, 17, 15, appt?.promised_time)}
                </select>
              </div>
            </div>
            <div>
              <label class="field-label">LICENSE PLATE</label>
              <input type="text" id="apptPlate" value="${escapeHtml(appt?.license_plate || '')}" placeholder="e.g. 7XYZ99" style="width:100%; padding:6px 8px; font-size:11px;">
            </div>
            <div style="position:relative;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label class="field-label" style="margin-bottom:0;">VIN (17-DIGIT)</label>
                <span id="apptVinLast8Sub" style="font-size:9px; color:var(--text-dim);">${formatVinLast8(appt?.vin)}</span>
              </div>
              <input type="text" id="apptVin" class="appt-vin-input" value="${escapeHtml(appt?.vin || '')}" placeholder="Enter 17-digit VIN..." data-input-action="appt.updateApptVinLast8Display" maxlength="17" autocomplete="off" style="width:100%; padding:6px 8px; font-size:11px;">
            </div>
          </div>

          <!-- ROW 3: Commercial Fields (Shown only if Fleet/Commercial) -->
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:10px;">
            <div id="apptFleetUnitContainer" class="appt-field ${appt?.fleet_unit ? '' : 'hidden'}">
              <label class="field-label">FLEET UNIT #:</label>
              <input type="text" id="apptFleetUnit" value="${escapeHtml(appt?.fleet_unit || '')}" placeholder="e.g. UNIT-402" style="width:100%; padding:6px 8px; font-size:11px;">
            </div>
            <div id="apptPoContainer" class="appt-field ${appt?.po_number ? '' : 'hidden'}">
              <label class="field-label">CUSTOMER PO #:</label>
              <input type="text" id="apptPo" value="${escapeHtml(appt?.po_number || '')}" placeholder="e.g. PO-8812" style="width:100%; padding:6px 8px; font-size:11px;">
            </div>
          </div>

          <!-- CONTEXTUAL ACTIONS: HISTORY & PREV RECS (Quietly exposed when Customer/Vehicle has text) -->
          <div id="apptContextualActions" class="hidden" style="display:flex; gap:10px; margin-top:4px;">
            <button type="button" class="secondary-action-btn" data-action="appt.openApptServiceHistoryModal">${UIComponent.Keycap("ALT+H", "command")} HISTORY</button>
            <button type="button" class="secondary-action-btn" title="Previous Recommendations (coming soon)" disabled>${UIComponent.Keycap("ALT+R", "command")} PREV RECS</button>
          </div>

          <!-- OPTIONAL SCHEDULING DETAILS -->
          <div style="margin-top:10px; border-top:1px dashed var(--border-soft); padding-top:10px;">
            <details style="cursor:pointer; font-size:11px;">
              <summary style="font-weight:700; color:var(--accent-amber); user-select:none;">+ SHOW OVERNIGHT OVERRIDE SETTING</summary>
              <div style="display:flex; gap:20px; padding:10px; margin-top:6px; border:1px solid var(--border-soft); border-radius:4px; background:var(--surface-subtle);">
                <div style="display:flex; align-items:center;">
                  <label class="appt-carry-over" style="display:inline-flex; align-items:center; gap:6px; color:var(--accent-amber); font-weight:700; font-size:10px; margin-top:0;">
                    <input type="checkbox" id="apptCarryOverInput" ${appt?.requires_carry_over ? 'checked' : ''}> CARRY-OVER / OVERNIGHT OVERRIDE
                  </label>
                </div>
              </div>
            </details>
          </div>

        </div>

        <!-- SERVICE REQUESTS HEADING & TABLE -->
        <div style="margin-top:6px; margin-bottom:2px; display:flex; justify-content:space-between; align-items:center;">
          <strong style="color:var(--text-main); font-size:12px;">SERVICE REQUESTS</strong>
          <button type="button" class="secondary-action-btn" data-action="appt.addApptLine">${UIComponent.Keycap("ALT+A", "command")} ADD LINE</button>
        </div>

        <div class="appt-lines-panel" style="flex:1; min-height:0; overflow-y:auto; border:1px solid var(--border-mid); border-radius:4px; background:var(--surface-panel);">
          <table class="ui-table">
            <thead class="appt-lines-head">
              <tr class="ui-table-head-subtle">
                <th class="appt-line-head-num">LN</th>
                <th class="appt-line-head-pay">PAY</th>
                <th class="appt-line-head-code">OP-CODE</th>
                <th>CUSTOMER CONCERN / REQUESTED SERVICE</th>
                <th style="width:145px; text-align:left;">ASSIGNED TECH</th>
                <th class="appt-line-head-hours">HRS</th>
                <th class="appt-line-head-money">PARTS ($)</th>
                <th class="appt-line-head-money">LABOR ($)</th>
                <th class="appt-line-head-total">TOTAL</th>
                <th class="appt-line-head-remove"></th>
              </tr>
            </thead>
            <tbody id="apptLinesWorkspaceBody">
            </tbody>
          </table>
        </div>

      </form>

      <!-- STICKY FOOTER TOTALS BAR -->
      <div class="appt-totals" style="display:flex; justify-content:space-between; align-items:center; padding:10px 16px; border-top:2px solid var(--accent-amber); background:var(--surface-panel); flex-shrink:0;">
        <div style="display:flex; gap:16px; font-size:11px; color:var(--text-muted); align-items:center;">
          Est. Hours: <strong id="apptTotalHours" class="u-text-amber" style="margin-right:12px;">0.00 HRS</strong>
          Est. Total: <span id="apptMasterTotal" class="appt-master-total" style="color:var(--accent-amber); font-weight:800; font-size:13px;">$0.00</span>
        </div>
        <div>
          <button type="button" id="btnConfirmAppt" class="primary-action-btn action-emerald btn-confirm" data-action="appt.confirmAppointmentFromEditor">${UIComponent.Keycap("ALT+C", "inverse", {className: "kbd-invert-emerald"})} ${appt ? 'SAVE CHANGES' : 'CONFIRM APPOINTMENT'}</button>
        </div>
      </div>
    </div>
  `;

  // Building the editor recalculates each inserted row. Do not treat that
  // initial render as a user edit and immediately write it back to SQLite.
  apptAutosaveSuspended = true;
  const apptLines = appt ? parseApptLines(appt.lines_json) : [];
  if (apptLines.length > 0) {
    apptLines.forEach(l => addApptLine(l));
  } else if (appt && appt.concern) {
    addApptLine({ concern: appt.concern, hrs: appt.estimated_hours || '1.0' });
  } else {
    addApptLine();
  }
  apptAutosaveSuspended = false;

  requestAnimationFrame(() => {
    updateApptButtonReadyStates();
    document.getElementById('apptCust')?.addEventListener('input', updateApptButtonReadyStates);
    if (window.EditorStack) {
      window.EditorStack.register('apptWriteupEditor', {
        cancelFn: () => {
          cancelAppointmentAutosave();
          requestNavigation('A');
        },
        getNormalizedSnapshot: getApptEditorNormalizedSnapshot
      });
    }
  });

  if (appt && appt.customer_name) {
    requestAnimationFrame(async () => {
      try {
        const res = await api('/api/history?query=' + encodeURIComponent(appt.customer_name));
        const matched = (res.history || []).find(r => r.vin && r.vin.length >= 8);
        if (matched && matched.vin) {
          const vinInp = document.getElementById('apptVin');
          if (vinInp && !vinInp.value.trim()) {
            vinInp.value = matched.vin;
            updateApptVinLast8Display(matched.vin);
          }
        }
      } catch (err) {}
    });
  }
}

function triggerApptConvertFromEditor() {
  if (activeEditingApptId) {
    convertApptToRo(activeEditingApptId);
  } else {
    document.getElementById('apptFullWriteupForm')?.requestSubmit();
  }
}

function printApptWriteupFromEditor() {
  if (activeEditingApptId) {
    // Inside the write-up editor
    printApptWriteup(activeEditingApptId);
  } else {
    // In the day list view — print the currently highlighted row
    const dayAppts = cachedAppointments.filter(a => {
      const d = a.appointment_date || (a.created_at ? a.created_at.slice(0, 10) : '');
      return d === activeApptDate && a.status !== 'CANCELLED';
    });
    const selected = dayAppts[activeApptRowIndex];
    if (selected) {
      printApptWriteup(selected.id);
    }
  }
}

function addApptLine(data = {}) {
  const tbody = document.getElementById('apptLinesWorkspaceBody');
  if (!tbody) return;

  const tr = document.createElement('tr');
  tr.className = 'appt-line-row';
  tr.innerHTML = `
    <td class="appt-line-num">1</td>
    <td class="u-align-center">
      <select class="appt-pay-select" data-change-action="appt.recalculateApptTotals">
        <option value="C" ${data.pay === 'C' ? 'selected' : ''}>C</option>
        <option value="W" ${data.pay === 'W' ? 'selected' : ''}>W</option>
        <option value="I" ${data.pay === 'I' ? 'selected' : ''}>I</option>
        <option value="G" ${data.pay === 'G' ? 'selected' : ''}>G</option>
      </select>
    </td>
    <td class="ui-relative">
      <input type="text" class="appt-line-input appt-opcode-input" value="${escapeHtml(data.op_code || '')}" placeholder="/ ↓ browse groups" data-input-action="appt.queueApptOpcodeDropdown" data-keydown-action="appt.handleSharedOpcodeKeydown" autocomplete="off">
      <div class="appt-opcode-dropdown hidden"></div>
    </td>
    <td><input type="text" class="appt-line-input appt-concern-input" value="${escapeHtml(data.concern || '')}" placeholder="Type Verbatim Customer Concern or Service Requested..."></td>
    <td>
      <select class="appt-line-input appt-line-tech-select" style="padding:4px; font-size:11px; font-weight:700; width:100%; background:var(--surface-input); color:var(--text-main); border:1px solid var(--border-soft);">
        ${generateTechnicianOptions(data.technician_id)}
      </select>
    </td>
    <td class="u-align-right"><input type="text" class="appt-line-input appt-hrs-input" data-input-action="appt.recalculateApptTotals" value="${data.hrs || ''}" placeholder="1.0"></td>
    <td class="u-align-right"><input type="text" class="appt-line-input appt-parts-input" data-input-action="appt.recalculateApptTotals" value="${data.parts || ''}" placeholder="0.00"></td>
    <td class="u-align-right"><input type="text" class="appt-line-input appt-labor-input" data-input-action="appt.labor-input" value="${data.labor || ''}" placeholder="auto"></td>
    <td class="appt-line-total">$0.00</td>
    <td class="u-align-center"><button type="button" class="line-remove-btn" data-action="appt.deleteApptLine" title="Remove Line">✕</button></td>
  `;
  tbody.appendChild(tr);
  recalculateApptTotals();
  updateApptButtonReadyStates();
}

function deleteApptLine(btn) {
  const tr = btn.closest('tr');
  if (tr) {
    tr.remove();
    recalculateApptTotals();
    updateApptButtonReadyStates();
  }
}

let recalcApptFrameId = null;
function recalculateApptTotals() {
  if (recalcApptFrameId !== null) return;
  recalcApptFrameId = requestAnimationFrame(() => {
    recalcApptFrameId = null;
    performApptTotalsCalculation();
  });
}

function performApptTotalsCalculation() {
  const tbody = document.getElementById('apptLinesWorkspaceBody');
  if (!tbody) return;

  let custPay = 0;
  let warrPay = 0;
  let intPay = 0;
  let goodwillPay = 0;
  let totalHours = 0;
  let masterTotal = 0;

  const rows = tbody.querySelectorAll('tr');
  rows.forEach((row, index) => {
    const lnBadge = row.querySelector('.appt-line-num');
    if (lnBadge) lnBadge.textContent = index + 1;

    const payType = row.querySelector('.appt-pay-select')?.value || 'C';
    const hrs = parseFloat(row.querySelector('.appt-hrs-input')?.value || 0) || 0;
    const parts = parseFloat(row.querySelector('.appt-parts-input')?.value || 0) || 0;
    const laborInp = row.querySelector('.appt-labor-input');

    // Auto-calculate labor from HRS x shop rate; only override if the user hasn't manually set a different value
    const autoLabor = parseFloat((hrs * shopLaborRate).toFixed(2));
    const currentLabor = parseFloat(laborInp?.value || 0) || 0;
    const isManual = laborInp && laborInp.dataset.manualOverride === '1';
    if (laborInp && !isManual) {
      laborInp.value = autoLabor.toFixed(2);
    }
    const labor = isManual ? currentLabor : autoLabor;

    const lineTotal = parts + labor;
    const totalEl = row.querySelector('.appt-line-total');
    if (totalEl) totalEl.textContent = `$${lineTotal.toFixed(2)}`;

    totalHours += hrs;
    masterTotal += lineTotal;

    if (payType === 'C') custPay += lineTotal;
    else if (payType === 'W') warrPay += lineTotal;
    else if (payType === 'I') intPay += lineTotal;
    else if (payType === 'G') goodwillPay += lineTotal;
  });

  const custEl = document.getElementById('apptCustPayTotal');
  const warrEl = document.getElementById('apptWarrPayTotal');
  const intEl = document.getElementById('apptIntPayTotal');
  const goodwillEl = document.getElementById('apptGoodwillPayTotal');
  const hrsEl = document.getElementById('apptTotalHours');
  const masterEl = document.getElementById('apptMasterTotal');

  if (custEl) custEl.textContent = `$${custPay.toFixed(2)}`;
  if (warrEl) warrEl.textContent = `$${warrPay.toFixed(2)}`;
  if (intEl) intEl.textContent = `$${intPay.toFixed(2)}`;
  if (goodwillEl) goodwillEl.textContent = `$${goodwillPay.toFixed(2)}`;
  if (hrsEl) hrsEl.textContent = `${totalHours.toFixed(2)} HRS`;
  if (masterEl) masterEl.textContent = `$${masterTotal.toFixed(2)}`;

  // Auto-save persistently in background after any field change
  if (typeof debouncedApptAutoSave === 'function') debouncedApptAutoSave();
}

/* ==========================================================================
   OPCODE HIERARCHY & KEYBOARD SEARCH LOGIC ('/' FOR CATEGORIES, BR/ FOR BRAKES)
   ========================================================================== */
function queueApptOpcodeDropdown(inputEl) {
  const dropdown = inputEl.parentNode.querySelector('.appt-opcode-dropdown');
  if (!dropdown) return;
  OpcodePicker.search(inputEl.value, inputEl, dropdown);
}


function formatVinLast8(vinStr) {
  const clean = (vinStr || '').trim().toUpperCase();
  if (clean.length >= 8) {
    const last8 = clean.slice(-8);
    return `<span class="vin-last-eight">LAST 8: ${escapeHtml(last8)}</span>`;
  }
  return '';
}

function updateApptVinLast8Display(val) {
  const subEl = document.getElementById('apptVinLast8Sub');
  if (subEl) subEl.innerHTML = formatVinLast8(val);
  const roSubEl = document.getElementById('roVinLast8Sub');
  if (roSubEl) roSubEl.innerHTML = formatVinLast8(val);
}

function toggleUnlockApptField(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.hasAttribute('readonly')) {
    input.removeAttribute('readonly');
    input.classList.remove('is-readonly');
    input.focus();
    if (btnEl) btnEl.innerHTML = '🔓 UNLOCKED';
  } else {
    input.setAttribute('readonly', 'true');
    input.classList.add('is-readonly');
    if (btnEl) btnEl.innerHTML = '🔒 LOCKED';
  }
}

function openApptAddPartModal() {
  const partNumber = prompt("ENTER PART NUMBER OR DESCRIPTION TO ADD TO WRITE-UP:");
  if (!partNumber) return;
  addApptLine({
    op_code: 'PARTS-ADD',
    concern: `PART REPLACEMENT: ${partNumber.toUpperCase()}`,
    hrs: '0.50',
    parts: '45.00',
    labor: '75.00',
    pay: 'C'
  });
}

let apptAutoSaveTimer = null;
let apptAutosaveSuspended = false;

function cancelAppointmentAutosave() {
  if (apptAutoSaveTimer) {
    clearTimeout(apptAutoSaveTimer);
    apptAutoSaveTimer = null;
  }
}

function debouncedApptAutoSave() {
  if (apptAutosaveSuspended) return;
  if (!activeEditingApptId && !document.getElementById('apptCust')?.value.trim()) return; // don't auto-save blank new form
  clearTimeout(apptAutoSaveTimer);
  const statusEl = document.getElementById('apptAutoSaveStatus');
  if (statusEl) statusEl.textContent = 'saving…';
  apptAutoSaveTimer = setTimeout(async () => {
    apptAutoSaveTimer = null;
    if (!document.getElementById('apptFullWriteupForm')) return;
    await silentSaveAppt();
  }, 900);
}

async function silentSaveAppt() {
  const existingAppt = activeEditingApptId ? cachedAppointments.find(a => a.id === activeEditingApptId) : null;
  const custInputVal = document.getElementById('apptCust')?.value.trim();
  const vehInputVal = document.getElementById('apptVeh')?.value.trim();

  const cust = custInputVal || existingAppt?.customer_name || '';
  const veh = vehInputVal || existingAppt?.vehicle_info || '';
  if (!cust && !veh) return; // nothing worth saving yet

  const plate = document.getElementById('apptPlate')?.value.trim() || '';
  const vin = document.getElementById('apptVin')?.value.trim() || '';
  const miles = document.getElementById('apptMiles')?.value.trim() || '';
  const fleetUnit = document.getElementById('apptFleetUnit')?.value.trim() || '';
  const po = document.getElementById('apptPo')?.value.trim() || '';
  const dateIso = document.getElementById('apptDateInput')?.value || activeApptDate;
  const timeStr = document.getElementById('apptTimeInput')?.value || '4:00 PM';
  const dropOffTime = document.getElementById('apptDropOffTimeInput')?.value || '';
  const firstTechSelect = document.querySelector('#apptLinesWorkspaceBody .appt-line-tech-select');
  const technicianId = firstTechSelect?.value ? parseInt(firstTechSelect.value) : null;
  const requiresCarryOver = Boolean(document.getElementById('apptCarryOverInput')?.checked);

  const tbody = document.getElementById('apptLinesWorkspaceBody');
  const rows = tbody ? tbody.querySelectorAll('tr') : [];
  const lines = [];
  let mainConcern = '';
  let totalHrs = 0;
  let masterTotal = 0;

  rows.forEach((r, idx) => {
    const pay = r.querySelector('.appt-pay-select')?.value || 'C';
    const op_code = r.querySelector('.appt-opcode-input')?.value.trim() || '';
    const concern = r.querySelector('.appt-concern-input')?.value.trim() || '';
    const techVal = r.querySelector('.appt-line-tech-select')?.value;
    const line_technician_id = techVal ? parseInt(techVal) : null;
    const hrs = parseFloat(r.querySelector('.appt-hrs-input')?.value || 0) || 0;
    const parts = parseFloat(r.querySelector('.appt-parts-input')?.value || 0) || 0;
    const labor = parseFloat(r.querySelector('.appt-labor-input')?.value || 0) || 0;
    if (idx === 0 && concern) mainConcern = concern;
    totalHrs += hrs;
    masterTotal += (parts + labor);
    if (op_code || concern || hrs > 0 || parts > 0 || labor > 0) {
      lines.push({ pay, op_code, concern, technician_id: line_technician_id, hrs, parts, labor, total: parts + labor });
    }
  });

  if (!mainConcern && lines.length > 0) mainConcern = lines[0].concern || lines[0].op_code;

  const statusEl = document.getElementById('apptAutoSaveStatus');
  try {
    const response = await api('/api/appointments', {
      method: 'POST',
      body: JSON.stringify({
        id: activeEditingApptId || undefined,
        customer: cust, vehicle: veh,
        concern: mainConcern || 'GENERAL SERVICE',
        pay_type: lines[0]?.pay || 'C',
        promised_time: timeStr, drop_off_time: dropOffTime, appointment_date: dateIso,
        preassigned_technician_id: technicianId,
        requires_carry_over: requiresCarryOver,
        license_plate: plate, vin, mileage: miles,
        fleet_unit: fleetUnit, po_number: po,
        lines, total_hours: totalHrs || 1.0, master_total: masterTotal
      })
    });
    const newId = response?.appointment?.id || response?.appointment_id || response?.id;
    if (newId) activeEditingApptId = newId;
    if (response?.appointment) {
      const savedIndex = cachedAppointments.findIndex(a => a.id === response.appointment.id);
      if (savedIndex >= 0) cachedAppointments[savedIndex] = response.appointment;
      else cachedAppointments.unshift(response.appointment);
    }
    if (statusEl) {
      statusEl.textContent = '✓ auto-saved';
      statusEl.className = 'appt-autosave-status feedback-success';
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2500);
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.code === 'TECH_OVERBOOKED'
        ? `⚠ ${err.technician} OVERBOOKED — MARK OVERNIGHT`
        : '⚠ save error';
      statusEl.className = 'appt-autosave-status feedback-error';
    }
  }
}

function updateApptButtonReadyStates() {
  const custName = document.getElementById('apptCust')?.value.trim() || '';
  const rows = [...document.querySelectorAll('#apptLinesWorkspaceBody tr')];
  const hasJobLine = rows.some(r => {
    const opcode = r.querySelector('.appt-opcode-input')?.value.trim();
    const concern = r.querySelector('.appt-concern-input')?.value.trim();
    return Boolean(opcode || concern);
  });

  const isReady = Boolean(custName && hasJobLine);

  const btnConfirm = document.getElementById('btnConfirmAppt');
  if (btnConfirm) {
    if (isReady) {
      btnConfirm.className = 'primary-action-btn action-emerald btn-confirm btn-ready-glow';
    } else {
      btnConfirm.className = 'primary-action-btn action-emerald btn-confirm';
    }
  }

  // Quietly expose History & Previous Recommendations contextually
  const vehName = document.getElementById('apptVeh')?.value.trim() || '';
  const contextActions = document.getElementById('apptContextualActions');
  if (contextActions) {
    if (custName || vehName) {
      contextActions.classList.remove('hidden');
    } else {
      contextActions.classList.add('hidden');
    }
  }
}

async function confirmAppointmentFromEditor() {
  if (window.AsyncOrchestrator) {
    return window.AsyncOrchestrator.executeMutation('#btnConfirmAppt', () => performConfirmAppointmentFromEditor());
  }
  return performConfirmAppointmentFromEditor();
}

async function performConfirmAppointmentFromEditor() {
  const form = document.getElementById('apptFullWriteupForm');
  if (!form || !form.reportValidity()) return;
  const cust = document.getElementById('apptCust')?.value.trim();
  if (!cust) {
    alert('CONFIRMATION BLOCKED!\n\nPlease select or enter a Customer Name before confirming the appointment.');
    document.getElementById('apptCust')?.focus();
    return;
  }

  const rows = [...document.querySelectorAll('#apptLinesWorkspaceBody tr')];
  const hasLine = rows.some(r => {
    const concern = r.querySelector('.appt-concern-input')?.value.trim();
    const op = r.querySelector('.appt-opcode-input')?.value.trim();
    return Boolean(concern || op);
  });

  if (!hasLine) {
    alert('CONFIRMATION BLOCKED!\n\nPlease add at least one job concern or op-code line item before confirming the appointment.');
    return;
  }

  const msgEl = document.getElementById('apptAutoSaveStatus');
  if (msgEl) {
    msgEl.textContent = 'CONFIRMING APPOINTMENT…';
    msgEl.style.color = 'var(--accent-emerald)';
  }

  await submitNewAppt(null, false, 'CONFIRMED');
}

async function submitNewAppt(e, isRetryAfterOverbook = false, targetStatus = 'CONFIRMED') {
  if (e) e.preventDefault();
  const cust = document.getElementById('apptCust').value.trim();
  const veh = document.getElementById('apptVeh').value.trim();
  const plate = document.getElementById('apptPlate')?.value.trim() || '';
  const vin = document.getElementById('apptVin')?.value.trim() || '';
  const miles = document.getElementById('apptMiles')?.value.trim() || '';
  const fleetUnit = document.getElementById('apptFleetUnit')?.value.trim() || '';
  const po = document.getElementById('apptPo')?.value.trim() || '';
  const dateIso = document.getElementById('apptDateInput')?.value || activeApptDate;
  const timeStr = document.getElementById('apptTimeInput')?.value || '4:00 PM';
  const dropOffTime = document.getElementById('apptDropOffTimeInput')?.value || '';
  const firstTechSelect = document.querySelector('#apptLinesWorkspaceBody .appt-line-tech-select');
  const technicianId = firstTechSelect?.value ? parseInt(firstTechSelect.value) : null;
  const carryOverInput = document.getElementById('apptCarryOverInput');
  const requiresCarryOver = Boolean(isRetryAfterOverbook || carryOverInput?.checked);
  const msgEl = document.getElementById('apptAutoSaveStatus') || document.getElementById('apptFormMessage');

  // Collect line items
  const tbody = document.getElementById('apptLinesWorkspaceBody');
  const rows = tbody ? tbody.querySelectorAll('tr') : [];
  const lines = [];
  let mainConcern = '';
  let totalHrs = 0;
  let masterTotal = 0;

  rows.forEach((r, idx) => {
    const pay = r.querySelector('.appt-pay-select')?.value || 'C';
    const op_code = r.querySelector('.appt-opcode-input')?.value.trim() || '';
    const concern = r.querySelector('.appt-concern-input')?.value.trim() || '';
    const techVal = r.querySelector('.appt-line-tech-select')?.value;
    const line_technician_id = techVal ? parseInt(techVal) : null;
    const hrs = parseFloat(r.querySelector('.appt-hrs-input')?.value || 0) || 0;
    const parts = parseFloat(r.querySelector('.appt-parts-input')?.value || 0) || 0;
    const labor = parseFloat(r.querySelector('.appt-labor-input')?.value || 0) || 0;

    if (idx === 0 && concern) mainConcern = concern;
    totalHrs += hrs;
    masterTotal += (parts + labor);

    if (op_code || concern || hrs > 0 || parts > 0 || labor > 0) {
      lines.push({ pay, op_code, concern, technician_id: line_technician_id, hrs, parts, labor, total: parts + labor });
    }
  });

  if (!mainConcern && lines.length > 0) mainConcern = lines[0].concern || lines[0].op_code;

  if (msgEl) {
    msgEl.textContent = 'SAVING APPOINTMENT WRITE-UP…';
    msgEl.className = 'feedback-neutral';
  }

  try {
    const response = await api('/api/appointments', {
      method: 'POST',
      body: JSON.stringify({
        id: activeEditingApptId || undefined,
        customer: cust,
        vehicle: veh,
        concern: mainConcern || 'GENERAL SERVICE',
        pay_type: lines[0]?.pay || 'C',
        promised_time: timeStr,
        drop_off_time: dropOffTime,
        preassigned_technician_id: technicianId,
        requires_carry_over: requiresCarryOver,
        appointment_date: dateIso,
        license_plate: plate,
        vin,
        mileage: miles,
        fleet_unit: fleetUnit,
        po_number: po,
        lines,
        total_hours: totalHrs || 1.0,
        master_total: masterTotal,
        status: targetStatus || 'CONFIRMED'
      })
    });

    const newId = response?.appointment?.id || response?.appointment_id || response?.id;
    if (newId) {
      activeEditingApptId = newId;
    }

    if (msgEl) {
      msgEl.textContent = `APPOINTMENT WRITE-UP CONFIRMED — ${cust} @ ${dateIso} ${timeStr}`;
      msgEl.className = 'feedback-success';
    }

    alert(`APPOINTMENT CONFIRMED & LOCKED IN!\n\nCustomer: ${cust}\nDate: ${dateIso}\nTime: ${timeStr}\nStatus: CONFIRMED`);

    setTimeout(() => {
      requestNavigation('A');
      activeApptDate = dateIso;
      loadAppointments(true);
    }, 500);

  } catch (err) {
    if (err.code === 'TECH_OVERBOOKED') {
      const approved = confirm(`${err.technician} is assigned ${Number(err.assigned_hours).toFixed(1)} of ${Number(err.daily_limit).toFixed(1)} hours. This appointment would raise the total to ${Number(err.projected_hours).toFixed(1)} hours.\n\nMark this appointment as CARRY-OVER / OVERNIGHT and continue?`);
      if (approved) {
        if (carryOverInput) carryOverInput.checked = true;
        return submitNewAppt(null, true);
      }
    }
    if (msgEl) {
      msgEl.textContent = err.message.toUpperCase();
      msgEl.className = 'feedback-warning';
    }
  }
}

/* ==========================================================================
   5. CONVERT APPOINTMENT TO ACTIVE REPAIR ORDER
   ========================================================================== */
async function convertApptToRo(apptId) {
  try {
    const result = await api(`/api/appointments/${apptId}/convert`, { method: 'POST' });
    await Promise.all([loadAppointments(true), loadRepairOrders()]);
    requestNavigation('O');
    expandRoByNumber(result.repair_order.id);
  } catch (err) {
    alert(`APPOINTMENT CONVERSION FAILED: ${err.message}`);
  }
}

function printApptWriteup(apptId) {
  const appt = cachedAppointments.find(a => a.id === apptId);
  if (!appt) return;

  const lines = parseApptLines(appt.lines_json);
  const printWindow = window.open('', '_blank');
  if (!printWindow) return;

  const linesRows = lines.length ? lines.map((l, i) => `
    <tr>
      <td class="line-cell">${i + 1}</td>
      <td class="line-cell">[${escapeHtml(l.pay || 'C')}] ${escapeHtml(l.op_code || '-')}</td>
      <td class="line-cell">${escapeHtml(l.concern || '')}</td>
      <td class="line-cell numeric">${parseFloat(l.hrs || 0).toFixed(2)}</td>
      <td class="line-cell numeric">$${parseFloat(l.parts || 0).toFixed(2)}</td>
      <td class="line-cell numeric">$${parseFloat(l.labor || 0).toFixed(2)}</td>
    </tr>
  `).join('') : `<tr><td colspan="6" class="empty-line">${escapeHtml(appt.concern || 'GENERAL SERVICE')}</td></tr>`;

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>APPOINTMENT WRITE-UP CONFIRMATION &amp; SIGN-IN — #${appt.id}</title>
      <style>
        body { font-family: monospace; padding: 20px; color: #000; }
        h2 { margin-bottom: 4px; }
        table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 12px; }
        th { text-align: left; border-bottom: 2px solid #000; padding: 6px; }
        .line-cell { padding: 6px; border-bottom: 1px solid #ccc; }
        .numeric { text-align: right; }
        .empty-line { padding: 10px; text-align: center; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; font-size: 12px; }
        .totals { margin-top: 20px; font-size: 11px; }
        .sig-box { margin-top: 40px; border-top: 1px dashed #000; padding-top: 10px; display: flex; justify-content: space-between; }
      </style>
    </head>
    <body>
      <h2>TaktRO — SERVICE APPOINTMENT WRITE-UP RECORD</h2>
      <div>APPOINTMENT ID: #${appt.id} | DATE: ${escapeHtml(appt.appointment_date || '')} | PROMISED: ${escapeHtml(appt.promised_time || '')}</div>
      <hr>
      <div class="info-grid">
        <div><strong>CUSTOMER:</strong> ${escapeHtml(appt.customer_name)}</div>
        <div><strong>VEHICLE:</strong> ${escapeHtml(appt.vehicle_info)}</div>
        <div><strong>VIN:</strong> ${escapeHtml(appt.vin || 'N/A')}</div>
        <div><strong>LICENSE PLATE:</strong> ${escapeHtml(appt.license_plate || 'N/A')}</div>
        <div><strong>MILEAGE:</strong> ${escapeHtml(appt.mileage || 'N/A')}</div>
        <div><strong>PO NUMBER:</strong> ${escapeHtml(appt.po_number || 'N/A')}</div>
      </div>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>OP-CODE</th>
            <th>JOB DESCRIPTION / CUSTOMER CONCERN</th>
            <th class="u-align-right">HRS</th>
            <th class="u-align-right">PARTS</th>
            <th class="u-align-right">LABOR</th>
          </tr>
        </thead>
        <tbody>
          ${linesRows}
        </tbody>
      </table>

      <div class="totals">
        <strong>ESTIMATED TOTAL HOURS:</strong> ${parseFloat(appt.estimated_hours || appt.total_hours || 1.0).toFixed(2)} HRS |
        <strong>ESTIMATED COST:</strong> $${parseFloat(appt.master_total || 0).toFixed(2)}
      </div>

      <div class="sig-box">
        <div>CUSTOMER AUTHORIZATION SIGNATURE: ___________________________</div>
        <div>DATE: ______________</div>
      </div>

      <script>
        window.onload = function() { window.print(); };
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

function generateShopPromisedTimeOptions(openHour = 8, closeHour = 17, intervalMinutes = 15, selectedVal = null) {
  const options = [];
  const formatTimeSlot = (hour, min) => {
    const period = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 === 0 ? 12 : hour % 12;
    const displayMin = min < 10 ? `0${min}` : min;
    return `${displayHour}:${displayMin} ${period}`;
  };

  for (let h = openHour; h <= closeHour; h++) {
    for (let m = 0; m < 60; m += intervalMinutes) {
      if (h === closeHour && m > 0) break;
      const timeStr = formatTimeSlot(h, m);
      const isSel = selectedVal ? (selectedVal.toUpperCase() === timeStr.toUpperCase()) : (h === 16 && m === 30);
      options.push(`<option value="${timeStr}" ${isSel ? 'selected' : ''}>${timeStr}</option>`);
    }
  }
  return options.join('');
}

function queueApptCustomerSearch(query) {
  clearTimeout(apptCustomerSearchTimer);
  const dropdown = document.getElementById('apptCustSearchResults');
  if (!dropdown) return;

  if (!query.trim()) {
    dropdown.innerHTML = '';
    dropdown.classList.add('hidden');
    apptCustomerSearchResults = [];
    apptCustActiveIndex = 0;
    return;
  }

  apptCustomerSearchTimer = setTimeout(() => searchApptCustomers(query), 150);
}

async function searchApptCustomers(query) {
  const dropdown = document.getElementById('apptCustSearchResults');
  if (!dropdown) return;

  try {
    const response = await api(`/api/customers?q=${encodeURIComponent(query.trim())}`);
    apptCustomerSearchResults = response.customers;
    apptCustActiveIndex = 0;
    renderApptCustomerDropdown();
  } catch (err) {
    dropdown.innerHTML = `<div class="typeahead-message typeahead-message--error">${escapeHtml(err.message)}</div>`;
    dropdown.classList.remove('hidden');
  }
}

function renderApptCustomerDropdown() {
  const dropdown = document.getElementById('apptCustSearchResults');
  if (!dropdown) return;

  if (!apptCustomerSearchResults.length) {
    dropdown.innerHTML = '<div class="typeahead-message">NO MATCHING CUSTOMERS.</div>';
    dropdown.classList.remove('hidden');
    return;
  }

  dropdown.innerHTML = apptCustomerSearchResults.map((cust, index) => {
    const isActive = index === apptCustActiveIndex;
    return `
      <div class="appt-cust-search-row ui-search-result ${isActive ? 'is-active' : ''}" tabindex="0" aria-selected="${isActive}" data-action="appt.selectApptCustomer" data-action-param="${escapeHtml(cust.id)}">
        <div class="typeahead-result-main">
          ${UIComponent.Keycap(index + 1, "index", {className: "typeahead-result-key"})}
          <strong class="typeahead-result-name">${escapeHtml(cust.name)}</strong>
          ${cust.customer_type ? `<div class="typeahead-result-subline">${escapeHtml(cust.customer_type)}</div>` : ''}
        </div>
        <div class="typeahead-result-meta">
          <span>${escapeHtml(cust.phone || 'NO PHONE')}</span>
        </div>
      </div>
    `;
  }).join('');

  dropdown.classList.remove('hidden');
}

async function selectApptCustomer(customerId) {
  const dropdown = document.getElementById('apptCustSearchResults');
  if (dropdown) dropdown.classList.add('hidden');

  try {
    const response = await api(`/api/customers/${customerId}`);
    const customer = response.customer;

    const custInput = document.getElementById('apptCust');
    const vehInput = document.getElementById('apptVeh');

    if (custInput) custInput.value = customer.name.toUpperCase();
    if (customer.vehicles && customer.vehicles.length > 0) {
      const mainVeh = customer.vehicles[0];
      if (vehInput) vehInput.value = formatVehicleYMM(mainVeh);
      const vinInput = document.getElementById('apptVin');
      const plateInput = document.getElementById('apptPlate');
      if (vinInput && mainVeh.vin) {
        vinInput.value = mainVeh.vin;
        updateApptVinLast8Display(mainVeh.vin);
      }
      if (plateInput && mainVeh.license_plate) {
        plateInput.value = mainVeh.license_plate;
      }
    }

    const isCommercial = customer && (customer.customer_type === 'FLEET' || customer.customer_type === 'COMPANY' || customer.customer_type === 'COMMERCIAL' || customer.customer_type === 'WHOLESALE' || (customer.customer_type && customer.customer_type !== 'RETAIL') || customer.fleet_unit_number || customer.po_number);

    const fleetContainer = document.getElementById('apptFleetUnitContainer');
    if (fleetContainer) fleetContainer.classList.toggle('hidden', !isCommercial);

    const poContainer = document.getElementById('apptPoContainer');
    if (poContainer) poContainer.classList.toggle('hidden', !isCommercial);

    const fleetInput = document.getElementById('apptFleetUnit');
    if (fleetInput) fleetInput.value = customer.fleet_unit_number || '';
  } catch (err) {
    console.error('Error selecting customer for appointment:', err);
  }
}

function handleApptCustSearchKeydown(e) {
  handleTypeaheadNavigation(e, {
    dropdown: document.getElementById('apptCustSearchResults'), results: apptCustomerSearchResults,
    activeIndex: apptCustActiveIndex, setActiveIndex: value => { apptCustActiveIndex = value; },
    render: renderApptCustomerDropdown, select: selectApptCustomer, valueForResult: customer => customer.id
  });
}

function queueApptVehicleSearch(query) {
  clearTimeout(apptVehicleSearchTimer);
  const dropdown = document.getElementById('apptVehSearchResults');
  if (!dropdown) return;

  if (!query.trim()) {
    dropdown.innerHTML = '';
    dropdown.classList.add('hidden');
    apptVehicleSearchResults = [];
    apptVehActiveIndex = 0;
    return;
  }

  apptVehicleSearchTimer = setTimeout(() => searchApptVehicles(query), 150);
}

async function searchApptVehicles(query) {
  const dropdown = document.getElementById('apptVehSearchResults');
  if (!dropdown) return;

  try {
    const response = await api(`/api/vehicles?q=${encodeURIComponent(query.trim())}`);
    apptVehicleSearchResults = response.vehicles;
    apptVehActiveIndex = 0;
    renderApptVehicleDropdown();
  } catch (err) {
    dropdown.innerHTML = `<div class="typeahead-message typeahead-message--error">${escapeHtml(err.message)}</div>`;
    dropdown.classList.remove('hidden');
  }
}

function renderApptVehicleDropdown() {
  const dropdown = document.getElementById('apptVehSearchResults');
  if (!dropdown) return;

  if (!apptVehicleSearchResults.length) {
    dropdown.innerHTML = '<div class="typeahead-message">NO MATCHING VEHICLES.</div>';
    dropdown.classList.remove('hidden');
    return;
  }

  dropdown.innerHTML = apptVehicleSearchResults.map((veh, index) => {
    const isActive = index === apptVehActiveIndex;
    const ymm = formatVehicleYMM(veh);
    return `
      <div class="appt-veh-search-row ui-search-result ${isActive ? 'is-active' : ''}" tabindex="0" aria-selected="${isActive}" data-action="appt.selectApptVehicle" data-action-param="${escapeHtml(index)}">
        <div class="typeahead-result-main">
          ${UIComponent.Keycap(index + 1, "index", {className: "typeahead-result-key"})}
          <strong class="typeahead-result-name">${escapeHtml(ymm)}</strong>
          ${(veh.license_plate || veh.vin) ? `<div class="typeahead-result-subline">${veh.license_plate ? `PLATE ${escapeHtml(veh.license_plate)}` : ''}${veh.vin ? `${veh.license_plate ? ' · ' : ''}VIN …${escapeHtml(veh.vin.slice(-8))}` : ''}</div>` : ''}
        </div>
        <div class="typeahead-result-meta">
          ${veh.customer_name ? `<span class="typeahead-result-owner">${escapeHtml(veh.customer_name)}</span>` : 'NO OWNER'}
        </div>
      </div>
    `;
  }).join('');

  dropdown.classList.remove('hidden');
}

function selectApptVehicle(index) {
  const veh = apptVehicleSearchResults[index];
  if (!veh) return;

  const dropdown = document.getElementById('apptVehSearchResults');
  if (dropdown) dropdown.classList.add('hidden');

  const vehInput = document.getElementById('apptVeh');
  const custInput = document.getElementById('apptCust');
  const vinInput = document.getElementById('apptVin');
  const plateInput = document.getElementById('apptPlate');

  if (vehInput) vehInput.value = formatVehicleYMM(veh);
  if (custInput && !custInput.value.trim() && veh.customer_name) {
    custInput.value = veh.customer_name.toUpperCase();
  }
  if (vinInput && veh.vin) {
    vinInput.value = veh.vin;
    updateApptVinLast8Display(veh.vin);
  }
  if (plateInput && veh.license_plate) plateInput.value = veh.license_plate;
}

function handleApptVehSearchKeydown(e) {
  handleTypeaheadNavigation(e, {
    dropdown: document.getElementById('apptVehSearchResults'), results: apptVehicleSearchResults,
    activeIndex: apptVehActiveIndex, setActiveIndex: value => { apptVehActiveIndex = value; },
    render: renderApptVehicleDropdown, select: selectApptVehicle
  });
}

/* ==========================================================================
   DEFERRED WRITE-UPS VIEW & APPOINTMENT MANAGEMENT MODAL (DELETE/RESCHEDULE/DEFER)
   ========================================================================== */
function renderApptDeferredView(container) {
  const deferredAppts = cachedAppointments.filter(a => a.status === 'DEFERRED');

  let tableRows = '';
  if (deferredAppts.length === 0) {
    tableRows = `<tr><td colspan="5" class="empty-state-cell">NO DEFERRED APPOINTMENT WRITE-UPS ON HOLD.</td></tr>`;
  } else {
    tableRows = deferredAppts.map((a, idx) => {
      const hrs = parseFloat(a.estimated_hours || a.total_hours || 1.0);
      const linesCount = parseApptLines(a.lines_json).length;
      const linesLabel = linesCount > 0
        ? `<span class="appt-deferred-lines">[${linesCount} line${linesCount > 1 ? 's' : ''}]</span>`
        : '';

      return `
        <tr tabindex="0" class="appt-deferred-row" data-action="appt.openApptWriteupEditor" data-action-param="${escapeHtml(a.id)}">
          <td class="appt-deferred-customer">
            ${escapeHtml(a.customer_name)}
            ${a.po_number ? `<div class="ui-note-dim">PO: ${escapeHtml(a.po_number)}</div>` : ''}
          </td>
          <td class="u-text-muted">
            ${escapeHtml(a.vehicle_info)}
          </td>
          <td class="u-text-main">
            ${escapeHtml(a.concern || 'GENERAL SERVICE')} ${linesLabel}
          </td>
          <td class="appt-deferred-hours">${hrs.toFixed(1)} HRS</td>
          <td class="appt-deferred-actions">
            <div class="ui-row-end-6">
              <button class="primary-action-btn appt-rebook-button" data-action="appt.promptApptManageModal" data-action-param="${escapeHtml(a.id)}">${UIComponent.Keycap("ALT+R", "inverse", {className: "kbd-invert"})} RE-BOOK</button>
              <button class="secondary-action-btn action-caution action-compact" data-action="appt.promptApptManageModal" data-action-param="${escapeHtml(a.id)}" title="Reschedule, defer, or permanently delete appointment">MANAGE</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  container.innerHTML = `
    <div class="ui-stack-12">
      <div class="appt-deferred-toolbar">
        <div>
          <strong class="ui-heading-amber">DEFERRED WRITE-UPS (ON HOLD)</strong>
          <span class="appt-deferred-count">Total Held Write-ups: <strong class="u-text-main">${deferredAppts.length}</strong></span>
        </div>
        <div class="appt-deferred-help">
          All write-up concerns, line items &amp; totals retained. Click RE-BOOK to assign to shop schedule.
        </div>
      </div>

      <table class="ui-table">
        <thead>
          <tr class="appt-deferred-head">
            <th class="appt-deferred-head-customer">CUSTOMER</th>
            <th class="appt-deferred-head-vehicle">VEHICLE</th>
            <th>SERVICE CONCERN / HELD LINE ITEMS</th>
            <th class="appt-deferred-head-hours">EST. HRS</th>
            <th class="appt-deferred-head-actions">ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
  `;
}

function promptApptManageModal(apptId) {
  const appt = cachedAppointments.find(a => a.id === apptId);
  if (!appt) return;

  document.getElementById('apptManageModalOverlay')?.remove();

  const linesCount = parseApptLines(appt.lines_json).length;
  const linesSummary = linesCount > 0 ? ` (${linesCount} line item${linesCount > 1 ? 's' : ''})` : '';

  const modalHtml = `
    <div id="apptManageModalOverlay" class="ui-modal-overlay">
      <div class="ui-modal-dialog ui-modal-dialog--compact">

        <!-- HEADER -->
        <div class="ui-modal-header">
          <div>
            <strong class="appt-manage-title">MANAGE APPOINTMENT RECORD #${appt.id}</strong>
            <div class="appt-manage-identity">${escapeHtml(appt.customer_name)} — ${escapeHtml(appt.vehicle_info)}</div>
          </div>
          <button class="modal-close-btn" aria-label="Close appointment management" data-action="appt.closeApptManageModal">✕</button>
        </div>

        <!-- CONCERN SUMMARY -->
        <div class="appt-manage-summary">
          <span class="u-text-muted">SERVICE: </span>
          <strong class="u-text-main">${escapeHtml(appt.concern || 'GENERAL SERVICE')}</strong>
          <span class="appt-manage-line-count">${linesSummary}</span>
        </div>

        <!-- OPTIONS GRID -->
        <div class="appt-manage-options">

          <!-- OPTION 1: RESCHEDULE -->
          <div class="appt-manage-option appt-manage-option--reschedule">
            <div class="appt-manage-option-title">📅 RESCHEDULE APPOINTMENT</div>
            <div class="appt-reschedule-fields">
              <input type="date" id="rescheduleDateInput" class="appt-reschedule-control" value="${appt.appointment_date || activeApptDate}">
              <select id="rescheduleTimeInput" class="ui-dark-select appt-reschedule-time">
                ${generateShopPromisedTimeOptions(8, 17, 15, appt.promised_time || '4:00 PM')}
              </select>
            </div>
            <button class="secondary-action-btn action-success appt-manage-action" data-action="appt.submitApptReschedule" data-action-param="${escapeHtml(appt.id)}">CONFIRM RESCHEDULE</button>
          </div>

          <!-- OPTION 2: DEFER -->
          <div class="appt-manage-option appt-manage-option--defer">
            <div class="appt-manage-option-title">⏱ DEFER WORK (HELD WRITE-UP)</div>
            <div class="appt-manage-description">
              Removes date/time &amp; releases shop capacity. Customer, vehicle, labor, and line items stay available for re-booking without re-typing.
            </div>
            <button class="secondary-action-btn action-caution appt-manage-action" data-action="appt.submitApptDefer" data-action-param="${escapeHtml(appt.id)}">DEFER WORK — RELEASE SHOP CAPACITY</button>
          </div>

          <!-- OPTION 3: PERMANENT DELETE -->
          <div class="appt-manage-option appt-manage-option--delete">
            <div class="appt-manage-option-title">PERMANENTLY DELETE APPOINTMENT</div>
            <div class="appt-manage-description">
              Permanently erases this appointment and its write-up. This cannot be undone.
            </div>
            <button class="secondary-action-btn action-danger appt-manage-action" data-action="appt.submitApptDelete" data-action-param="${escapeHtml(appt.id)}">PERMANENTLY DELETE APPOINTMENT</button>
          </div>

        </div>

      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function closeApptManageModal() {
  document.getElementById('apptManageModalOverlay')?.remove();
}

async function submitApptReschedule(apptId) {
  const newDate = document.getElementById('rescheduleDateInput')?.value || activeApptDate;
  const newTime = document.getElementById('rescheduleTimeInput')?.value || '4:00 PM';
  closeApptManageModal();
  try {
    await api(`/api/appointments/${apptId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'SCHEDULED', appointment_date: newDate, promised_time: newTime })
    });
    activeApptDate = newDate;
    await loadAppointments(true);
  } catch (err) {
    if (err && err.message && err.message.toLowerCase().includes('not found')) {
      await loadAppointments(true);
    } else {
      alert('Error rescheduling appointment: ' + err.message);
    }
  }
}

async function submitApptDefer(apptId) {
  closeApptManageModal();
  try {
    await api(`/api/appointments/${apptId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'DEFERRED' })
    });
    await loadAppointments(true);
  } catch (err) {
    if (err && err.message && err.message.toLowerCase().includes('not found')) {
      await loadAppointments(true);
    } else {
      alert('Error deferring appointment: ' + err.message);
    }
  }
}

async function submitApptDelete(apptId) {
  if (!confirm('Permanently delete this appointment and its complete write-up? This cannot be undone.')) return;
  closeApptManageModal();
  try {
    await api(`/api/appointments/${apptId}`, { method: 'DELETE' });
    await loadAppointments(true);
  } catch (err) {
    if (err && err.message && err.message.toLowerCase().includes('not found')) {
      await loadAppointments(true);
    } else {
      alert('Error deleting appointment: ' + err.message);
    }
  }
}

/* ==========================================================================
   LIVE SERVICE HISTORY MODAL (VEHICLE & CUSTOMER HISTORY LOOKUP)
   ========================================================================== */
function openApptServiceHistoryModal() {
  const cust = document.getElementById('apptCust')?.value.trim() || '';
  const veh = document.getElementById('apptVeh')?.value.trim() || '';
  const vin = document.getElementById('apptVin')?.value.trim() || '';
  const plate = document.getElementById('apptPlate')?.value.trim() || '';
  const query = cust || veh || vin || plate || '';
  openServiceHistoryModal(query);
}

function openRoServiceHistoryModal() {
  const cust = document.getElementById('roCustInput')?.value.trim() || '';
  const veh = document.getElementById('roVehInput')?.value.trim() || '';
  const vin = document.getElementById('roVinInput')?.value.trim() || '';
  const plate = document.getElementById('roPlateInput')?.value.trim() || '';
  const query = cust || veh || vin || plate || '';
  openServiceHistoryModal(query);
}

function closeServiceHistoryModal() {
  document.getElementById('serviceHistoryModalOverlay')?.remove();
}

async function openServiceHistoryModal(initialQuery = '') {
  document.getElementById('serviceHistoryModalOverlay')?.remove();

  const modalHtml = `
    <div id="serviceHistoryModalOverlay" class="ui-modal-overlay">
      <div class="ui-modal-dialog ui-modal-dialog--history">

        <!-- HEADER -->
        <div class="ui-modal-header ui-mb-12">
          <div>
            <strong class="history-title">📜 CUSTOMER &amp; VEHICLE SERVICE HISTORY</strong>
            <div class="history-subtitle">Search prior write-ups, active repair orders, and completed jobs</div>
          </div>
          <button class="modal-close-btn" aria-label="Close service history" data-action="appt.closeServiceHistoryModal">✕</button>
        </div>

        <!-- SEARCH FILTER BAR -->
        <div class="ui-mb-12">
          <input type="text" id="historyModalSearchInput" class="history-search" value="${escapeHtml(initialQuery)}" placeholder="Search by customer name, vehicle YMM, VIN, license plate, or job code..." data-input-action="appt.queueHistorySearch">
        </div>

        <!-- HISTORY RESULTS CONTAINER -->
        <div id="historyModalResults" class="history-results">
          <div class="history-message">SEARCHING SERVICE HISTORY…</div>
        </div>

      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  fetchAndRenderHistoryResults(initialQuery);
}

function queueHistorySearch(value) {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => {
    historySearchTimer = null;
    fetchAndRenderHistoryResults(value);
  }, 180);
}

async function fetchAndRenderHistoryResults(queryStr) {
  const container = document.getElementById('historyModalResults');
  if (!container) return;

  try {
    const res = await api('/api/history?query=' + encodeURIComponent(queryStr.trim()));
    const records = res.history || [];

    if (records.length === 0) {
      container.innerHTML = `<div class="history-message history-message--empty">NO PRIOR SERVICE HISTORY FOUND ${queryStr ? `MATCHING "${escapeHtml(queryStr.toUpperCase())}"` : ''}.</div>`;
      return;
    }

    container.innerHTML = records.map(r => {
      const lines = parseApptLines(r.lines_json);
      const isConverted = r.status === 'CONVERTED';
      const isDeferred = r.status === 'DEFERRED';

      const statusBadge = isConverted
        ? `<span class="history-status history-status--converted">CONVERTED TO RO</span>`
        : isDeferred
        ? `<span class="history-status history-status--deferred">DEFERRED (HELD)</span>`
        : `<span class="history-status">${r.status}</span>`;

      const linesTable = lines.length > 0 ? `
        <table class="history-lines">
          <thead>
            <tr class="history-lines-head">
              <th>PAY</th>
              <th>OP-CODE</th>
              <th>JOB DESCRIPTION</th>
              <th class="u-align-right">HRS</th>
              <th class="u-align-right">PARTS</th>
              <th class="u-align-right">LABOR</th>
              <th class="u-align-right">TOTAL</th>
            </tr>
          </thead>
          <tbody>
            ${lines.map(l => `
              <tr class="history-line">
                <td class="history-line-pay history-line-pay--${String(l.pay || 'C').toLowerCase()}">${escapeHtml(l.pay || 'C')}</td>
                <td class="history-line-code">${escapeHtml(l.op_code || '-')}</td>
                <td class="u-text-main">${escapeHtml(l.concern || '')}</td>
                <td class="history-line-number">${(l.hrs || 0).toFixed(1)}</td>
                <td class="history-line-number">$${(l.parts || 0).toFixed(2)}</td>
                <td class="history-line-number">$${(l.labor || 0).toFixed(2)}</td>
                <td class="history-line-total">$${((l.parts || 0) + (l.labor || 0)).toFixed(2)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : `<div class="history-concern">${escapeHtml(r.concern || 'GENERAL SERVICE')}</div>`;

      return `
        <div class="history-card">
          <div class="history-card-header">
            <div>
              <strong class="u-text-amber">RECORD #${r.id}</strong>
              <span class="history-date">${r.appointment_date || (r.created_at ? r.created_at.slice(0, 10) : '')} ${r.promised_time || ''}</span>
              ${statusBadge}
            </div>
            <div class="history-total">
              ${(r.total_hours || r.estimated_hours || 1.0).toFixed(1)} HRS &nbsp; | &nbsp; $${(r.master_total || 0).toFixed(2)}
            </div>
          </div>
          <div class="history-identity">
            <span>${escapeHtml(r.customer_name)} — ${escapeHtml(r.vehicle_info)}</span>
            <span class="ui-label-dim">${r.vin ? `VIN: ${escapeHtml(r.vin)}` : ''} ${r.license_plate ? `PLATE: ${escapeHtml(r.license_plate)}` : ''}</span>
          </div>
          ${linesTable}
        </div>
      `;
    }).join('');

  } catch (err) {
    container.innerHTML = `<div class="history-message history-message--error">FAILED TO LOAD HISTORY: ${escapeHtml(err.message)}</div>`;
  }
}

if (window.WorkspaceLifecycle) {
  window.WorkspaceLifecycle.register('A', {
    getInitialState: () => ({
      viewMode: 'day',
      date: typeof activeApptDate !== 'undefined' ? activeApptDate : '2026-08-20',
      selectedId: null,
      activeRowIndex: 0,
      editorMode: 'schedule'
    }),
    mount: (container) => {
      container.setAttribute('data-workspace', 'appointments');
    },
    load: async (state) => {
      if (typeof loadAppointments === 'function') {
        await loadAppointments();
      }
      return typeof activeApptList !== 'undefined' ? activeApptList : [];
    },
    render: () => {
      return typeof renderAppointmentsContent === 'function' ? renderAppointmentsContent() : '';
    },
    interact: () => {
      if (typeof updateApptActiveRowHighlight === 'function') {
        updateApptActiveRowHighlight();
      }
    },
    unmount: () => {
      // transient cleanup
    }
  });
}


document.addEventListener('DOMContentLoaded', () => {
  const actions = {
    "appt.view-day": (param, element, event) => setApptViewMode('day'),
    "appt.view-week": (param, element, event) => setApptViewMode('week'),
    "appt.view-month": (param, element, event) => setApptViewMode('month'),
    "appt.view-deferred": (param, element, event) => setApptViewMode('deferred'),
    "appt.previous-date": (param, element, event) => shiftApptDate(-1),
    "appt.onApptDateSelect": (param, element, event) => onApptDateSelect(element.value),
    "appt.setApptDateToToday": (param, element, event) => setApptDateToToday(),
    "appt.next-date": (param, element, event) => shiftApptDate(1),
    "appt.openNewApptDialog": (param, element, event) => openNewApptDialog(),
    "appt.promptApptManageModal": (param, element, event) => promptApptManageModal(Number(param)),
    "appt.printApptWriteup": (param, element, event) => printApptWriteup(Number(param)),
    "appt.convertApptToRo": (param, element, event) => convertApptToRo(Number(param)),
    "appt.openApptWriteupEditor": (param, element, event) => openApptWriteupEditor(Number(param)),
    "appt.selectApptDateAndDayView": (param, element, event) => selectApptDateAndDayView(param),
    "appt.requestNavigation": (param, element, event) => requestNavigation('A'),
    "appt.printApptWriteupFromEditor": (param, element, event) => printApptWriteupFromEditor(),
    "appt.triggerApptConvertFromEditor": (param, element, event) => triggerApptConvertFromEditor(),
    "appt.submitNewAppt": (param, element, event) => submitNewAppt(event),
    "appt.customer-search": (_, element) => { queueApptCustomerSearch(element.value); updateApptButtonReadyStates(); },
    "appt.handleApptCustSearchKeydown": (param, element, event) => handleApptCustSearchKeydown(event),
    "appt.vehicle-search": (_, element) => { queueApptVehicleSearch(element.value); updateApptButtonReadyStates(); },
    "appt.handleApptVehSearchKeydown": (param, element, event) => handleApptVehSearchKeydown(event),
    "appt.updateApptVinLast8Display": (param, element, event) => updateApptVinLast8Display(element.value),
    "appt.openApptServiceHistoryModal": (param, element, event) => openApptServiceHistoryModal(),
    "appt.addApptLine": (param, element, event) => addApptLine(),
    "appt.confirmAppointmentFromEditor": (param, element, event) => confirmAppointmentFromEditor(),
    "appt.recalculateApptTotals": (param, element, event) => recalculateApptTotals(),
    "appt.queueApptOpcodeDropdown": (param, element, event) => queueApptOpcodeDropdown(element),
    "appt.handleSharedOpcodeKeydown": (param, element, event) => OpcodePicker.handleKeydown(event, element),
    "appt.labor-input": (_, element) => { element.dataset.manualOverride = '1'; recalculateApptTotals(); },
    "appt.deleteApptLine": (param, element, event) => deleteApptLine(element),
    "appt.selectApptCustomer": (param, element, event) => selectApptCustomer(Number(param)),
    "appt.selectApptVehicle": (param, element, event) => selectApptVehicle(Number(param)),
    "appt.closeApptManageModal": (param, element, event) => closeApptManageModal(),
    "appt.submitApptReschedule": (param, element, event) => submitApptReschedule(Number(param)),
    "appt.submitApptDefer": (param, element, event) => submitApptDefer(Number(param)),
    "appt.submitApptDelete": (param, element, event) => submitApptDelete(Number(param)),
    "appt.closeServiceHistoryModal": (param, element, event) => closeServiceHistoryModal(),
    "appt.queueHistorySearch": (param, element, event) => queueHistorySearch(element.value),
  };
  for (const [name, handler] of Object.entries(actions)) {
    EventDelegator.registerAction(name, handler, {permission: "appointments"});
  }
});
