/**
 * TaktRO — Vehicle & Equipment Identity Domain Module (vehicles/vehicles.js)
 * Handles Customer Vehicles, Shop Fleet Vehicles (Loaner Cars, Parts Runner Trucks, Tuning Trucks),
 * Customer Equipment (Generators, Pressure Washers, Small Engines), and Shop Maintenance Tools (A/C Machines, Lifts, Compressors).
 */

let vehicleSearchTimer = null;
let vehicleSearchResults = [];
let activeVehicle = null;
let customerLinkTimer = null;
let customerLinkResults = [];
let pendingVehicleCustomerLink = null;

function formatVehicleYMM(veh) {
  if (!veh) return '';
  const assetType = veh.asset_type || 'VEHICLE';
  if (assetType === 'EQUIPMENT' || assetType === 'SHOP_EQUIPMENT') {
    const category = veh.equipment_category ? `[${veh.equipment_category}] ` : '';
    const make = veh.make || '';
    const model = veh.model || '';
    return `${category}${make} ${model}`.trim().toUpperCase();
  }
  const fleetPrefix = veh.shop_fleet_type ? `[${veh.shop_fleet_type}] ` : '';
  const year = veh.year || '';
  const make = veh.make || '';
  let model = (veh.model || '').trim().split(/\s+/).filter(word => !word.includes('/')).join(' ');
  const rawTrim = String(veh.trim || '').trim();
  const trim = rawTrim && !rawTrim.includes('/') ? ` ${rawTrim}` : '';
  return `${fleetPrefix}${year} ${make} ${model}${trim}`.trim().toUpperCase();
}

function renderVehicleContent() {
  requestAnimationFrame(() => searchVehicles(''));
  return `
    <div class="vehicle-shell">
      <div class="ui-command-panel">
        <strong class="ui-copy">VEHICLE &amp; EQUIPMENT DIRECTORY LOOKUP</strong>
        <button id="addVehicleBtn" class="primary-action-btn" data-action="vehicle.openAddVehicle">${UIComponent.Keycap("ALT+A", "inverse", {className: "kbd-invert"})} ADD VEHICLE / EQUIPMENT</button>
      </div>
      <input id="vehicleSearch" type="text" placeholder="Search customer, make/brand, model, VIN, serial #, category, loaner/runner, plate..." class="vehicle-search" data-input-action="vehicle.queueVehicleSearch" data-keydown-action="vehicle.handleVehicleSearchKeydown" autofocus>
      <div id="vehicleResults"></div>
    </div>
  `;
}

function openAddVehicle() {
  renderVehicleForm();
}

function toggleAssetTypeFields(selectEl) {
  const assetType = selectEl.value;
  const isRoadVehicle = assetType === 'VEHICLE' || assetType === 'SHOP_VEHICLE';
  const isShopFleet = assetType === 'SHOP_VEHICLE';

  const vinGroup = document.getElementById('vinGroup');
  const eqpGroup = document.getElementById('eqpGroup');
  const shopFleetGroup = document.getElementById('shopFleetGroup');
  const vehicleFields = document.querySelectorAll('.veh-only-field');
  const vinInput = vinGroup?.querySelector('[name=vin]');
  if (vinInput) vinInput.required = isRoadVehicle;

  if (isRoadVehicle) {
    if (vinGroup) vinGroup.style.display = 'flex';
    if (eqpGroup) eqpGroup.style.display = 'none';
    vehicleFields.forEach(el => el.style.display = 'block');
  } else {
    if (vinGroup) vinGroup.style.display = 'none';
    if (eqpGroup) eqpGroup.style.display = 'grid';
    vehicleFields.forEach(el => el.style.display = 'block');
  }

  if (shopFleetGroup) {
    shopFleetGroup.style.display = isShopFleet ? 'block' : 'none';
  }
}

function renderVehicleForm(vehicle = null) {
  activeVehicle = vehicle;
  const value = (key) => escapeHtml(vehicle?.[key] ?? '');
  const selectedTrans = (type) => (vehicle?.transmission_type || 'unknown') === type ? 'selected' : '';
  const selectedAsset = (type) => (vehicle?.asset_type || 'VEHICLE') === type ? 'selected' : '';
  const selectedCat = (cat) => (vehicle?.equipment_category || '') === cat ? 'selected' : '';
  const selectedFleet = (flt) => (vehicle?.shop_fleet_type || '') === flt ? 'selected' : '';

  const assetType = vehicle?.asset_type || 'VEHICLE';
  const isRoadVehicle = assetType === 'VEHICLE' || assetType === 'SHOP_VEHICLE';
  const isShopFleet = assetType === 'SHOP_VEHICLE';

  document.getElementById('vehicleResults').innerHTML = `
    <form class="vehicle-form" data-submit-action="vehicle.save" data-action-param="${vehicle?.id || ''}" data-submit-hotkey="ALT+S">
      <h3>${vehicle ? `EDIT ASSET #${vehicle.id}` : 'ADD VEHICLE OR SHOP / CUSTOMER EQUIPMENT'}</h3>

      <div style="grid-column:1 / -1; background:var(--surface-subtle); padding:12px; border-radius:4px; border:1px solid var(--border-mid); display:flex; gap:20px; align-items:center;">
        <label style="margin:0; font-weight:700; color:var(--accent-amber);">ASSET CLASSIFICATION:
          <select name="asset_type" data-change-action="vehicle.toggleAssetTypeFields" style="margin-left:10px; background:var(--surface-panel); padding:4px 8px;">
            <option value="VEHICLE" ${selectedAsset('VEHICLE')}>🚗 CUSTOMER AUTOMOTIVE VEHICLE</option>
            <option value="SHOP_VEHICLE" ${selectedAsset('SHOP_VEHICLE')}>🚚 SHOP FLEET VEHICLE (LOANER CAR, RUNNER TRUCK, SHUTTLE, TUNING)</option>
            <option value="EQUIPMENT" ${selectedAsset('EQUIPMENT')}>🛠️ CUSTOMER EQUIPMENT (GENERATOR, PRESSURE WASHER, ETC.)</option>
            <option value="SHOP_EQUIPMENT" ${selectedAsset('SHOP_EQUIPMENT')}>🏭 SHOP INTERNAL TOOL / MACHINERY (A/C MACHINE, LIFT, COMPRESSOR)</option>
          </select>
        </label>
      </div>

      <div id="shopFleetGroup" style="display:${isShopFleet ? 'block' : 'none'}; grid-column:1 / -1; background:rgba(var(--accent-emerald-rgb),0.1); border:1px solid var(--accent-emerald); padding:10px 14px; border-radius:4px;">
        <label style="margin:0; font-weight:700; color:var(--accent-emerald);">SHOP FLEET ROLE:
          <select name="shop_fleet_type" style="margin-left:10px; background:var(--surface-panel); border:1px solid var(--accent-emerald); padding:4px 8px;">
            <option value="CUSTOMER LOANER" ${selectedFleet('CUSTOMER LOANER')}>CUSTOMER LOANER CAR</option>
            <option value="PARTS RUNNER" ${selectedFleet('PARTS RUNNER')}>PARTS RUNNER TRUCK</option>
            <option value="SHOP TUNING TRUCK" ${selectedFleet('SHOP TUNING TRUCK')}>SHOP TUNING / RACE TRUCK</option>
            <option value="SHUTTLE VAN" ${selectedFleet('SHUTTLE VAN')}>SHUTTLE VAN</option>
            <option value="MOBILE SERVICE TRUCK" ${selectedFleet('MOBILE SERVICE TRUCK')}>MOBILE SERVICE TRUCK</option>
            <option value="TOW RIG" ${selectedFleet('TOW RIG')}>TOW RIG</option>
            <option value="OTHER FLEET" ${selectedFleet('OTHER FLEET')}>OTHER SHOP VEHICLE</option>
          </select>
        </label>
      </div>

      <div class="vehicle-identity-note"><strong>ASSET IDENTITY</strong><span>Enter VIN or Serial Number / Asset Tag. VIN decoding is available for automotive vehicles.</span></div>

      <div id="vinGroup" class="vehicle-vin" style="display:${isRoadVehicle ? 'flex' : 'none'}; grid-column:1 / -1;">
        <label class="ui-flex-1">VIN (17 CHARACTERS)
          <div class="vin-entry">
            <input name="vin" value="${value('vin')}" ${isRoadVehicle ? 'required minlength="17" maxlength="17"' : ''} data-input-action="vehicle.uppercase">
            <button type="button" class="secondary-action-btn" data-action="vehicle.decodeVin">DECODE VIN</button>
          </div>
        </label>
      </div>

      <div id="eqpGroup" style="display:${!isRoadVehicle ? 'grid' : 'none'}; grid-template-columns:1fr 1fr 1fr; gap:12px; grid-column:1 / -1;">
        <label>SERIAL # / ASSET TAG<input name="serial_number" value="${value('serial_number')}" placeholder="e.g. PW-88192 or TAG-04" data-input-action="vehicle.uppercase"></label>
        <label>EQUIPMENT CATEGORY<select name="equipment_category">
          <option value="PRESSURE WASHER" ${selectedCat('PRESSURE WASHER')}>PRESSURE WASHER</option>
          <option value="A/C RECOVERY MACHINE" ${selectedCat('A/C RECOVERY MACHINE')}>A/C RECOVERY MACHINE</option>
          <option value="GENERATOR" ${selectedCat('GENERATOR')}>GENERATOR</option>
          <option value="AIR COMPRESSOR" ${selectedCat('AIR COMPRESSOR')}>AIR COMPRESSOR</option>
          <option value="AUTOMOTIVE LIFT" ${selectedCat('AUTOMOTIVE LIFT')}>AUTOMOTIVE LIFT</option>
          <option value="SMALL ENGINE" ${selectedCat('SMALL ENGINE')}>SMALL ENGINE</option>
          <option value="TRACTOR / MOWER" ${selectedCat('TRACTOR / MOWER')}>TRACTOR / MOWER</option>
          <option value="HEAVY MACHINERY" ${selectedCat('HEAVY MACHINERY')}>HEAVY MACHINERY</option>
          <option value="OTHER EQUIPMENT" ${selectedCat('OTHER EQUIPMENT')}>OTHER EQUIPMENT</option>
        </select></label>
        <label>USAGE HOURS METER<input name="hours_meter" value="${value('hours_meter')}" placeholder="e.g. 142.5 hrs" inputmode="decimal"></label>
      </div>

      <label>YEAR<input name="year" value="${value('year') || '2024'}" required inputmode="numeric" maxlength="4"></label>
      <label>MAKE / BRAND<input name="make" value="${value('make')}" required placeholder="e.g. Ford / Honda / Generac"></label>
      <label>MODEL / SPEC<input name="model" value="${value('model')}" required placeholder="e.g. F-150 / GX200 4000PSI"></label>
      <label class="veh-only-field">TRIM<input name="trim" value="${value('trim')}"></label>
      <label>ENGINE / MOTOR SPEC<input name="engine" value="${value('engine')}" placeholder="e.g. 5.0L V8 / 13HP Petrol / 220V 3-Phase"></label>
      <label class="veh-only-field">TRANSMISSION TYPE<select name="transmission_type">
        <option value="unknown" ${selectedTrans('unknown')}>UNKNOWN</option><option value="automatic" ${selectedTrans('automatic')}>AUTOMATIC</option>
        <option value="manual" ${selectedTrans('manual')}>MANUAL</option><option value="cvt" ${selectedTrans('cvt')}>CVT</option>
        <option value="dual-clutch" ${selectedTrans('dual-clutch')}>DUAL-CLUTCH</option><option value="other" ${selectedTrans('other')}>OTHER</option>
      </select></label>
      <label class="veh-only-field">TRANSMISSION DETAIL<input name="transmission" value="${value('transmission')}" placeholder="Speeds, model, or decoded description"></label>
      <label class="veh-only-field">DRIVE TYPE<input name="drive_type" value="${value('drive_type')}"></label>
      <label class="veh-only-field">BODY CLASS<input name="body_class" value="${value('body_class')}"></label>
      <label class="veh-only-field">FUEL TYPE<input name="fuel_type" value="${value('fuel_type')}"></label>
      <label>COLOR / FINISH<input name="color" value="${value('color')}"></label>
      <label class="veh-only-field">LICENSE PLATE<input name="plate" value="${value('plate')}"></label>
      <label class="veh-only-field">MILEAGE (ODOMETER)<input name="mileage" value="${value('mileage')}" inputmode="numeric"></label>
      
      <!-- EXPANDABLE FLUID SPECIFICATIONS SECTION -->
      <details class="vehicle-wide-field" style="background:var(--surface-subtle); border:1px solid var(--border-bright); border-radius:4px; padding:8px 12px; grid-column:1 / -1;">
        <summary style="cursor:pointer; color:var(--accent-amber); font-weight:800; font-size:12px;">🛢️ VEHICLE FLUID SPECIFICATIONS &amp; CAPACITIES <span style="color:var(--accent-crimson); font-size:10px; margin-left:8px; font-weight:800;">** TECH TO VERIFY</span></summary>
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-top:10px;">
          <label>ENGINE OIL SPEC &amp; CAPACITY<input name="engine_oil_spec" value="${value('engine_oil_spec')}" placeholder="e.g. 5W-30 Full Syn (6.0 Qts)"></label>
          <label>TRANSMISSION FLUID SPEC<input name="trans_fluid_spec" value="${value('trans_fluid_spec')}" placeholder="e.g. DEXRON VI / Mercon LV / ATF-WS"></label>
          <label>COOLANT / ANTIFREEZE SPEC<input name="coolant_spec" value="${value('coolant_spec')}" placeholder="e.g. OAT 50/50 Orange / HOAT Gold"></label>
        </div>
        <label style="margin-top:8px; display:block;">ADDITIONAL FLUID &amp; FILTER NOTES<textarea name="fluid_notes" rows="2" placeholder="Differential oil spec, transfer case fluid, brake fluid DOT spec, filter part #s...">${value('fluid_notes')}</textarea></label>
      </details>

      <label class="vehicle-wide-field">MODIFICATIONS / CUSTOM SPECS<textarea name="modifications" rows="2" placeholder="Lift, axle gearing, tire size, custom fittings, electrical upgrades...">${value('modifications')}</textarea></label>
      <label class="vehicle-wide-field">SERVICE &amp; ASSET NOTES<textarea name="notes" rows="2" placeholder="Maintenance schedule, shop usage notes, filter sizes, oil specs...">${value('notes')}</textarea></label>
      <input type="hidden" name="decode_source" value="${value('decode_source')}">
      <div class="vehicle-link-state">
        <strong>${vehicle?.is_shop_equipment || vehicle?.asset_type === 'SHOP_EQUIPMENT' || vehicle?.asset_type === 'SHOP_VEHICLE' ? `🏭 SHOP INTERNAL ASSET — ${vehicle?.shop_fleet_type || 'Internal Shop Asset'}` : (vehicle?.customer_id ? `LINKED — ${escapeHtml(vehicle.customer_name || 'CUSTOMER')}` : 'ORPHAN ASSET')}</strong>
        <span>${vehicle ? (vehicle.is_shop_equipment || vehicle.asset_type === 'SHOP_VEHICLE' ? '<span style="font-size:11px; color:var(--accent-emerald);">[SHOP INTERNAL FLEET / ASSET]</span>' : `<button type="button" class="secondary-action-btn action-compact" data-action="vehicle.openCustomerLink">${UIComponent.Keycap("C", "command")} CONNECT CUSTOMER</button>`) : 'Asset will remain orphan until connected.'}</span>
      </div>
      <div class="vehicle-form-actions"><span id="vehicleMessage"></span><button type="submit">${vehicle ? 'SAVE ASSET' : 'ADD ASSET'}</button></div>
    </form>`;
  document.querySelector('.vehicle-form input').focus();
}

function handleVehicleSearchKeydown(event) {
  if (event.key !== 'Tab' || event.shiftKey) return;
  const firstRow = document.querySelector('.vehicle-search-row');
  if (vehicleSearchResults.length && firstRow) {
    event.preventDefault();
    firstRow.focus();
  } else {
    const addBtn = document.getElementById('addVehicleBtn');
    if (addBtn) {
      event.preventDefault();
      addBtn.focus();
    }
  }
}

function openCustomerLink(vehicle) {
  activeVehicle = vehicle;
  pendingVehicleCustomerLink = vehicle;
  document.getElementById('vehicleResults').innerHTML = `
    <div class="customer-link-panel">
      <div class="staff-intro"><div><h3>CONNECT CUSTOMER</h3><p>${formatVehicleYMM(vehicle)} · ${escapeHtml(vehicle.vin || vehicle.serial_number)}</p></div><button class="staff-back" data-action="vehicle.renderVehicleForm">BACK TO ASSET</button></div>
      <input id="customerLinkSearch" class="vehicle-search" placeholder="Search customer name or phone..." data-input-action="vehicle.queueCustomerLinkSearch" autofocus>
      <div id="customerLinkResults"></div>
      <button class="new-customer-route" data-action="vehicle.openNewCustomerCard">${UIComponent.Keycap("ALT+N", "command")} NEW CUSTOMER</button>
    </div>`;
  requestAnimationFrame(() => document.getElementById('customerLinkSearch')?.focus());
}

function queueCustomerLinkSearch(query) {
  clearTimeout(customerLinkTimer);
  const results = document.getElementById('customerLinkResults');
  if (!query.trim()) { results.innerHTML = ''; customerLinkResults = []; return; }
  customerLinkTimer = setTimeout(() => searchCustomersForLink(query), 180);
}

async function searchCustomersForLink(query) {
  const response = await api(`/api/customers?q=${encodeURIComponent(query.trim())}`);
  customerLinkResults = response.customers;
  document.getElementById('customerLinkResults').innerHTML = response.customers.length
    ? response.customers.map((customer, index) => `<button class="customer-link-row" data-action="vehicle.linkCustomerToVehicle" data-action-param="${escapeHtml(customer.id)}">${UIComponent.Keycap(index + 1, "index")}<strong>${escapeHtml(customer.name)}</strong><span>${escapeHtml(customer.phone || 'NO PHONE')}</span></button>`).join('')
    : '<div class="vehicle-empty">NO MATCHING CUSTOMERS.</div>';
}

function openNewCustomerCard(vehicle) {
  pendingVehicleCustomerLink = vehicle;
  document.getElementById('activeTaskTitle').textContent = 'CUSTOMER DIRECTORY — NEW CUSTOMER';
  document.getElementById('workspaceContent').innerHTML = `
    <form class="new-customer-card" data-submit-action="vehicle.createCustomerAndReturn" data-submit-hotkey="ALT+S">
      <div class="staff-intro"><div><h3>NEW CUSTOMER</h3><p>Complete the customer record before connecting ${formatVehicleYMM(vehicle)}.</p></div></div>
      <section><h4>PRIMARY CONTACT</h4>
        <label>FULL NAME<input name="name" required autofocus></label><label>PHONE<input name="phone" required></label>
        <label>EMAIL<input name="email" type="email"></label><label>COMMUNICATION<select name="communication_preference"><option value="">NOT SET</option><option>PHONE</option><option>TEXT / SMS</option><option>EMAIL</option></select></label>
      </section>
      <section><h4>ADDRESS</h4>
        <label class="wide">STREET ADDRESS<input name="address"></label><label>CITY<input name="city"></label>
        <label>STATE / PROVINCE<input name="state"></label><label>POSTAL CODE<input name="postal_code"></label>
      </section>
      <section><h4>CUSTOMER NOTES</h4><label class="wide"><textarea name="notes" rows="5"></textarea></label></section>
      <div class="vehicle-link-state"><strong>ASSET TO CONNECT</strong><span>${escapeHtml(vehicle.vin || vehicle.serial_number)} · ${formatVehicleYMM(vehicle)}</span></div>
      <div class="vehicle-form-actions"><span id="customerCreateMessage"></span><button type="submit">CREATE CUSTOMER & CONNECT ASSET</button></div>
    </form>`;
}

async function linkCustomerToVehicle(customerId) {
  const result = await api(`/api/vehicles/${activeVehicle.id}/customer`, { method: 'POST', body: JSON.stringify({ customer_id: customerId }) });
  renderVehicleForm(result.vehicle);
}

async function createCustomerAndReturn(event, boundElement = event.currentTarget) {
  event.preventDefault();
  const message = document.getElementById('customerCreateMessage');
  message.textContent = 'CREATING CUSTOMER…';
  try {
    const customer = await api('/api/customers', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(boundElement))) });
    activeVehicle = pendingVehicleCustomerLink;
    const linked = await api(`/api/vehicles/${activeVehicle.id}/customer`, { method: 'POST', body: JSON.stringify({ customer_id: customer.customer.id }) });
    pendingVehicleCustomerLink = null;
    document.getElementById('activeTaskTitle').textContent = 'VEHICLE & EQUIPMENT DIRECTORY';
    document.getElementById('workspaceContent').innerHTML = renderVehicleContent();
    renderVehicleForm(linked.vehicle);
  } catch (error) {
    message.textContent = error.message.toUpperCase();
    message.className = 'staff-error';
  }
}

async function decodeVin(form) {
  const vin = form.elements.vin.value.trim().toUpperCase();
  const message = document.getElementById('vehicleMessage');
  if (vin.length !== 17) {
    message.textContent = 'ENTER A 17-CHARACTER VIN.';
    return;
  }
  message.textContent = 'DECODING…';
  try {
    const result = await api(`/api/vin/${encodeURIComponent(vin)}`);
    for (const [field, value] of Object.entries(result.vehicle)) {
      if (form.elements[field]) {
        form.elements[field].value = value ?? '';
      }
    }
    // Also trigger fluid updates in case new specs matched the database
    if (result.vehicle.engine_oil_spec && form.elements.engine_oil_spec) form.elements.engine_oil_spec.value = result.vehicle.engine_oil_spec;
    if (result.vehicle.trans_fluid_spec && form.elements.trans_fluid_spec) form.elements.trans_fluid_spec.value = result.vehicle.trans_fluid_spec;
    if (result.vehicle.coolant_spec && form.elements.coolant_spec) form.elements.coolant_spec.value = result.vehicle.coolant_spec;
    if (result.vehicle.fluid_notes && form.elements.fluid_notes) form.elements.fluid_notes.value = result.vehicle.fluid_notes;

    if (form.elements.decode_source) form.elements.decode_source.value = result.vehicle.source || '';
    message.textContent = result.vehicle.error_text ? `DECODED WITH NOTE: ${result.vehicle.error_text}` : 'VIN DECODED.';
  } catch (error) {
    message.textContent = error.message.toUpperCase();
    message.className = 'staff-error';
  }
}

function queueVehicleSearch(query) {
  clearTimeout(vehicleSearchTimer);
  vehicleSearchTimer = setTimeout(() => searchVehicles(query), 180);
}

function handleVehicleRowKeydown(event, number, boundElement = event.currentTarget) {
  if (event.key === 'Enter') {
    event.preventDefault();
    openVehicleByNumber(number);
    return;
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const rows = [...document.querySelectorAll('.vehicle-search-row')];
  const index = rows.indexOf(boundElement);
  const nextIndex = event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0);
  rows[nextIndex]?.focus();
}

async function searchVehicles(query = '') {
  const results = document.getElementById('vehicleResults');
  if (!results) return;
  const currentQuery = document.getElementById('vehicleSearch')?.value.trim() || '';
  results.innerHTML = '<div class="vehicle-empty">SEARCHING VEHICLE DIRECTORY…</div>';
  try {
    const response = await api(`/api/vehicles?q=${encodeURIComponent(currentQuery)}`);
    vehicleSearchResults = response.vehicles || [];
    if (!vehicleSearchResults.length) {
      results.innerHTML = `<div class="vehicle-empty">NO MATCHING VEHICLES OR EQUIPMENT. PRESS ${UIComponent.Keycap("ALT+A", "command")} TO ADD ONE.</div>`;
      return;
    }
    results.innerHTML = vehicleSearchResults.map((vehicle, index) => vehicleSearchRowMarkup(vehicle, index)).join('');
  } catch (error) {
    results.innerHTML = `<div class="vehicle-empty staff-error">${escapeHtml(error.message)}</div>`;
  }
}

function vehicleSearchRowMarkup(vehicle, index) {
  const assetType = vehicle.asset_type || 'VEHICLE';
  let badgeStyle = 'background:rgba(var(--accent-amber-rgb),0.2); color:var(--accent-amber);';
  let badgeLabel = 'VEHICLE';

  if (assetType === 'SHOP_VEHICLE') {
    badgeStyle = 'background:rgba(var(--accent-emerald-rgb),0.2); color:var(--accent-emerald);';
    badgeLabel = vehicle.shop_fleet_type || 'SHOP FLEET';
  } else if (assetType === 'SHOP_EQUIPMENT' || vehicle.is_shop_equipment) {
    badgeStyle = 'background:rgba(var(--accent-emerald-rgb),0.2); color:var(--accent-emerald);';
    badgeLabel = 'SHOP ASSET';
  } else if (assetType === 'EQUIPMENT') {
    badgeStyle = 'background:rgba(var(--accent-steel-rgb),0.2); color:var(--accent-steel);';
    badgeLabel = vehicle.equipment_category || 'EQUIPMENT';
  }

  const idTag = vehicle.vin || vehicle.serial_number || 'NO SERIAL';
  const formattedId = vehicle.vin && vehicle.vin.length >= 8
    ? `<span class="u-text-muted">${escapeHtml(vehicle.vin.slice(0, vehicle.vin.length - 8))}</span><strong style="color:var(--accent-amber); font-weight:800; background:rgba(var(--accent-amber-rgb),0.18); padding:1px 4px; border-radius:2px; border:1px solid rgba(var(--accent-amber-rgb),0.3); margin-left:4px;">${escapeHtml(vehicle.vin.slice(-8))}</strong>`
    : escapeHtml(idTag);
  const isInternal = vehicle.is_shop_equipment || assetType === 'SHOP_VEHICLE' || assetType === 'SHOP_EQUIPMENT';
  const ownerLabel = isInternal ? (vehicle.shop_fleet_type || 'SHOP INTERNAL') : (vehicle.customer_id ? vehicle.customer_name : 'UNLINKED CUSTOMER');
  const plateOrMeter = vehicle.hours_meter ? `${vehicle.hours_meter} HRS` : (vehicle.plate || '—');

  return `<div class="vehicle-search-row" tabindex="0" data-action="vehicle.openVehicleByNumber" data-action-param="${escapeHtml(index + 1)}" data-keydown-action="vehicle.handleVehicleRowKeydown">
    ${UIComponent.Keycap(index + 1, "index", {className: "vehicle-result-number"})}
    <span class="vehicle-result-type" style="${badgeStyle}">${escapeHtml(badgeLabel)}</span>
    <div class="vehicle-result-identity"><span class="vehicle-result-label">VEHICLE</span><strong>${escapeHtml(formatVehicleYMM(vehicle))}</strong></div>
    <div class="vehicle-result-owner"><span class="vehicle-result-label">OWNER</span><strong class="${isInternal || vehicle.customer_id ? 'vehicle-linked' : 'vehicle-orphan'}">${escapeHtml(ownerLabel)}</strong></div>
    <div class="vehicle-result-detail"><span class="vehicle-result-label">${vehicle.hours_meter ? 'METER' : 'PLATE'}</span><strong>${escapeHtml(plateOrMeter)}</strong></div>
    <div class="vehicle-result-detail"><span class="vehicle-result-label">${vehicle.vin ? 'VIN' : 'SERIAL'}</span><span>${formattedId}</span></div>
  </div>`;
}

function openVehicleByNumber(number) {
  const vehicle = vehicleSearchResults[number - 1];
  if (vehicle) renderVehicleForm(vehicle);
}

async function createVehicle(event, boundElement = event.currentTarget) {
  event.preventDefault();
  const form = boundElement;
  const data = Object.fromEntries(new FormData(form));
  const message = document.getElementById('vehicleMessage');
  message.textContent = 'SAVING…';
  try {
    const result = await api('/api/vehicles', { method: 'POST', body: JSON.stringify(data) });
    renderVehicleRecord(result.vehicle);
  } catch (error) {
    message.textContent = error.message.toUpperCase();
    message.className = 'staff-error';
  }
}

async function updateVehicle(event, vehicleId, boundElement = event.currentTarget) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(boundElement));
  const message = document.getElementById('vehicleMessage');
  message.textContent = 'SAVING…';
  try {
    const result = await api(`/api/vehicles/${vehicleId}`, { method: 'POST', body: JSON.stringify(data) });
    renderVehicleRecord(result.vehicle);
  } catch (error) {
    message.textContent = error.message.toUpperCase();
    message.className = 'staff-error';
  }
}

function renderVehicleRecord(vehicle) {
  activeVehicle = vehicle;
  document.getElementById('vehicleSearch').value = vehicle.vin || vehicle.serial_number || '';
  document.getElementById('vehicleResults').innerHTML = vehicleRecordMarkup(vehicle);
}

function vehicleRecordMarkup(vehicle) {
  const assetType = vehicle.asset_type || 'VEHICLE';
  const isEquip = assetType === 'EQUIPMENT' || assetType === 'SHOP_EQUIPMENT';
  const isInternal = vehicle.is_shop_equipment || assetType === 'SHOP_VEHICLE' || assetType === 'SHOP_EQUIPMENT';
  const ownerLabel = isInternal ? `SHOP FLEET — ${vehicle.shop_fleet_type || 'INTERNAL SHOP ASSET'}` : (vehicle.customer_id ? `LINKED — ${escapeHtml(vehicle.customer_name)}` : 'ORPHAN ASSET');

  return `<div class="vehicle-record"><h3>${formatVehicleYMM(vehicle)}</h3>
      <div class="ui-row-8">
        <button type="button" class="secondary-action-btn" data-action="vehicle.renderVehicleForm">EDIT ASSET</button>
        ${!isInternal ? '<button type="button" class="secondary-action-btn" data-action="vehicle.openCustomerLink">CONNECT CUSTOMER</button>' : ''}
      </div>
      <div class="vehicle-record-heading"><p>ID / SERIAL / VIN: <strong>${escapeHtml(vehicle.vin || vehicle.serial_number || 'NONE')}</strong></p>
      <span class="${vehicle.customer_id || isInternal ? 'vehicle-linked' : 'vehicle-orphan'}">${ownerLabel}</span></div>
      <div class="vehicle-data">
        <span>ASSET TYPE<strong>${escapeHtml(assetType)}</strong></span>
        <span>FLEET ROLE / CATEGORY<strong>${escapeHtml(vehicle.shop_fleet_type || vehicle.equipment_category || (isEquip ? 'EQUIPMENT' : 'AUTOMOTIVE'))}</strong></span>
        <span>YEAR<strong>${vehicle.year || '—'}</strong></span><span>MAKE / BRAND<strong>${escapeHtml(vehicle.make)}</strong></span>
        <span>MODEL / SPEC<strong>${escapeHtml(vehicle.model)}</strong></span><span>TRIM<strong>${escapeHtml(vehicle.trim || '—')}</strong></span>
        <span>ENGINE / MOTOR<strong>${escapeHtml(vehicle.engine || '—')}</strong></span>
        <span>USAGE HOURS<strong>${vehicle.hours_meter ? `${vehicle.hours_meter} HRS` : '—'}</strong></span>
        <span>ODOMETER<strong>${vehicle.mileage?.toLocaleString() || '—'}</strong></span>
        <span>COLOR / FINISH<strong>${escapeHtml(vehicle.color || '—')}</strong></span>
        <span>LICENSE PLATE<strong>${escapeHtml(vehicle.plate || '—')}</strong></span>
      </div>
      <div class="vehicle-context">
        <details open style="background:var(--surface-subtle); border:1px solid var(--border-mid); border-radius:4px; padding:10px; margin-bottom:10px;">
          <summary style="cursor:pointer; color:var(--accent-amber); font-weight:800; font-size:11px;">🛢️ VEHICLE FLUID SPECIFICATIONS &amp; SERVICE DATA <span style="color:var(--accent-crimson); font-size:10px; margin-left:8px; font-weight:800;">** TECH TO VERIFY</span></summary>
          <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-top:8px; font-size:11px;">
            <div><span class="ui-label-dim">ENGINE OIL:</span> <strong>${escapeHtml(vehicle.engine_oil_spec || 'NOT SPECIFIED')}</strong></div>
            <div><span class="ui-label-dim">TRANS FLUID:</span> <strong>${escapeHtml(vehicle.trans_fluid_spec || 'NOT SPECIFIED')}</strong></div>
            <div><span class="ui-label-dim">COOLANT:</span> <strong>${escapeHtml(vehicle.coolant_spec || 'NOT SPECIFIED')}</strong></div>
          </div>
          ${vehicle.fluid_notes ? `<div style="margin-top:6px; font-size:10px; color:var(--text-muted);"><span class="ui-label-dim">FLUID NOTES:</span> ${escapeHtml(vehicle.fluid_notes)}</div>` : ''}
        </details>
        <section><h4>MODIFICATIONS / SPECS</h4><p>${escapeHtml(vehicle.modifications || 'NONE RECORDED')}</p></section>
        <section><h4>SERVICE &amp; ASSET NOTES</h4><p>${escapeHtml(vehicle.notes || 'NONE RECORDED')}</p></section>
      </div>
      ${!isEquip ? `<div style="margin-top:14px; display:flex; gap:8px; align-items:center;">
        <button class="primary-action-btn" data-action="vehicle.loadVehicleSafety" data-action-param="${escapeHtml(vehicle.id)}">CHECK NHTSA RECALLS &amp; TSBs</button>
        ${hasPermission('staff_admin') ? '<button class="secondary-action-btn" data-action="vehicle.refreshNhtsaCommunications">REFRESH NHTSA TSB INDEX</button>' : ''}
        <span class="ui-label-dim">YEAR / MAKE / MODEL APPLICABILITY — VERIFY VIN AND OEM PROCEDURE BEFORE REPAIR</span>
      </div><div id="vehicleSafetyResults"></div>` : ''}
      </div>`;
}

async function loadVehicleSafety(vehicleId) {
  const container = document.getElementById('vehicleSafetyResults');
  if (!container) return;
  container.innerHTML = '<div class="empty-state-cell">CHECKING NHTSA DATA…</div>';
  try {
    const result = await api(`/api/vehicles/${vehicleId}/safety`);
    const recallRows = (result.recalls || []).map(recall => `
      <article class="nhtsa-result nhtsa-recall">
        <strong>RECALL ${escapeHtml(recall.NHTSACampaignNumber || recall.nhtsaCampaignNumber || 'CAMPAIGN')}</strong>
        <span>${escapeHtml(recall.Component || recall.component || 'COMPONENT NOT LISTED')}</span>
        <p>${escapeHtml(recall.Summary || recall.summary || 'No summary supplied.')}</p>
        ${recall.Remedy || recall.remedy ? `<p><b>REMEDY:</b> ${escapeHtml(recall.Remedy || recall.remedy)}</p>` : ''}
      </article>`).join('');
    const communicationRows = (result.communications || []).map(item => `
      <article class="nhtsa-result">
        <strong>${escapeHtml(item.document_id || `NHTSA ${item.nhtsa_id}`)}</strong>
        <span>${escapeHtml(item.communication_type || 'MANUFACTURER COMMUNICATION')} · ${escapeHtml(item.nhtsa_component || 'COMPONENT NOT LISTED')}</span>
        <p>${escapeHtml(item.summary || 'No summary supplied.')}</p>
        <a href="${escapeHtml(item.pdf_url)}" target="_blank" rel="noopener">OPEN NHTSA BULLETIN PDF</a>
      </article>`).join('');
    container.innerHTML = `
      <div class="nhtsa-summary"><strong>${result.recalls.length} RECALLS</strong><strong>${result.communications.length} TSBs / MANUFACTURER COMMUNICATIONS</strong>${result.recall_status === 'unavailable' ? '<span>LIVE RECALL SERVICE UNAVAILABLE</span>' : ''}</div>
      ${recallRows || '<div class="empty-state-cell">NO YEAR / MAKE / MODEL RECALLS RETURNED.</div>'}
      ${communicationRows || '<div class="empty-state-cell">NO MATCHING LOCAL TSB RECORDS. A MANAGER MAY NEED TO REFRESH THE RELEVANT NHTSA ARCHIVE.</div>'}`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state-cell">${escapeHtml(err.message)}</div>`;
  }
}

async function refreshNhtsaCommunications() {
  if (!confirm('Download and index all official NHTSA manufacturer-communications archives from 1995 through the current period? This may take several minutes.')) return;
  try {
    const ranges = ['1995-1999', '2000-2004', '2005-2009', '2010-2014', '2015-2019', '2020-2024', '2025-2026'];
    let totalRows = 0;
    for (const archiveRange of ranges) {
      const result = await api('/api/nhtsa/communications/import', {
        method: 'POST', body: JSON.stringify({ archive_range: archiveRange })
      });
      totalRows += result.rows_processed;
    }
    alert(`NHTSA INDEX REFRESHED\n\nRows processed: ${totalRows}`);
    if (activeVehicle?.id) loadVehicleSafety(activeVehicle.id);
  } catch (err) {
    alert('NHTSA refresh error: ' + err.message);
  }
}

function handleVehicleEscapeNav() {
  const results = document.getElementById('vehicleResults');
  if (results && results.innerHTML.trim() !== '') {
    results.innerHTML = '';
    const search = document.getElementById('vehicleSearch');
    if (search) {
      search.value = '';
      search.focus();
    }
    return true;
  }
  return false;
}

if (window.WorkspaceLifecycle) {
  window.WorkspaceLifecycle.register('V', {
    getInitialState: () => ({
      query: '',
      page: 1,
      selectedId: null,
      editorMode: 'directory'
    }),
    mount: (container) => {
      container.setAttribute('data-workspace', 'vehicles');
    },
    load: async (state) => {
      if (typeof searchVehicles === 'function') {
        await searchVehicles(state.query || '');
      }
      return typeof vehicleSearchResults !== 'undefined' ? vehicleSearchResults : [];
    },
    render: () => {
      return typeof renderVehicleDirectoryContent === 'function' ? renderVehicleDirectoryContent() : '';
    },
    interact: () => {
      // interact bindings
    },
    unmount: () => {
      activeVehicle = null;
    }
  });
}


document.addEventListener('DOMContentLoaded', () => {
  const actions = {
    "vehicle.save": (param, element, event) => param ? updateVehicle(event, Number(param), element) : createVehicle(event, element),
    "vehicle.openAddVehicle": (param, element, event) => openAddVehicle(),
    "vehicle.queueVehicleSearch": (param, element, event) => queueVehicleSearch(element.value),
    "vehicle.handleVehicleSearchKeydown": (param, element, event) => handleVehicleSearchKeydown(event),
    "vehicle.toggleAssetTypeFields": (param, element, event) => toggleAssetTypeFields(element),
    "vehicle.uppercase": (_, element) => { element.value = element.value.toUpperCase(); },
    "vehicle.decodeVin": (param, element, event) => decodeVin(element.form),
    "vehicle.openCustomerLink": (param, element, event) => openCustomerLink(activeVehicle),
    "vehicle.renderVehicleForm": (param, element, event) => renderVehicleForm(activeVehicle),
    "vehicle.queueCustomerLinkSearch": (param, element, event) => queueCustomerLinkSearch(element.value),
    "vehicle.openNewCustomerCard": (param, element, event) => openNewCustomerCard(activeVehicle),
    "vehicle.linkCustomerToVehicle": (param, element, event) => linkCustomerToVehicle(Number(param)),
    "vehicle.createCustomerAndReturn": (param, element, event) => createCustomerAndReturn(event, element),
    "vehicle.openVehicleByNumber": (param, element, event) => openVehicleByNumber(Number(param)),
    "vehicle.handleVehicleRowKeydown": (param, element, event) => handleVehicleRowKeydown(event, Number(param), element),
    "vehicle.loadVehicleSafety": (param, element, event) => loadVehicleSafety(Number(param)),
    "vehicle.refreshNhtsaCommunications": (param, element, event) => refreshNhtsaCommunications(),
  };
  for (const [name, handler] of Object.entries(actions)) {
    EventDelegator.registerAction(name, handler, {permission: "customers"});
  }
});
