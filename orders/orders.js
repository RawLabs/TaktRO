/**
 * TaktRO — Repair Orders Domain Module (orders/orders.js)
 * Manages Repair Order Board, write-up editor, C/W/I/G billing, line totals, op-code autocomplete, fleet rules & PO validation gates.
 */

let activeRoCustomer = null;
let activeEditingRoId = null;

let roCustomerSearchTimer = null;
let roCustomerSearchResults = [];
let roCustActiveIndex = 0;

let roVehicleSearchTimer = null;
let roVehicleSearchResults = [];
let roVehActiveIndex = 0;

// TaktRO house codes follow GROUP-SYSTEM-ACTION. They use Toyota service
// terminology, but the default hours are editable shop estimates—not Toyota
// warranty labor-operation numbers or factory flat-rate times.
const BASE_JOB_OPCODE_CATALOG = [
  { code: 'MA-GEN-INSP', concern: 'MULTI-POINT VEHICLE INSPECTION', hrs: '0.40', parts: '0.00', category: 'MAINTENANCE' },
  { code: 'MA-SCHED-REV', concern: 'MAINTENANCE SCHEDULE AND SERVICE HISTORY REVIEW', hrs: '0.30', parts: '0.00', category: 'MAINTENANCE' },
  { code: 'MA-OIL-SERV', concern: 'ENGINE OIL AND FILTER REPLACEMENT', hrs: '0.50', parts: '49.95', category: 'MAINTENANCE' },
  { code: 'MA-AIR-RPL', concern: 'ENGINE AIR FILTER REPLACEMENT', hrs: '0.20', parts: '29.95', category: 'MAINTENANCE' },
  { code: 'MA-CAB-RPL', concern: 'CABIN AIR FILTER REPLACEMENT', hrs: '0.30', parts: '34.95', category: 'MAINTENANCE' },
  { code: 'MA-WIP-RPL', concern: 'FRONT WIPER BLADE REPLACEMENT — PAIR', hrs: '0.20', parts: '39.95', category: 'MAINTENANCE' },
  { code: 'MA-FUEL-INSP', concern: 'FUEL LINES, CONNECTIONS AND FUEL-TANK BAND INSPECTION', hrs: '0.30', parts: '0.00', category: 'MAINTENANCE' },
  { code: 'MA-CHAS-TORQ', concern: 'CHASSIS AND BODY FASTENER TORQUE CHECK', hrs: '0.50', parts: '0.00', category: 'MAINTENANCE' },

  { code: 'BR-GEN-DIAG', concern: 'BRAKE SYSTEM CONCERN DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'BRAKES' },
  { code: 'BR-GEN-INSP', concern: 'BRAKE PAD, DISC, LINING, DRUM, LINE AND HOSE INSPECTION', hrs: '0.50', parts: '0.00', category: 'BRAKES' },
  { code: 'BR-FRT-RPL', concern: 'FRONT BRAKE PAD AND ROTOR REPLACEMENT', hrs: '2.00', parts: '249.95', category: 'BRAKES' },
  { code: 'BR-RR-RPL', concern: 'REAR BRAKE PAD AND ROTOR REPLACEMENT', hrs: '2.00', parts: '229.95', category: 'BRAKES' },
  { code: 'BR-DRUM-SERV', concern: 'REAR DRUM BRAKE CLEANING, INSPECTION AND ADJUSTMENT', hrs: '1.00', parts: '0.00', category: 'BRAKES' },
  { code: 'BR-FLUID-SERV', concern: 'BRAKE FLUID EXCHANGE AND SYSTEM BLEED', hrs: '1.00', parts: '29.95', category: 'BRAKES' },
  { code: 'BR-ABS-DIAG', concern: 'ABS AND VEHICLE STABILITY CONTROL WARNING DIAGNOSIS', hrs: '1.20', parts: '0.00', category: 'BRAKES' },
  { code: 'BR-PARK-ADJ', concern: 'PARKING BRAKE INSPECTION AND ADJUSTMENT', hrs: '0.60', parts: '0.00', category: 'BRAKES' },

  { code: 'ST-GEN-DIAG', concern: 'STEERING AND HANDLING CONCERN DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'STEERING' },
  { code: 'ST-GEN-INSP', concern: 'STEERING GEAR, LINKAGE AND BOOT INSPECTION', hrs: '0.40', parts: '0.00', category: 'STEERING' },
  { code: 'ST-TIEROD-RPL', concern: 'STEERING TIE-ROD END REPLACEMENT', hrs: '1.20', parts: '89.95', category: 'STEERING' },
  { code: 'ST-RACK-RPL', concern: 'STEERING RACK ASSEMBLY REPLACEMENT', hrs: '4.00', parts: '749.95', category: 'STEERING' },
  { code: 'ST-EPS-DIAG', concern: 'ELECTRIC POWER STEERING SYSTEM DIAGNOSIS', hrs: '1.20', parts: '0.00', category: 'STEERING' },

  { code: 'SU-GEN-DIAG', concern: 'SUSPENSION NOISE AND RIDE CONCERN DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'SUSPENSION' },
  { code: 'SU-GEN-INSP', concern: 'BALL JOINT, DUST COVER, SHOCK AND STRUT INSPECTION', hrs: '0.50', parts: '0.00', category: 'SUSPENSION' },
  { code: 'SU-FRT-STRUT', concern: 'FRONT STRUT ASSEMBLY REPLACEMENT — PAIR', hrs: '3.00', parts: '449.95', category: 'SUSPENSION' },
  { code: 'SU-RR-SHOCK', concern: 'REAR SHOCK ABSORBER REPLACEMENT — PAIR', hrs: '1.50', parts: '249.95', category: 'SUSPENSION' },
  { code: 'SU-BALL-RPL', concern: 'SUSPENSION BALL JOINT REPLACEMENT', hrs: '1.50', parts: '119.95', category: 'SUSPENSION' },
  { code: 'SU-CTRL-RPL', concern: 'SUSPENSION CONTROL ARM REPLACEMENT', hrs: '2.00', parts: '249.95', category: 'SUSPENSION' },

  { code: 'TW-GEN-DIAG', concern: 'TIRE WEAR AND VIBRATION CONCERN DIAGNOSIS', hrs: '0.70', parts: '0.00', category: 'TIRES & WHEELS' },
  { code: 'TW-ROT-SERV', concern: 'TIRE ROTATION AND PRESSURE ADJUSTMENT', hrs: '0.40', parts: '0.00', category: 'TIRES & WHEELS' },
  { code: 'TW-BAL-SERV', concern: 'FOUR-WHEEL TIRE BALANCE', hrs: '1.00', parts: '0.00', category: 'TIRES & WHEELS' },
  { code: 'SS-ALIGN-CHK', concern: 'FOUR-WHEEL ALIGNMENT MEASUREMENT', hrs: '0.50', parts: '0.00', category: 'STEERING / SUSPENSION' },
  { code: 'SS-ALIGN-ADJ', concern: 'FOUR-WHEEL ALIGNMENT ADJUSTMENT', hrs: '1.50', parts: '0.00', category: 'STEERING / SUSPENSION' },
  { code: 'TW-TIRE-RPL', concern: 'TIRE REPLACEMENT, MOUNT AND BALANCE — EACH', hrs: '0.40', parts: '0.00', category: 'TIRES & WHEELS' },
  { code: 'TW-TPMS-DIAG', concern: 'TIRE PRESSURE MONITOR SYSTEM DIAGNOSIS', hrs: '0.80', parts: '0.00', category: 'TIRES & WHEELS' },
  { code: 'TW-TPMS-RPL', concern: 'TIRE PRESSURE SENSOR REPLACEMENT AND REGISTRATION — EACH', hrs: '0.60', parts: '79.95', category: 'TIRES & WHEELS' },

  { code: 'EL-GEN-DIAG', concern: 'GENERAL ELECTRICAL CONCERN DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'ELECTRICAL' },
  { code: 'EL-BATT-TEST', concern: '12-VOLT BATTERY CONDITION TEST', hrs: '0.40', parts: '0.00', category: 'ELECTRICAL' },
  { code: 'EL-BATT-RPL', concern: '12-VOLT BATTERY REPLACEMENT AND INITIALIZATION', hrs: '0.50', parts: '189.95', category: 'ELECTRICAL' },
  { code: 'EL-START-DIAG', concern: 'STARTING SYSTEM DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'ELECTRICAL' },
  { code: 'EL-CHRG-DIAG', concern: 'CHARGING SYSTEM DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'ELECTRICAL' },
  { code: 'EL-LAMP-DIAG', concern: 'EXTERIOR LIGHTING SYSTEM DIAGNOSIS', hrs: '0.80', parts: '0.00', category: 'ELECTRICAL' },
  { code: 'EL-HORN-DIAG', concern: 'HORN SYSTEM DIAGNOSIS', hrs: '0.60', parts: '0.00', category: 'ELECTRICAL' },

  { code: 'AC-GEN-DIAG', concern: 'AIR CONDITIONING AND CLIMATE CONTROL DIAGNOSIS', hrs: '1.20', parts: '0.00', category: 'HVAC' },
  { code: 'AC-PERF-TEST', concern: 'AIR CONDITIONING PERFORMANCE TEST', hrs: '0.70', parts: '0.00', category: 'HVAC' },
  { code: 'AC-LEAK-TEST', concern: 'AIR CONDITIONING REFRIGERANT LEAK TEST', hrs: '1.00', parts: '0.00', category: 'HVAC' },
  { code: 'AC-REFR-SERV', concern: 'RECOVER, EVACUATE AND RECHARGE REFRIGERANT', hrs: '1.40', parts: '89.95', category: 'HVAC' },
  { code: 'AC-BLOW-DIAG', concern: 'BLOWER MOTOR AND AIRFLOW CONCERN DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'HVAC' },
  { code: 'AC-ODOR-SERV', concern: 'EVAPORATOR CLEANING AND DEODORIZING SERVICE', hrs: '0.70', parts: '34.95', category: 'HVAC' },

  { code: 'CO-GEN-DIAG', concern: 'COOLING SYSTEM LEAK AND OVERHEATING DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'COOLING' },
  { code: 'CO-GEN-INSP', concern: 'RADIATOR, CONDENSER, HOSE AND COOLANT INSPECTION', hrs: '0.40', parts: '0.00', category: 'COOLING' },
  { code: 'CO-COOL-SERV', concern: 'ENGINE COOLANT DRAIN AND REFILL', hrs: '1.00', parts: '49.95', category: 'COOLING' },
  { code: 'CO-RAD-RPL', concern: 'RADIATOR ASSEMBLY REPLACEMENT', hrs: '2.50', parts: '349.95', category: 'COOLING' },
  { code: 'CO-HOSE-RPL', concern: 'RADIATOR HOSE REPLACEMENT', hrs: '0.80', parts: '59.95', category: 'COOLING' },

  { code: 'EX-GEN-DIAG', concern: 'EXHAUST NOISE AND LEAK CONCERN DIAGNOSIS', hrs: '0.70', parts: '0.00', category: 'EXHAUST' },
  { code: 'EX-GEN-INSP', concern: 'EXHAUST PIPE, HEAT SHIELD AND MOUNTING INSPECTION', hrs: '0.30', parts: '0.00', category: 'EXHAUST' },
  { code: 'EX-MUFF-RPL', concern: 'MUFFLER AND TAILPIPE ASSEMBLY REPLACEMENT', hrs: '1.20', parts: '299.95', category: 'EXHAUST' },

  { code: 'DT-GEN-DIAG', concern: 'DRIVELINE NOISE AND VIBRATION DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'DRIVELINE' },
  { code: 'DT-BOOT-INSP', concern: 'DRIVE SHAFT AND CV BOOT INSPECTION', hrs: '0.40', parts: '0.00', category: 'DRIVELINE' },
  { code: 'DT-AXLE-RPL', concern: 'CV AXLE SHAFT ASSEMBLY REPLACEMENT', hrs: '2.00', parts: '249.95', category: 'DRIVELINE' },
  { code: 'DT-PROP-SERV', concern: 'PROPELLER SHAFT LUBRICATION AND BOLT RETORQUE', hrs: '0.60', parts: '9.95', category: 'DRIVELINE' },
  { code: 'DT-DIFF-SERV', concern: 'DIFFERENTIAL FLUID REPLACEMENT', hrs: '0.80', parts: '49.95', category: 'DRIVELINE' },
  { code: 'DT-TCASE-SERV', concern: 'TRANSFER CASE FLUID REPLACEMENT', hrs: '0.70', parts: '39.95', category: 'DRIVELINE' },
  { code: 'TR-GEN-DIAG', concern: 'TRANSMISSION OR TRANSAXLE OPERATION DIAGNOSIS — NO INTERNAL REPAIR', hrs: '1.20', parts: '0.00', category: 'TRANSMISSION — EXTERNAL' },
  { code: 'TR-FLUID-INSP', concern: 'TRANSMISSION OR TRANSAXLE FLUID AND EXTERNAL LEAK INSPECTION', hrs: '0.40', parts: '0.00', category: 'TRANSMISSION — EXTERNAL' },
  { code: 'TR-FLUID-SERV', concern: 'TRANSMISSION OR TRANSAXLE FLUID DRAIN AND REFILL', hrs: '1.00', parts: '89.95', category: 'TRANSMISSION — EXTERNAL' },

  { code: 'HY-GEN-DIAG', concern: 'HYBRID SYSTEM WARNING AND OPERATION DIAGNOSIS', hrs: '1.50', parts: '0.00', category: 'HYBRID / EV' },
  { code: 'HY-BATT-INSP', concern: 'HIGH-VOLTAGE BATTERY COOLING INTAKE AND FILTER INSPECTION', hrs: '0.40', parts: '0.00', category: 'HYBRID / EV' },
  { code: 'HY-FILT-RPL', concern: 'HIGH-VOLTAGE BATTERY COOLING AIR FILTER REPLACEMENT', hrs: '0.60', parts: '29.95', category: 'HYBRID / EV' },
  { code: 'HY-COOL-INSP', concern: 'INVERTER COOLANT LEVEL AND EXTERNAL LEAK INSPECTION', hrs: '0.40', parts: '0.00', category: 'HYBRID / EV' },

  { code: 'AD-GEN-DIAG', concern: 'DRIVER ASSISTANCE SYSTEM WARNING DIAGNOSIS', hrs: '1.20', parts: '0.00', category: 'ADAS / SAFETY' },
  { code: 'AD-CAM-CAL', concern: 'FORWARD RECOGNITION CAMERA CALIBRATION', hrs: '1.50', parts: '0.00', category: 'ADAS / SAFETY' },
  { code: 'AD-RADAR-CAL', concern: 'MILLIMETER-WAVE RADAR SENSOR CALIBRATION', hrs: '1.50', parts: '0.00', category: 'ADAS / SAFETY' },
  { code: 'AD-BSM-DIAG', concern: 'BLIND SPOT MONITOR SYSTEM DIAGNOSIS', hrs: '1.20', parts: '0.00', category: 'ADAS / SAFETY' },

  { code: 'BD-GEN-DIAG', concern: 'BODY, WATER LEAK, WIND NOISE OR TRIM CONCERN DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'BODY / INTERIOR' },
  { code: 'BD-DOOR-DIAG', concern: 'DOOR, LOCK, WINDOW OR REGULATOR DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'BODY / INTERIOR' },
  { code: 'BD-WIP-DIAG', concern: 'WIPER AND WASHER SYSTEM DIAGNOSIS', hrs: '0.80', parts: '0.00', category: 'BODY / INTERIOR' },
  { code: 'BD-DETAIL-SERV', concern: 'FULL VEHICLE DETAIL', hrs: '2.00', parts: '24.95', category: 'BODY / INTERIOR' },

  { code: 'AV-GEN-DIAG', concern: 'AUDIO, NAVIGATION AND CONNECTIVITY SYSTEM DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'AUDIO / ACCESSORY' },
  { code: 'AV-KEY-DIAG', concern: 'SMART KEY AND WIRELESS REMOTE DIAGNOSIS', hrs: '1.00', parts: '0.00', category: 'AUDIO / ACCESSORY' },
  { code: 'AV-KEY-REG', concern: 'SMART KEY OR WIRELESS REMOTE REGISTRATION', hrs: '0.70', parts: '0.00', category: 'AUDIO / ACCESSORY' }
];

let customJobCodes = [];

async function loadCustomJobCodes() {
  if (!sessionToken || !hasPermission('repair_orders')) {
    customJobCodes = [];
    return;
  }
  try {
    const result = await api('/api/job-codes');
    customJobCodes = (result.job_codes || []).map(item => ({
      id: item.id,
      code: item.code,
      concern: item.description,
      category: item.category,
      hrs: Number(item.default_hours).toFixed(2),
      parts: Number(item.default_parts).toFixed(2),
      custom: true,
      createdBy: item.created_by_name || 'UNKNOWN',
      modifiedBy: item.modified_by_name || 'UNKNOWN',
      updatedAt: item.updated_at
    }));
  } catch (err) {
    customJobCodes = [];
    console.error('Unable to load custom job codes:', err);
  }
}

function getJobOpcodeCatalog() {
  return [...BASE_JOB_OPCODE_CATALOG, ...customJobCodes];
}

let activeRoList = [];

function calculateMustStart(promisedTimeStr, totalHours) {
  if (!promisedTimeStr || promisedTimeStr === '—' || !totalHours || totalHours <= 0) return '—';
  let timeStr = String(promisedTimeStr).trim().toUpperCase();
  let isPM = timeStr.includes('PM');
  let isAM = timeStr.includes('AM');
  timeStr = timeStr.replace(/AM|PM/g, '').trim();

  const parts = timeStr.split(':');
  if (parts.length < 2) return '—';

  let hours = parseInt(parts[0], 10);
  let minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes)) return '—';

  if (isPM && hours < 12) hours += 12;
  if (isAM && hours === 12) hours = 0;

  let promisedMinutes = hours * 60 + minutes;
  let laborMinutes = Math.round(totalHours * 60);
  let mustStartMinutes = promisedMinutes - laborMinutes;

  if (mustStartMinutes < 0) {
    mustStartMinutes += 24 * 60;
  }

  let startHours = Math.floor(mustStartMinutes / 60) % 24;
  let startMins = mustStartMinutes % 60;

  let startPeriod = startHours >= 12 ? 'PM' : 'AM';
  let displayHour = startHours % 12;
  if (displayHour === 0) displayHour = 12;
  let displayMin = String(startMins).padStart(2, '0');

  return `${displayHour}:${displayMin} ${startPeriod}`;
}

let cachedRoTechnicians = [];

function formatEmpNumber(id) {
  const num = Number(id) || 0;
  return num >= 1000 ? String(num) : String(num).padStart(3, '0');
}

async function loadRoTechnicians() {
  if (!sessionToken || !hasPermission('repair_orders')) return;
  try {
    const res = await api('/api/technicians');
    cachedRoTechnicians = res.technicians || [];
  } catch (err) {
    console.error('Unable to load technicians for RO:', err);
  }
}

function generateRoTechnicianOptions(selectedId = null) {
  const selectedNum = selectedId ? Number(selectedId) : null;
  let html = `<option value="">— NO TECH —</option>`;
  html += cachedRoTechnicians.map(t => {
    const isSelected = selectedNum === Number(t.id) ? 'selected' : '';
    const label = `#${formatEmpNumber(t.id)} - ${escapeHtml(t.name)}`;
    return `<option value="${t.id}" ${isSelected}>${label}</option>`;
  }).join('');
  return html;
}

async function loadRepairOrders() {
  if (!sessionToken || !hasPermission('repair_orders')) {
    activeRoList = [];
    return;
  }
  try {
    const [, result] = await Promise.all([
      loadRoTechnicians(),
      api('/api/repair-orders')
    ]);
    activeRoList = (result.repair_orders || []).map(record => {
      const lines = (() => { try { return JSON.parse(record.lines_json || '[]'); } catch (_) { return []; } })();
      const statusRaw = String(record.status || 'write-up').toLowerCase();
      const statusLabel = statusRaw.replace(/-/g, ' ').toUpperCase();
      const hrs = Number(record.total_hours || 0);
      const promised = record.promised_time || '—';
      const mustStart = calculateMustStart(promised, hrs);
      const preassignedTechId = record.preassigned_technician_id || null;
      const preassignedTech = preassignedTechId ? `#${formatEmpNumber(preassignedTechId)}` : '—';
      
      let statusType = 'steel';
      if (statusRaw.includes('complete') || statusRaw.includes('invoiced') || statusRaw.includes('ready')) {
        statusType = 'emerald';
      } else if (statusRaw.includes('write-up') || statusRaw.includes('intake') || statusRaw.includes('draft') || statusRaw.includes('appointment')) {
        statusType = 'cyan';
      } else if (statusRaw.includes('part') || statusRaw.includes('hold') || statusRaw.includes('wait')) {
        statusType = 'amber';
      }

      const getLineDisplay = (line) => {
        if (!line) return '-';
        const code = line.op_code || '-';
        if (line.booked) return `${code} [B]`;
        return code;
      };

      return {
        id: record.id, ro: record.ro_number, cust: record.customer_name, veh: record.vehicle_info,
        preassignedTechId, preassignedTech,
        status: statusLabel, statusType,
        jobA: getLineDisplay(lines[0]), jobAPay: lines[0]?.pay || '',
        jobB: getLineDisplay(lines[1]), jobBPay: lines[1]?.pay || '',
        jobC: getLineDisplay(lines[2]), jobCPay: lines[2]?.pay || '',
        hrs, mustStart, promised,
        record, lines
      };
    });
    renderOpenRoTableRows();
  } catch (err) {
    activeRoList = [];
    console.error('Unable to load repair orders:', err);
  }
}

let roSortState = { col: null, dir: 'asc' };

function sortRoTable(col) {
  if (roSortState.col === col) {
    roSortState.dir = roSortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    roSortState.col = col;
    roSortState.dir = 'asc';
  }

  activeRoList.sort((a, b) => {
    let valA = a[col] ?? '';
    let valB = b[col] ?? '';
    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();

    if (valA < valB) return roSortState.dir === 'asc' ? -1 : 1;
    if (valA > valB) return roSortState.dir === 'asc' ? 1 : -1;
    return 0;
  });

  renderOpenRoTableRows();
}

let activeRoRowIndex = 0;

function handleRoBoardArrowNav(dir) {
  const rows = [...document.querySelectorAll('#openRoTableBody tr')];
  if (!rows.length) return;
  if (dir === 'down') {
    activeRoRowIndex = Math.min(rows.length - 1, activeRoRowIndex + 1);
  } else if (dir === 'up') {
    activeRoRowIndex = Math.max(0, activeRoRowIndex - 1);
  }
  rows.forEach((row, i) => {
    if (i === activeRoRowIndex) {
      row.classList.add('is-selected');
      row.style.outline = '2px solid var(--accent-amber)';
      row.focus();
    } else {
      row.classList.remove('is-selected');
      row.style.outline = 'none';
    }
  });
}

function openSelectedRoFromBoard() {
  const rows = [...document.querySelectorAll('#openRoTableBody tr')];
  const targetRow = rows[activeRoRowIndex] || rows[0];
  if (targetRow) {
    targetRow.click();
  }
}

function renderOpenRoTableRows() {
  if (!document.getElementById('openRoTableBody')) return;
  const content = document.getElementById('workspaceContent');
  if (content) content.innerHTML = renderRoWriteupContent();
}

let roBoardPage = 1;
let roBoardPageSize = 15;
function changeRoBoardPage(p) {
  roBoardPage = p;
  activeRoRowIndex = 0;
  const c = document.getElementById('workspaceContent');
  if (c) c.innerHTML = renderRoWriteupContent();
}
window.changeRoBoardPage = changeRoBoardPage;

function renderRoWriteupContent() {
  const getSortIcon = (col) => roSortState.col === col ? (roSortState.dir === 'asc' ? ' ↑' : ' ↓') : ' ⇅';

  const startIndex = (roBoardPage - 1) * roBoardPageSize;
  const paginatedRos = activeRoList.slice(startIndex, startIndex + roBoardPageSize);
  const totalPages = Math.ceil(activeRoList.length / roBoardPageSize) || 1;
  const paginationHtml = window.UIComponent ? window.UIComponent.Pagination({
    currentPage: roBoardPage,
    totalPages,
    totalItems: activeRoList.length,
    pageSize: roBoardPageSize,
    pageAction: 'ro.page'
  }) : '';

  const headerHtml = window.UIComponent ? window.UIComponent.WorkspaceHeader({
    title: 'ACTIVE OPEN REPAIR ORDERS BOARD',
    subtitle: 'PRESS ALT+N FOR NEW RO | USE ARROWS & ENTER TO OPEN',
    badgeText: `${activeRoList.length} OPEN`,
    badgeKind: 'caution',
    actionsHtml: `<button class="primary-action-btn" data-command="ro.create_new">${UIComponent.Keycap('ALT+N', 'inverse', {className: 'kbd-invert'})} NEW REPAIR ORDER</button>`,
    legendKey: ''
  }) : `
    <div class="ui-command-panel">
      <div style="display:flex; gap:12px; align-items:center;">
        <strong class="ui-copy">ACTIVE OPEN REPAIR ORDERS BOARD</strong>
        <span style="font-size:11px; color:var(--text-dim);">PRESS ${UIComponent.Keycap('ALT+N', 'command', {className: 'u-text-amber'})} FOR NEW RO | USE ARROWS &amp; ENTER TO OPEN</span>
      </div>
      <button class="primary-action-btn" data-command="ro.create_new">${UIComponent.Keycap('ALT+N', 'inverse', {className: 'kbd-invert'})} NEW REPAIR ORDER</button>
    </div>
  `;

  return `
    <div style="display:flex; flex-direction:column; gap:16px; font-family:var(--font-mono); color:var(--text-main); height:100%; justify-content:space-between;">

      <!-- TOP: RO ACTIONS HEADER & ACTIVE OPEN RO LIST TABLE -->
      <div style="display:flex; flex-direction:column; gap:16px;">
        ${headerHtml}

        <!-- OPEN REPAIR ORDERS TABLE WITH DEDICATED JOB CODE COLUMNS & MUST START TIME CALCULATOR -->
        <table class="ui-table">
          <thead>
            <tr class="ui-table-head">
              <th style="padding:10px; width:45px; text-align:center;">#</th>
              <th style="width:75px; cursor:pointer;" data-action="ro.sort" data-action-param="ro">RO #${getSortIcon('ro')}</th>
              <th style="width:130px; cursor:pointer;" data-action="ro.sort" data-action-param="cust">CUSTOMER NAME${getSortIcon('cust')}</th>
              <th style="width:140px; cursor:pointer;" data-action="ro.sort" data-action-param="veh">VEHICLE${getSortIcon('veh')}</th>
              <th style="width:125px; text-align:center; cursor:pointer;" data-action="ro.sort" data-action-param="preassignedTech">PREASSIGNED TECH${getSortIcon('preassignedTech')}</th>
              <th style="width:110px; cursor:pointer;" data-action="ro.sort" data-action-param="status">STATUS${getSortIcon('status')}</th>
              <th style="width:100px; cursor:pointer;" data-action="ro.sort" data-action-param="jobA">LINE A${getSortIcon('jobA')}</th>
              <th style="width:100px; cursor:pointer;" data-action="ro.sort" data-action-param="jobB">LINE B${getSortIcon('jobB')}</th>
              <th style="width:100px; cursor:pointer;" data-action="ro.sort" data-action-param="jobC">LINE C${getSortIcon('jobC')}</th>
              <th style="text-align:right; width:65px; cursor:pointer;" data-action="ro.sort" data-action-param="hrs">HOURS${getSortIcon('hrs')}</th>
              <th style="text-align:right; width:125px; cursor:pointer;" data-action="ro.sort" data-action-param="mustStart">MUST START${getSortIcon('mustStart')}</th>
              <th style="text-align:right; width:130px; padding-right:12px; cursor:pointer;" data-action="ro.sort" data-action-param="promised">PROMISED TIME${getSortIcon('promised')}</th>
            </tr>
          </thead>
          <tbody id="openRoTableBody">
            ${paginatedRos.length ? paginatedRos.map((item, pIdx) => {
              const idx = pIdx;
              return `
              <tr tabindex="0" class="${idx === activeRoRowIndex ? 'is-selected' : ''}" style="border-bottom:1px solid var(--border-soft); cursor:pointer; ${idx === activeRoRowIndex ? 'outline:2px solid var(--accent-amber);' : ''}" data-action="ro.open" data-action-param="${item.id}">
                <td style="padding:10px; text-align:center; font-weight:700; color:var(--text-muted);">${idx + 1}</td>
                <td style="color:var(--accent-amber); font-weight:700;">${escapeHtml(item.ro)}</td>
                <td style="font-weight:600;">${escapeHtml(item.cust)}</td>
                <td>${escapeHtml(item.veh)}</td>
                <td style="font-weight:700; text-align:center;">${item.preassignedTech !== '—' ? `<span class="data-id">${escapeHtml(item.preassignedTech)}</span>` : '<span class="u-text-dim">—</span>'}</td>
                <td>${window.UIComponent ? window.UIComponent.StatusBadge(item.status, item.statusType === 'emerald' ? 'positive' : 'caution') : `<span class="ui-status-badge badge-${item.statusType}">${escapeHtml(item.status)}</span>`}</td>
                <td>${item.jobA !== '-' ? `<span class="code-chip">${escapeHtml(item.jobA)}</span> <span class="pay-chip pay-${(item.jobAPay || 'c').toLowerCase()}">${escapeHtml(item.jobAPay)}</span>` : '<span class="u-text-dim">-</span>'}</td>
                <td>${item.jobB !== '-' ? `<span class="code-chip">${escapeHtml(item.jobB)}</span> <span class="pay-chip pay-${(item.jobBPay || 'c').toLowerCase()}">${escapeHtml(item.jobBPay)}</span>` : '<span class="u-text-dim">-</span>'}</td>
                <td>${item.jobC !== '-' ? `<span class="code-chip">${escapeHtml(item.jobC)}</span> <span class="pay-chip pay-${(item.jobCPay || 'c').toLowerCase()}">${escapeHtml(item.jobCPay)}</span>` : '<span class="u-text-dim">-</span>'}</td>
                <td style="text-align:right; font-weight:700; color:var(--accent-amber);">${item.hrs.toFixed(2)}</td>
                <td style="text-align:right; font-weight:700; color:var(--accent-emerald);">${escapeHtml(item.mustStart)}</td>
                <td style="text-align:right; padding-right:12px; color:var(--accent-amber); font-weight:600;">${escapeHtml(item.promised)}</td>
              </tr>
            `;
            }).join('') : '<tr><td colspan="12" class="empty-state-cell">NO PERSISTENT REPAIR ORDERS HAVE BEEN CREATED.</td></tr>'}
          </tbody>
        </table>

        ${paginationHtml}
      </div>

      <!-- BOTTOM: TOTAL WORK IN SHOP -->
      <div style="background:var(--surface-panel); padding:14px 16px; border-radius:4px; border:1px solid var(--border-mid); display:flex; justify-content:space-between; align-items:center;">
        <div style="font-size:12px; color:var(--text-muted);">
          ALL OPEN REPAIR ORDERS: <strong class="u-text-main">${activeRoList.length} ORDERS OPEN</strong> <span style="font-size:10px; color:var(--text-dim); margin-left:4px;">(EXCLUDES CLOSED)</span>
        </div>
        <div style="font-size:12px; color:var(--accent-amber); font-weight:700; background:var(--surface-input); padding:4px 12px; border-radius:3px; border:1px solid var(--border-mid);">
          SHOP HOURS: 8:00 AM - 5:00 PM
        </div>
        <div class="u-text-muted">OPEN-RO WORKLOAD: <strong class="ui-heading-amber">${activeRoList.reduce((sum, item) => sum + Number(item.hrs || 0), 0).toFixed(1)} HR TOTAL</strong></div>
      </div>

    </div>
  `;
}

function getRoEditorNormalizedSnapshot() {
  const form = document.getElementById('roWriteupForm');
  if (!form) return {};
  const data = {};
  Array.from(form.querySelectorAll('input, select, textarea')).forEach(el => {
    if (!el.id && !el.name) return;
    const k = el.id || el.name;
    data[k] = el.type === 'checkbox' ? Boolean(el.checked) : el.value.trim();
  });
  return data;
}

function createNewRoSession(initialCust = null, initialVeh = null) {
  activeEditingRoId = null;
  const targetCust = initialCust || (typeof activeCustomer !== 'undefined' ? activeCustomer : null);
  const targetVeh = initialVeh || (typeof activeVehicle !== 'undefined' ? activeVehicle : null);
  activeRoCustomer = targetCust;
  const contentEl = document.getElementById('workspaceContent');
  const titleEl = document.getElementById('activeTaskTitle');
  titleEl.textContent = 'REPAIR ORDER WRITE-UP EDITOR';
  contentEl.innerHTML = renderRoEditorScreen('');
  addNewRoLine();
  requestAnimationFrame(() => {
    const custInput = document.getElementById('roCustInput');
    if (custInput && targetCust) {
      custInput.value = targetCust.name || '';
    }
    const vehInput = document.getElementById('roVehInput');
    if (vehInput && targetVeh) {
      vehInput.value = `${targetVeh.year} ${targetVeh.make} ${targetVeh.model}`.trim();
      const vinInput = document.getElementById('roVinInput');
      if (vinInput && targetVeh.vin) vinInput.value = targetVeh.vin;
      const plateInput = document.getElementById('roPlateInput');
      if (plateInput && targetVeh.plate) plateInput.value = targetVeh.plate;
    }
    if (custInput && !targetCust) {
      custInput.focus();
      custInput.select();
    }
    if (window.EditorStack) {
      window.EditorStack.register('roEditor', {
        cancelFn: () => {
          activeEditingRoId = null;
          const c = document.getElementById('workspaceContent');
          if (c) c.innerHTML = renderRoWriteupContent();
        },
        getNormalizedSnapshot: getRoEditorNormalizedSnapshot
      });
    }
  });
}

function expandRoByNumber(num) {
  const selectedRo = activeRoList.find(item => item.id === num) || activeRoList[num - 1];
  if (selectedRo) return openRoWriteupForEdit(selectedRo.id);
}

async function openRoWriteupForEdit(roId) {
  try {
    const res = await api('/api/repair-orders');
    const allRos = res.repair_orders || [];
    const target = allRos.find(r => r.id === Number(roId));
    if (!target) {
      alert('REPAIR ORDER NOT FOUND.');
      return;
    }

    activeEditingRoId = target.id;
    const contentEl = document.getElementById('workspaceContent');
    const titleEl = document.getElementById('activeTaskTitle');
    const overlay = document.getElementById('workspaceOverlay');

    if (overlay && state.activeTask === 'O') overlay.classList.remove('hidden');

    titleEl.textContent = `REPAIR ORDER WRITE-UP EDITOR (${target.ro_number})`;
    contentEl.innerHTML = renderRoEditorScreen(target.ro_number);

    document.getElementById('roCustInput').value = target.customer_name || '';
    document.getElementById('roVehInput').value = target.vehicle_info || '';
    document.getElementById('roTagInput').value = target.promised_time || '';
    const preassignedSelect = document.getElementById('roPreassignedTechSelect');
    if (preassignedSelect) {
      preassignedSelect.value = target.preassigned_technician_id || '';
    }
    document.getElementById('roPlateInput').value = target.license_plate || '';
    document.getElementById('roVinInput').value = target.vin || '';
    document.getElementById('roMilesInput').value = target.mileage || '';
    document.getElementById('roFleetUnitInput').value = target.fleet_unit || '';
    document.getElementById('roPoInput').value = target.po_number || '';
    document.getElementById('roFleetUnitContainer').style.display = target.fleet_unit ? 'block' : 'none';
    document.getElementById('roPoContainer').style.display = target.po_number ? 'block' : 'none';

    const status = document.getElementById('roStatusSelect');
    if (status) {
      status.value = target.status || 'write-up';
      changeRoStatus(status);
    }

    const body = document.getElementById('roLinesWorkspaceBody');
    if (body) {
      body.innerHTML = '';
      const lines = target.lines || (target.lines_json ? JSON.parse(target.lines_json) : []);
      lines.forEach(addNewRoLine);
      if (!lines.length) addNewRoLine();
    }

    renderConfirmedRoParts(target);
    if (target.status === 'invoiced') {
      contentEl.querySelectorAll('input, select, button').forEach(el => {
        if (!['ro.back', 'ro.service_history'].includes(el.dataset.command)) el.disabled = true;
      });
      document.getElementById('roSaveMessage').textContent = 'POSTED — INVENTORY UPDATED';
    }

    requestAnimationFrame(() => {
      updateRoButtonReadyStates();
      document.getElementById('roCustInput')?.addEventListener('input', updateRoButtonReadyStates);
    });
  } catch (err) {
    alert('FAILED TO LOAD REPAIR ORDER: ' + err.message);
  }
}

function escBackToBoard() {
  requestNavigation('O');
}

function renderRoEditorScreen(roNum = '') {
  return `
    <div id="roWriteupForm" style="display:flex; flex-direction:column; gap:14px; font-family:var(--font-mono); color:var(--text-main); height:100%;">

      <!-- TOP CONTROL BAR: BACK TO BOARD, RO NUMBER & ACTIONS -->
      <div class="ro-editor-toolbar" style="display:flex; justify-content:space-between; align-items:center; background:var(--surface-panel); padding:10px 16px; border-radius:4px; border:1px solid var(--border-mid);">
        <div class="ui-row-10">
          <button class="secondary-action-btn" data-command="ro.back">${UIComponent.Keycap('ESC', 'command')} BACK TO BOARD</button>
          <span class="u-text-dim">|</span>
          <div style="display:inline-flex; align-items:center; gap:6px;">
            <img src="media/TaktRO_media_package_2026-08-16/TaktRO_media_package/02_APP/TaktRO_app_icon_64.png" alt="RO Logo" style="height:22px; width:auto; object-fit:contain;">
            <strong style="color:var(--accent-amber); font-size:14px;">${roNum ? `REPAIR ORDER WRITE-UP ${roNum}` : 'NEW REPAIR ORDER WRITE-UP'}</strong>
          </div>
          <span class="u-text-dim">|</span>
          <button class="secondary-action-btn" data-command="ro.service_history">${UIComponent.Keycap('ALT+H', 'command')} HISTORY</button>
          <button class="secondary-action-btn" title="Previous Recommendations (coming soon)" disabled>${UIComponent.Keycap('ALT+R', 'command')} PREV RECS</button>
        </div>
        <div class="ui-row-10">
          <span id="roSaveMessage" style="color:var(--text-muted); font-size:13px;"></span>
          <button type="button" class="secondary-action-btn" data-command="ro.add_line">${UIComponent.Keycap('ALT+A', 'command')} ADD LINE ITEM</button>
          <button class="secondary-action-btn" data-command="ro.add_part">${UIComponent.Keycap('ALT+P', 'command')} ADD PART FROM INVENTORY</button>
          <button type="button" id="btnSaveRo" class="secondary-action-btn" data-command="ro.save">${UIComponent.Keycap('ALT+S', 'command', {id: 'kbdSaveRo'})} SAVE RO</button>
          ${roNum ? '' : `<button type="button" id="btnGenerateRo" class="secondary-action-btn" data-command="ro.generate">${UIComponent.Keycap('ALT+G', 'command', {id: 'kbdGenerateRo'})} GENERATE RO</button>`}
          <select id="roStatusSelect" class="ro-status-select status-write-up" aria-label="Repair order status" data-change-action="ro.status">
            <option value="write-up">WRITE-UP</option>
            <option value="hold-authorization">HOLD — AUTHORIZATION</option>
            <option value="ready-dispatch">READY TO DISPATCH</option>
            <option value="in-progress">IN PROGRESS</option>
            <option value="hold-parts">HOLD — PARTS</option>
            <option value="work-complete">WORK COMPLETE</option>
            <option value="invoiced">INVOICED</option>
          </select>
          <button type="button" class="primary-action-btn" data-command="ro.invoice">POST / INVOICE RO</button>
          <span class="ro-timing-marker timing-on-track" id="roTimingMarker">ON TRACK</span>
        </div>
      </div>

      <div id="roConfirmedParts" aria-live="polite"></div>
      <!-- CUSTOMER & VEHICLE INTAKE FIELDS (RESPONSIVE FLEX GRID) -->
      <div style="display:flex; flex-wrap:wrap; gap:8px; background:var(--surface-panel); padding:12px 14px; border-radius:4px; border:1px solid var(--border-mid);">
        <div style="position:relative; flex:1 1 180px;">
          <label class="field-label">CUSTOMER NAME / PHONE [C]:</label>
          <input type="text" id="roCustInput" placeholder="Search customer name or phone..." class="control-full" data-input-action="ro.customer-search" data-keydown-action="ro.customer-key" autocomplete="off" autofocus>
          <div id="roCustSearchResults" class="hidden typeahead-dropdown"></div>
        </div>
        <div style="position:relative; flex:1 1 180px;">
          <label class="field-label">VEHICLE (YR MAKE MODEL) [V]:</label>
          <input type="text" id="roVehInput" placeholder="e.g. 2022 Ford F-150" class="control-full" data-input-action="ro.vehicle-search" data-keydown-action="ro.vehicle-key" autocomplete="off">
          <div id="roVehSearchResults" class="hidden typeahead-dropdown"></div>
        </div>
        <div style="flex:1 1 100px;">
          <label class="field-label">LICENSE PLATE:</label>
          <input type="text" id="roPlateInput" placeholder="e.g. 7XYZ99" class="control-full">
        </div>
        <div style="flex:1.5 1 200px;">
          <div class="ui-between-mb-2">
            <label class="field-label">VIN (17-DIGIT)</label>
            <span id="roVinLast8Sub"></span>
          </div>
          <input type="text" id="roVinInput" placeholder="Enter 17-digit VIN..." style="width:100%; padding:6px 8px; font-size:11px; letter-spacing:0.04em;" data-input-action="ro.vin" maxlength="17" autocomplete="off">
        </div>
        <div style="flex:1 1 110px;">
          <label class="field-label">MILEAGE IN:</label>
          <input type="text" id="roMilesInput" placeholder="Enter Mileage..." class="control-full">
          <div id="roLastMilesSub" style="font-size:9px; color:var(--text-dim); margin-top:2px; height:12px;"></div>
        </div>
        <div id="roFleetUnitContainer" style="display:none; flex:1 1 110px;">
          <label class="field-label">FLEET UNIT #:</label>
          <input type="text" id="roFleetUnitInput" placeholder="e.g. UNIT-402" class="control-full">
        </div>
        <div id="roPoContainer" style="display:none; flex:1 1 110px;">
          <label class="field-label">CUSTOMER PO #:</label>
          <input type="text" id="roPoInput" placeholder="e.g. PO-8812" class="control-full">
        </div>
        <div style="flex:1 1 130px;">
          <label class="field-label">PREASSIGNED TECH:</label>
          <select id="roPreassignedTechSelect" class="control-full">
            ${generateRoTechnicianOptions()}
          </select>
        </div>
        <div style="flex:1 1 110px;">
          <label class="field-label">PROMISED TIME:</label>
          <select id="roTagInput" class="control-full">
            ${generateShopPromisedTimeOptions()}
          </select>
        </div>
      </div>

      <!-- REPAIR ORDER LINE ITEMS WORKSPACE TABLE -->
      <div style="flex:1; background:var(--surface-panel); border:1px solid var(--border-mid); border-radius:4px; overflow-y:auto;">
        <table class="ui-table">
          <thead>
            <tr class="ui-table-head-subtle">
              <th style="padding:10px; width:35px; text-align:center;">LN</th>
              <th style="width:55px; text-align:center;">PAY</th>
              <th style="width:120px;">OP-CODE</th>
              <th>VERBATIM CUSTOMER CONCERN / JOB DESCRIPTION</th>
              <th style="width:130px; text-align:center;">TECH</th>
              <th style="text-align:right; width:70px;">HRS</th>
              <th style="text-align:right; width:85px;">PARTS ($)</th>
              <th style="text-align:right; width:85px;">LABOR ($)</th>
              <th style="text-align:right; width:95px;">TOTAL</th>
              <th style="width:35px; text-align:center;"></th>
            </tr>
          </thead>
          <tbody id="roLinesWorkspaceBody">
          </tbody>
        </table>
      </div>

      <!-- BOTTOM: LIVE C W I BREAKDOWN & MASTER TOTAL BAR -->
      <div style="background:var(--surface-panel); padding:12px 16px; border-radius:4px; border:1px solid var(--border-bright); display:flex; justify-content:space-between; align-items:center;">
        <div style="display:flex; gap:24px; font-size:12px;">
          <div>[C] CUSTOMER PAY: <strong id="roCustPayTotal" class="u-text-green">$0.00</strong></div>
          <div>[W] WARRANTY PAY: <strong id="roWarrPayTotal" class="u-text-blue">$0.00</strong></div>
          <div>[I] INTERNAL PAY: <strong id="roIntPayTotal" class="u-text-amber">$0.00</strong></div>
          <div>[G] GOODWILL: <strong id="roGoodwillPayTotal" class="u-text-red">$0.00</strong></div>
        </div>
        <div style="display:flex; gap:20px; align-items:center;">
          <div style="font-size:12px; font-weight:700; color:var(--text-dim);" id="roInheritedRate">LABOR RATE: $150.00 — RETAIL</div>
          <span class="u-text-dim">|</span>
          <div style="font-size:12px; color:var(--text-muted);">TOTAL LABORED: <strong id="roTotalHours">0.00 HRS</strong></div>
          <span class="u-text-dim">|</span>
          <div style="color:var(--accent-amber); font-size:16px; font-weight:800;">MASTER RO TOTAL: <span id="roMasterTotal">$0.00</span></div>
        </div>
      </div>

    </div>
  `;
}

function updateRoButtonReadyStates() {
  const custName = document.getElementById('roCustInput')?.value.trim() || '';
  const rows = [...document.querySelectorAll('#roLinesWorkspaceBody tr')];
  const hasJobLine = rows.some(r => {
    const opcode = r.querySelector('.ro-opcode-input')?.value.trim();
    const concern = r.querySelector('.ro-concern-input')?.value.trim();
    return Boolean(opcode || concern);
  });

  const isReady = Boolean(custName && hasJobLine);

  const btnGenerate = document.getElementById('btnGenerateRo');
  const kbdGenerate = document.getElementById('kbdGenerateRo');
  if (btnGenerate) {
    if (isReady) {
      btnGenerate.className = 'secondary-action-btn action-emerald btn-ready btn-ready-glow';
      if (kbdGenerate) kbdGenerate.className = 'keycap keycap--command kbd-invert-emerald';
    } else {
      btnGenerate.className = 'secondary-action-btn';
      if (kbdGenerate) kbdGenerate.className = 'keycap keycap--command';
    }
  }

  const btnSave = document.getElementById('btnSaveRo');
  const kbdSave = document.getElementById('kbdSaveRo');
  if (btnSave) {
    if (isReady) {
      btnSave.className = 'secondary-action-btn action-emerald btn-ready';
      if (kbdSave) kbdSave.className = 'keycap keycap--command kbd-invert-emerald';
    } else {
      btnSave.className = 'secondary-action-btn';
      if (kbdSave) kbdSave.className = 'keycap keycap--command';
    }
  }
}

function changeRoStatus(selectEl) {
  selectEl.className = `ro-status-select status-${selectEl.value}`;

  if (selectEl.value === 'invoiced') {
    const rows = [...document.querySelectorAll('#roLinesWorkspaceBody tr')];
    const unbookedRows = rows.filter(row => row.dataset.booked !== '1');
    if (unbookedRows.length > 0) {
      alert(`INVOICING BLOCKED!\n\nAll active job lines must be BOOKED [B] before the Repair Order can be invoiced.`);
      selectEl.value = 'work-complete';
      selectEl.className = 'ro-status-select status-work-complete';
      return;
    }

    const isFleet = activeRoCustomer && (activeRoCustomer.customer_type === 'FLEET' || activeRoCustomer.customer_type === 'COMPANY');
    const requiresPo = isFleet || (activeRoCustomer && activeRoCustomer.reimbursement_details && activeRoCustomer.reimbursement_details.includes('PO'));

    if (requiresPo) {
      const poInput = document.getElementById('roPoInput');
      if (poInput && !poInput.value.trim()) {
        alert(`FLEET / COMPANY ACCOUNT RULES ENFORCED!\n\nTHIS ACCOUNT REQUIRES A PURCHASE ORDER (PO) BEFORE INVOICING.\n\nPlease enter the PO Number in the "CUSTOMER PO #" field.`);
        selectEl.value = 'work-complete';
        selectEl.className = 'ro-status-select status-work-complete';
      }
    }
  }
}

function addNewRoLine(data = {}) {
  const tbody = document.getElementById('roLinesWorkspaceBody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  const isSubline = Boolean(data.is_part_subline || data.is_subline);
  if (isSubline) tr.className = 'ro-part-subline';
  tr.style.borderBottom = '1px solid var(--border-soft)';
  if (isSubline) tr.style.background = 'rgba(255, 179, 0, 0.04)';
  tr.dataset.booked = data.booked ? '1' : '0';
  tr.dataset.lineId = data.line_id || crypto.randomUUID();

  const hrsVal = parseFloat(data.hrs || 0) || 0;
  let initialLabor = data.labor;
  if (hrsVal > 0 && (!initialLabor || parseFloat(initialLabor) === 0)) {
    initialLabor = (hrsVal * getActiveRoLaborRate()).toFixed(2);
  }

  const formattedHrs = data.hrs !== undefined && data.hrs !== null && data.hrs !== '' ? data.hrs : '';
  const formattedParts = data.parts !== undefined && data.parts !== null && data.parts !== '' ? data.parts : '';
  const formattedLabor = initialLabor !== undefined && initialLabor !== null && initialLabor !== '' && parseFloat(initialLabor) !== 0
    ? initialLabor
    : (hrsVal > 0 ? (hrsVal * getActiveRoLaborRate()).toFixed(2) : '');

  tr.innerHTML = `
    <td style="padding:10px; text-align:center; font-weight:700; color:var(--accent-amber);" class="ro-line-num">${isSubline ? '↳' : '1'}</td>
    <td class="u-align-center">
      <select class="ro-pay-select" data-change-action="ro.totals" style=" font-weight:800; border:1px solid var(--border-control); padding:3px; border-radius:2px; font-size:11px;">
        <option value="C" ${data.pay === 'C' ? 'selected' : ''}>C</option>
        <option value="W" ${data.pay === 'W' ? 'selected' : ''}>W</option>
        <option value="I" ${data.pay === 'I' ? 'selected' : ''}>I</option>
        <option value="G" ${data.pay === 'G' ? 'selected' : ''}>G</option>
      </select>
    </td>
    <td class="ui-relative">
      <input type="text" class="ro-opcode-input" value="${escapeHtml(data.op_code || '')}" placeholder="e.g. BR-GEN-DIAG" style="width:90%; padding:4px 6px; font-size:11px; border-radius:2px; ${isSubline ? 'padding-left:14px; color:var(--accent-amber); font-weight:700;' : ''}" data-input-action="ro.opcode-search" data-keydown-action="ro.opcode-key" autocomplete="off">
      <div class="ro-opcode-dropdown hidden" style="position:absolute; top:100%; left:0; width:340px; background:var(--surface-panel); border:1px solid var(--accent-amber); border-radius:4px; max-height:220px; overflow-y:auto; z-index:999; box-shadow:0 8px 24px var(--shadow-color); margin-top:4px;"></div>
    </td>
    <td style="${isSubline ? 'padding-left:18px;' : ''}"><input type="text" class="ro-concern-input" value="${escapeHtml(data.concern || '')}" placeholder="Type Verbatim Concern or Job Description..." style="width:98%; padding:4px 6px; font-size:11px; border-radius:2px; ${isSubline ? 'color:var(--text-main); font-weight:600;' : ''}"></td>
    <td class="u-align-center">
      <select class="ro-tech-select" style="font-weight:700; border:1px solid var(--border-control); padding:3px; border-radius:2px; font-size:11px; max-width:125px;">
        ${generateRoTechnicianOptions(data.tech_id || data.technician_id)}
      </select>
    </td>
    <td class="u-align-right"><input type="text" class="ro-hrs-input" data-input-action="ro.hours" value="${formattedHrs}" placeholder="0.0" style="width:48px; text-align:right; padding:4px 6px; font-size:11px; border-radius:2px;"></td>
    <td class="u-align-right"><input type="text" class="ro-parts-input" data-input-action="ro.totals" value="${formattedParts}" placeholder="0.00" style="width:62px; text-align:right; padding:4px 6px; font-size:11px; border-radius:2px;"></td>
    <td class="u-align-right"><input type="text" class="ro-labor-input" data-input-action="ro.labor" value="${formattedLabor}" placeholder="0.00" style="width:62px; text-align:right; padding:4px 6px; font-size:11px; border-radius:2px;"></td>
    <td style="text-align:right; padding-right:8px; font-weight:700; color:var(--accent-amber);" class="ro-line-total">$0.00</td>
    <td class="u-align-center"><label title="Confirm job line complete and booked"><input type="checkbox" class="ro-book-checkbox" ${data.booked ? 'checked' : ''} data-change-action="ro.book"> B</label><button type="button" class="line-remove-btn" data-action="ro.remove-line" title="Remove Line">✕</button></td>
  `;
  tr.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateRoButtonReadyStates));
  tbody.appendChild(tr);
  performRoTotalsCalculation();
  updateRoButtonReadyStates();
}

function toggleRoLineBooking(chk) {
  const tr = chk.closest('tr');
  if (!tr) return;
  const label = chk.parentElement;
  if (chk.checked) {
    tr.dataset.booked = '1';
    if (label) label.style.color = 'var(--accent-emerald)';
    if (label) label.style.fontWeight = '800';
  } else {
    tr.dataset.booked = '0';
    if (label) label.style.color = 'var(--text-muted)';
    if (label) label.style.fontWeight = 'normal';
  }
}

function deleteRoLine(btn) {
  const tr = btn.closest('tr');
  if (tr) {
    tr.remove();
    recalculateRoTotals();
    updateRoButtonReadyStates();
  }
}

function getActiveRoLaborRate() {
  const cust = (typeof activeRoCustomer !== 'undefined' && activeRoCustomer) ? activeRoCustomer : (window.activeRoCustomer || null);
  if (cust) {
    if (cust.labor_rate) return Number(cust.labor_rate);
    if (cust.customer_type === 'FLEET' || cust.customer_type === 'COMPANY') return 120.00;
  }
  return 150.00;
}

function handleRoHrsInputChange(hrsInp) {
  const row = hrsInp.closest('tr');
  if (row) {
    const hrs = parseFloat(hrsInp.value || 0) || 0;
    const laborInp = row.querySelector('.ro-labor-input');
    const currentLabor = parseFloat(laborInp?.value || 0) || 0;
    const isManual = laborInp && (laborInp.dataset.userOverridden === '1' || laborInp.dataset.manualOverride === '1') && currentLabor > 0;
    if (laborInp && (!isManual || currentLabor === 0)) {
      if (hrs > 0) {
        const rate = getActiveRoLaborRate();
        laborInp.value = (hrs * rate).toFixed(2);
      } else if (hrsInp.value.trim() === '' || hrs === 0) {
        laborInp.value = '';
      }
    }
  }
  performRoTotalsCalculation();
}

function handleRoLaborInputChange(laborInp) {
  const val = parseFloat(laborInp.value || 0) || 0;
  if (val > 0) {
    laborInp.dataset.userOverridden = '1';
  } else {
    delete laborInp.dataset.userOverridden;
    delete laborInp.dataset.manualOverride;
  }
  performRoTotalsCalculation();
}

let recalcRoFrameId = null;
function recalculateRoTotals() {
  if (recalcRoFrameId !== null) return;
  recalcRoFrameId = requestAnimationFrame(() => {
    recalcRoFrameId = null;
    performRoTotalsCalculation();
  });
}

function performRoTotalsCalculation() {
  const tbody = document.getElementById('roLinesWorkspaceBody');
  if (!tbody) return;

  let custPay = 0;
  let warrPay = 0;
  let intPay = 0;
  let goodwillPay = 0;
  let totalHours = 0;
  let masterTotal = 0;

  const rate = getActiveRoLaborRate();
  const rows = tbody.querySelectorAll('tr');
  rows.forEach((row, index) => {
    const lnBadge = row.querySelector('.ro-line-num');
    if (lnBadge) lnBadge.textContent = index + 1;

    const payType = row.querySelector('.ro-pay-select')?.value || 'C';
    const hrs = parseFloat(row.querySelector('.ro-hrs-input')?.value || 0) || 0;
    const parts = parseFloat(row.querySelector('.ro-parts-input')?.value || 0) || 0;
    const laborInp = row.querySelector('.ro-labor-input');

    const autoLabor = parseFloat((hrs * rate).toFixed(2));
    const currentLabor = parseFloat(laborInp?.value || 0) || 0;
    const isManual = laborInp && (laborInp.dataset.userOverridden === '1' || laborInp.dataset.manualOverride === '1') && currentLabor > 0;

    if (laborInp && (!isManual || currentLabor === 0)) {
      if (hrs > 0) {
        laborInp.value = autoLabor.toFixed(2);
      }
    }
    const labor = (isManual && currentLabor > 0) ? currentLabor : (hrs > 0 ? autoLabor : currentLabor);

    const lineTotal = parts + labor;
    const totalEl = row.querySelector('.ro-line-total');
    if (totalEl) totalEl.textContent = `$${lineTotal.toFixed(2)}`;

    totalHours += hrs;
    masterTotal += lineTotal;

    if (payType === 'C') custPay += lineTotal;
    else if (payType === 'W') warrPay += lineTotal;
    else if (payType === 'I') intPay += lineTotal;
    else if (payType === 'G') goodwillPay += lineTotal;
  });

  const custEl = document.getElementById('roCustPayTotal');
  const warrEl = document.getElementById('roWarrPayTotal');
  const intEl = document.getElementById('roIntPayTotal');
  const goodwillEl = document.getElementById('roGoodwillPayTotal');
  const hrsEl = document.getElementById('roTotalHours');
  const masterEl = document.getElementById('roMasterTotal');

  if (custEl) custEl.textContent = `$${custPay.toFixed(2)}`;
  if (warrEl) warrEl.textContent = `$${warrPay.toFixed(2)}`;
  if (intEl) intEl.textContent = `$${intPay.toFixed(2)}`;
  if (goodwillEl) goodwillEl.textContent = `$${goodwillPay.toFixed(2)}`;
  if (hrsEl) hrsEl.textContent = `${totalHours.toFixed(2)} HRS`;
  if (masterEl) masterEl.textContent = `$${masterTotal.toFixed(2)}`;

  updateRoButtonReadyStates();
}

async function saveRepairOrder() {
  if (window.AsyncOrchestrator) {
    return window.AsyncOrchestrator.executeMutation('#btnSaveRo', () => performSaveRepairOrder());
  }
  return performSaveRepairOrder();
}

async function performSaveRepairOrder() {
  const message = document.getElementById('roSaveMessage');
  const preassignedTechVal = document.getElementById('roPreassignedTechSelect')?.value || '';
  const preassigned_technician_id = preassignedTechVal ? Number(preassignedTechVal) : null;
  const rows = [...document.querySelectorAll('#roLinesWorkspaceBody tr')];
  const lines = rows.map(row => {
    const techVal = row.querySelector('.ro-tech-select')?.value || '';
    return {
      line_id: row.dataset.lineId,
      pay: row.querySelector('.ro-pay-select')?.value || 'C',
      tech_id: techVal ? Number(techVal) : null,
      op_code: row.querySelector('.ro-opcode-input')?.value.trim() || '',
      concern: row.querySelector('.ro-concern-input')?.value.trim() || '',
      hrs: row.querySelector('.ro-hrs-input')?.value || 0,
      parts: row.querySelector('.ro-parts-input')?.value || 0,
      labor: row.querySelector('.ro-labor-input')?.value || 0,
      booked: row.querySelector('.ro-book-checkbox')?.checked ? 1 : 0
    };
  }).filter(line => line.op_code || line.concern || Number(line.hrs) || Number(line.parts) || Number(line.labor));

  const payload = {
    id: activeEditingRoId || undefined,
    customer: document.getElementById('roCustInput')?.value.trim() || '',
    vehicle: document.getElementById('roVehInput')?.value.trim() || '',
    license_plate: document.getElementById('roPlateInput')?.value.trim() || '',
    vin: document.getElementById('roVinInput')?.value.trim() || '',
    mileage: document.getElementById('roMilesInput')?.value.trim() || '',
    fleet_unit: document.getElementById('roFleetUnitInput')?.value.trim() || '',
    po_number: document.getElementById('roPoInput')?.value.trim() || '',
    promised_time: document.getElementById('roTagInput')?.value || '',
    preassigned_technician_id,
    status: document.getElementById('roStatusSelect')?.value || 'write-up',
    lines
  };
  if (message) {
    message.textContent = 'SAVING…';
    message.style.color = 'var(--text-muted)';
  }
  try {
    const result = await api('/api/repair-orders', { method: 'POST', body: JSON.stringify(payload) });
    activeEditingRoId = result.repair_order.id;
    await loadRepairOrders();
    document.getElementById('activeTaskTitle').textContent = `REPAIR ORDER WRITE-UP EDITOR (${result.repair_order.ro_number})`;
    if (message) {
      message.textContent = `SAVED ${result.repair_order.ro_number}`;
      message.style.color = 'var(--accent-emerald)';
    }
    return result;
  } catch (err) {
    if (message) {
      message.textContent = err.message.toUpperCase();
      message.style.color = 'var(--accent-crimson)';
    }
    throw err;
  }
}

async function invoiceRepairOrder() {
  const statusSelect = document.getElementById('roStatusSelect');
  if (!statusSelect) return;

  const rows = [...document.querySelectorAll('#roLinesWorkspaceBody tr')];
  if (!rows.length) {
    alert('INVOICING BLOCKED!\n\nCannot invoice an empty Repair Order with no line items.');
    return;
  }

  const unbookedRows = rows.filter(row => row.dataset.booked !== '1');
  if (unbookedRows.length > 0) {
    alert('INVOICING BLOCKED!\n\nAll active job lines must be BOOKED [B] before the Repair Order can be invoiced.');
    return;
  }

  const isFleet = activeRoCustomer && (activeRoCustomer.customer_type === 'FLEET' || activeRoCustomer.customer_type === 'COMPANY');
  const requiresPo = isFleet || (activeRoCustomer && activeRoCustomer.reimbursement_details && activeRoCustomer.reimbursement_details.includes('PO'));

  if (requiresPo) {
    const poInput = document.getElementById('roPoInput');
    if (poInput && !poInput.value.trim()) {
      alert('FLEET / COMPANY ACCOUNT RULES ENFORCED!\n\nTHIS ACCOUNT REQUIRES A PURCHASE ORDER (PO) BEFORE INVOICING.\n\nPlease enter the PO Number in the "CUSTOMER PO #" field.');
      return;
    }
  }

  const previousStatus = statusSelect.value;
  statusSelect.value = 'invoiced';
  changeRoStatus(statusSelect);

  const message = document.getElementById('roSaveMessage');
  if (message) {
    message.textContent = 'INVOICING…';
    message.style.color = 'var(--accent-amber)';
  }

  try {
    const result = await saveRepairOrder();
    if (result && result.repair_order) {
      const ro = result.repair_order;
      await openRoWriteupForEdit(ro.id);
      const cust = ro.customer_name || 'CUSTOMER';
      const total = Number(ro.master_total || 0).toFixed(2);
      if (window.FeedbackManager) {
        window.FeedbackManager.toast(`REPAIR ORDER INVOICED SUCCESSFULLY! (RO #${ro.ro_number})`, 'success');
      } else {
        alert(`REPAIR ORDER INVOICED SUCCESSFULLY!\n\nRO Number: ${ro.ro_number}\nCustomer: ${cust}\nStatus: INVOICED\nMaster Total: $${total}`);
      }
    }
  } catch (err) {
    statusSelect.value = previousStatus;
    changeRoStatus(statusSelect);
    alert('INVOICING ERROR: ' + err.message);
  }
}

async function generateRoFromWriteup() {
  const custName = document.getElementById('roCustInput')?.value.trim() || '';
  const vehInfo = document.getElementById('roVehInput')?.value.trim() || '';
  if (!custName || !vehInfo) {
    alert('GENERATE RO BLOCKED!\n\nBoth Customer Name and Vehicle (Year Make Model) are required to generate and dispatch a Repair Order.');
    return;
  }
  const statusSelect = document.getElementById('roStatusSelect');
  if (statusSelect) {
    statusSelect.value = 'ready-dispatch';
    changeRoStatus(statusSelect);
  }
  await saveRepairOrder();
  const message = document.getElementById('roSaveMessage');
  if (message) {
    message.textContent = 'GENERATED RO';
    message.style.color = 'var(--accent-emerald)';
  }
}

function queueRoCustomerSearch(query) {
  clearTimeout(roCustomerSearchTimer);
  const dropdown = document.getElementById('roCustSearchResults');
  if (!dropdown) return;

  if (!query.trim()) {
    dropdown.innerHTML = '';
    dropdown.classList.add('hidden');
    roCustomerSearchResults = [];
    roCustActiveIndex = 0;
    return;
  }

  roCustomerSearchTimer = setTimeout(() => searchRoCustomers(query), 150);
}

async function searchRoCustomers(query) {
  const dropdown = document.getElementById('roCustSearchResults');
  if (!dropdown) return;

  try {
    const response = await api(`/api/customers?q=${encodeURIComponent(query.trim())}`);
    roCustomerSearchResults = response.customers;
    roCustActiveIndex = 0;
    renderRoCustomerDropdown();
  } catch (err) {
    dropdown.innerHTML = `<div style="padding:10px; color:var(--accent-amber); font-size:11px;">${escapeHtml(err.message)}</div>`;
    dropdown.classList.remove('hidden');
  }
}

function renderRoCustomerDropdown() {
  const dropdown = document.getElementById('roCustSearchResults');
  if (!dropdown) return;

  if (!roCustomerSearchResults.length) {
    dropdown.innerHTML = '<div style="padding:10px; color:var(--text-muted); font-size:11px;">NO MATCHING CUSTOMERS IN DATABASE.</div>';
    dropdown.classList.remove('hidden');
    return;
  }

  dropdown.innerHTML = roCustomerSearchResults.map((cust, index) => {
    const isActive = index === roCustActiveIndex;
    return `
      <div class="ro-cust-search-row ui-search-result ${isActive ? 'is-active' : ''}" tabindex="0" aria-selected="${isActive}" data-action="ro.customer" data-action-param="${cust.id}" data-keydown-action="ro.customer-row">
        <div>
          ${UIComponent.Keycap(index + 1, 'index', {style: 'background:var(--accent-amber); color:var(--surface-input); font-weight:800; margin-right:6px;'})}
          <strong class="u-text-main">${escapeHtml(cust.name)}</strong>
          ${isActive ? '<span style="font-size:9px; color:var(--accent-amber); margin-left:6px; font-weight:800;">[ENTER ↵]</span>' : ''}
        </div>
        <div class="ui-label-muted">
          <span>${escapeHtml(cust.phone || 'NO PHONE')}</span>
          ${cust.email ? ` · <span>${escapeHtml(cust.email)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  dropdown.classList.remove('hidden');
  if (window.DropdownRegistry) {
    window.DropdownRegistry.open('roCustSearchResults', dropdown, document.getElementById('roCustInput'), () => {
      const d = document.getElementById('roCustSearchResults');
      if (d) d.classList.add('hidden');
    });
  }
}

async function selectRoCustomer(customerId) {
  if (window.DropdownRegistry) window.DropdownRegistry.close();
  const dropdown = document.getElementById('roCustSearchResults');
  if (dropdown) dropdown.classList.add('hidden');

  try {
    const response = await api(`/api/customers/${customerId}`);
    const customer = response.customer;
    activeRoCustomer = customer;

    const custInput = document.getElementById('roCustInput');
    if (custInput) custInput.value = customer.name.toUpperCase();

    if (customer.vehicles && customer.vehicles.length > 0) {
      const veh = customer.vehicles[0];
      const vehInput = document.getElementById('roVehInput');
      const vinInput = document.getElementById('roVinInput');
      const plateInput = document.getElementById('roPlateInput');
      const milesInput = document.getElementById('roMilesInput');
      const lastSub = document.getElementById('roLastMilesSub');

      if (vehInput) vehInput.value = formatVehicleYMM(veh);
      if (vinInput) vinInput.value = (veh.vin || '').toUpperCase();
      if (plateInput) plateInput.value = (veh.plate || '').toUpperCase();
      if (milesInput) milesInput.value = '';
      if (lastSub) {
        lastSub.innerHTML = veh.mileage ? `<span style="color:var(--accent-amber); font-weight:700;">LAST: ${veh.mileage.toLocaleString()} MILES</span>` : '';
      }
      requestAnimationFrame(() => milesInput?.focus());
    }

    const fleetUnitInput = document.getElementById('roFleetUnitInput');
    const fleetUnitContainer = document.getElementById('roFleetUnitContainer');
    const poContainer = document.getElementById('roPoContainer');

    const isCommercial = customer && (customer.customer_type === 'FLEET' || customer.customer_type === 'COMPANY' || customer.customer_type === 'COMMERCIAL' || customer.customer_type === 'WHOLESALE' || (customer.customer_type && customer.customer_type !== 'RETAIL') || customer.fleet_unit_number || customer.po_number);

    if (fleetUnitContainer) fleetUnitContainer.style.display = isCommercial ? 'block' : 'none';
    if (poContainer) poContainer.style.display = isCommercial ? 'block' : 'none';
    if (fleetUnitInput) fleetUnitInput.value = customer.fleet_unit_number || '';

    let activeRate = 150.00;
    let rateLabel = 'RETAIL';
    if (customer.labor_rate) {
      activeRate = customer.labor_rate;
      rateLabel = `${customer.company_name || customer.name} CUSTOM`;
    } else if (customer.customer_type === 'FLEET' || customer.customer_type === 'COMPANY') {
      activeRate = 120.00;
      rateLabel = 'FLEET DEFAULT';
    }
    const rateEl = document.getElementById('roInheritedRate');
    if (rateEl) rateEl.textContent = `LABOR RATE: $${activeRate.toFixed(2)} — ${rateLabel}`;

  } catch (err) {
    console.error('Error fetching customer details for RO:', err);
  }
}

function handleRoCustomerSearchKeydown(e) {
  handleTypeaheadNavigation(e, {
    dropdown: document.getElementById('roCustSearchResults'), results: roCustomerSearchResults,
    activeIndex: roCustActiveIndex, setActiveIndex: value => { roCustActiveIndex = value; },
    render: renderRoCustomerDropdown, select: selectRoCustomer, valueForResult: customer => customer.id
  });
}

function queueRoVehicleSearch(query) {
  clearTimeout(roVehicleSearchTimer);
  const dropdown = document.getElementById('roVehSearchResults');
  if (!dropdown) return;

  if (!query.trim()) {
    dropdown.innerHTML = '';
    dropdown.classList.add('hidden');
    roVehicleSearchResults = [];
    roVehActiveIndex = 0;
    return;
  }

  roVehicleSearchTimer = setTimeout(() => searchRoVehicles(query), 150);
}

async function searchRoVehicles(query) {
  const dropdown = document.getElementById('roVehSearchResults');
  if (!dropdown) return;

  try {
    const response = await api(`/api/vehicles?q=${encodeURIComponent(query.trim())}`);
    roVehicleSearchResults = response.vehicles;
    roVehActiveIndex = 0;
    renderRoVehicleDropdown();
  } catch (err) {
    dropdown.innerHTML = `<div style="padding:10px; color:var(--accent-amber); font-size:11px;">${escapeHtml(err.message)}</div>`;
    dropdown.classList.remove('hidden');
  }
}

function renderRoVehicleDropdown() {
  const dropdown = document.getElementById('roVehSearchResults');
  if (!dropdown) return;

  if (!roVehicleSearchResults.length) {
    dropdown.innerHTML = '<div style="padding:10px; color:var(--text-muted); font-size:11px;">NO MATCHING VEHICLES OR EQUIPMENT IN DATABASE.</div>';
    dropdown.classList.remove('hidden');
    return;
  }

  dropdown.innerHTML = roVehicleSearchResults.map((veh, index) => {
    const isActive = index === roVehActiveIndex;
    const ymm = formatVehicleYMM(veh);
    const isShop = veh.is_shop_equipment || veh.asset_type === 'SHOP_EQUIPMENT';
    const isEquip = veh.asset_type === 'EQUIPMENT';

    let tagHtml = '';
    if (isShop) {
      tagHtml = '<span style="background:rgba(var(--accent-emerald-rgb),0.2); color:var(--accent-emerald); padding:1px 5px; border-radius:2px; font-size:9px; font-weight:800; margin-left:6px;">SHOP TOOL / ASSET</span>';
    } else if (isEquip) {
      tagHtml = '<span style="background:rgba(var(--accent-steel-rgb),0.2); color:var(--accent-steel); padding:1px 5px; border-radius:2px; font-size:9px; font-weight:800; margin-left:6px;">EQUIPMENT</span>';
    }

    return `
      <div class="ro-veh-search-row ui-search-result ${isActive ? 'is-active' : ''}" tabindex="0" aria-selected="${isActive}" data-action="ro.vehicle" data-action-param="${index}">
        <div>
          ${UIComponent.Keycap(index + 1, 'index', {style: 'background:var(--accent-amber); color:var(--surface-input); font-weight:800; margin-right:6px;'})}
          <strong class="u-text-main">${escapeHtml(ymm)}</strong> ${tagHtml}
          ${isActive ? '<span style="font-size:9px; color:var(--accent-amber); margin-left:6px; font-weight:800;">[ENTER ↵]</span>' : ''}
        </div>
        <div class="ui-label-muted">
          <span>${escapeHtml(veh.vin || veh.serial_number || 'NO SERIAL')}</span>
          ${veh.plate ? ` · <span>PLATE: ${escapeHtml(veh.plate)}</span>` : ''}
          ${isShop ? ` · <span style="color:var(--accent-emerald); font-weight:700;">SHOP INTERNAL</span>` : (veh.customer_name ? ` · <span style="color:var(--accent-amber); font-weight:700;">${escapeHtml(veh.customer_name)}</span>` : '')}
        </div>
      </div>
    `;
  }).join('');

  dropdown.classList.remove('hidden');
}

function selectRoVehicle(index) {
  const veh = roVehicleSearchResults[index];
  if (!veh) return;

  const isShop = veh.is_shop_equipment || veh.asset_type === 'SHOP_EQUIPMENT';
  if (isShop) {
    const confirmInternal = confirm(`SHOP INTERNAL ASSET NOTICE:\n\n"${formatVehicleYMM(veh)}" is registered as Shop Internal Equipment (Tool/Machinery).\n\nIt is an internal shop asset rather than a customer repair piece.\n\nPress OK to attach this internal asset to an Internal [I] Repair Order, or Cancel to pick a customer vehicle.`);
    if (!confirmInternal) return;
  }

  const dropdown = document.getElementById('roVehSearchResults');
  if (dropdown) dropdown.classList.add('hidden');

  const vehInput = document.getElementById('roVehInput');
  const vinInput = document.getElementById('roVinInput');
  const plateInput = document.getElementById('roPlateInput');
  const milesInput = document.getElementById('roMilesInput');
  const lastSub = document.getElementById('roLastMilesSub');
  const custInput = document.getElementById('roCustInput');

  if (vehInput) vehInput.value = formatVehicleYMM(veh);
  if (vinInput) vinInput.value = (veh.vin || veh.serial_number || '').toUpperCase();
  if (plateInput) plateInput.value = (veh.plate || '').toUpperCase();
  if (milesInput) milesInput.value = '';
  if (lastSub) {
    if (veh.hours_meter) {
      lastSub.innerHTML = `<span style="color:var(--accent-emerald); font-weight:700;">HOURS METER: ${veh.hours_meter} HRS</span>`;
    } else if (veh.mileage) {
      lastSub.innerHTML = `<span style="color:var(--accent-amber); font-weight:700;">LAST: ${veh.mileage.toLocaleString()} MILES</span>`;
    } else {
      lastSub.innerHTML = '';
    }
  }
  if (isShop && custInput) {
    custInput.value = 'INTERNAL SHOP MAINTENANCE';
  } else if (custInput && !custInput.value.trim() && veh.customer_name) {
    custInput.value = veh.customer_name.toUpperCase();
  }
  requestAnimationFrame(() => milesInput?.focus());
}

function handleRoVehicleSearchKeydown(e) {
  handleTypeaheadNavigation(e, {
    dropdown: document.getElementById('roVehSearchResults'), results: roVehicleSearchResults,
    activeIndex: roVehActiveIndex, setActiveIndex: value => { roVehActiveIndex = value; },
    render: renderRoVehicleDropdown, select: selectRoVehicle
  });
}

function queueOpcodeDropdown(inputEl) {
  const td = inputEl.closest('td');
  if (!td) return;
  const dropdown = td.querySelector('.ro-opcode-dropdown');
  if (!dropdown) return;
  if (window.OpcodePicker) {
    OpcodePicker.search(inputEl.value, inputEl, dropdown);
  }
}

function renderOpcodeDropdown(inputEl, dropdown, matches) {
  if (!matches.length) {
    dropdown.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:10px;">NO MATCHING OP-CODES</div>';
    dropdown.classList.remove('hidden');
    return;
  }

  dropdown.innerHTML = matches.map((item, index) => `
    <div class="opcode-item-row" data-action="ro.opcode" data-action-param="${escapeHtml(item.code)}" style="padding:6px 10px; border-bottom:1px solid var(--border-mid); cursor:pointer; display:flex; justify-content:space-between; align-items:center; font-size:11px;">
      <div>
        ${UIComponent.Keycap(item.code, 'index', {style: 'background:var(--accent-amber); color:var(--surface-input); font-weight:800; margin-right:4px;'})}
        <span style="color:var(--text-main); font-weight:600; font-size:10px;">${escapeHtml(item.concern)}</span>
      </div>
      <div style="color:var(--accent-amber); font-weight:700; font-size:10px; min-width:45px; text-align:right;">${item.hrs}h</div>
    </div>
  `).join('');

  dropdown.classList.remove('hidden');
}

function selectOpcodeItem(rowEl, code) {
  const tr = rowEl.closest('tr');
  if (!tr) return;

  const item = getJobOpcodeCatalog().find(i => i.code === code);
  if (!item) return;

  const opcodeInput = tr.querySelector('.ro-opcode-input');
  const concernInput = tr.querySelector('.ro-concern-input');
  const hrsInput = tr.querySelector('.ro-hrs-input');
  const partsInput = tr.querySelector('.ro-parts-input');
  const laborInput = tr.querySelector('.ro-labor-input');
  const dropdown = tr.querySelector('.ro-opcode-dropdown');

  if (opcodeInput) opcodeInput.value = item.code;
  if (concernInput) concernInput.value = item.concern;
  if (hrsInput) hrsInput.value = item.hrs;
  if (partsInput) partsInput.value = item.parts;
  if (laborInput) {
    delete laborInput.dataset.userOverridden;
    delete laborInput.dataset.manualOverride;
    const rate = getActiveRoLaborRate();
    const hrsVal = parseFloat(item.hrs || 0) || 0;
    const laborVal = hrsVal > 0 ? hrsVal * rate : (parseFloat(item.labor || 0) || 0);
    laborInput.value = laborVal.toFixed(2);
  }
  if (dropdown) dropdown.classList.add('hidden');

  performRoTotalsCalculation();
}

function handleRoCustRowKeydown(e, customerId, rowElement = e.currentTarget) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    selectRoCustomer(customerId);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = rowElement.nextElementSibling;
    if (next) next.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = rowElement.previousElementSibling;
    if (prev) prev.focus();
    else document.getElementById('roCustInput')?.focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('roCustSearchResults')?.classList.add('hidden');
    document.getElementById('roCustInput')?.focus();
  }
}

function handleOrdersEscapeNav() {
  const linesBody = document.getElementById('roLinesWorkspaceBody');
  if (linesBody) {
    requestNavigation('O');
    return true;
  }
  return false;
}

function renderRoHistoryWorkspace() {
  const isCashoutMode = typeof state !== 'undefined' && state.activeTask === 'F';

  requestAnimationFrame(() => {
    loadRoHistoryData();
  });

  return `
    <div style="font-family:var(--font-mono); color:var(--text-main); display:flex; flex-direction:column; gap:14px; height:100%;">
      <div class="ui-command-panel">
        <div>
          <strong class="ui-copy">${isCashoutMode ? 'FINAL CASHOUT &amp; POSTING ENGINE' : 'REPAIR ORDER HISTORY &amp; SEARCH AUDIT ENGINE'}</strong>
          <span style="font-size:11px; color:var(--text-dim); margin-left:12px;">${isCashoutMode ? 'CASHOUT INVOICED REPAIR ORDERS &amp; POST CLOSED BATCHES' : 'SEARCH CLOSED &amp; ACTIVE ROs BY CUSTOMER, VIN, PART #, OR JOB TYPE'}</span>
        </div>
        <div class="ui-row-8">
          <select id="histSortOrder" class="ui-dark-select" data-change-action="ro.history" style="padding:6px 10px; font-size:11px;">
            <option value="DESC">NEWEST FIRST (DESCENDING)</option>
            <option value="ASC">OLDEST FIRST (ASCENDING)</option>
          </select>
        </div>
      </div>

      <!-- FILTER CONTROLS BAR -->
      <div style="display:grid; grid-template-columns: 2fr 1fr 1fr 1fr 1fr; gap:10px; background:var(--surface-subtle); padding:12px; border-radius:4px; border:1px solid var(--border-mid);">
        <div>
          <label class="ui-label-dim">SEARCH (CUSTOMER / VIN / PLATE / RO# / PART #)</label>
          <input id="histQueryInput" type="text" class="control-full" placeholder="Type name, VIN, RO#, or part..." data-input-action="ro.history-search" autocomplete="off">
        </div>
        <div>
          <label class="ui-label-dim">STATUS FILTER</label>
          <select id="histStatusFilter" class="ui-dark-select control-full" data-change-action="ro.history">
            <option value="invoiced" ${isCashoutMode ? 'selected' : ''}>INVOICED ONLY</option>
            <option value="" ${!isCashoutMode ? 'selected' : ''}>ALL STATUSES</option>
            <option value="work-complete">WORK COMPLETE</option>
            <option value="write-up">WRITE-UP</option>
          </select>
        </div>
        <div>
          <label class="ui-label-dim">JOB TYPE FILTER</label>
          <select id="histJobType" class="ui-dark-select control-full" data-change-action="ro.history">
            <option value="">ALL JOB TYPES</option>
            <option value="MAINTENANCE">MAINTENANCE</option>
            <option value="BRAKES">BRAKES</option>
            <option value="STEERING">STEERING &amp; SUSPENSION</option>
            <option value="TIRES">TIRES &amp; WHEELS</option>
            <option value="ELECTRICAL">ELECTRICAL &amp; DIAG</option>
          </select>
        </div>
        <div>
          <label class="ui-label-dim">START DATE</label>
          <input id="histStartDate" type="date" class="control-full" data-change-action="ro.history">
        </div>
        <div>
          <label class="ui-label-dim">END DATE</label>
          <input id="histEndDate" type="date" class="control-full" data-change-action="ro.history">
        </div>
      </div>

      <!-- RESULTS CONTAINER -->
      <div id="roHistoryResultsContainer" style="flex:1; overflow-y:auto;">
        <div style="padding:20px; text-align:center; color:var(--text-dim);">LOADING REPAIR ORDER DATA...</div>
      </div>
    </div>
  `;
}

let debouncedHistSearchTimer = null;
function debounceRoHistorySearch() {
  clearTimeout(debouncedHistSearchTimer);
  debouncedHistSearchTimer = setTimeout(() => {
    loadRoHistoryData();
  }, 200);
}

async function loadRoHistoryData() {
  const container = document.getElementById('roHistoryResultsContainer');
  if (!container) return;

  const isCashoutMode = typeof state !== 'undefined' && state.activeTask === 'F';
  const query = document.getElementById('histQueryInput')?.value || '';
  const statusFilter = document.getElementById('histStatusFilter')?.value ?? (isCashoutMode ? 'invoiced' : '');
  const jobType = document.getElementById('histJobType')?.value || '';
  const startDate = document.getElementById('histStartDate')?.value || '';
  const endDate = document.getElementById('histEndDate')?.value || '';
  const sort = document.getElementById('histSortOrder')?.value || 'DESC';

  try {
    const params = new URLSearchParams({ query, status: statusFilter, job_type: jobType, start_date: startDate, end_date: endDate, sort });
    const res = await api(`/api/history?${params.toString()}`);
    const orders = res.repair_orders || [];

    if (!orders.length) {
      container.innerHTML = `<div style="padding:24px; color:var(--text-muted); text-align:center; background:var(--surface-panel); border-radius:4px; border:1px solid var(--border-mid);">NO REPAIR ORDERS MATCHING CURRENT SEARCH &amp; FILTER CRITERIA.</div>`;
      return;
    }

    container.innerHTML = `
      <table class="ui-table" style="background:var(--surface-panel); border-radius:4px; border:1px solid var(--border-mid); overflow:hidden;">
        <thead>
          <tr class="ui-table-head-subtle">
            <th class="ui-cell-tight" style="width:110px;">RO #</th>
            <th class="ui-cell-tight" style="width:120px;">DATE</th>
            <th class="ui-cell-tight">CUSTOMER NAME</th>
            <th class="ui-cell-tight">VEHICLE &amp; VIN</th>
            <th class="ui-cell-tight" style="width:130px;">STATUS</th>
            <th class="ui-cell-tight-right" style="width:100px;">TOTAL ($)</th>
            <th class="ui-cell-tight" style="width:90px; text-align:center;">ACTION</th>
          </tr>
        </thead>
        <tbody>
          ${orders.map(ro => {
            const statusRaw = String(ro.status || 'open').toLowerCase();
            const statusClass = statusRaw === 'invoiced' ? 'color:var(--accent-emerald); font-weight:700;' : statusRaw === 'closed' ? 'color:var(--text-muted);' : 'color:var(--accent-cyan); font-weight:700;';
            const displayTotal = Number(ro.master_total || ro.grand_total || ro.customer_total || 0).toFixed(2);
            return `
              <tr style="border-bottom:1px solid var(--border-soft);">
                <td class="ui-cell-tight"><strong class="u-text-amber">${escapeHtml(ro.ro_number || `RO-${ro.id}`)}</strong></td>
                <td class="ui-cell-tight">${escapeHtml(String(ro.created_at || '').substring(0, 10))}</td>
                <td class="ui-cell-tight"><strong>${escapeHtml(ro.customer_name || 'RETAIL CUSTOMER')}</strong></td>
                <td class="ui-cell-tight"><span class="ui-label-dim">${escapeHtml(ro.vehicle_info || '')} ${ro.vin ? `(VIN: ${escapeHtml(ro.vin)})` : ''}</span></td>
                <td class="ui-cell-tight"><span style="${statusClass}">${escapeHtml(ro.status || 'OPEN')}</span></td>
                <td class="ui-cell-tight-right"><strong class="u-text-green">$${displayTotal}</strong></td>
                <td class="ui-cell-tight" style="text-align:center;">
                  <button type="button" class="secondary-action-btn action-compact" data-action="ro.edit" data-action-param="${ro.id}">VIEW</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    container.innerHTML = `<div style="padding:16px; color:var(--accent-crimson); font-size:12px;">${escapeHtml(err.message)}</div>`;
  }
}

if (window.WorkspaceLifecycle) {
  window.WorkspaceLifecycle.register('O', {
    getInitialState: () => ({
      search: '',
      selectedId: null,
      activeRowIndex: 0,
      editorMode: 'board'
    }),
    mount: (container) => {
      container.setAttribute('data-workspace', 'orders');
    },
    load: async () => {
      await loadRepairOrders();
      return activeRoList;
    },
    render: () => {
      return renderRoWriteupContent();
    },
    interact: () => {
      if (typeof updateRoActiveRowHighlight === 'function') {
        updateRoActiveRowHighlight();
      }
    },
    unmount: () => {
      activeEditingRoId = null;
    }
  });
}

function renderConfirmedRoParts(ro) {
  const panel = document.getElementById('roConfirmedParts');
  if (!panel) return;
  const charges = ro.part_charges || [];
  panel.replaceChildren();
  if (!charges.length) return;
  const heading = document.createElement('strong');
  heading.textContent = 'CONFIRMED INVENTORY PARTS';
  panel.appendChild(heading);
  charges.forEach(charge => {
    const row = document.createElement('div');
    row.textContent = `${charge.part_number} — ${charge.qty} @ $${Number(charge.unit_price).toFixed(2)} — ${charge.status} `;
    if (ro.status !== 'invoiced') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'REMOVE / RELEASE';
      remove.addEventListener('click', async () => {
        try {
          await saveRepairOrder();
          await api('/api/repair-orders/remove-part', { method: 'POST', body: JSON.stringify({ charge_id: charge.id }) });
          await loadRepairOrders();
          await openRoWriteupForEdit(ro.id);
        } catch (err) { alert(err.message); }
      });
      row.appendChild(remove);
    }
    panel.appendChild(row);
  });
}


document.addEventListener('DOMContentLoaded', () => {
  const actions = {
    'ro.open': (param) => expandRoByNumber(Number(param)),
    'ro.sort': (param) => sortRoTable(param),
    'ro.status': (_, element) => changeRoStatus(element),
    'ro.customer-search': (_, element) => queueRoCustomerSearch(element.value),
    'ro.customer-key': (_, element, event) => handleRoCustomerSearchKeydown(event),
    'ro.vehicle-search': (_, element) => queueRoVehicleSearch(element.value),
    'ro.vehicle-key': (_, element, event) => handleRoVehicleSearchKeydown(event),
    'ro.vin': (_, element) => updateApptVinLast8Display(element.value),
    'ro.totals': () => performRoTotalsCalculation(),
    'ro.opcode-search': (_, element) => queueOpcodeDropdown(element),
    'ro.opcode-key': (_, element, event) => OpcodePicker.handleKeydown(event, element),
    'ro.hours': (_, element) => handleRoHrsInputChange(element),
    'ro.labor': (_, element) => handleRoLaborInputChange(element),
    'ro.book': (_, element) => toggleRoLineBooking(element),
    'ro.remove-line': (_, element) => deleteRoLine(element),
    'ro.customer': (param) => selectRoCustomer(Number(param)),
    'ro.customer-row': (param, element, event) => handleRoCustRowKeydown(event, Number(param), element),
    'ro.vehicle': (param) => selectRoVehicle(Number(param)),
    'ro.opcode': (param, element) => selectOpcodeItem(element, param),
    'ro.history': () => loadRoHistoryData(),
    'ro.history-search': () => debounceRoHistorySearch(),
    'ro.edit': (param) => openRoWriteupForEdit(Number(param)),
    'ro.page': (param) => changeRoBoardPage(Number(param)),
  };
  for (const [name, handler] of Object.entries(actions)) {
    EventDelegator.registerAction(name, handler, { permission: 'repair_orders' });
  }
});
