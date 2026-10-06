/* TaktRO lean Canadian management setup. Daily defaults stay visible; exceptions expand on demand. */

let managementSetupState = null;

function renderManagementSetupLoading() {
  return '<div class="empty-workspace-panel"><strong>LOADING MANAGEMENT SETUP…</strong><span>Canadian business, pricing, payer programs, and vendors.</span></div>';
}

async function loadManagementSetup() {
  const host = document.getElementById('workspaceContent');
  try {
    managementSetupState = await api('/api/management-setup');
    const state = managementSetupState;
    if (!state.rates.length) state.rates = ['C', 'W', 'I'].map(pay => ({ pay_type: pay, hourly_rate: pay === 'C' ? 150 : 112.5, name: `${pay} GENERAL RATE` }));
    if (!state.taxes.length) state.taxes = [{ name: 'GST', registration_id: state.profile.tax_registration_id || '', rate: 5 }];
    else state.taxes = state.taxes.map(tax => ({ ...tax, rate: Number(tax.rules?.[0]?.rate || 0) * 100 }));
    if (!state.fees.length) state.fees = [
      { fee_type: 'SHOP_SUPPLIES', calculation_type: 'PERCENT', basis_type: 'LABOR', rate_or_amount: 5, maximum_amount: 35, customer_description: 'SHOP SUPPLIES' },
      { fee_type: 'HAZMAT', calculation_type: 'DISABLED', basis_type: 'LABOR', rate_or_amount: 0, customer_description: 'ENVIRONMENTAL / HAZARDOUS MATERIALS' },
    ];
    if (!state.customer_types.length) state.customer_types = [
      { code: 'RETAIL', name: 'RETAIL', parts_adjustment_percent: 0, labor_adjustment_percent: 0, manager_override_required: true, active: true },
      { code: 'FLEET', name: 'FLEET', parts_adjustment_percent: -10, labor_adjustment_percent: -10, manager_override_required: true, active: true },
      { code: 'STAFF', name: 'STAFF', parts_adjustment_percent: 0, labor_adjustment_percent: 0, manager_override_required: true, active: true, note: 'CUSTOMER PAY; COST-PLUS RULE MAY BE ADDED' },
    ];
    if (host) host.innerHTML = renderManagementSetup();
  } catch (err) {
    if (host) host.innerHTML = `<div class="empty-workspace-panel"><strong>SETUP COULD NOT LOAD</strong><span>${escapeHtml(err.message)}</span></div>`;
  }
}

function setupInput(id, label, value = '', type = 'text', extra = '') {
  return `<label class="setup-field"><span>${label}</span><input id="${id}" type="${type}" value="${escapeHtml(value ?? '')}" ${extra}></label>`;
}

function renderManagementSetup() {
  const s = managementSetupState;
  const p = s.profile || {};
  const revision = s.revision || {};
  return `
    <div class="management-setup-shell">
      <div class="setup-command-bar">
        <div><strong>MANAGEMENT SETUP</strong><span class="setup-status status-${String(revision.status || 'DRAFT').toLowerCase()}">${escapeHtml(revision.status || 'DRAFT')}</span><small>DEFAULTS FIRST · EXCEPTIONS ONLY WHEN USED</small></div>
        <div class="setup-actions"><span id="managementSetupMessage"></span><button id="btnSaveSetupDraft" class="secondary-action-btn" data-action="setup.save-draft">${UIComponent.Keycap("ALT+S", "command")} SAVE DRAFT</button><button id="btnPublishSetup" class="positive-action-btn" data-action="setup.publish">${UIComponent.Keycap("ALT+P", "inverse")} TEST &amp; PUBLISH</button></div>
      </div>

      <details class="setup-section" open>
        <summary><span>1</span> CANADIAN BUSINESS &amp; TAX IDENTITY <small>Used on estimates, repair orders, invoices, and purchase orders</small></summary>
        <div class="setup-grid cols-4">
          ${setupInput('setupLegalName', 'LEGAL BUSINESS NAME *', p.legal_name)}
          ${setupInput('setupInvoiceName', 'OPERATING / INVOICE NAME', p.invoice_name)}
          ${setupInput('setupPhone', 'SHOP PHONE', p.phone, 'tel')}
          ${setupInput('setupEmail', 'SHOP EMAIL', p.email, 'email')}
          ${setupInput('setupAddress1', 'STREET ADDRESS', p.address_line_1)}
          ${setupInput('setupCity', 'CITY', p.city)}
          ${setupInput('setupRegion', 'PROVINCE / TERRITORY', p.region || 'AB')}
          ${setupInput('setupPostal', 'POSTAL CODE', p.postal_code)}
          <label class="setup-field"><span>COUNTRY</span><select id="setupCountry" class="ui-dark-select"><option value="CA">CANADA</option></select></label>
          <label class="setup-field"><span>DOCUMENT CURRENCY</span><select id="setupCurrency" class="ui-dark-select"><option value="CAD" ${p.currency_code !== 'USD' ? 'selected' : ''}>CAD</option><option value="USD" ${p.currency_code === 'USD' ? 'selected' : ''}>USD</option></select></label>
          ${setupInput('setupTimezone', 'IANA TIMEZONE', p.timezone_name || 'America/Edmonton')}
          ${setupInput('setupTaxRegistration', 'BN / GST-HST REGISTRATION #', p.tax_registration_id)}
          ${setupInput('setupBusinessNumber', 'CRA BUSINESS NUMBER (9 DIGITS)', p.business_number)}
          ${setupInput('setupBusinessStructure', 'BUSINESS STRUCTURE', p.business_structure, 'text', 'placeholder="CORPORATION / SOLE PROPRIETOR / PARTNERSHIP"')}
          ${setupInput('setupBusinessLicense', 'MUNICIPAL / TRADE LICENCE #', p.business_license_number)}
        </div>
        <div class="setup-repeat-list" id="setupTaxRows">${s.taxes.map((row, i) => renderTaxRow(row, i)).join('')}</div>
        <button class="secondary-action-btn compact" data-action="setup.addSetupTax">+ ADD TAX REGISTRATION</button>
      </details>

      <details class="setup-section" open>
        <summary><span>2</span> LABOUR, FEES &amp; CUSTOMER TYPES <small>Plain defaults; manager-controlled exceptions</small></summary>
        <h4>BASE LABOUR RATES</h4>
        <div class="setup-grid cols-3">${s.rates.map((row, i) => setupInput(`setupRate${i}`, `${row.pay_type} — ${row.name}`, row.hourly_rate, 'number', 'min="0" step="0.01"')).join('')}</div>
        <h4>STANDARD FEES</h4>
        <div class="setup-repeat-list">${s.fees.map((row, i) => renderFeeRow(row, i)).join('')}</div>
        <h4>CUSTOMER TYPES <small>Separate from repair-line pay type</small></h4>
        <div class="setup-repeat-list" id="setupCustomerTypeRows">${s.customer_types.map((row, i) => renderCustomerTypeRow(row, i)).join('')}</div>
        <button class="secondary-action-btn compact" data-action="setup.addSetupCustomerType">+ ADD CUSTOMER TYPE</button>
      </details>
      <details class="setup-section">
        <summary><span>3</span> WARRANTY / INTERNAL / GOODWILL PROGRAMS <small>Open only when payer rules differ from shop defaults</small></summary>
        <div class="setup-repeat-list" id="setupProgramRows">${s.payer_programs.map((row, i) => renderPayerProgramRow(row, i)).join('')}</div>
        <button class="secondary-action-btn compact" data-action="setup.addSetupProgram">+ ADD PAYER PROGRAM</button>
        <p class="setup-help">GOODWILL is a distinct [G] pay type. Split funding remains one work line; program allocation is recorded behind the line.</p>
      </details>
    </div>`;
}

function renderTaxRow(row, i) {
  return `<div class="setup-rule-row" data-tax-row><input value="${escapeHtml(row.name || '')}" aria-label="Tax name"><input value="${escapeHtml(row.registration_id || '')}" aria-label="Registration number" placeholder="REGISTRATION #"><input type="number" min="0" step="0.001" value="${Number(row.rate || 0)}" aria-label="Tax percent"><span>%</span><button class="line-remove-btn" data-action="setup.remove-row" data-action-param="[data-tax-row]">×</button></div>`;
}

function renderFeeRow(row, i) {
  return `<div class="setup-rule-row fee-row" data-fee-index="${i}"><strong>${escapeHtml(row.customer_description || row.fee_type)}</strong><select class="ui-dark-select fee-method"><option value="DISABLED" ${row.calculation_type === 'DISABLED' ? 'selected' : ''}>OFF</option><option value="FLAT" ${row.calculation_type === 'FLAT' ? 'selected' : ''}>FLAT $</option><option value="PERCENT" ${row.calculation_type === 'PERCENT' ? 'selected' : ''}>% OF LABOUR</option></select><input class="fee-value" type="number" min="0" step="0.01" value="${Number(row.rate_or_amount || 0)}"><input class="fee-cap" type="number" min="0" step="0.01" value="${row.maximum_amount ?? ''}" placeholder="OPTIONAL CAP $"></div>`;
}

function renderCustomerTypeRow(row, i) {
  return `<div class="setup-rule-row customer-type-row" data-customer-type-row><input value="${escapeHtml(row.code || '')}" aria-label="Type code" placeholder="CODE"><input value="${escapeHtml(row.name || '')}" aria-label="Type name" placeholder="NAME"><label>P/L % <input type="number" step="0.1" value="${Number(row.parts_adjustment_percent || 0)}" aria-label="Parts adjustment"></label><label>LAB % <input type="number" step="0.1" value="${Number(row.labor_adjustment_percent || 0)}" aria-label="Labour adjustment"></label><label>MIN JOB $ <input type="number" min="0" step="0.01" value="${row.minimum_job_total ?? ''}" aria-label="Minimum job total"></label><button class="line-remove-btn" data-action="setup.remove-row" data-action-param="[data-customer-type-row]">×</button></div>`;
}

function renderPayerProgramRow(row = {}, i = 0) {
  return `<div class="setup-rule-row payer-program-row" data-program-row><select class="ui-dark-select"><option value="W" ${row.pay_type === 'W' ? 'selected' : ''}>WARRANTY</option><option value="I" ${row.pay_type === 'I' ? 'selected' : ''}>INTERNAL</option><option value="G" ${row.pay_type === 'G' ? 'selected' : ''}>GOODWILL</option></select><input value="${escapeHtml(row.name || '')}" placeholder="PROGRAM / REASON"><select class="ui-dark-select"><option value="DOOR_PERCENT">% OF DOOR RATE</option><option value="FIXED_RATE">FIXED HOURLY RATE</option><option value="CAPPED_RATE">CAPPED HOURLY RATE</option><option value="NO_LABOR">NO LABOUR</option></select><input type="number" min="0" step="0.01" value="${Number(row.labor_value ?? 100)}" aria-label="Labour value"><label><input type="checkbox" ${row.manager_approval_required ? 'checked' : ''}> MGR APPROVAL</label><button class="line-remove-btn" data-action="setup.remove-row" data-action-param="[data-program-row]">×</button></div>`;
}

function addSetupTax() { document.getElementById('setupTaxRows')?.insertAdjacentHTML('beforeend', renderTaxRow({ name: '', rate: 0 }, Date.now())); }
function addSetupCustomerType() { document.getElementById('setupCustomerTypeRows')?.insertAdjacentHTML('beforeend', renderCustomerTypeRow({}, Date.now())); }
function addSetupProgram() { document.getElementById('setupProgramRows')?.insertAdjacentHTML('beforeend', renderPayerProgramRow({}, Date.now())); }

function collectManagementSetup() {
  const s = managementSetupState;
  const taxes = [...document.querySelectorAll('[data-tax-row]')].map(row => { const inputs = row.querySelectorAll('input'); return { name: inputs[0].value, registration_id: inputs[1].value, rate: Number(inputs[2].value || 0) }; });
  const fees = [...document.querySelectorAll('[data-fee-index]')].map(row => { const base = s.fees[Number(row.dataset.feeIndex)]; return { ...base, calculation_type: row.querySelector('.fee-method').value, rate_or_amount: Number(row.querySelector('.fee-value').value || 0), maximum_amount: row.querySelector('.fee-cap').value || null }; });
  const customer_types = [...document.querySelectorAll('[data-customer-type-row]')].map(row => { const inputs = row.querySelectorAll('input'); return { code: inputs[0].value, name: inputs[1].value, parts_adjustment_percent: Number(inputs[2].value || 0), labor_adjustment_percent: Number(inputs[3].value || 0), minimum_job_total: inputs[4].value || null, manager_override_required: true, active: true }; });
  const payer_programs = [...document.querySelectorAll('[data-program-row]')].map(row => { const selects = row.querySelectorAll('select'); const inputs = row.querySelectorAll('input'); return { pay_type: selects[0].value, name: inputs[0].value, labor_method: selects[1].value, labor_value: Number(inputs[1].value || 0), parts_method: 'ACTUAL', parts_value: 100, manager_approval_required: inputs[2].checked, active: true }; });
  return { action: 'SAVE_DRAFT', profile: { legal_name: document.getElementById('setupLegalName').value, invoice_name: document.getElementById('setupInvoiceName').value, phone: document.getElementById('setupPhone').value, email: document.getElementById('setupEmail').value, address_line_1: document.getElementById('setupAddress1').value, city: document.getElementById('setupCity').value, region: document.getElementById('setupRegion').value, postal_code: document.getElementById('setupPostal').value, country_code: 'CA', currency_code: document.getElementById('setupCurrency').value, timezone_name: document.getElementById('setupTimezone').value, tax_registration_id: document.getElementById('setupTaxRegistration').value, business_number: document.getElementById('setupBusinessNumber').value, business_structure: document.getElementById('setupBusinessStructure').value, business_license_number: document.getElementById('setupBusinessLicense').value, promised_time_buffer_minutes: 30, ro_prefix: 'RO', po_prefix: 'PO' }, rates: s.rates.map((row, i) => ({ ...row, hourly_rate: Number(document.getElementById(`setupRate${i}`).value || 0) })), taxes, fees, customer_types, payer_programs };
}

async function saveManagementSetup(action) {
  const message = document.getElementById('managementSetupMessage');
  const payload = collectManagementSetup(); payload.action = action;
  if (!payload.profile.legal_name.trim()) { if (message) message.textContent = 'LEGAL NAME IS REQUIRED'; return; }
  if (action === 'PUBLISH' && !confirm('PUBLISH THESE RULES FOR LIVE ESTIMATES, APPOINTMENTS, AND REPAIR ORDERS?')) return;
  try {
    if (message) message.textContent = action === 'PUBLISH' ? 'TESTING…' : 'SAVING…';
    const result = await api('/api/management-setup', { method: 'POST', body: JSON.stringify(payload) });
    if (message) message.textContent = result.status === 'ACTIVE' ? 'PUBLISHED' : 'DRAFT SAVED';
    await loadManagementSetup();
  } catch (err) { if (message) message.textContent = err.message.toUpperCase(); }
}


document.addEventListener('DOMContentLoaded', () => {
  const actions = {
    "setup.save-draft": (param, element, event) => saveManagementSetup('SAVE_DRAFT'),
    "setup.publish": (param, element, event) => saveManagementSetup('PUBLISH'),
    "setup.addSetupTax": (param, element, event) => addSetupTax(),
    "setup.addSetupCustomerType": (param, element, event) => addSetupCustomerType(),
    "setup.addSetupProgram": (param, element, event) => addSetupProgram(),
    "setup.remove-row": (param, element) => element.closest(param)?.remove(),
  };
  for (const [name, handler] of Object.entries(actions)) {
    EventDelegator.registerAction(name, handler, {permission: "shop_setup"});
  }
});
