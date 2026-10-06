/**
 * TaktRO — Parts & Inventory Control Workspace Module (parts/parts.js)
 * Keyboard-first parts lookup, 1-pass intake, RO job line allocation, counter sale invoicing, cycle counting & audit tracking.
 */

let partsSearchTimer = null;
let partsSearchResults = [];
let partsActiveIndex = 0;

let csCustSearchTimer = null;
let csCustSearchResults = [];
let csCustActiveIndex = 0;

function renderPartsContent() {
  setTimeout(() => {
    const input = document.getElementById('partsSearchInput');
    if (input) input.focus();
    searchParts('');
  }, 10);

  return `
    <div style="font-family:var(--font-mono); color:var(--text-main); display:flex; flex-direction:column; gap:14px; height:100%; justify-content:space-between;">
      
      <!-- TOP: HEADER BAR & ACTION HUB -->
      <div class="ui-stack-12">
        <div class="ui-command-panel">
          <div style="display:flex; align-items:center; gap:10px;">
            <img src="media/TaktRO_media_package_2026-08-16/TaktRO_media_package/01_WEB/TaktRO_logo_dark_400px.png" alt="Parts Logo" style="height:26px; width:auto; object-fit:contain;">
            <div>
              <strong class="ui-copy">PARTS &amp; INVENTORY CONTROL ENGINE</strong>
              <span style="font-size:11px; color:var(--text-dim); margin-left:12px;">SEARCH BY PART #, DESCRIPTION, BIN, OR SUPPLIER</span>
            </div>
          </div>
          <div class="ui-row-8">
            <button class="secondary-action-btn" data-command="parts.add_stock">${UIComponent.Keycap('ALT+A', 'command')} ADD STOCK PART</button>
            <button class="secondary-action-btn" data-command="parts.add_passthrough">${UIComponent.Keycap('ALT+P', 'command')} ADD PASS-THROUGH PART</button>
            <button class="secondary-action-btn" data-command="parts.counter_sale">${UIComponent.Keycap('ALT+I', 'command')} INVOICE COUNTER SALE</button>
            <button class="primary-action-btn" data-command="parts.apply_ro">${UIComponent.Keycap('ALT+O', 'inverse', {className: 'kbd-invert'})} APPLY TO RO</button>
            <button class="secondary-action-btn" data-command="parts.receive_stock">${UIComponent.Keycap('ALT+R', 'command')} RECEIVE STOCK</button>
          </div>
        </div>

        <!-- METRIC SUMMARY TILES BAR -->
        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px;">
          <div style="background:var(--surface-panel); border:1px solid var(--border-mid); border-radius:4px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div class="ui-label-dim">REORDER ALERTS</div>
              <div style="font-size:16px; font-weight:800; color:var(--accent-amber);" id="metricReorderCount">0</div>
            </div>
            <span style="font-size:9px; background:rgba(var(--accent-amber-rgb),0.15); color:var(--accent-amber); padding:2px 6px; border-radius:2px; font-weight:700;">LOW STOCK</span>
          </div>
          <div style="background:var(--surface-panel); border:1px solid var(--border-mid); border-radius:4px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div class="ui-label-dim">RESERVED TO ROs</div>
              <div style="font-size:16px; font-weight:800; color:var(--accent-steel);" id="metricReservedCount">0</div>
            </div>
            <span style="font-size:9px; background:rgba(var(--accent-steel-rgb),0.15); color:var(--accent-steel); padding:2px 6px; border-radius:2px; font-weight:700;">SPOKEN FOR</span>
          </div>
          <div style="background:var(--surface-panel); border:1px solid var(--border-mid); border-radius:4px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div class="ui-label-dim">TOTAL CATALOG SKUS</div>
              <div style="font-size:16px; font-weight:800; color:var(--text-main);" id="metricTotalSkus">0</div>
            </div>
            <span style="font-size:9px; background:var(--surface-raised); color:var(--text-muted); padding:2px 6px; border-radius:2px; font-weight:700;">ACTIVE</span>
          </div>
        </div>

        <!-- SEARCH INPUT -->
        <input id="partsSearchInput" type="text" placeholder="Type Part #, Description, Home Bin (e.g. BIN-A12), or Supplier..." style="width:100%; background:var(--surface-subtle); padding:10px 12px; font-size:13px; border-radius:4px;" data-input-action="parts.search" data-keydown-action="parts.search-key" autocomplete="off">
      </div>

      <!-- RESULTS CONTAINER / INVENTORY WORKSPACE TABLE -->
      <div id="partsResults" style="flex:1; overflow-y:auto; margin-top:4px;">
        <div style="padding:24px; color:var(--text-muted); text-align:center; background:var(--surface-panel); border-radius:4px; border:1px solid var(--border-mid); font-size:12px;">LOADING INVENTORY CATALOG...</div>
      </div>

    </div>
  `;
}

const debouncedSearchParts = typeof debounce === 'function' ? debounce((query) => searchParts(query), 150) : null;

function queuePartsSearch(query) {
  if (debouncedSearchParts) {
    debouncedSearchParts(query);
  } else {
    clearTimeout(partsSearchTimer);
    partsSearchTimer = setTimeout(() => searchParts(query), 150);
  }
}

let partsSearchSequence = 0;

function cancelPendingPartsSearch() {
  clearTimeout(partsSearchTimer);
  ++partsSearchSequence;
}

async function searchParts(query = '') {
  const container = document.getElementById('partsResults');
  if (!container) return;

  const seq = ++partsSearchSequence;
  try {
    const isFastMoving = (query.trim() === '');
    const url = isFastMoving ? '/api/parts?fast_moving=1' : `/api/parts?q=${encodeURIComponent(query.trim())}`;
    const response = await api(url);
    if (seq !== partsSearchSequence) return;

    partsSearchResults = response.parts || [];
    partsActiveIndex = 0;
    window.currentViewingPartId = null;
    window.isViewingFastMoving = isFastMoving;
    renderPartsTable();
  } catch (err) {
    if (seq !== partsSearchSequence) return;
    container.innerHTML = `<div style="padding:16px; color:var(--accent-amber); font-size:12px; background:var(--surface-panel); border-radius:4px;">${escapeHtml(err.message)}</div>`;
  }
}

let partsCatalogPage = 1;
let partsCatalogPageSize = 20;
function changePartsCatalogPage(p) {
  partsCatalogPage = p;
  renderPartsTable();
}
window.changePartsCatalogPage = changePartsCatalogPage;

function renderPartsTable() {
  const container = document.getElementById('partsResults');
  if (!container) return;

  let totalReserved = 0;
  let reorderCount = 0;

  partsSearchResults.forEach(p => {
    const res = typeof p.qty_reserved === 'number' ? p.qty_reserved : (parseInt(p.qty_reserved || 0, 10) || 0);
    totalReserved += res;
    if (p.is_low_stock) reorderCount++;
  });

  const mReorder = document.getElementById('metricReorderCount');
  const mReserved = document.getElementById('metricReservedCount');
  const mSkus = document.getElementById('metricTotalSkus');

  if (mReorder) mReorder.textContent = reorderCount;
  if (mReserved) mReserved.textContent = totalReserved;
  if (mSkus) mSkus.textContent = partsSearchResults.length;

  if (!partsSearchResults.length) {
    container.innerHTML = '<div style="padding:24px; color:var(--text-muted); text-align:center; background:var(--surface-panel); border-radius:4px; border:1px solid var(--border-mid);">NO INVENTORY ITEMS FOUND MATCHING SEARCH QUERY.</div>';
    return;
  }

  const startIndex = (partsCatalogPage - 1) * partsCatalogPageSize;
  const paginatedParts = partsSearchResults.slice(startIndex, startIndex + partsCatalogPageSize);
  const totalPages = Math.ceil(partsSearchResults.length / partsCatalogPageSize) || 1;
  const paginationHtml = window.UIComponent ? window.UIComponent.Pagination({
    currentPage: partsCatalogPage,
    totalPages,
    totalItems: partsSearchResults.length,
    pageSize: partsCatalogPageSize,
    pageAction: 'parts.page'
  }) : '';

  const tableHeaderHtml = window.isViewingFastMoving
    ? `<div style="background:rgba(var(--accent-emerald-rgb),0.12); padding:10px 14px; border:1px solid var(--border-mid); border-bottom:none; border-radius:4px 4px 0 0; display:flex; justify-content:space-between; align-items:center; font-family:var(--font-mono); margin-top:10px;">
         <span style="color:var(--accent-emerald); font-weight:800; font-size:12px;">⚡ TOP 10 FAST-MOVING PARTS (FREQUENTLY SOLD)</span>
         <span style="font-size:10px; color:var(--text-muted);">PRESS ${UIComponent.Keycap('1-0', 'command', {className: 'u-text-emerald'})} TO QUICKLY ROUTE TO PART</span>
       </div>`
    : '';

  container.innerHTML = tableHeaderHtml + `
    <table style="width:100%; border-collapse:collapse; font-size:11px; background:var(--surface-panel); border-radius:4px; border:1px solid var(--border-mid); overflow:hidden;">
      <thead>
        <tr class="ui-table-head-subtle">
          <th style="padding:10px 12px; width:40px; text-align:center;">#</th>
          <th style="padding:10px 12px; width:130px;">PART #</th>
          <th style="padding:10px 12px;">DESCRIPTION &amp; CATEGORY</th>
          <th style="padding:10px 12px; width:100px;">HOME BIN</th>
          <th style="padding:10px 12px; text-align:right; width:70px;">ON HAND</th>
          <th style="padding:10px 12px; text-align:right; width:70px;">RESERVED</th>
          <th style="padding:10px 12px; text-align:right; width:80px;">AVAILABLE</th>
          <th style="padding:10px 12px; text-align:right; width:75px;">COST ($)</th>
          <th style="padding:10px 12px; text-align:right; width:75px;">RETAIL ($)</th>
          <th style="padding:10px 12px; text-align:center; width:100px;">STATUS</th>
          <th style="padding:10px 12px; text-align:center; width:160px;">ACTIONS</th>
        </tr>
      </thead>
      <tbody>
        ${paginatedParts.map((part, pIdx) => {
          const index = startIndex + pIdx;
          const isActive = index === partsActiveIndex;
          const costVal = typeof part.cost_price === 'number' ? part.cost_price : (parseFloat(part.cost_price || 0) || 0.0);
          const retailVal = typeof part.retail_price === 'number' ? part.retail_price : (parseFloat(part.retail_price || 0) || 0.0);
          const availVal = typeof part.qty_available === 'number' ? part.qty_available : (parseInt(part.qty_available || 0, 10) || 0);
          const resVal = typeof part.qty_reserved === 'number' ? part.qty_reserved : (parseInt(part.qty_reserved || 0, 10) || 0);
          const onHandVal = typeof part.qty_on_hand === 'number' ? part.qty_on_hand : (parseInt(part.qty_on_hand || 0, 10) || 0);

          const statusBadge = window.UIComponent ? (
            part.is_low_stock
              ? UIComponent.StatusBadge(`REORDER (${availVal})`, 'caution')
              : availVal === 0
              ? UIComponent.StatusBadge('OUT OF STOCK', 'danger')
              : UIComponent.StatusBadge('IN STOCK', 'positive')
          ) : (part.is_low_stock
            ? `<span style="background:rgba(var(--accent-amber-rgb),0.18); color:var(--accent-amber); padding:2px 6px; border-radius:3px; font-weight:800; font-size:9px;">REORDER (${availVal})</span>`
            : availVal === 0
            ? `<span style="background:rgba(var(--accent-crimson-rgb),0.18); color:var(--accent-crimson); padding:2px 6px; border-radius:3px; font-weight:800; font-size:9px;">OUT OF STOCK</span>`
            : `<span style="background:rgba(var(--accent-emerald-rgb),0.15); color:var(--accent-emerald); padding:2px 6px; border-radius:3px; font-weight:800; font-size:9px;">IN STOCK</span>`);

          const kbdVal = (index + 1) === 10 ? '0' : (index + 1);

          return `
            <tr tabindex="0" style="border-bottom:1px solid var(--border-soft); ${isActive ? 'background:rgba(var(--accent-amber-rgb),0.15);' : ''}; cursor:pointer;" data-action="parts.detail" data-action-param="${part.id}">
              <td style="padding:8px 12px; text-align:center;">${UIComponent.Keycap(kbdVal, 'index')}</td>
              <td style="padding:8px 12px;"><strong class="ui-copy">${part.line_code ? `<span class="code-chip">${escapeHtml(part.line_code)}</span> ` : ''}${escapeHtml(part.part_number || '')}</strong></td>
              <td style="padding:8px 12px;">
                <div style="color:var(--text-main); font-weight:600;">${escapeHtml(part.description || '')}</div>
                <div class="ui-label-muted">${escapeHtml(part.category || 'GENERAL')} · ${escapeHtml(part.supplier_name || 'NO SUPPLIER')} ${part.is_pass_through ? '<span style="background:rgba(var(--accent-amber-rgb),0.2); color:var(--accent-amber); padding:1px 5px; border-radius:2px; font-weight:800; font-size:9px; margin-left:4px;">PASS-THROUGH</span>' : '<span style="background:rgba(var(--accent-emerald-rgb),0.15); color:var(--accent-emerald); padding:1px 5px; border-radius:2px; font-weight:800; font-size:9px; margin-left:4px;">STOCK SKU</span>'} ${part.interchange_number ? `<span style="color:var(--text-dim); margin-left:6px;">[ALT: ${escapeHtml(part.interchange_number)}]</span>` : ''}</div>
              </td>
              <td style="padding:8px 12px;">
                <span style="background:var(--surface-raised); color:var(--accent-amber); padding:3px 7px; border-radius:3px; border:1px solid var(--border-bright); font-weight:700; font-size:10px;">${escapeHtml(part.home_bin || 'MAIN')}</span>
              </td>
              <td style="padding:8px 12px; text-align:right; color:var(--text-main); font-weight:700;">${onHandVal}</td>
              <td style="padding:8px 12px; text-align:right; color:var(--accent-steel); font-weight:700;">${resVal}</td>
              <td style="padding:8px 12px; text-align:right; color:var(--accent-emerald); font-weight:800; font-size:13px;">${availVal}</td>
              <td style="padding:8px 12px; text-align:right; color:var(--text-muted);">$${costVal.toFixed(2)} ${part.last_cost_date ? `<div style="font-size:9px; color:var(--text-dim);">${escapeHtml(part.last_cost_date)}</div>` : ''}</td>
              <td style="padding:8px 12px; text-align:right; color:var(--accent-amber); font-weight:700;">$${retailVal.toFixed(2)}</td>
              <td style="padding:8px 12px; text-align:center;">${statusBadge}</td>
              <td style="padding:8px 12px; text-align:center;">
                <div style="display:flex; gap:4px; justify-content:center;">
                  <button type="button" class="primary-action-btn action-compact" data-command="parts.apply_ro" data-part-id="${part.id}" title="Apply to RO Line">+RO</button>
                  <button type="button" class="secondary-action-btn action-compact" data-command="parts.counter_sale" data-part-id="${part.id}" title="Counter Sale Invoice">INV</button>
                  <button type="button" class="secondary-action-btn action-compact" data-action="parts.receive" data-action-param="${part.id}" title="Receive Stock">+REC</button>
                  <button type="button" class="secondary-action-btn action-compact" data-action="parts.detail" data-action-param="${part.id}" title="View History">HIST</button>
                </div>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    <div style="margin-top:12px;">${paginationHtml}</div>
  `;
}

function handlePartsSearchKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (partsSearchResults.length) {
      partsActiveIndex = (partsActiveIndex + 1) % partsSearchResults.length;
      renderPartsTable();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (partsSearchResults.length) {
      partsActiveIndex = (partsActiveIndex - 1 + partsSearchResults.length) % partsSearchResults.length;
      renderPartsTable();
    }
  } else if (e.key === 'Enter' && partsSearchResults.length) {
    e.preventDefault();
    const activePart = partsSearchResults[partsActiveIndex] || partsSearchResults[0];
    openPartsDetail(activePart.id);
  }
}

function openQuickReceiveModal() {
  if (!partsSearchResults.length) return;
  const part = partsSearchResults[partsActiveIndex] || partsSearchResults[0];
  openPartsReceive(part.id);
}

// --- I: INVOICE COUNTER SALE (OVER-THE-COUNTER CASHOUT) ---
window.activeCounterSale = null;

function initCounterSaleSession() {
  if (!window.activeCounterSale) {
    window.activeCounterSale = {
      customerName: 'WALK-IN COUNTER CUSTOMER',
      paymentMethod: 'CASH',
      items: []
    };
  }
}

function cancelCounterSaleSession() {
  window.activeCounterSale = null;
  searchParts('');
}

async function openPartsInvoiceCounterSaleModal(partId = null) {
  cancelPendingPartsSearch();
  initCounterSaleSession();

  let targetPartId = partId || window.currentViewingPartId;
  if (!targetPartId && partsSearchResults.length) {
    const p = partsSearchResults[partsActiveIndex] || partsSearchResults[0];
    targetPartId = p ? p.id : null;
  }

  if (targetPartId) {
    const res = await api(`/api/parts/${targetPartId}`);
    const part = res.part;
    const existing = window.activeCounterSale.items.find(i => i.part_id === part.id);
    if (!existing) {
      window.activeCounterSale.items.push({
        part_id: part.id,
        part_number: part.part_number,
        description: part.description,
        qty: 1,
        unit_price: part.retail_price,
        avail_stock: part.qty_available
      });
    }
  }

  window.currentViewingPartId = null;
  renderCounterSaleForm();
}

function renderCounterSaleForm() {
  const container = document.getElementById('partsResults');
  if (!container || !window.activeCounterSale) return;

  const items = window.activeCounterSale.items;

  const itemsHtml = items.map((item, idx) => {
    const isExpanded = window.expandedCounterSaleIndex === idx;
    const itemTotal = (item.qty * item.unit_price).toFixed(2);

    return `
      <tr style="border-bottom:${isExpanded ? 'none' : '1px solid var(--border-mid)'}; ${isExpanded ? 'background:rgba(var(--accent-amber-rgb),0.15);' : ''}; cursor:pointer;" data-action="parts.counter-item" data-action-param="${idx + 1}">
        <td class="ui-cell-center">
          ${UIComponent.Keycap(idx + 1, 'index', {style: `background:${isExpanded ? 'var(--accent-amber)' : 'var(--surface-raised)'}; color:${isExpanded ? 'var(--surface-input)' : 'var(--text-main)'}; font-weight:800; padding:2px 6px; border-radius:2px; border:1px solid var(--border-bright); cursor:pointer;`})}
        </td>
        <td class="ui-cell"><strong class="u-text-amber">${escapeHtml(item.part_number)}</strong></td>
        <td style="padding:8px 10px; color:var(--text-main);">${escapeHtml(item.description)}</td>
        <td style="padding:8px 10px; text-align:right; color:var(--accent-emerald); font-weight:700;">${item.avail_stock}</td>
        <td class="ui-cell-right">
          <input type="number" id="csQty_${idx}" min="1" max="${item.avail_stock || 99}" value="${item.qty}" style="width:60px; text-align:right; padding:4px 6px; font-size:11px; border-radius:2px;" data-input-action="parts.counter-qty" data-action-param="${idx}">
        </td>
        <td class="ui-cell-right">
          <input type="text" id="csPrice_${idx}" value="${item.unit_price.toFixed(2)}" style="width:70px; text-align:right; padding:4px 6px; font-size:11px; border-radius:2px;" data-input-action="parts.counter-price" data-action-param="${idx}">
        </td>
        <td style="padding:8px 10px; text-align:right; font-weight:800; color:var(--accent-emerald);" id="csItemTotal_${idx}">
          $${itemTotal}
        </td>
        <td class="ui-cell-center">
          <button type="button" class="line-remove-btn" data-action="parts.counter-remove" data-action-param="${idx}" title="Remove Item">✕</button>
        </td>
      </tr>
      ${isExpanded ? `
        <tr style="border-bottom:1px solid var(--accent-amber); background:var(--surface-input);">
          <td colspan="8" style="padding:10px 14px;">
            <div style="display:flex; justify-content:space-between; align-items:center; background:var(--surface-panel); border-left:3px solid var(--accent-amber); padding:8px 12px; border-radius:3px; font-size:10px;">
              <div>
                <strong class="u-text-amber">${escapeHtml(item.part_number)} DETAILS:</strong>
                <span style="color:var(--text-muted); margin-left:8px;">HOME BIN:</span> <strong class="u-text-main">${escapeHtml(item.home_bin || 'BIN-STORE')}</strong>
                <span style="color:var(--text-muted); margin-left:12px;">CATEGORY:</span> <strong class="u-text-main">${escapeHtml(item.category || 'PARTS')}</strong>
                <span style="color:var(--text-muted); margin-left:12px;">SUPPLIER:</span> <strong class="u-text-main">${escapeHtml(item.supplier_name || 'SHOP CATALOG')}</strong>
              </div>
              <div style="display:flex; gap:16px;">
                <span>RETAIL: <strong class="u-text-amber">$${item.unit_price.toFixed(2)}</strong></span>
                <span>AVAIL: <strong class="u-text-green">${item.avail_stock}</strong></span>
              </div>
            </div>
          </td>
        </tr>
      ` : ''}
    `;
  }).join('');

  const totalInvoice = items.reduce((sum, item) => sum + (item.qty * item.unit_price), 0).toFixed(2);

  container.innerHTML = `
    <form id="counterSaleForm" data-submit-hotkey="ALT+I" data-submit-action="parts.counter-submit" style="background:var(--surface-panel); border:1px solid var(--accent-emerald); padding:16px; border-radius:4px; font-family:var(--font-mono);">
      <div class="ui-section-heading">
        <div>
          <strong style="color:var(--accent-emerald); font-size:13px;">INVOICE COUNTER SALE (OVER-THE-COUNTER CASHOUT)</strong>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
            ${items.length} ITEM(S) ON OPEN INVOICE
          </div>
        </div>
        <button type="button" class="primary-action-btn" data-action="parts.lookup-open">${UIComponent.Keycap('ALT+P', 'inverse', {className: 'kbd-invert'})} + ADD PARTS FROM INVENTORY</button>
      </div>

      <div style="display:grid; grid-template-columns: 2fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="ui-relative">
          <label class="field-label">CUSTOMER NAME * (TYPE TO SEARCH DATABASE)</label>
          <input type="text" id="csCust" required value="${escapeHtml(window.activeCounterSale.customerName)}" style="width:100%; padding:6px 8px; font-size:12px;" data-input-action="parts.counter-customer-search" data-keydown-action="parts.counter-customer-key" autocomplete="off" autofocus>
          <div id="csCustDropdown" style="display:none; position:absolute; top:100%; left:0; right:0; z-index:100; max-height:220px; overflow-y:auto; background:var(--surface-panel); border:1px solid var(--accent-emerald); border-radius:3px; box-shadow:0 6px 16px rgba(var(--shadow-rgb),0.6);"></div>
        </div>
        <div>
          <label class="field-label">PAYMENT METHOD</label>
          <select id="csPayMethod" class="field-input" data-change-action="parts.payment-method">
            <option value="CASH" ${window.activeCounterSale.paymentMethod === 'CASH' ? 'selected' : ''}>CASH</option>
            <option value="CREDIT CARD" ${window.activeCounterSale.paymentMethod === 'CREDIT CARD' ? 'selected' : ''}>CREDIT CARD</option>
            <option value="DEBIT CARD" ${window.activeCounterSale.paymentMethod === 'DEBIT CARD' ? 'selected' : ''}>DEBIT CARD</option>
            <option value="CHECK" ${window.activeCounterSale.paymentMethod === 'CHECK' ? 'selected' : ''}>CHECK</option>
          </select>
        </div>
      </div>

      <table style="width:100%; border-collapse:collapse; font-size:11px; background:var(--surface-input); border-radius:3px; border:1px solid var(--border-mid); margin-bottom:14px;">
        <thead>
          <tr style="background:var(--surface-subtle); color:var(--text-muted); text-align:left;">
            <th style="padding:8px 10px; width:35px; text-align:center;">#</th>
            <th style="padding:8px 10px; width:120px;">PART #</th>
            <th class="ui-cell">DESCRIPTION</th>
            <th style="padding:8px 10px; text-align:right; width:60px;">AVAIL</th>
            <th style="padding:8px 10px; text-align:right; width:70px;">QTY</th>
            <th style="padding:8px 10px; text-align:right; width:80px;">PRICE ($)</th>
            <th style="padding:8px 10px; text-align:right; width:90px;">TOTAL ($)</th>
            <th style="padding:8px 10px; width:30px;"></th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml || '<tr><td colspan="8" style="padding:16px; text-align:center; color:var(--text-muted);">NO PARTS ADDED TO INVOICE YET. PRESS P TO SEARCH AND ADD PARTS.</td></tr>'}
        </tbody>
      </table>

      <div style="display:flex; justify-content:space-between; align-items:center; background:var(--surface-input); padding:12px 14px; border-radius:3px; border:1px solid var(--border-mid); margin-bottom:16px;">
        <span class="ui-copy-muted">TOTAL INVOICE CASHOUT AMOUNT:</span>
        <strong id="csTotalDisplay" style="font-size:18px; color:var(--accent-emerald); font-weight:800;">$${totalInvoice}</strong>
      </div>

      <div class="ui-actions-end">
        <button type="button" class="secondary-action-btn" data-action="parts.counter-cancel">${UIComponent.Keycap('ESC', 'command')} CANCEL</button>
        <button type="submit" class="primary-action-btn action-success">${UIComponent.Keycap('ALT+I', 'inverse', {className: 'kbd-invert'})} POST COUNTER SALE &amp; PRINT RECEIPT</button>
      </div>
    </form>
  `;
}

function updateCounterSaleItemQty(index, val) {
  if (!window.activeCounterSale || !window.activeCounterSale.items[index]) return;
  window.activeCounterSale.items[index].qty = parseInt(val) || 1;
  renderCounterSaleForm();
}

function updateCounterSaleItemPrice(index, val) {
  if (!window.activeCounterSale || !window.activeCounterSale.items[index]) return;
  window.activeCounterSale.items[index].unit_price = parseFloat(val) || 0.0;
  renderCounterSaleForm();
}

function removeCounterSaleItem(index) {
  if (!window.activeCounterSale) return;
  window.activeCounterSale.items.splice(index, 1);
  renderCounterSaleForm();
}

function selectCounterSaleItemByNumber(num) {
  const idx = num - 1;
  if (!window.activeCounterSale || !window.activeCounterSale.items[idx]) return;

  window.expandedCounterSaleIndex = (window.expandedCounterSaleIndex === idx) ? null : idx;
  renderCounterSaleForm();

  requestAnimationFrame(() => {
    const qtyInput = document.getElementById(`csQty_${idx}`);
    if (qtyInput) {
      qtyInput.focus();
      qtyInput.select();
    }
  });
}

function onCsCustomerInput(val) {
  if (!window.activeCounterSale) return;
  window.activeCounterSale.customerName = val;
  clearTimeout(csCustSearchTimer);

  if (!val.trim()) {
    const dropdown = document.getElementById('csCustDropdown');
    if (dropdown) dropdown.style.display = 'none';
    return;
  }

  csCustSearchTimer = setTimeout(() => searchCsCustomers(val), 150);
}

async function searchCsCustomers(query) {
  const dropdown = document.getElementById('csCustDropdown');
  if (!dropdown) return;

  try {
    const response = await api(`/api/customers?q=${encodeURIComponent(query.trim())}`);
    csCustSearchResults = response.customers || [];
    csCustActiveIndex = 0;
    renderCsCustDropdown();
  } catch (err) {
    dropdown.innerHTML = `<div style="padding:10px; color:var(--accent-amber); font-size:11px;">${escapeHtml(err.message)}</div>`;
    dropdown.style.display = 'block';
  }
}

function renderCsCustDropdown() {
  const dropdown = document.getElementById('csCustDropdown');
  if (!dropdown) return;

  if (!csCustSearchResults.length) {
    dropdown.innerHTML = '<div style="padding:10px; color:var(--text-muted); font-size:11px;">NO MATCHING CUSTOMERS IN DATABASE.</div>';
    dropdown.style.display = 'block';
    return;
  }

  dropdown.innerHTML = csCustSearchResults.map((cust, index) => {
    const isActive = index === csCustActiveIndex;
    const typeLabel = cust.customer_type && cust.customer_type !== 'RETAIL'
      ? `<span style="background:var(--accent-amber); color:var(--surface-input); font-weight:800; padding:1px 5px; border-radius:2px; font-size:9px; margin-left:6px;">${escapeHtml(cust.customer_type)}</span>`
      : '';
    const nameDisplay = cust.company_name ? `${escapeHtml(cust.company_name)} (${escapeHtml(cust.name)})` : escapeHtml(cust.name);

    return `
      <div class="ui-search-result ${isActive ? 'is-active-positive' : ''}" aria-selected="${isActive}" data-action="parts.counter-customer" data-action-param="${cust.id}">
        <div>
          ${UIComponent.Keycap(index + 1, 'index', {style: 'background:var(--accent-emerald); color:var(--surface-input); font-weight:800; margin-right:6px;'})}
          <strong class="u-text-main">${nameDisplay}</strong>
          ${typeLabel}
          ${isActive ? '<span style="font-size:9px; color:var(--accent-emerald); margin-left:6px; font-weight:800;">[ENTER ↵]</span>' : ''}
        </div>
        <div class="ui-label-muted">
          <span>${escapeHtml(cust.phone || 'NO PHONE')}</span>
          ${cust.email ? ` · <span>${escapeHtml(cust.email)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  dropdown.style.display = 'block';
}

function selectCsCustomer(customerId) {
  const cust = csCustSearchResults.find(c => c.id === customerId);
  if (!cust || !window.activeCounterSale) return;

  const displayName = cust.company_name ? `${cust.company_name} (${cust.name})` : cust.name;
  window.activeCounterSale.customerName = displayName;

  const input = document.getElementById('csCust');
  if (input) input.value = displayName;

  const dropdown = document.getElementById('csCustDropdown');
  if (dropdown) dropdown.style.display = 'none';
}

function onCsCustomerKeydown(e) {
  const dropdown = document.getElementById('csCustDropdown');
  const isDropdownVisible = dropdown && dropdown.style.display !== 'none';

  if (isDropdownVisible && csCustSearchResults.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      csCustActiveIndex = (csCustActiveIndex + 1) % csCustSearchResults.length;
      renderCsCustDropdown();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      csCustActiveIndex = (csCustActiveIndex - 1 + csCustSearchResults.length) % csCustSearchResults.length;
      renderCsCustDropdown();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const selected = csCustSearchResults[csCustActiveIndex];
      if (selected) selectCsCustomer(selected.id);
      return;
    }
    if (e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1;
      if (csCustSearchResults[idx]) {
        e.preventDefault();
        selectCsCustomer(csCustSearchResults[idx].id);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dropdown.style.display = 'none';
      return;
    }
  }
}

async function submitCounterSale(event) {
  if (event) event.preventDefault();
  if (!window.activeCounterSale || !window.activeCounterSale.items.length) {
    alert('Please add at least one part item to the counter sale invoice.');
    return;
  }

  try {
    const cust = window.activeCounterSale.customerName || 'WALK-IN COUNTER CUSTOMER';
    const payMethod = window.activeCounterSale.paymentMethod || 'CASH';
    const items = window.activeCounterSale.items;

    const payload = {
      customer_name: cust,
      payment_method: payMethod,
      items: items.map(item => ({
        part_id: item.part_id,
        qty: item.qty,
        unit_price: item.unit_price
      }))
    };

    const res = await api('/api/parts/counter-sale', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    alert(`INVOICE COUNTER SALE COMPLETED!\n\nInvoice #: ${res.invoice_number}\nCustomer: ${cust}\nLine Items: ${res.items_count}\nTotal Paid: $${res.total_amount.toFixed(2)} (${payMethod})\n\nPrinted Cashout Receipt ${res.invoice_number}`);

    closeOtcModal();
    if (typeof searchParts === 'function') {
      const q = document.getElementById('partsSearchInput')?.value || '';
      searchParts(q);
    }
  } catch (err) {
    alert('COUNTER SALE ERROR: ' + err.message);
  }
}

// --- O: APPLY PART TO REPAIR ORDER JOB LINE ---
async function openPartsApplyToRoModal(partId = null) {
  cancelPendingPartsSearch();
  let selectedPart = null;
  if (partId) {
    const res = await api(`/api/parts/${partId}`);
    selectedPart = res.part;
  } else if (partsSearchResults.length) {
    selectedPart = partsSearchResults[partsActiveIndex] || partsSearchResults[0];
  }

  if (!selectedPart) {
    alert('No inventory part selected.');
    return;
  }

  const container = document.getElementById('partsResults');
  if (!container) return;

  const partNumber = selectedPart ? selectedPart.part_number : 'SELECT PART';
  const partDesc = selectedPart ? selectedPart.description : '';
  const availStock = selectedPart ? selectedPart.qty_available : 0;

  if (typeof loadRepairOrders === 'function') await loadRepairOrders();
  const activeRos = (typeof activeRoList !== 'undefined' ? activeRoList : [])
    .filter(r => (r.record?.status || r.status) !== 'invoiced')
    .map(r => {
      const rawLines = r.lines || r.record?.lines || [];
      const jobLines = rawLines.length ? rawLines.map((line, index) => ({
        code: line.line_id || String(index),
        desc: line.concern || 'SERVICE LINE'
      })) : [{ code: 'NEW', desc: 'Create New Job Line on RO' }];
      return {
        roNumber: r.ro || r.ro_number,
        customerName: r.cust || r.customer_name || 'UNNAMED CUSTOMER',
        vehicle: r.veh || r.vehicle_info || 'NO VEHICLE',
        jobLines
      };
    });

  if (!activeRos.length) {
    container.innerHTML = `
      <div class="empty-workspace-panel">
        <strong>NO PERSISTENT REPAIR ORDERS AVAILABLE</strong>
        <span>Part allocation will become available when an active non-invoiced Repair Order exists.</span>
        <button type="button" class="secondary-action-btn" data-command="parts.back">${UIComponent.Keycap('ESC', 'command')} BACK TO PARTS</button>
      </div>`;
    return;
  }

  const roOptionsHtml = activeRos.map(r =>
    `<option value="${r.roNumber}">#${r.roNumber} — ${escapeHtml(r.customerName)} (${escapeHtml(r.vehicle)})</option>`
  ).join('');

  container.innerHTML = `
    <form id="applyToRoForm" data-submit-hotkey="ALT+O" data-submit-action="parts.apply-submit" data-action-param="${selectedPart ? selectedPart.id : 0}" style="background:var(--surface-panel); border:1px solid var(--accent-amber); padding:16px; border-radius:4px; font-family:var(--font-mono);">
      <div class="ui-section-heading">
        <strong class="ui-heading-amber">APPLY PART TO REPAIR ORDER JOB LINE — PART #${escapeHtml(partNumber)}</strong>
        <span style="font-size:11px; color:var(--accent-emerald); font-weight:700;">AVAILABLE: ${availStock}</span>
      </div>

      <div style="display:grid; grid-template-columns: 2fr 2fr 1fr; gap:12px; margin-bottom:14px;">
        <div>
          <label class="field-label">SELECT REPAIR ORDER *</label>
          <select id="appRoSelect" required class="field-input" data-change-action="parts.ro-lines">
            ${roOptionsHtml}
          </select>
        </div>
        <div>
          <label style="font-size:10px; color:var(--accent-amber); font-weight:700; display:block; margin-bottom:4px;">SELECT REPAIR JOB LINE *</label>
          <select id="appJobLineSelect" required style="width:100%; border:1px solid var(--accent-amber); padding:6px 8px; font-size:11px;">
          </select>
        </div>
        <div>
          <label class="field-label">QTY TO APPLY *</label>
          <input type="number" id="appQty" required min="1" max="${availStock || 99}" value="1" style="width:100%; padding:6px 8px; font-size:12px;">
        </div>
      </div>

      <div class="ui-mb-16">
        <label class="field-label">ALLOCATION NOTES</label>
        <input type="text" id="appNotes" placeholder="e.g. Technician intake allocation..." class="field-input">
      </div>

      <div class="ui-actions-end">
        <button type="button" class="secondary-action-btn" data-command="parts.back">${UIComponent.Keycap('ALT+C', 'command')} CANCEL</button>
        <button type="submit" class="primary-action-btn">${UIComponent.Keycap('ALT+O', 'inverse', {className: 'kbd-invert'})} CONFIRM APPLY TO RO JOB LINE</button>
      </div>
    </form>
  `;

  window.currentActiveRos = activeRos;
  updateRoJobLines(activeRos[0].roNumber);
}

function updateRoJobLines(roNumber) {
  const jobSelect = document.getElementById('appJobLineSelect');
  if (!jobSelect || !window.currentActiveRos) return;
  const targetRo = window.currentActiveRos.find(r => r.roNumber === roNumber) || window.currentActiveRos[0];
  jobSelect.innerHTML = targetRo.jobLines.map(j =>
    `<option value="${j.code}">${j.code} — ${j.desc}</option>`
  ).join('');
}

async function submitApplyToRo(event, partId) {
  event.preventDefault();
  try {
    const roNo = document.getElementById('appRoSelect').value.trim();
    const jobLine = document.getElementById('appJobLineSelect').value;
    const qty = parseInt(document.getElementById('appQty').value) || 0;
    const notes = document.getElementById('appNotes').value.trim();

    const res = await api('/api/repair-orders/apply-part', {
      method: 'POST',
      body: JSON.stringify({ ro_number: roNo, part_id: partId, qty, job_line: jobLine, notes })
    });

    if (typeof loadRepairOrders === 'function') await loadRepairOrders();

    alert(`PART ALLOCATED TO REPAIR ORDER JOB LINE!\n\nPart: ${res.part.part_number}\nRO #: ${roNo}\nJob Line: ${jobLine}\nQuantity Reserved: ${qty}\nRemaining Available: ${res.part.qty_available}`);

    if (typeof activeEditingRoId !== 'undefined' && activeEditingRoId && typeof openRoWriteupForEdit === 'function') {
      const activeRoObj = (typeof activeRoList !== 'undefined' ? activeRoList : []).find(r => r.id === activeEditingRoId);
      if (activeRoObj && activeRoObj.ro === roNo) {
        await openRoWriteupForEdit(activeEditingRoId);
      } else {
        searchParts('');
      }
    } else {
      searchParts('');
    }
  } catch (err) {
    alert('Apply to RO Error: ' + err.message);
  }
}

// --- RECEIVE STOCK (1-PASS INTAKE) ---
async function openPartsReceive(partId) {
  cancelPendingPartsSearch();
  try {
    const response = await api(`/api/parts/${partId}`);
    const part = response.part;
    const container = document.getElementById('partsResults');
    if (!container) return;

    container.innerHTML = `
      <form id="receiveStockForm" data-submit-hotkey="ALT+R" data-submit-action="parts.receive-submit" data-action-param="${part.id}" style="background:var(--surface-panel); border:1px solid var(--accent-amber); padding:16px; border-radius:4px; font-family:var(--font-mono);">
        <div class="ui-section-heading">
          <strong class="ui-heading-amber">1-PASS STOCK INTAKE / RECEIVING — PART #${escapeHtml(part.part_number)}</strong>
          <span class="ui-copy-muted">${escapeHtml(part.description)}</span>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap:12px; margin-bottom:14px;">
          <div>
            <label class="field-label">QUANTITY TO RECEIVE *</label>
            <input type="number" id="recQty" required min="1" value="1" style="width:100%; padding:6px 8px; font-size:12px;" autofocus>
          </div>
          <div>
            <label class="field-label">HOME BIN LOCATION</label>
            <input type="text" id="recBin" value="${escapeHtml(part.home_bin)}" style="width:100%; padding:6px 8px; font-size:12px;">
          </div>
          <div>
            <label class="field-label">UNIT COST ($)</label>
            <input type="text" id="recCost" value="${part.cost_price.toFixed(2)}" style="width:100%; padding:6px 8px; font-size:12px;">
          </div>
          <div>
            <label class="field-label">INVOICE / PO REFERENCE</label>
            <input type="text" id="recRef" placeholder="e.g. NAPA-9941" style="width:100%; padding:6px 8px; font-size:12px;">
          </div>
        </div>
        <div class="ui-mb-16">
          <label class="field-label">RECEIVING NOTES</label>
          <input type="text" id="recNotes" placeholder="Optional receiving notes..." class="field-input">
        </div>
        <div class="ui-actions-end">
          <button type="button" class="secondary-action-btn" data-command="parts.back">${UIComponent.Keycap('ALT+C', 'command')} CANCEL</button>
          <button type="submit" class="primary-action-btn action-emerald">${UIComponent.Keycap('ALT+R', 'inverse', {className: 'kbd-invert-emerald'})} CONFIRM RECEIPT</button>
        </div>
      </form>
    `;
  } catch (err) {
    alert('Error opening receiving form: ' + err.message);
  }
}

async function submitReceiveStock(event, partId) {
  event.preventDefault();
  try {
    const qty = parseInt(document.getElementById('recQty').value) || 0;
    const bin_location = document.getElementById('recBin').value.trim();
    const cost = document.getElementById('recCost').value.trim();
    const reference_id = document.getElementById('recRef').value.trim();
    const notes = document.getElementById('recNotes').value.trim();

    await api('/api/parts/receive', {
      method: 'POST',
      body: JSON.stringify({ part_id: partId, qty, bin_location, cost, reference_id, notes })
    });
    searchParts('');
  } catch (err) {
    alert('Receive error: ' + err.message);
  }
}

async function openPartsAdjustStockModal(partId = null) {
  cancelPendingPartsSearch();
  let selectedId = partId || window.currentViewingPartId;
  if (!selectedId && partsSearchResults.length) {
    const activePart = partsSearchResults[partsActiveIndex] || partsSearchResults[0];
    selectedId = activePart.id;
  }
  if (!selectedId) {
    alert('No inventory part selected.');
    return;
  }

  try {
    const response = await api(`/api/parts/${selectedId}`);
    const part = response.part;
    const container = document.getElementById('partsResults');
    if (!container) return;

    container.innerHTML = `
      <form id="adjustStockForm" data-submit-hotkey="ALT+S" data-submit-action="parts.adjust-submit" data-action-param="${part.id}" style="background:var(--surface-panel); border:1px solid var(--accent-amber); padding:16px; border-radius:4px; font-family:var(--font-mono);">
        <div class="ui-section-heading">
          <strong class="ui-heading-amber">MANUAL STOCK LEVEL ADJUSTMENT — PART #${escapeHtml(part.part_number)}</strong>
          <span class="ui-copy-muted">${escapeHtml(part.description)}</span>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:12px; margin-bottom:14px;">
          <div>
            <label class="field-label">CURRENT STOCK ON HAND</label>
            <input type="text" value="${part.qty_on_hand}" readonly style="width:100%; padding:6px 8px; font-size:12px; background:var(--surface-input); border:1px solid var(--border-mid); color:var(--text-muted);">
          </div>
          <div>
            <label class="field-label">NEW STOCK ON HAND *</label>
            <input type="number" id="adjNewQty" required min="0" value="${part.qty_on_hand}" style="width:100%; padding:6px 8px; font-size:12px;" data-input-action="parts.adjust-delta" data-action-param="${part.qty_on_hand}" autofocus>
          </div>
          <div>
            <label class="field-label">ADJUSTMENT DELTA</label>
            <span id="adjDeltaDisplay" style="display:block; padding:6px 8px; font-size:13px; font-weight:800; color:var(--text-dim);">0</span>
          </div>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 2fr; gap:12px; margin-bottom:14px;">
          <div>
            <label class="field-label">ADJUSTMENT REASON *</label>
            <select id="adjReason" required style="width:100%; padding:6px 8px; font-size:12px; border:1px solid var(--accent-amber); background:var(--surface-input); color:var(--text-main);">
              <option value="COUNT_VARIANCE">COUNT VARIANCE</option>
              <option value="DAMAGED">DAMAGED</option>
              <option value="LOST">LOST</option>
              <option value="FOUND">FOUND</option>
              <option value="RETURNED">RETURNED</option>
              <option value="OTHER">OTHER (REASON IN NOTES)</option>
            </select>
          </div>
          <div>
            <label class="field-label">DETAILED AUDIT NOTES * (MANDATORY)</label>
            <input type="text" id="adjNotes" required placeholder="Describe the physical reason for count change..." class="field-input" style="width:100%;">
          </div>
        </div>
        <div class="ui-actions-end">
          <button type="button" class="secondary-action-btn" data-action="parts.detail" data-action-param="${part.id}">${UIComponent.Keycap('ALT+C', 'command')} CANCEL</button>
          <button type="submit" class="primary-action-btn action-amber">${UIComponent.Keycap('ALT+S', 'inverse', {className: 'kbd-invert-amber'})} SAVE ADJUSTMENT</button>
        </div>
      </form>
    `;

    // Focus and select the input
    const input = document.getElementById('adjNewQty');
    if (input) {
      input.focus();
      input.select();
    }

    updateAdjustmentDeltaDisplay(part.qty_on_hand);
  } catch (err) {
    alert('Error loading adjustment form: ' + err.message);
  }
}

function updateAdjustmentDeltaDisplay(currentQty) {
  const newQtyInput = document.getElementById('adjNewQty');
  const deltaDisplay = document.getElementById('adjDeltaDisplay');
  if (!newQtyInput || !deltaDisplay) return;
  const newQty = parseInt(newQtyInput.value, 10);
  if (isNaN(newQty)) {
    deltaDisplay.textContent = '-';
    deltaDisplay.style.color = 'var(--text-dim)';
    return;
  }
  const delta = newQty - currentQty;
  if (delta > 0) {
    deltaDisplay.textContent = `+${delta}`;
    deltaDisplay.style.color = 'var(--accent-emerald)';
  } else if (delta < 0) {
    deltaDisplay.textContent = `${delta}`;
    deltaDisplay.style.color = 'var(--accent-crimson)';
  } else {
    deltaDisplay.textContent = '0';
    deltaDisplay.style.color = 'var(--text-dim)';
  }
}

async function submitAdjustStock(event, partId) {
  event.preventDefault();
  try {
    const newQtyInput = document.getElementById('adjNewQty');
    const reasonSelect = document.getElementById('adjReason');
    const notesInput = document.getElementById('adjNotes');
    if (!newQtyInput || !reasonSelect || !notesInput) return;

    const newQty = parseInt(newQtyInput.value, 10);
    const reason_code = reasonSelect.value;
    const notes = notesInput.value.trim();

    if (!notes) {
      alert('AUDIT NOTES ARE MANDATORY FOR QUANTITY ADJUSTMENTS.');
      return;
    }

    const partRes = await api(`/api/parts/${partId}`);
    const currentQty = partRes.part.qty_on_hand;
    const qty_change = newQty - currentQty;

    if (qty_change === 0) {
      alert('NO QUANTITY CHANGE SPECIFIED.');
      return;
    }

    await api('/api/parts/adjust', {
      method: 'POST',
      body: JSON.stringify({
        part_id: partId,
        qty_change: qty_change,
        reason_code: reason_code,
        notes: notes
      })
    });

    alert('STOCK ADJUSTED SUCCESSFULLY.');
    openPartsDetail(partId);
  } catch (err) {
    alert('Adjustment error: ' + err.message);
  }
}

// --- PART TRANSACTION HISTORY DETAIL ---
async function openPartsDetail(partId) {
  cancelPendingPartsSearch();
  try {
    const response = await api(`/api/parts/${partId}`);
    const part = response.part;
    window.currentLoadedPart = part;
    window.currentViewingPartId = part.id;
    const container = document.getElementById('partsResults');
    if (!container) return;

    container.innerHTML = `
      <div style="background:var(--surface-panel); border:1px solid var(--border-mid); padding:16px; border-radius:4px; font-family:var(--font-mono);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; border-bottom:1px solid var(--border-mid); padding-bottom:10px;">
          <div>
            <h3 style="margin:0; font-size:16px; color:var(--accent-amber);">
              ${part.line_code ? `<span style="background:var(--accent-amber); color:var(--surface-input); font-weight:800; padding:2px 6px; border-radius:2px; margin-right:6px;">${escapeHtml(part.line_code)}</span>` : ''}
              ${escapeHtml(part.part_number)} — ${escapeHtml(part.description)}
            </h3>
            <div class="ui-copy-muted" style="margin-top:4px;">CATEGORY: <strong>${escapeHtml(part.category)}</strong> · HOME BIN: <strong>${escapeHtml(part.home_bin)}</strong> · VENDOR: <strong>${escapeHtml(part.supplier_name || 'NONE')}</strong></div>
            <div class="ui-copy-muted" style="margin-top:2px;">LAST COST: <strong>$${part.cost_price ? part.cost_price.toFixed(2) : '0.00'}</strong> (${escapeHtml(part.last_cost_date || 'INITIAL')}) · AVERAGE COST: <strong>$${part.average_cost ? part.average_cost.toFixed(2) : '0.00'}</strong></div>
            ${part.interchange_number ? `<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">ALTERNATE / INTERCHANGE PART NUMBERS: <strong class="u-text-amber">${escapeHtml(part.interchange_number)}</strong></div>` : ''}
          </div>
          <div class="ui-row-8">
            <button class="secondary-action-btn" data-command="parts.back">${UIComponent.Keycap('ESC', 'command')} BACK TO PARTS</button>
            <button class="primary-action-btn" data-command="parts.apply_ro">${UIComponent.Keycap('ALT+O', 'inverse', {className: 'kbd-invert'})} APPLY TO RO</button>
            <button class="secondary-action-btn" data-command="parts.edit_details">${UIComponent.Keycap('ALT+E', 'command')} EDIT PART DETAILS</button>
            <button class="secondary-action-btn" data-command="parts.counter_sale">${UIComponent.Keycap('ALT+I', 'command')} ${window.activeCounterSale ? '+ ADD TO OPEN INVOICE' : 'COUNTER SALE'}</button>
            <button class="secondary-action-btn" data-command="parts.adjust_qty">${UIComponent.Keycap('ALT+Q', 'command')} ADJUST QTY</button>
            <button class="secondary-action-btn" data-command="parts.breakout">${UIComponent.Keycap('ALT+B', 'command')} BREAKOUT</button>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:12px; margin-bottom:16px; background:var(--surface-input); padding:12px; border-radius:4px; border:1px solid var(--border-mid);">
          <div><span class="ui-label-dim">ON HAND:</span> <strong style="color:var(--text-main); font-size:14px;">${part.qty_on_hand}</strong></div>
          <div><span class="ui-label-dim">RESERVED:</span> <strong style="color:var(--accent-steel); font-size:14px;">${part.qty_reserved}</strong></div>
          <div><span class="ui-label-dim">AVAILABLE:</span> <strong style="color:var(--accent-emerald); font-size:16px; font-weight:800;">${part.qty_available}</strong></div>
          <div><span class="ui-label-dim">REORDER POINT:</span> <strong style="color:var(--accent-amber); font-size:14px;">${part.reorder_point}</strong> (QTY: ${part.reorder_qty})</div>
        </div>

        <h4 style="margin:0 0 8px 0; font-size:12px; color:var(--text-main);">ACTIVE RO RESERVATIONS</h4>
        <table style="width:100%; border-collapse:collapse; font-size:10px; background:var(--surface-subtle); margin-bottom:16px; border-radius:4px; overflow:hidden;">
          <thead>
            <tr style="background:var(--surface-input); color:var(--text-muted); text-align:left;">
              <th class="ui-cell-tight">RO</th>
              <th class="ui-cell-tight-right">REQUESTED</th>
              <th class="ui-cell-tight-right">PHYSICALLY COVERED</th>
              <th class="ui-cell-tight-right">SHORT</th>
              <th class="ui-cell-tight">STATUS</th>
            </tr>
          </thead>
          <tbody>
            ${part.reservations && part.reservations.length ? part.reservations.map(reservation => {
              const shortQty = Math.max(0, reservation.requested_qty - reservation.fulfilled_qty);
              const isShort = shortQty > 0 || reservation.status === 'SHORT';
              return `
                <tr style="border-bottom:1px solid var(--border-soft); ${isShort ? 'background:rgba(var(--accent-crimson-rgb),0.12);' : ''}">
                  <td style="padding:6px 8px; color:var(--accent-steel); font-weight:700;">${escapeHtml(reservation.ro_number)}</td>
                  <td class="ui-cell-tight-right">${reservation.requested_qty}</td>
                  <td class="ui-cell-tight-right">${reservation.fulfilled_qty}</td>
                  <td style="padding:6px 8px; text-align:right; color:${isShort ? 'var(--accent-crimson)' : 'var(--text-muted)'}; font-weight:700;">${shortQty}</td>
                  <td style="padding:6px 8px; color:${isShort ? 'var(--accent-crimson)' : 'var(--accent-emerald)'}; font-weight:700;">${escapeHtml(reservation.status)}</td>
                </tr>`;
            }).join('') : '<tr><td colspan="5" style="padding:10px; text-align:center; color:var(--text-muted);">NO ACTIVE RO RESERVATIONS.</td></tr>'}
          </tbody>
        </table>

        <h4 style="margin:0 0 8px 0; font-size:12px; color:var(--text-main);">PERMANENT TRANSACTION LEDGER AUDIT TRAIL</h4>
        <table style="width:100%; border-collapse:collapse; font-size:10px; background:var(--surface-subtle); border-radius:4px; overflow:hidden;">
          <thead>
            <tr style="background:var(--surface-input); color:var(--text-muted); text-align:left;">
              <th class="ui-cell-tight">TIMESTAMP</th>
              <th class="ui-cell-tight">TYPE</th>
              <th class="ui-cell-tight-right">CHANGE</th>
              <th class="ui-cell-tight-right">PREV</th>
              <th class="ui-cell-tight-right">NEW</th>
              <th class="ui-cell-tight">REF TYPE</th>
              <th class="ui-cell-tight">REF ID</th>
              <th class="ui-cell-tight">REASON / NOTES</th>
              <th class="ui-cell-tight">ACTOR</th>
            </tr>
          </thead>
          <tbody>
            ${part.transactions && part.transactions.length ? part.transactions.map(tx => `
              <tr style="border-bottom:1px solid var(--border-soft);">
                <td style="padding:6px 8px; color:var(--text-dim);">${escapeHtml(tx.created_at.replace('T', ' ').substring(0, 19))}</td>
                <td class="ui-cell-tight"><strong class="u-text-amber">${escapeHtml(tx.transaction_type.toUpperCase())}</strong></td>
                <td style="padding:6px 8px; text-align:right; font-weight:700; color:${tx.qty_change >= 0 ? 'var(--accent-emerald)' : 'var(--accent-crimson)'};">${tx.qty_change > 0 ? '+' : ''}${tx.qty_change}</td>
                <td style="padding:6px 8px; text-align:right; color:var(--text-dim);">${tx.previous_qty}</td>
                <td style="padding:6px 8px; text-align:right; font-weight:700; color:var(--text-main);">${tx.new_qty}</td>
                <td style="padding:6px 8px; color:var(--text-muted);">${escapeHtml(tx.reference_type)}</td>
                <td style="padding:6px 8px; color:var(--accent-steel); font-weight:700;">${escapeHtml(tx.reference_id || '—')}</td>
                <td style="padding:6px 8px; color:var(--text-main);">${escapeHtml(tx.reason_code || '')} ${escapeHtml(tx.notes || '')}</td>
                <td style="padding:6px 8px; color:var(--text-muted);">${escapeHtml(tx.actor_name || 'SYSTEM')}</td>
              </tr>
            `).join('') : '<tr><td colspan="9" style="padding:12px; text-align:center; color:var(--text-muted);">NO TRANSACTIONS RECORDED FOR THIS ITEM.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    alert('Error fetching part detail: ' + err.message);
  }
}

async function openEditPartDetails(partIdOrPart) {
  cancelPendingPartsSearch();
  try {
    let part = (typeof partIdOrPart === 'object' && partIdOrPart) ? partIdOrPart : null;
    if (!part && window.currentLoadedPart && (partIdOrPart === undefined || window.currentLoadedPart.id === Number(partIdOrPart))) {
      part = window.currentLoadedPart;
    }
    if (!part) {
      const response = await api(`/api/parts/${partIdOrPart}`);
      part = response.part;
    }
    window.currentViewingPartId = part.id;
    const container = document.getElementById('partsResults');
    if (!container) return;

    container.innerHTML = `
      <div class="edit-part-details-subview" style="background:var(--surface-panel); border:1px solid var(--border-mid); padding:16px; border-radius:4px; font-family:var(--font-mono);">
        <form id="editPartDetailsForm" data-submit-action="parts.edit-submit" data-action-param="${part.id}" data-submit-hotkey="ALT+S">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; border-bottom:1px solid var(--border-mid); padding-bottom:10px;">
            <div>
              <h3 style="margin:0; font-size:16px; color:var(--accent-amber);">
                ${part.line_code ? `<span style="background:var(--accent-amber); color:var(--surface-input); font-weight:800; padding:2px 6px; border-radius:2px; margin-right:6px;">${escapeHtml(part.line_code)}</span>` : ''}
                EDIT PART DETAILS — ${escapeHtml(part.part_number)}
              </h3>
              <div class="ui-copy-muted" style="margin-top:4px;">${escapeHtml(part.description)}</div>
            </div>
            <span class="ui-label-dim">PRESS ${UIComponent.Keycap('ESC', 'command')} TO CANCEL</span>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px; background:var(--surface-input); padding:14px; border-radius:4px; border:1px solid var(--border-mid);">
            <div>
              <label class="ui-label-dim">HOME BIN *</label>
              <input id="editHomeBin" class="field-input" style="width:100%; margin-top:4px;" value="${escapeHtml(part.home_bin || 'UNASSIGNED')}" required autofocus>
            </div>
            <div>
              <label class="ui-label-dim">ALTERNATE / INTERCHANGE PART NUMBERS</label>
              <input id="editInterchange" class="field-input" style="width:100%; margin-top:4px;" value="${escapeHtml(part.interchange_number || '')}" placeholder="e.g. 0W20-SYN, W712/95">
            </div>
          </div>

          <div style="display:flex; justify-content:flex-end; gap:10px;">
            <button type="button" class="secondary-action-btn ui-button-compact" data-action="parts.detail" data-action-param="${part.id}">CANCEL</button>
            <button type="submit" class="primary-action-btn ui-button-compact action-emerald">${UIComponent.Keycap('ALT+S', 'inverse', {className: 'kbd-invert'})} SAVE DETAILS</button>
          </div>
        </form>
      </div>
    `;

    if (window.EditorStack) {
      window.EditorStack.register('editPartDetailsEditor', {
        cancelFn: () => openPartsDetail(part.id),
        getNormalizedSnapshot: () => {
          const bin = (document.getElementById('editHomeBin')?.value || '').trim().toUpperCase();
          const interchange = (document.getElementById('editInterchange')?.value || '').trim().toUpperCase();
          return JSON.stringify({ bin, interchange });
        }
      });
    }
  } catch (err) {
    alert('Error loading part for editing: ' + err.message);
  }
}

async function submitEditPartDetails(event, partId) {
  event.preventDefault();
  const homeBin = (document.getElementById('editHomeBin')?.value || '').trim().toUpperCase() || 'UNASSIGNED';
  const interchange = (document.getElementById('editInterchange')?.value || '').trim().toUpperCase();

  try {
    const response = await api(`/api/parts/${partId}/metadata`, {
      method: 'POST',
      body: JSON.stringify({
        home_bin: homeBin,
        interchange_number: interchange
      })
    });

    if (window.EditorStack?.activeEditor?.id === 'editPartDetailsEditor') {
      window.EditorStack.reset();
    }

    delete window.currentLoadedPart;
    await openPartsDetail(partId);
  } catch (err) {
    if (window.FeedbackManager) {
      window.FeedbackManager.toast('Failed to save part details: ' + err.message, 'error');
    } else {
      console.error('Failed to save part details:', err);
    }
  }
}

// --- RO WRITE-UP / INVOICING INVENTORY PART SELECTION MODAL ---
let roPartSearchTimer = null;

function openRoAddPartModal() {
  const existing = document.getElementById('roPartSearchModalOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'roPartSearchModalOverlay';
  overlay.className = 'ui-modal-overlay ui-modal-overlay--top';

  overlay.innerHTML = `
    <div class="ui-modal-dialog ui-modal-dialog--parts">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-mid); padding-bottom:10px; margin-bottom:14px;">
        <div>
          <strong class="ui-heading-amber">INVENTORY LOOKUP — SELECT PART TO ADD TO RO WRITE-UP</strong>
          <div style="font-size:10px; color:var(--text-dim); margin-top:2px;">SEARCH BY PART #, DESCRIPTION, BIN, OR SUPPLIER</div>
        </div>
        <button class="secondary-action-btn" data-action="parts.lookup-close">${UIComponent.Keycap('ESC', 'command')} CLOSE</button>
      </div>

      <input id="roPartSearchInput" type="text" placeholder="Type Part #, Description, or Bin (e.g. 90915, BIN-A12)..." style="width:100%; padding:10px 12px; font-size:12px; border-radius:4px; margin-bottom:14px;" data-input-action="parts.lookup-search" autocomplete="off">

      <div id="roPartSearchModalResults" style="flex:1; overflow-y:auto; max-height:420px; background:var(--surface-input); border:1px solid var(--border-mid); border-radius:4px;"></div>
    </div>
  `;

  document.body.appendChild(overlay);
  if (window.ModalStack) {
    window.ModalStack.open('roPartSearchModalOverlay', {
      modalEl: overlay,
      openerEl: document.activeElement,
      closeFn: closeRoPartSearchModal
    });
  }

  requestAnimationFrame(() => {
    const input = document.getElementById('roPartSearchInput');
    if (input) input.focus();
    searchRoPartsModal('');
  });
}

function closeRoPartSearchModal() {
  const modal = document.getElementById('roPartSearchModalOverlay');
  if (modal) modal.remove();
  if (window.ModalStack) window.ModalStack.cleanStaleEntries();
}

function queueRoPartSearch(query) {
  clearTimeout(roPartSearchTimer);
  roPartSearchTimer = setTimeout(() => searchRoPartsModal(query), 150);
}

async function searchRoPartsModal(query = '') {
  const resultsEl = document.getElementById('roPartSearchModalResults');
  if (!resultsEl) return;

  try {
    const res = await api(`/api/parts?q=${encodeURIComponent(query.trim())}`);
    const parts = res.parts || [];

    if (!parts.length) {
      resultsEl.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted); font-size:11px;">NO INVENTORY PARTS FOUND MATCHING QUERY.</div>';
      return;
    }

    const isCounterSale = !!document.getElementById('counterSaleForm');

    resultsEl.innerHTML = `
      <table style="width:100%; border-collapse:collapse; font-size:11px;">
        <thead>
          <tr class="ui-table-head">
            <th style="padding:8px 10px; width:110px;">PART #</th>
            <th class="ui-cell">DESCRIPTION</th>
            <th style="padding:8px 10px; width:90px;">BIN</th>
            <th style="padding:8px 10px; text-align:right; width:70px;">AVAIL</th>
            <th style="padding:8px 10px; text-align:right; width:80px;">RETAIL ($)</th>
            <th style="padding:8px 10px; text-align:center; width:120px;">ACTION</th>
          </tr>
        </thead>
        <tbody>
          ${parts.map(p => `
            <tr style="border-bottom:1px solid var(--border-soft);">
              <td class="ui-cell"><strong class="u-text-amber">${escapeHtml(p.part_number)}</strong></td>
              <td style="padding:8px 10px; color:var(--text-main);">${escapeHtml(p.description)}</td>
              <td class="ui-cell"><span style="background:var(--surface-raised); color:var(--text-muted); padding:2px 5px; border-radius:2px; font-size:10px;">${escapeHtml(p.home_bin)}</span></td>
              <td style="padding:8px 10px; text-align:right; font-weight:800; color:var(--accent-emerald);">${p.qty_available}</td>
              <td style="padding:8px 10px; text-align:right; font-weight:700; color:var(--accent-amber);">$${p.retail_price.toFixed(2)}</td>
              <td class="ui-cell-center">
                ${isCounterSale ?
                  `<button type="button" class="secondary-action-btn action-compact" data-action="parts.counter-select" data-action-param="${p.id}">+ SELECT PART</button>` :
                  `<button type="button" class="primary-action-btn action-compact" data-action="parts.ro-confirm" data-action-param="${p.id}">+ ADD TO RO</button>`
                }
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    resultsEl.innerHTML = `<div style="padding:16px; color:var(--accent-crimson); font-size:11px;">${escapeHtml(err.message)}</div>`;
  }
}

async function confirmAddPartToRo(partId) {
  try {
    if (typeof activeEditingRoId === 'undefined' || !activeEditingRoId) {
      alert('SAVE THE REPAIR ORDER BEFORE RESERVING INVENTORY PARTS.');
      return;
    }
    const activeRo = (typeof activeRoList !== 'undefined' ? activeRoList : [])
      .find(ro => ro.id === activeEditingRoId);
    if (!activeRo?.ro) {
      alert('THE SAVED REPAIR ORDER COULD NOT BE FOUND. SAVE OR REOPEN THE RO AND TRY AGAIN.');
      return;
    }
    const res = await api(`/api/parts/${partId}`);
    const part = res.part;

    // Get current job lines in the DOM
    const rows = [...document.querySelectorAll('#roLinesWorkspaceBody tr')];
    const jobLines = rows.map((row, index) => {
      const opCode = row.querySelector('.ro-opcode-input')?.value.trim() || '';
      const concern = row.querySelector('.ro-concern-input')?.value.trim() || '';
      return {
        index: row.dataset.lineId || index,
        label: `Line ${index + 1}: ${opCode ? opCode + ' — ' : ''}${concern.substring(0, 45)}${concern.length > 45 ? '...' : ''}`
      };
    });

    // Create confirmation UI overlay
    const existingConfirm = document.getElementById('roPartConfirmOverlay');
    if (existingConfirm) existingConfirm.remove();

    const confirmOverlay = document.createElement('div');
    confirmOverlay.id = 'roPartConfirmOverlay';
    confirmOverlay.className = 'ui-modal-overlay ui-modal-overlay--top';
    confirmOverlay.style.zIndex = '200'; // Sits on top of lookup modal

    const optionsHtml = jobLines.map(line =>
      `<option value="${line.index}">${escapeHtml(line.label)}</option>`
    ).join('');

    confirmOverlay.innerHTML = `
      <div class="ui-modal-dialog" style="max-width: 480px; border:1px solid var(--accent-amber); background:var(--bg-card); padding:16px; border-radius:4px; font-family:var(--font-mono);">
        <div style="border-bottom:1px solid var(--border-mid); padding-bottom:8px; margin-bottom:12px;">
          <strong class="ui-heading-amber">ALLOCATE PART TO RO JOB LINE</strong>
          <div style="font-size:10px; color:var(--text-dim); margin-top:2px;">${escapeHtml(part.part_number)} — ${escapeHtml(part.description)}</div>
        </div>
        
        <form id="roPartConfirmForm" data-submit-hotkey="ALT+S" data-submit-action="parts.ro-allocate" data-action-param="${part.id}" data-ro-number="${escapeHtml(activeRo.ro)}">
          <div style="margin-bottom:12px;">
            <label class="field-label">QTY TO ALLOCATE *</label>
            <input type="number" id="allocQty" required min="1" max="${part.qty_on_hand - part.qty_reserved || 99}" value="1" style="width:100%; padding:6px 8px; font-size:12px;" autofocus>
          </div>
          <div style="margin-bottom:14px;">
            <label class="field-label">SELECT JOB LINE *</label>
            <select id="allocJobLine" required style="width:100%; border:1px solid var(--border-mid); background:var(--surface-input); color:var(--text-main); padding:6px 8px; font-size:11px;">
              <option value="NEW">- CREATE NEW JOB LINE -</option>
              ${optionsHtml}
            </select>
          </div>
          <div class="ui-actions-end">
            <button type="button" class="secondary-action-btn" data-action="parts.close-overlay" data-action-param="roPartConfirmOverlay">${UIComponent.Keycap('ESC', 'command')} CANCEL</button>
            <button type="submit" class="primary-action-btn">${UIComponent.Keycap('ALT+S', 'inverse', {className: 'kbd-invert'})} ALLOCATE PART</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(confirmOverlay);

    // Focus quantity input
    requestAnimationFrame(() => {
      document.getElementById('allocQty')?.focus();
    });

  } catch (err) {
    alert(err.message);
  }
}

async function submitRoPartAllocation(event, partId, roNumber) {
  event.preventDefault();
  const qty = parseInt(document.getElementById('allocQty').value, 10);
  const targetLineVal = document.getElementById('allocJobLine').value;

  try {
    const res = await api(`/api/parts/${partId}`);
    const part = res.part;
    const unreserved = part.qty_on_hand - part.qty_reserved;
    if (qty > unreserved) {
      alert(`CANNOT ALLOCATE ${qty} UNITS. ONLY ${unreserved} UNRESERVED UNITS AVAILABLE.`);
      return;
    }

    // Persist current edits, then confirm billing and reserve stock in one operation.
    await saveRepairOrder();
    await api('/api/repair-orders/apply-part', {
      method: 'POST',
      body: JSON.stringify({ part_id: partId, qty, ro_number: roNumber, job_line: targetLineVal })
    });
    await loadRepairOrders();
    await openRoWriteupForEdit(activeEditingRoId);

    // Close overlays
    const confirmOverlay = document.getElementById('roPartConfirmOverlay');
    if (confirmOverlay) confirmOverlay.remove();
    closeRoPartSearchModal();

  } catch (err) {
    alert('Allocation failed: ' + err.message);
  }
}


function selectPartForCounterSale(partId) {
  closeRoPartSearchModal();
  openPartsInvoiceCounterSaleModal(partId);
}

function handlePartsEscBackStep() {
  const modalOverlay = document.getElementById('roPartSearchModalOverlay');
  if (modalOverlay) {
    modalOverlay.remove();
    return true;
  }

  const container = document.getElementById('partsResults');
  if (!container) return false;

  const hasSubForm = container.querySelector('#receiveStockForm, #counterSaleForm, #applyToRoForm, #adjustStockForm');
  const isDetailView = container.innerHTML.includes('PERMANENT TRANSACTION LEDGER AUDIT TRAIL') || container.innerHTML.includes('BIN CYCLE COUNT WORKSPACE');

  if (hasSubForm || isDetailView) {
    searchParts('');
    return true;
  }

  return false;
}

const STANDARD_PART_CATEGORIES = [
  'OIL & FLUIDS',
  'FILTERS',
  'BRAKES & WHEEL',
  'STEERING & SUSPENSION',
  'IGNITION & ELECTRICAL',
  'ENGINE & COOLING',
  'TRANSMISSION & DRIVETRAIN',
  'EXHAUST & EMISSIONS',
  'TIRES & WHEELS',
  'HARDWARE & SHOP SUPPLIES',
  'BUY-IN / SPECIAL ORDER'
];

function openNewStockPartModal() {
  openNewPartModal('STOCK');
}

function openNewPassThroughPartModal() {
  openNewPartModal('PASSTHROUGH');
}

async function openNewPartModal(defaultType = 'STOCK') {
  const existing = document.getElementById('newPartModalOverlay');
  if (existing) existing.remove();

  const isPass = defaultType === 'PASSTHROUGH';
  let vendors = [];
  try {
    const vRes = await api('/api/vendors');
    vendors = vRes.vendors || [];
  } catch (e) {}

  const overlay = document.createElement('div');
  overlay.id = 'newPartModalOverlay';
  overlay.className = 'ui-modal-overlay';
  overlay.innerHTML = `
    <div class="ui-modal-dialog ui-modal-dialog--parts" style="width:720px;">
      <div class="ui-modal-header">
        <strong class="ui-copy"><span class="u-text-amber">${isPass ? 'ADD NEW PASS-THROUGH BUY-IN PART (ALT+P)' : 'ADD NEW STOCK INVENTORY PART (ALT+A)'}</span></strong>
        <span class="ui-label-dim">PRESS ${UIComponent.Keycap('ESC', 'command')} TO CANCEL</span>
      </div>
      
      <div style="display:flex; flex-direction:column; gap:12px; margin-top:8px;">
        <div style="display:flex; gap:10px; background:var(--surface-raised); padding:8px; border-radius:4px; border:1px solid var(--border-mid);">
          <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; font-size:11px; font-weight:700;">
            <input type="radio" name="newPartType" value="STOCK" ${!isPass ? 'checked' : ''} data-change-action="parts.new-type" data-action-param="STOCK">
            <span>STOCK INVENTORY SKU (FULL CATALOG ITEM)</span>
          </label>
          <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; font-size:11px; font-weight:700;">
            <input type="radio" name="newPartType" value="PASSTHROUGH" ${isPass ? 'checked' : ''} data-change-action="parts.new-type" data-action-param="PASSTHROUGH">
            <span class="u-text-amber">PASS-THROUGH / BUY-IN PART (SPECIAL ORDER)</span>
          </label>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1.5fr 1.2fr; gap:10px;">
          <div>
            <label class="ui-label-dim">LINE CODE / MAKE</label>
            <input id="npLineCode" class="control-full" placeholder="e.g. LMY, ACD, WIX" autocomplete="off">
          </div>
          <div>
            <label class="ui-label-dim">PART NUMBER *</label>
            <input id="npPartNumber" class="control-full" placeholder="e.g. LM2259, PF64" autocomplete="off" autofocus>
          </div>
          <div>
            <label class="ui-label-dim">CATEGORY *</label>
            <select id="npCategory" class="field-input control-full" style="padding:6px 8px;">
              ${STANDARD_PART_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
            </select>
          </div>
        </div>

        <div>
          <label class="ui-label-dim">DESCRIPTION *</label>
          <input id="npDescription" class="control-full" placeholder="e.g. LIQUI MOLY SPECIAL TEC AA MOTOR OIL 5W20 5L" autocomplete="off">
        </div>

        <div style="display:grid; grid-template-columns:1.5fr 1fr 1fr 1fr; gap:10px;">
          <div>
            <label class="ui-label-dim">PREFERRED VENDOR</label>
            <select id="npVendor" class="field-input control-full" style="padding:6px 8px;">
              <option value="">SELECT VENDOR...</option>
              ${vendors.map(v => `<option value="${v.id}">${escapeHtml(v.vendor_name)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="ui-label-dim">COST PRICE ($)</label>
            <input id="npCost" type="number" step="0.01" min="0" class="control-full" placeholder="0.00">
          </div>
          <div>
            <label class="ui-label-dim">RETAIL PRICE ($)</label>
            <input id="npRetail" type="number" step="0.01" min="0" class="control-full" placeholder="0.00">
          </div>
          <div id="npBinContainer">
            <label class="ui-label-dim">HOME BIN *</label>
            <input id="npHomeBin" class="control-full" placeholder="e.g. BIN-A12" value="BIN-A1">
          </div>
        </div>

        <div>
          <label class="ui-label-dim">ALTERNATE / INTERCHANGE PART NUMBERS (COMMA SEPARATED)</label>
          <input id="npInterchange" class="control-full" placeholder="e.g. 2259, 2044, 22002, WIX-51056" autocomplete="off">
        </div>

        <div id="npStockQtyRow" style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div>
            <label class="ui-label-dim">INITIAL STOCK QTY</label>
            <input id="npQtyOnHand" type="number" min="0" class="control-full" value="0">
          </div>
          <div>
            <label class="ui-label-dim">MIN REORDER THRESHOLD</label>
            <input id="npMinReorder" type="number" min="0" class="control-full" value="2">
          </div>
        </div>

        <div id="npPassThroughNote" class="ui-label-dim hidden" style="background:rgba(var(--accent-amber-rgb),0.12); padding:8px 10px; border-radius:3px; border:1px solid var(--border-bright); color:var(--accent-amber);">
          ℹ️ PASS-THROUGH PART: Will not clog catalog stock inventory ledger. Used for direct job allocation &amp; custom supplier orders.
        </div>

        <div class="ui-actions-end" style="margin-top:10px;">
          <button type="button" class="secondary-action-btn" data-action="parts.close-overlay" data-action-param="newPartModalOverlay">CANCEL</button>
          <button type="button" class="positive-action-btn" data-action="parts.new-save">${UIComponent.Keycap('ALT+S', 'inverse', {className: 'kbd-invert'})} SAVE PART</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      overlay.remove();
    } else if (e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveNewPart();
    }
  });

  setTimeout(() => {
    const input = document.getElementById('npPartNumber');
    if (input) input.focus();
  }, 50);
}

function toggleNewPartType(type) {
  const isPass = type === 'PASSTHROUGH';
  const binContainer = document.getElementById('npBinContainer');
  const stockQtyRow = document.getElementById('npStockQtyRow');
  const note = document.getElementById('npPassThroughNote');

  if (binContainer) binContainer.style.opacity = isPass ? '0.4' : '1';
  if (stockQtyRow) stockQtyRow.style.display = isPass ? 'none' : 'grid';
  if (note) note.classList.toggle('hidden', !isPass);
}

async function saveNewPart() {
  const lineCode = document.getElementById('npLineCode')?.value.trim();
  const partNumber = document.getElementById('npPartNumber')?.value.trim();
  const description = document.getElementById('npDescription')?.value.trim();
  const category = document.getElementById('npCategory')?.value.trim() || 'OIL & FLUIDS';
  const vendorSelect = document.getElementById('npVendor');
  const vendorId = vendorSelect?.value ? parseInt(vendorSelect.value, 10) : null;
  const supplierName = vendorSelect?.options[vendorSelect.selectedIndex]?.text || '';
  const cost = parseFloat(document.getElementById('npCost')?.value || '0');
  const retail = parseFloat(document.getElementById('npRetail')?.value || '0');
  const interchange = document.getElementById('npInterchange')?.value.trim();
  const isPassThrough = document.querySelector('input[name="newPartType"]:checked')?.value === 'PASSTHROUGH';
  const homeBin = isPassThrough ? 'DIRECT-PASS' : (document.getElementById('npHomeBin')?.value.trim() || 'BIN-A1');
  const qtyOnHand = isPassThrough ? 0 : parseInt(document.getElementById('npQtyOnHand')?.value || '0', 10);
  const minReorder = isPassThrough ? 0 : parseInt(document.getElementById('npMinReorder')?.value || '0', 10);

  if (!partNumber || !description) {
    alert('PART NUMBER AND DESCRIPTION ARE REQUIRED.');
    return;
  }

  try {
    await api('/api/parts', {
      method: 'POST',
      body: JSON.stringify({
        line_code: lineCode,
        part_number: partNumber,
        description: description,
        category: category,
        preferred_vendor_id: vendorId,
        supplier_name: supplierName !== 'SELECT VENDOR...' ? supplierName : '',
        cost_price: cost,
        retail_price: retail,
        home_bin: homeBin,
        interchange_number: interchange,
        qty_on_hand: qtyOnHand,
        min_reorder_qty: minReorder,
        is_pass_through: isPassThrough ? 1 : 0
      })
    });

    document.getElementById('newPartModalOverlay')?.remove();
    searchParts(partNumber);
  } catch (err) {
    alert('ERROR SAVING PART: ' + err.message);
  }
}

function closeBulkBreakoutModal() {
  if (window.ModalStack && window.ModalStack.stack.some(m => m.id === 'bulkBreakoutOverlay')) {
    return window.ModalStack.close('bulkBreakoutOverlay');
  }
  const existing = document.getElementById('bulkBreakoutOverlay');
  if (existing) existing.remove();
}

function openBulkBreakoutModal(partId) {
  closeBulkBreakoutModal();

  const part = partsSearchResults.find(p => p.id === partId) || (window.currentViewingPartId === partId ? { id: partId } : null);
  const parentPartNo = part?.part_number || 'CONTAINER';

  const overlay = document.createElement('div');
  overlay.id = 'bulkBreakoutOverlay';
  overlay.className = 'ui-modal-overlay';
  overlay.innerHTML = `
    <form id="bulkBreakoutForm" data-submit-hotkey="ALT+S" data-submit-action="parts.split-submit" data-action-param="${partId}" class="ui-modal-dialog" style="width:580px;">
      <div class="ui-modal-header">
        <strong class="ui-copy"><span class="u-text-amber">BREAK OUT BULK CONTAINER INTO PER-UNIT CHILD SKU</span></strong>
        <span class="ui-label-dim">PRESS ${UIComponent.Keycap('ESC', 'command')} TO CANCEL</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:12px; margin-top:10px;">
        <div style="font-size:11px; color:var(--text-muted); background:var(--surface-raised); padding:8px 10px; border-radius:4px; border:1px solid var(--border-mid);">
          ℹ️ Breakdown parent container into per-unit child inventory item (e.g. 5L jug into per-Liter / L child SKU).
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div>
            <label class="ui-label-dim">NEW CHILD PART # *</label>
            <input id="bbChildPartNo" class="control-full" value="${parentPartNo}-1L" placeholder="e.g. LM2259-1L" required autofocus>
          </div>
          <div>
            <label class="ui-label-dim">CONTAINER YIELD QTY (UNITS PER CONTAINER) *</label>
            <input id="bbYieldQty" type="number" step="1" min="1" value="5" class="control-full" required>
          </div>
        </div>

        <div>
          <label class="ui-label-dim">CHILD DESCRIPTION *</label>
          <input id="bbChildDesc" class="control-full" value="${escapeHtml(part?.description || '')} (PER LITER)" placeholder="e.g. LIQUI MOLY 5W20 1L PER-UNIT" required>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div>
            <label class="ui-label-dim">UNIT RETAIL PRICE ($)</label>
            <input id="bbChildRetail" type="number" step="0.01" min="0" value="${((part?.cost_price || 40) / 5 * 1.5).toFixed(2)}" class="control-full" placeholder="0.00" required>
          </div>
          <div>
            <label class="ui-label-dim">UNIT OF MEASURE</label>
            <input id="bbUom" class="control-full" placeholder="e.g. L, QT, GAL" value="L">
          </div>
        </div>

        <div class="ui-actions-end" style="margin-top:10px;">
          <button type="button" class="secondary-action-btn ui-button-compact" data-action="parts.split-close">CANCEL</button>
          <button type="submit" class="primary-action-btn ui-button-compact action-emerald">${UIComponent.Keycap('ALT+S', 'inverse', {className: 'kbd-invert'})} CREATE CHILD PER-UNIT SKU</button>
        </div>
      </div>
    </form>
  `;
  document.body.appendChild(overlay);

  const opener = document.activeElement;
  if (window.ModalStack) {
    window.ModalStack.open('bulkBreakoutOverlay', {
      modalEl: overlay,
      openerEl: opener,
      closeFn: () => overlay.remove()
    });
  }
}

async function submitBulkBreakout(event, parentPartId) {
  event.preventDefault();
  try {
    const partNo = document.getElementById('bbChildPartNo').value.trim();
    const desc = document.getElementById('bbChildDesc').value.trim();
    const yieldQty = parseFloat(document.getElementById('bbYieldQty').value) || 5;
    const retail = parseFloat(document.getElementById('bbChildRetail').value) || 0;
    const uom = document.getElementById('bbUom').value.trim() || 'L';

    const res = await api(`/api/parts/${parentPartId}/breakout`, {
      method: 'POST',
      body: JSON.stringify({
        part_number: partNo,
        description: desc,
        unit_yield_qty: yieldQty,
        retail_price: retail,
        unit_of_measure: uom
      })
    });

    await closeBulkBreakoutModal();
    alert(`CHILD PER-UNIT SKU CREATED SUCCESSFULLY!\n\nPart Number: ${res.part.part_number}\nUnit Cost: $${res.part.cost_price.toFixed(2)}\nRetail Price: $${res.part.retail_price.toFixed(2)}`);
    searchParts(res.part.part_number);
  } catch (err) {
    alert('Breakout Error: ' + err.message);
  }
}

window.openPartsAdjustStockModal = openPartsAdjustStockModal;
window.updateAdjustmentDeltaDisplay = updateAdjustmentDeltaDisplay;
window.submitAdjustStock = submitAdjustStock;
window.confirmAddPartToRo = confirmAddPartToRo;
window.submitRoPartAllocation = submitRoPartAllocation;
window.openEditPartDetails = openEditPartDetails;
window.submitEditPartDetails = submitEditPartDetails;
window.openBulkBreakoutModal = openBulkBreakoutModal;
window.closeBulkBreakoutModal = closeBulkBreakoutModal;

if (window.WorkspaceLifecycle) {
  window.WorkspaceLifecycle.register('P', {
    getInitialState: () => ({
      query: '',
      page: 1,
      pageSize: 20,
      selectedId: null,
      activeRowIndex: 0
    }),
    mount: (container) => {
      container.setAttribute('data-workspace', 'parts');
    },
    load: async (state) => {
      if (typeof searchParts === 'function') {
        await searchParts(state.query || '');
      }
      return typeof activePartsCatalogList !== 'undefined' ? activePartsCatalogList : [];
    },
    render: () => {
      return typeof renderPartsCatalogContent === 'function' ? renderPartsCatalogContent() : '';
    },
    interact: () => {
      if (typeof updatePartsActiveRowHighlight === 'function') {
        updatePartsActiveRowHighlight();
      }
    },
    unmount: () => {
      // transient cleanup
    }
  });
}


document.addEventListener('DOMContentLoaded', () => {
  const actions = {
    'parts.page': (param) => changePartsCatalogPage(Number(param)),
    'parts.search': (_, element) => queuePartsSearch(element.value),
    'parts.search-key': (_, element, event) => handlePartsSearchKeydown(event),
    'parts.detail': (param) => openPartsDetail(Number(param)),
    'parts.receive': (param) => openPartsReceive(Number(param)),
    'parts.counter-item': (param) => selectCounterSaleItemByNumber(Number(param)),
    'parts.counter-qty': (param, element) => updateCounterSaleItemQty(Number(param), element.value),
    'parts.counter-price': (param, element) => updateCounterSaleItemPrice(Number(param), element.value),
    'parts.counter-remove': (param) => removeCounterSaleItem(Number(param)),
    'parts.counter-submit': (_, element, event) => submitCounterSale(event),
    'parts.counter-customer-search': (_, element) => onCsCustomerInput(element.value),
    'parts.counter-customer-key': (_, element, event) => onCsCustomerKeydown(event),
    'parts.payment-method': (_, element) => { window.activeCounterSale.paymentMethod = element.value; },
    'parts.counter-cancel': () => cancelCounterSaleSession(),
    'parts.counter-customer': (param) => selectCsCustomer(Number(param)),
    'parts.apply-submit': (param, element, event) => submitApplyToRo(event, Number(param)),
    'parts.ro-lines': (_, element) => updateRoJobLines(element.value),
    'parts.receive-submit': (param, element, event) => submitReceiveStock(event, Number(param)),
    'parts.adjust-submit': (param, element, event) => submitAdjustStock(event, Number(param)),
    'parts.adjust-delta': (param) => updateAdjustmentDeltaDisplay(Number(param)),
    'parts.lookup-close': () => closeRoPartSearchModal(),
    'parts.lookup-search': (_, element) => queueRoPartSearch(element.value),
    'parts.counter-select': (param) => selectPartForCounterSale(Number(param)),
    'parts.ro-confirm': (param) => confirmAddPartToRo(Number(param)),
    'parts.ro-allocate': (param, element, event) => submitRoPartAllocation(event, Number(param), element.dataset.roNumber),
    'parts.close-overlay': (param) => document.getElementById(param)?.remove(),
    'parts.new-type': (param) => toggleNewPartType(param),
    'parts.new-save': () => saveNewPart(),
    'parts.edit-submit': (param, element, event) => submitEditPartDetails(event, Number(param)),
    'parts.lookup-open': () => openRoAddPartModal(),
    'parts.split-submit': (param, element, event) => submitBulkBreakout(event, Number(param)),
    'parts.split-close': () => closeBulkBreakoutModal(),
  };
  for (const [name, handler] of Object.entries(actions)) {
    EventDelegator.registerAction(name, handler, { permission: 'parts' });
  }
});
