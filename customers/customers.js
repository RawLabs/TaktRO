/**
 * TaktRO — Customer Directory Domain Module (customers/customers.js)
 * Manages customer search, master directory lookup, customer profile card rendering, inline profile editor, and fleet fields.
 */

let customerSearchTimer = null;
let customerSearchResults = [];
let activeCustomer = null;

const CANADIAN_PROVINCES = [
  ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
  ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'],
  ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'],
  ['SK', 'Saskatchewan'], ['YT', 'Yukon']
];

function normalizeCanadianProvince(value) {
  const input = String(value || '').trim().toUpperCase();
  const match = CANADIAN_PROVINCES.find(([code, name]) => input === code || input === name.toUpperCase());
  return match?.[0] || input;
}

function canadianProvinceOptions(selectedValue = '') {
  const selected = normalizeCanadianProvince(selectedValue);
  const known = CANADIAN_PROVINCES.some(([code]) => code === selected);
  return `<option value="">SELECT PROVINCE / TERRITORY</option>${CANADIAN_PROVINCES.map(([code, name]) => `<option value="${code}" ${selected === code ? 'selected' : ''}>${code} — ${name.toUpperCase()}</option>`).join('')}${selected && !known ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} — INTERNATIONAL / OTHER</option>` : '<option value="OTHER">OTHER / INTERNATIONAL</option>'}`;
}

function formatCanadianPostalInput(input) {
  const compact = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) input.value = `${compact.slice(0, 3)} ${compact.slice(3)}`;
}

function formatCanadianPhoneInput(input) {
  const digits = input.value.replace(/\D/g, '');
  if (digits.length === 10) input.value = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  else if (digits.length === 11 && digits.startsWith('1')) input.value = `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
}

function updateCustomerTypeFields(customerType) {
  const type = String(customerType || 'RETAIL').toUpperCase();
  const showBusiness = ['FLEET', 'COMPANY', 'WHOLESALE'].includes(type);
  const showFleet = type === 'FLEET';
  document.querySelectorAll('.customer-business-field').forEach(el => el.hidden = !showBusiness);
  document.querySelectorAll('.customer-fleet-field').forEach(el => el.hidden = !showFleet);
  document.querySelectorAll('.customer-account-header').forEach(el => {
    el.style.gridTemplateColumns = showFleet ? '1fr 2fr 1fr' : showBusiness ? '1fr 2fr' : 'minmax(240px, 420px)';
  });
}

function renderCustomerContent() {
  requestAnimationFrame(() => searchCustomers(''));
  return `
    <div class="customer-shell">
      <div class="ui-command-panel">
        <strong class="ui-copy">CUSTOMER MASTER DIRECTORY LOOKUP</strong>
        <button id="addCustomerBtn" class="primary-action-btn" data-action="customer.openNewCustomerForm">${UIComponent.Keycap("ALT+A", "inverse", {className: "kbd-invert"})} NEW CUSTOMER</button>
      </div>
      <input id="customerSearch" class="vehicle-search" placeholder="Search customer name, phone, email, or vehicle plate..." data-input-action="customer.queueCustomerSearch" data-keydown-action="customer.handleCustomerSearchKeydown" autofocus>
      <div id="customerDirectoryList"></div>
      <div id="customerResults"></div>
    </div>`;
}

const debouncedSearchCustomers = typeof debounce === 'function' ? debounce((query) => searchCustomers(query), 180) : null;

function queueCustomerSearch(query) {
  const results = document.getElementById('customerResults');
  activeCustomer = null;
  if (!query.trim()) { searchCustomers(''); return; }
  if (debouncedSearchCustomers) {
    debouncedSearchCustomers(query);
  } else {
    clearTimeout(customerSearchTimer);
    customerSearchTimer = setTimeout(() => searchCustomers(query), 180);
  }
}

async function searchCustomers(query) {
  const response = await api(`/api/customers?q=${encodeURIComponent(query.trim())}`);
  const directory = document.getElementById('customerDirectoryList');
  if (!directory) return;
  customerSearchResults = response.customers;
  directory.innerHTML = response.customers && response.customers.length
    ? response.customers.map((customer, index) => `<div class="customer-directory-row" tabindex="0" data-action="customer.openCustomerByNumber" data-action-param="${escapeHtml(index + 1)}" data-keydown-action="customer.handleCustomerRowKeydown">${UIComponent.Keycap(index + 1, "index")}<strong>${escapeHtml(customer.name)}</strong><span>${escapeHtml(customer.phone || 'NO PHONE')}</span><span>${escapeHtml(customer.email || 'NO EMAIL')}</span></div>`).join('')
    : `<div class="vehicle-empty">NO MATCHING CUSTOMERS. PRESS ${UIComponent.Keycap("ALT+A", "command")} TO ADD A NEW CUSTOMER.</div>`;
}

function handleCustomerSearchKeydown(event) {
  if (event.key !== 'Tab' || event.shiftKey) return;
  const firstRow = document.querySelector('.customer-directory-row');
  if (customerSearchResults.length && firstRow) {
    event.preventDefault();
    firstRow.focus();
  } else {
    const addBtn = document.getElementById('addCustomerBtn');
    if (addBtn) {
      event.preventDefault();
      addBtn.focus();
    }
  }
}

function handleCustomerRowKeydown(event, number, rowElement = event.currentTarget) {
  if (event.key === 'Enter') { event.preventDefault(); openCustomerByNumber(number); return; }
  if (event.altKey && event.key.toUpperCase() === 'E' && activeCustomer) { event.preventDefault(); editCustomerCard(); return; }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const rows = [...document.querySelectorAll('.customer-directory-row')];
  const index = rows.indexOf(rowElement);
  if (event.key === 'ArrowUp' && index === 0) { document.getElementById('customerSearch')?.focus(); return; }
  rows[event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0)]?.focus();
}

async function openCustomerByNumber(number) {
  const summary = customerSearchResults[number - 1];
  if (!summary) return;
  const response = await api(`/api/customers/${summary.id}`);
  renderCustomerCard(response.customer);
}

function renderCustomerCard(customer) {
  if (window.EditorStack?.activeEditor?.id === 'customerEditor') EditorStack.activeEditor = null;
  if (!customer) {
    const results = document.getElementById('customerResults');
    if (results) results.innerHTML = '';
    activeCustomer = null;
    const search = document.getElementById('customerSearch');
    if (search) {
      search.value = '';
      search.focus();
    }
    return;
  }
  activeCustomer = customer;
  const customerType = String(customer.customer_type || 'RETAIL').toUpperCase();
  const isFleetCustomer = customerType === 'FLEET';
  const isBusinessCustomer = ['FLEET', 'COMPANY', 'WHOLESALE'].includes(customerType);
  const vehicles = customer.vehicles && customer.vehicles.length ? customer.vehicles.map(v => `${v.year} ${escapeHtml(v.make)} ${escapeHtml(v.model)} · ${escapeHtml(v.plate || v.vin)}`).join('<br>') : 'NO LINKED VEHICLES';

  const typeBadge = customer.customer_type && customer.customer_type !== 'RETAIL'
    ? `<span style="background:var(--accent-amber); color:var(--surface-input); font-weight:800; padding:2px 8px; border-radius:3px; font-size:10px; margin-left:10px;">${escapeHtml(customer.customer_type)} ACCOUNT</span>`
    : '';

  document.getElementById('customerResults').innerHTML = `<div class="customer-record" style="margin-top:12px;">
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-mid); padding-bottom:10px; margin-bottom:14px;">
      <div>
        <div style="display:flex; align-items:center; gap:6px;">
          <h3 style="margin:0; font-size:18px; color:var(--text-main);">${escapeHtml(customer.name)}</h3>
          ${typeBadge}
        </div>
        <span class="ui-copy-muted">CUSTOMER #${customer.id}</span>
      </div>
      <button class="primary-action-btn" data-action="customer.editCustomerCard">${UIComponent.Keycap("ALT+E", "inverse", {className: "kbd-invert"})} EDIT CUSTOMER</button>
    </div>

    ${isBusinessCustomer && (customer.company_name || customer.fleet_unit_number || customer.contact_person || customer.fleet_card_details || customer.reimbursement_details || customer.tax_exempt_number) ? `
      <div style="background:var(--surface-panel); border-left:3px solid var(--accent-amber); padding:10px 14px; border-radius:3px; margin-bottom:14px; font-size:11px;">
        <div style="display:flex; gap:20px; flex-wrap:wrap; margin-bottom:6px;">
          ${customer.company_name ? `<div><span class="u-text-dim">COMPANY / FLEET NAME:</span> <strong class="u-text-amber">${escapeHtml(customer.company_name)}</strong></div>` : ''}
          ${isFleetCustomer && customer.fleet_unit_number ? `<div><span class="u-text-dim">FLEET UNIT / ACC #:</span> <strong class="u-text-main">${escapeHtml(customer.fleet_unit_number)}</strong></div>` : ''}
          ${customer.contact_person ? `<div><span class="u-text-dim">CONTACT PERSON / DISPATCH:</span> <strong class="u-text-main">${escapeHtml(customer.contact_person)}</strong></div>` : ''}
          ${customer.tax_exempt_number ? `<div><span class="u-text-dim">TAX EXEMPT #:</span> <strong class="u-text-green">${escapeHtml(customer.tax_exempt_number)}</strong></div>` : ''}
          ${customer.labor_rate ? `<div><span class="u-text-dim">CUSTOM LABOR RATE:</span> <strong class="u-text-amber">$${parseFloat(customer.labor_rate).toFixed(2)}/HR</strong></div>` : ''}
        </div>
        ${isFleetCustomer && customer.fleet_card_details ? `<div class="ui-mt-4"><span class="u-text-dim">FLEET CARD / PAYMENT INFO:</span> <strong class="u-text-green">${escapeHtml(customer.fleet_card_details)}</strong></div>` : ''}
        ${customer.reimbursement_details ? `<div class="ui-mt-4"><span class="u-text-dim">REIMBURSEMENT &amp; BILLING NOTES:</span> <strong class="u-text-blue">${escapeHtml(customer.reimbursement_details)}</strong></div>` : ''}
      </div>
    ` : ''}

    <div class="customer-record-grid">
      <section><h4>CONTACT</h4><p>${escapeHtml(customer.phone || 'NO PHONE')}<br>${escapeHtml(customer.email || 'NO EMAIL')}<br>${escapeHtml(customer.communication_preference || 'NO COMMUNICATION PREFERENCE')}</p></section>
      <section><h4>ADDRESS</h4><p>${escapeHtml(customer.address || 'NO ADDRESS')}<br>${escapeHtml([customer.city, customer.state, customer.postal_code].filter(Boolean).join(', ') || '—')}</p></section>
      <section><h4>LINKED VEHICLES</h4><p>${vehicles}</p></section>
      <section><h4>NOTES</h4><p>${escapeHtml(customer.notes || 'NONE RECORDED')}</p></section>
    </div>
  </div>`;
}

function editCustomerCard() {
  if (!activeCustomer) return;
  const cust = activeCustomer;
  document.getElementById('customerResults').innerHTML = `
    <form id="editCustForm" data-submit-action="customer.saveCustomerEdits" data-action-param="${escapeHtml(cust.id)}" data-submit-hotkey="ALT+S" data-keydown-action="customer.handleCustomerFormKeydown" style="background:var(--surface-panel); border:1px solid var(--accent-amber); padding:16px; border-radius:4px; margin-top:12px; font-family:var(--font-mono);">
      <div class="ui-between-mb-12">
        <strong class="ui-heading-amber">EDIT CUSTOMER PROFILE (CUSTOMER #${cust.id})</strong>
        <button type="button" class="secondary-action-btn ui-button-compact" data-action="customer.renderCustomerCard">${UIComponent.Keycap("ESC", "command")} CANCEL</button>
      </div>

      <div style="font-size:10px; color:var(--text-muted); background:var(--surface-subtle); padding:8px 12px; border-radius:4px; border:1px solid var(--border-mid); margin-bottom:14px; display:flex; justify-content:space-between; align-items:center;">
        <span><strong class="u-text-amber">NUMERIC FIELD JUMPS:</strong> Press ${UIComponent.Keycap("Alt+1", "command", {className: "u-text-amber"})}–${UIComponent.Keycap("Alt+9", "command", {className: "u-text-amber"})} to jump focus to any field mouse-free.</span>
        <span>Press ${UIComponent.Keycap("Tab", "command")} to flow in order · Press ${UIComponent.Keycap("Alt+S", "command")} to Save</span>
      </div>
      
      <!-- ACCOUNT TYPE & COMPANY HEADER ROW -->
      <div class="customer-account-header" style="display:grid; grid-template-columns: 1fr 2fr 1fr; gap:12px; margin-bottom:12px;">
        <div>
          <label style="font-size:10px; color:var(--accent-amber); font-weight:700; display:block; margin-bottom:4px;">${UIComponent.Keycap("1", "command", {style: "background:var(--accent-amber); color:var(--text-on-accent); padding:1px 5px; font-weight:800; font-size:9px; border-radius:2px; margin-right:4px;"})} ACCOUNT TYPE *</label>
          <select id="editCustType" data-change-action="customer.updateCustomerTypeFields" style="width:100%; border:1px solid var(--accent-amber); padding:6px 8px; font-size:11px;">
            ${customerTypeOptions(cust.customer_type || 'RETAIL')}
          </select>
        </div>
        <div class="customer-business-field">
          <label class="field-label">${UIComponent.Keycap("2", "command", {className: "field-jump-key"})} COMPANY / FLEET NAME</label>
          <input type="text" id="editCompany" value="${escapeHtml(cust.company_name || '')}" placeholder="Company or fleet account name" class="control-full">
        </div>
        <div class="customer-fleet-field">
          <label class="field-label">${UIComponent.Keycap("3", "command", {className: "field-jump-key"})} FLEET UNIT / ACC #</label>
          <input type="text" id="editFleetUnit" value="${escapeHtml(cust.fleet_unit_number || '')}" placeholder="e.g. UNIT #402 / ACC-991" class="control-full">
        </div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap:12px; margin-bottom:12px;">
        <div>
          <label class="field-label">${UIComponent.Keycap("4", "command", {className: "field-jump-key"})} FULL NAME / PRIMARY *</label>
          <input type="text" id="editCustName" value="${escapeHtml(cust.name || '')}" class="control-full" required autofocus>
        </div>
        <div class="customer-business-field">
          <label class="field-label">${UIComponent.Keycap("5", "command", {className: "field-jump-key"})} CONTACT PERSON / DISPATCH</label>
          <input type="text" id="editContactPerson" value="${escapeHtml(cust.contact_person || '')}" placeholder="e.g. MARK STEVENS (MGR)" class="control-full">
        </div>
        <div>
          <label class="field-label">${UIComponent.Keycap("6", "command", {className: "field-jump-key"})} PHONE NUMBER *</label>
          <input type="tel" id="editCustPhone" value="${escapeHtml(cust.phone || '')}" placeholder="(403) 555-0123" data-focusout-action="customer.phone-format" class="control-full">
        </div>
        <div>
          <label class="field-label">${UIComponent.Keycap("7", "command", {className: "field-jump-key"})} EMAIL ADDRESS</label>
          <input type="email" id="editCustEmail" value="${escapeHtml(cust.email || '')}" class="control-full">
        </div>
      </div>

      <!-- FLEET CARD & REIMBURSEMENT DETAILS ROW -->
      <div style="display:grid; grid-template-columns: 1.2fr 1.2fr 0.8fr 0.8fr; gap:12px; margin-bottom:12px;">
        <div class="customer-fleet-field">
          <label class="field-label">${UIComponent.Keycap("8", "command", {className: "field-jump-key"})} FLEET CARD / PAYMENT INFO</label>
          <input type="text" id="editFleetCard" value="${escapeHtml(cust.fleet_card_details || '')}" placeholder="e.g. WEX CARD #4412-8890" class="control-full">
        </div>
        <div class="customer-business-field">
          <label class="field-label">${UIComponent.Keycap("9", "command", {className: "field-jump-key"})} REIMBURSEMENT &amp; BILLING NOTES</label>
          <input type="text" id="editReimbursement" value="${escapeHtml(cust.reimbursement_details || '')}" placeholder="e.g. PO REQUIRED ON ALL INVOICES" class="control-full">
        </div>
        <div class="customer-business-field">
          <label class="field-label">TAX EXEMPT #</label>
          <input type="text" id="editTaxExempt" value="${escapeHtml(cust.tax_exempt_number || '')}" placeholder="e.g. EXEMPT-9941" class="control-full">
        </div>
        <div class="customer-business-field">
          <label class="field-label">LABOR RATE ($/HR)</label>
          <input type="number" step="0.01" id="editLaborRate" value="${cust.labor_rate !== null && cust.labor_rate !== undefined ? cust.labor_rate : ''}" placeholder="Shop Default ($150)" class="control-full">
        </div>
      </div>

      <div style="display:grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap:12px; margin-bottom:12px;">
        <div>
          <label class="field-label">STREET ADDRESS</label>
          <input type="text" id="editCustAddress" value="${escapeHtml(cust.address || '')}" class="control-full">
        </div>
        <div>
          <label class="field-label">CITY</label>
          <input type="text" id="editCustCity" value="${escapeHtml(cust.city || '')}" class="control-full">
        </div>
        <div>
          <label class="field-label">PROVINCE / TERRITORY</label>
          <select id="editCustState" class="ui-dark-select control-full">${canadianProvinceOptions(cust.state)}</select>
        </div>
        <div>
          <label class="field-label">POSTAL CODE</label>
          <input type="text" id="editCustPostal" value="${escapeHtml(cust.postal_code || '')}" placeholder="A1A 1A1" maxlength="10" data-focusout-action="customer.postal-format" class="control-full">
        </div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 2fr; gap:12px; margin-bottom:16px;">
        <div>
          <label class="field-label">PREFERENCE</label>
          <select id="editCustPref" class="control-full">
            <option value="PHONE" ${cust.communication_preference === 'PHONE' ? 'selected' : ''}>PHONE</option>
            <option value="TEXT / SMS" ${cust.communication_preference === 'TEXT / SMS' ? 'selected' : ''}>TEXT / SMS</option>
            <option value="EMAIL" ${cust.communication_preference === 'EMAIL' ? 'selected' : ''}>EMAIL</option>
          </select>
        </div>
        <div>
          <label class="field-label">CUSTOMER NOTES</label>
          <input type="text" id="editCustNotes" value="${escapeHtml(cust.notes || '')}" class="control-full">
        </div>
      </div>
      <div class="ui-actions-end">
        <button type="button" class="secondary-action-btn" data-action="customer.renderCustomerCard">${UIComponent.Keycap("C", "command")} CANCEL</button>
        <button type="submit" class="primary-action-btn">${UIComponent.Keycap("Alt+S", "inverse", {className: "kbd-invert"})} SAVE PROFILE</button>
      </div>
    </form>
  `;
  requestAnimationFrame(() => {
    updateCustomerTypeFields(cust.customer_type || 'RETAIL');
    if (window.EditorStack) {
      window.EditorStack.register('customerEditor', {
        cancelFn: () => renderCustomerCard(activeCustomer),
        getNormalizedSnapshot: getCustomerEditorNormalizedSnapshot
      });
    }
  });
}

function getCustomerEditorNormalizedSnapshot() {
  const form = document.getElementById('editCustForm') || document.getElementById('newCustForm');
  if (!form) return {};
  return Object.fromEntries([...form.querySelectorAll('input[id], select[id], textarea[id]')]
    .map(input => [input.id, input.type === 'checkbox' ? input.checked : input.value.trim()]));
}

async function saveCustomerEdits(event, customerId) {
  event.preventDefault();
  try {
    const data = {
      name: document.getElementById('editCustName').value.trim(),
      phone: document.getElementById('editCustPhone').value.trim(),
      email: document.getElementById('editCustEmail').value.trim(),
      address: document.getElementById('editCustAddress').value.trim(),
      city: document.getElementById('editCustCity').value.trim(),
      state: document.getElementById('editCustState').value.trim(),
      postal_code: document.getElementById('editCustPostal').value.trim(),
      communication_preference: document.getElementById('editCustPref').value,
      notes: document.getElementById('editCustNotes').value.trim(),
      customer_type: document.getElementById('editCustType').value,
      company_name: document.getElementById('editCompany').value.trim(),
      fleet_unit_number: document.getElementById('editFleetUnit').value.trim(),
      contact_person: document.getElementById('editContactPerson').value.trim(),
      fleet_card_details: document.getElementById('editFleetCard').value.trim(),
      reimbursement_details: document.getElementById('editReimbursement').value.trim(),
      tax_exempt_number: document.getElementById('editTaxExempt').value.trim(),
      labor_rate: document.getElementById('editLaborRate').value.trim() ? parseFloat(document.getElementById('editLaborRate').value) : null
    };

    const response = await api(`/api/customers/${customerId}`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
    activeCustomer = response.customer;
    renderCustomerCard(response.customer);
  } catch (err) {
    alert('Error updating customer profile: ' + err.message);
  }
}

function handleCustomerEscapeNav() {
  const results = document.getElementById('customerResults');
  if (results && results.innerHTML.trim() !== '') {
    results.innerHTML = '';
    const search = document.getElementById('customerSearch');
    if (search) {
      search.value = '';
      search.focus();
    }
    return true;
  }
  return false;
}

function openNewCustomerForm() {
  activeCustomer = null;
  document.getElementById('customerResults').innerHTML = `
    <form id="newCustForm" data-submit-action="customer.createNewCustomer" data-submit-hotkey="ALT+S" data-keydown-action="customer.handleCustomerFormKeydown" style="background:var(--surface-panel); border:1px solid var(--accent-amber); padding:16px; border-radius:4px; margin-top:12px; font-family:var(--font-mono);">
      <div class="ui-between-mb-12">
        <strong class="ui-heading-amber">CREATE NEW CUSTOMER RECORD</strong>
        <button type="button" class="secondary-action-btn ui-button-compact" data-action="customer.cancel-new">${UIComponent.Keycap("ESC", "command")} CANCEL</button>
      </div>

      <div style="font-size:10px; color:var(--text-muted); background:var(--surface-subtle); padding:8px 12px; border-radius:4px; border:1px solid var(--border-mid); margin-bottom:14px; display:flex; justify-content:space-between; align-items:center;">
        <span><strong class="u-text-amber">NUMERIC FIELD JUMPS:</strong> Press ${UIComponent.Keycap("Alt+1", "command", {className: "u-text-amber"})}–${UIComponent.Keycap("Alt+9", "command", {className: "u-text-amber"})} to jump focus to any field mouse-free.</span>
        <span>Press ${UIComponent.Keycap("Tab", "command")} to flow in order · Press ${UIComponent.Keycap("Alt+S", "command")} to Save</span>
      </div>
      
      <!-- ACCOUNT TYPE & COMPANY HEADER ROW -->
      <div class="customer-account-header" style="display:grid; grid-template-columns:minmax(240px, 420px); gap:12px; margin-bottom:12px;">
        <div>
          <label style="font-size:10px; color:var(--accent-amber); font-weight:700; display:block; margin-bottom:4px;">${UIComponent.Keycap("1", "command", {style: "background:var(--accent-amber); color:var(--text-on-accent); padding:1px 5px; font-weight:800; font-size:9px; border-radius:2px; margin-right:4px;"})} ACCOUNT TYPE *</label>
          <select id="editCustType" data-change-action="customer.updateCustomerTypeFields" style="width:100%; border:1px solid var(--accent-amber); padding:6px 8px; font-size:11px;">
            ${customerTypeOptions('RETAIL')}
          </select>
        </div>
        <div class="customer-business-field" hidden>
          <label class="field-label">${UIComponent.Keycap("2", "command", {className: "field-jump-key"})} COMPANY / FLEET NAME</label>
          <input type="text" id="editCompany" placeholder="Company or fleet account name" class="control-full">
        </div>
        <div class="customer-fleet-field" hidden>
          <label class="field-label">${UIComponent.Keycap("3", "command", {className: "field-jump-key"})} FLEET UNIT / ACC #</label>
          <input type="text" id="editFleetUnit" placeholder="e.g. UNIT #402 / ACC-991" class="control-full">
        </div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap:12px; margin-bottom:12px;">
        <div>
          <label class="field-label">${UIComponent.Keycap("4", "command", {className: "field-jump-key"})} FULL NAME / PRIMARY *</label>
          <input type="text" id="editCustName" placeholder="Customer Full Name" class="control-full" required autofocus>
        </div>
        <div class="customer-business-field" hidden>
          <label class="field-label">${UIComponent.Keycap("5", "command", {className: "field-jump-key"})} CONTACT PERSON / DISPATCH</label>
          <input type="text" id="editContactPerson" placeholder="e.g. MARK STEVENS (MGR)" class="control-full">
        </div>
        <div>
          <label class="field-label">${UIComponent.Keycap("6", "command", {className: "field-jump-key"})} PHONE NUMBER *</label>
          <input type="tel" id="editCustPhone" placeholder="(403) 555-0123" data-focusout-action="customer.phone-format" class="control-full" required>
        </div>
        <div>
          <label class="field-label">${UIComponent.Keycap("7", "command", {className: "field-jump-key"})} EMAIL ADDRESS</label>
          <input type="email" id="editCustEmail" placeholder="customer@example.com" class="control-full">
        </div>
      </div>

      <!-- FLEET CARD & REIMBURSEMENT DETAILS ROW -->
      <div style="display:grid; grid-template-columns: 1.2fr 1.2fr 0.8fr 0.8fr; gap:12px; margin-bottom:12px;">
        <div class="customer-fleet-field" hidden>
          <label class="field-label">${UIComponent.Keycap("8", "command", {className: "field-jump-key"})} FLEET CARD / PAYMENT INFO</label>
          <input type="text" id="editFleetCard" placeholder="e.g. WEX CARD #4412-8890" class="control-full">
        </div>
        <div class="customer-business-field" hidden>
          <label class="field-label">${UIComponent.Keycap("9", "command", {className: "field-jump-key"})} REIMBURSEMENT &amp; BILLING NOTES</label>
          <input type="text" id="editReimbursement" placeholder="e.g. PO REQUIRED ON ALL INVOICES" class="control-full">
        </div>
        <div class="customer-business-field" hidden>
          <label class="field-label">TAX EXEMPT #</label>
          <input type="text" id="editTaxExempt" placeholder="e.g. EXEMPT-9941" class="control-full">
        </div>
        <div class="customer-business-field" hidden>
          <label class="field-label">LABOR RATE ($/HR)</label>
          <input type="number" step="0.01" id="editLaborRate" placeholder="Shop Default ($150)" class="control-full">
        </div>
      </div>

      <div style="display:grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap:12px; margin-bottom:12px;">
        <div>
          <label class="field-label">STREET ADDRESS</label>
          <input type="text" id="editCustAddress" class="control-full">
        </div>
        <div>
          <label class="field-label">CITY</label>
          <input type="text" id="editCustCity" class="control-full">
        </div>
        <div>
          <label class="field-label">PROVINCE / TERRITORY</label>
          <select id="editCustState" class="ui-dark-select control-full">${canadianProvinceOptions('')}</select>
        </div>
        <div>
          <label class="field-label">POSTAL CODE</label>
          <input type="text" id="editCustPostal" placeholder="A1A 1A1" maxlength="10" data-focusout-action="customer.postal-format" class="control-full">
        </div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 2fr; gap:12px; margin-bottom:16px;">
        <div>
          <label class="field-label">PREFERENCE</label>
          <select id="editCustPref" class="control-full">
            <option value="PHONE" selected>PHONE</option>
            <option value="TEXT / SMS">TEXT / SMS</option>
            <option value="EMAIL">EMAIL</option>
          </select>
        </div>
        <div>
          <label class="field-label">CUSTOMER NOTES</label>
          <input type="text" id="editCustNotes" placeholder="Special billing rules, vehicle preferences, notes..." class="control-full">
        </div>
      </div>

      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button type="button" data-action="customer.cancel-new" class="secondary-action-btn">${UIComponent.Keycap("ESC", "command")} CANCEL</button>
        <button type="submit" class="primary-action-btn">${UIComponent.Keycap("Alt+S", "inverse", {className: "kbd-invert"})} CREATE CUSTOMER RECORD</button>
      </div>
    </form>`;
  requestAnimationFrame(() => {
    updateCustomerTypeFields('RETAIL');
    window.EditorStack?.register('customerEditor', {
      cancelFn: () => renderCustomerCard(null),
      getNormalizedSnapshot: getCustomerEditorNormalizedSnapshot
    });
  });
}

function handleCustomerFormKeydown(e) {
  if (e.altKey && e.key.toUpperCase() === 'S') {
    e.preventDefault();
    const form = document.getElementById('newCustForm') || document.getElementById('editCustForm');
    if (form) form.requestSubmit();
    return;
  }

  if (e.altKey && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const targetMap = {
      '1': 'editCustType',
      '2': 'editCompany',
      '3': 'editFleetUnit',
      '4': 'editCustName',
      '5': 'editContactPerson',
      '6': 'editCustPhone',
      '7': 'editCustEmail',
      '8': 'editFleetCard',
      '9': 'editReimbursement'
    };
    const el = document.getElementById(targetMap[e.key]);
    if (el) {
      el.focus();
      if (el.select) el.select();
    }
  }
}

async function createNewCustomer(event) {
  event.preventDefault();
  if (window.AsyncOrchestrator) {
    return window.AsyncOrchestrator.executeMutation(event.target, () => performCreateNewCustomer());
  }
  return performCreateNewCustomer();
}

async function performCreateNewCustomer() {
  try {
    const data = {
      name: document.getElementById('editCustName').value.trim(),
      phone: document.getElementById('editCustPhone').value.trim(),
      email: document.getElementById('editCustEmail').value.trim(),
      address: document.getElementById('editCustAddress').value.trim(),
      city: document.getElementById('editCustCity').value.trim(),
      state: document.getElementById('editCustState').value.trim(),
      postal_code: document.getElementById('editCustPostal').value.trim(),
      communication_preference: document.getElementById('editCustPref').value,
      notes: document.getElementById('editCustNotes').value.trim(),
      customer_type: document.getElementById('editCustType').value,
      company_name: document.getElementById('editCompany').value.trim(),
      fleet_unit_number: document.getElementById('editFleetUnit').value.trim(),
      contact_person: document.getElementById('editContactPerson').value.trim(),
      fleet_card_details: document.getElementById('editFleetCard').value.trim(),
      reimbursement_details: document.getElementById('editReimbursement').value.trim(),
      tax_exempt_number: document.getElementById('editTaxExempt').value.trim(),
      labor_rate: document.getElementById('editLaborRate').value.trim() ? parseFloat(document.getElementById('editLaborRate').value) : null
    };
    const response = await api('/api/customers', {
      method: 'POST',
      body: JSON.stringify(data)
    });
    activeCustomer = response.customer;
    renderCustomerCard(response.customer);
  } catch (err) {
    alert('Error creating customer profile: ' + err.message);
  }
}
let configuredCustomerTypes = [
  { code: 'RETAIL', name: 'RETAIL' }, { code: 'FLEET', name: 'FLEET' },
  { code: 'COMPANY', name: 'COMPANY' }, { code: 'WHOLESALE', name: 'WHOLESALE' },
  { code: 'INTERNAL', name: 'INTERNAL' },
];

function customerTypeOptions(selected = 'RETAIL') {
  const chosen = String(selected || 'RETAIL').toUpperCase();
  const types = [...configuredCustomerTypes];
  if (!types.some(type => type.code === chosen)) types.push({ code: chosen, name: chosen });
  return types.map(type => `<option value="${escapeHtml(type.code)}" ${type.code === chosen ? 'selected' : ''}>${escapeHtml(type.name)}</option>`).join('');
}

async function loadConfiguredCustomerTypes() {
  try {
    const result = await api('/api/customer-types');
    if (result.customer_types?.length) configuredCustomerTypes = result.customer_types.map(type => ({ code: String(type.code).toUpperCase(), name: String(type.name).toUpperCase() }));
  } catch (_err) { /* safe defaults remain available */ }
}

if (window.WorkspaceLifecycle) {
  window.WorkspaceLifecycle.register('C', {
    getInitialState: () => ({
      query: '',
      page: 1,
      selectedId: null,
      editorMode: 'directory'
    }),
    mount: (container) => {
      container.setAttribute('data-workspace', 'customers');
    },
    load: async (state) => {
      if (typeof searchCustomers === 'function') {
        await searchCustomers(state.query || '');
      }
      return typeof customerSearchResults !== 'undefined' ? customerSearchResults : [];
    },
    render: () => {
      return typeof renderCustomerDirectoryContent === 'function' ? renderCustomerDirectoryContent() : '';
    },
    interact: () => {
      // interact bindings
    },
    unmount: () => {
      activeCustomer = null;
    }
  });
}


document.addEventListener('DOMContentLoaded', () => {
  const actions = {
    "customer.phone-format": (_, element) => formatCanadianPhoneInput(element),
    "customer.postal-format": (_, element) => formatCanadianPostalInput(element),
    "customer.openNewCustomerForm": (param, element, event) => openNewCustomerForm(),
    "customer.queueCustomerSearch": (param, element, event) => queueCustomerSearch(element.value),
    "customer.handleCustomerSearchKeydown": (param, element, event) => handleCustomerSearchKeydown(event),
    "customer.openCustomerByNumber": (param, element, event) => openCustomerByNumber(Number(param)),
    "customer.handleCustomerRowKeydown": (param, element, event) => handleCustomerRowKeydown(event, Number(param), element),
    "customer.editCustomerCard": (param, element, event) => editCustomerCard(),
    "customer.saveCustomerEdits": (param, element, event) => saveCustomerEdits(event, Number(param)),
    "customer.handleCustomerFormKeydown": (param, element, event) => handleCustomerFormKeydown(event),
    "customer.renderCustomerCard": (param, element, event) => renderCustomerCard(activeCustomer),
    "customer.updateCustomerTypeFields": (param, element, event) => updateCustomerTypeFields(element.value),
    "customer.createNewCustomer": (param, element, event) => createNewCustomer(event),
    "customer.cancel-new": () => renderCustomerCard(null),
  };
  for (const [name, handler] of Object.entries(actions)) {
    EventDelegator.registerAction(name, handler, {permission: "customers"});
  }
});
