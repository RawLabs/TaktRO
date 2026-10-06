/* Standalone Vendor Directory Task Workspace for TaktRO */

let vendorState = null;

function renderVendorLoading() {
  return '<div class="empty-workspace-panel"><strong>LOADING VENDOR DIRECTORY…</strong><span>Retrieving parts suppliers and ordering details.</span></div>';
}

async function loadVendorWorkspace() {
  const host = document.getElementById('workspaceContent');
  try {
    const data = await api('/api/management-setup');
    vendorState = data;
    if (host) host.innerHTML = renderVendorWorkspaceContent();
  } catch (err) {
    if (host) host.innerHTML = `<div class="empty-workspace-panel"><strong>VENDORS COULD NOT LOAD</strong><span>${escapeHtml(err.message)}</span></div>`;
  }
}

function renderVendorWorkspaceContent() {
  const s = vendorState || { vendors: [] };
  return `
    <div class="management-setup-shell">
      <div class="setup-command-bar">
        <div><strong>VENDOR DIRECTORY</strong><small>Supplier profiles, ordering parameters, and contact sheets.</small></div>
        <div class="setup-actions">
          <input id="vendorWorkspaceSearch" class="setup-field input" style="width: 320px; font-weight: normal; text-transform: uppercase;" placeholder="SEARCH VENDOR, CONTACT, OR ACCOUNT…" data-input-action="vendor.filterVendorWorkspaceCards">
          <button class="primary-action-btn" data-action="vendor.openVendorWorkspaceEditor">${UIComponent.Keycap("ALT+A", "inverse")} ADD VENDOR</button>
        </div>
      </div>
      <div id="vendorWorkspaceCards" class="vendor-card-grid" style="margin-top: 14px;">
        ${s.vendors.map(renderVendorWorkspaceCard).join('') || '<div class="setup-help">NO VENDORS REGISTERED IN DATABASE.</div>'}
      </div>
      <div id="vendorWorkspaceEditor" style="margin-top: 20px;"></div>
    </div>
  `;
}

function renderVendorWorkspaceCard(vendor) {
  const searchable = [vendor.name, vendor.account_number, ...vendor.contacts.flatMap(c => [c.name, c.function])].join(' ').toUpperCase();
  const primary = vendor.contacts.find(c => c.is_primary) || vendor.contacts[0];
  return `
    <button type="button" class="vendor-card" data-vendor-search="${escapeHtml(searchable)}" data-action="vendor.edit" data-action-param="${escapeHtml(vendor.id)}">
      <strong>${escapeHtml(vendor.name)}</strong>
      <span>${escapeHtml(vendor.account_number || 'NO ACCOUNT #')} · ${escapeHtml(vendor.category || 'PARTS')}</span>
      <span>${primary ? `${escapeHtml(primary.function || 'CONTACT')}: ${escapeHtml(primary.name)}` : 'NO CONTACTS'}</span>
    </button>
  `;
}

function filterVendorWorkspaceCards(query) {
  const q = query.trim().toUpperCase();
  document.querySelectorAll('#vendorWorkspaceCards .vendor-card').forEach(card => {
    card.hidden = q && !card.dataset.vendorSearch.includes(q);
  });
}

function openVendorWorkspaceEditor(id = null) {
  const vendor = vendorState.vendors.find(item => item.id === id) || { contacts: [], active: 1, category: 'PARTS', country_code: 'CA', currency_code: 'CAD' };
  document.getElementById('vendorWorkspaceEditor').innerHTML = `
    <div class="vendor-editor" data-vendor-id="${vendor.id || ''}">
      <div class="setup-command-bar">
        <strong>${vendor.id ? 'EDIT' : 'ADD'} VENDOR</strong>
        <button class="secondary-action-btn compact" data-action="vendor.cancel">CANCEL</button>
      </div>
      <div class="setup-grid cols-4">
        ${setupInput('vendorName','VENDOR NAME *',vendor.name)}
        ${setupInput('vendorAccount','ACCOUNT #',vendor.account_number)}
        ${setupInput('vendorPhone','ORDERING PHONE',vendor.ordering_phone)}
        ${setupInput('vendorEmail','ORDERING EMAIL',vendor.ordering_email,'email')}
        ${setupInput('vendorAddress','STREET ADDRESS',vendor.address_line_1)}
        ${setupInput('vendorCity','CITY',vendor.city)}
        ${setupInput('vendorRegion','PROVINCE / TERRITORY',vendor.region || 'AB')}
        ${setupInput('vendorPostal','POSTAL CODE',vendor.postal_code)}
        ${setupInput('vendorTaxId','GST / TAX REGISTRATION #',vendor.tax_id)}
        ${setupInput('vendorMethod','ORDERING METHOD',vendor.ordering_method)}
        ${setupInput('vendorCutoff','ORDER CUTOFF',vendor.cutoff_time)}
        ${setupInput('vendorDelivery','DELIVERY NOTE',vendor.delivery_note)}
        ${setupInput('vendorTerms','TERMS NOTE',vendor.terms_note)}
      </div>
      <details class="setup-subsection">
        <summary>RETURNS, CORES &amp; WARRANTY</summary>
        <div class="setup-grid cols-3">
          ${setupInput('vendorReturns','RETURN / CORE NOTE',vendor.returns_core_note)}
          ${setupInput('vendorWarranty','WARRANTY LINK / REFERENCE',vendor.warranty_link)}
          ${setupInput('vendorNote','OPERATIONAL NOTE',vendor.operational_note)}
        </div>
      </details>
      <h4>CONTACTS</h4>
      <div id="vendorWorkspaceContactRows">${vendor.contacts.map(renderVendorWorkspaceContactRow).join('')}</div>
      <button class="secondary-action-btn compact" data-action="vendor.addVendorWorkspaceContact">+ ADD CONTACT</button>
      <div class="setup-actions" style="margin-top: 14px;">
        <button class="positive-action-btn" data-action="vendor.saveWorkspaceVendor">SAVE VENDOR</button>
      </div>
    </div>
  `;
  document.getElementById('vendorName')?.focus();
}

function renderVendorWorkspaceContactRow(contact = {}) {
  return `
    <div class="setup-rule-row vendor-contact-row" data-vendor-contact>
      <input value="${escapeHtml(contact.name || '')}" placeholder="NAME">
      <input value="${escapeHtml(contact.function || '')}" placeholder="FUNCTION / DESK">
      <input value="${escapeHtml(contact.phone || '')}" placeholder="PHONE">
      <input value="${escapeHtml(contact.extension || '')}" placeholder="EXT">
      <input value="${escapeHtml(contact.email || '')}" placeholder="EMAIL">
      <label><input type="checkbox" ${contact.is_primary ? 'checked' : ''}> PRIMARY</label>
      <button class="line-remove-btn" data-action="vendor.remove-row" data-action-param="[data-vendor-contact]">×</button>
    </div>
  `;
}

function addVendorWorkspaceContact() {
  document.getElementById('vendorWorkspaceContactRows')?.insertAdjacentHTML('beforeend', renderVendorWorkspaceContactRow());
}

async function saveWorkspaceVendor() {
  const editor = document.querySelector('.vendor-editor');
  const contacts = [...document.querySelectorAll('[data-vendor-contact]')].map(row => {
    const input = row.querySelectorAll('input');
    return {
      name: input[0].value,
      function: input[1].value,
      phone: input[2].value,
      extension: input[3].value,
      email: input[4].value,
      is_primary: input[5].checked,
      active: true
    };
  });
  try {
    await api('/api/vendors', {
      method: 'POST',
      body: JSON.stringify({
        id: editor?.dataset.vendorId ? Number(editor.dataset.vendorId) : null,
        name: document.getElementById('vendorName').value,
        account_number: document.getElementById('vendorAccount').value,
        ordering_phone: document.getElementById('vendorPhone').value,
        ordering_email: document.getElementById('vendorEmail').value,
        address_line_1: document.getElementById('vendorAddress')?.value || '',
        city: document.getElementById('vendorCity')?.value || '',
        region: document.getElementById('vendorRegion')?.value || 'AB',
        postal_code: document.getElementById('vendorPostal')?.value || '',
        tax_id: document.getElementById('vendorTaxId')?.value || '',
        ordering_method: document.getElementById('vendorMethod').value,
        cutoff_time: document.getElementById('vendorCutoff').value,
        delivery_note: document.getElementById('vendorDelivery').value,
        terms_note: document.getElementById('vendorTerms').value,
        returns_core_note: document.getElementById('vendorReturns').value,
        warranty_link: document.getElementById('vendorWarranty').value,
        operational_note: document.getElementById('vendorNote').value,
        country_code: 'CA',
        currency_code: 'CAD',
        active: true,
        contacts
      })
    });
    await loadVendorWorkspace();
  } catch (err) {
    alert(err.message);
  }
}


document.addEventListener('DOMContentLoaded', () => {
  const actions = {
    "vendor.filterVendorWorkspaceCards": (param, element, event) => filterVendorWorkspaceCards(element.value),
    "vendor.openVendorWorkspaceEditor": (param, element, event) => openVendorWorkspaceEditor(),
    "vendor.edit": (param, element, event) => openVendorWorkspaceEditor(Number(param)),
    "vendor.cancel": () => { document.getElementById('vendorWorkspaceEditor').replaceChildren(); },
    "vendor.addVendorWorkspaceContact": (param, element, event) => addVendorWorkspaceContact(),
    "vendor.saveWorkspaceVendor": (param, element, event) => saveWorkspaceVendor(),
    "vendor.remove-row": (param, element) => element.closest(param)?.remove(),
  };
  for (const [name, handler] of Object.entries(actions)) {
    EventDelegator.registerAction(name, handler, {permission: "shop_setup"});
  }
});
