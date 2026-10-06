/** Shared opcode search and selection for RO and appointment editors. */
(() => {
const activeRows = new WeakMap();
const OP_CATEGORY_GROUPS = [
  { prefix: 'BR/', name: 'BRAKES & BRAKING SYSTEM', cat: 'BRAKES', genCode: 'BR/GEN', genConcern: 'BRAKE SYSTEM CONCERN / CUSTOM SERVICE' },
  { prefix: 'MA/', name: 'MAINTENANCE & SCHEDULED SERVICE', cat: 'MAINTENANCE', genCode: 'MA/GEN', genConcern: 'GENERAL MAINTENANCE / CUSTOM SERVICE' },
  { prefix: 'ST/', name: 'STEERING & LINKAGE', cat: 'STEERING', genCode: 'ST/GEN', genConcern: 'STEERING SYSTEM CONCERN / CUSTOM SERVICE' },
  { prefix: 'SU/', name: 'SUSPENSION & RIDE CONTROL', cat: 'SUSPENSION', genCode: 'SU/GEN', genConcern: 'SUSPENSION CONCERN / CUSTOM SERVICE' },
  { prefix: 'ENG/', name: 'ENGINE & DRIVETRAIN', cat: 'ENGINE', genCode: 'ENG/GEN', genConcern: 'ENGINE CONCERN / CUSTOM SERVICE' },
  { prefix: 'ELE/', name: 'ELECTRICAL & DIAGNOSTICS', cat: 'ELECTRICAL', genCode: 'ELE/GEN', genConcern: 'ELECTRICAL CONCERN / DIAGNOSIS' },
  { prefix: 'HVAC/', name: 'HEATING, VENTILATION & A/C', cat: 'HEATING & A/C', genCode: 'HVAC/GEN', genConcern: 'HVAC HEATING / AC SERVICE' },
  { prefix: 'TR/', name: 'TRANSMISSION & DIFFERENTIAL', cat: 'TRANSMISSION', genCode: 'TR/GEN', genConcern: 'TRANSMISSION CONCERN / SERVICE' }
];

function processOpcodeSearch(qInput, inputEl, dropdown) {
  const rawQ = qInput.trim().toUpperCase();
  activeRows.set(dropdown, 0);

  if (!rawQ) {
    dropdown.innerHTML = '';
    dropdown.classList.add('hidden');
    return;
  }

  // STAGE 1: User typed '/' alone -> Show Parent Groups List ONLY
  if (rawQ === '/') {
    dropdown.innerHTML = `
      <div class="opcode-menu-heading">
        PARENT JOB GROUPS (SELECT A GROUP WITH ARROWS + ENTER):
      </div>
      ${OP_CATEGORY_GROUPS.map((cat, idx) => {
        const isSel = idx === 0;
        return `
        <div class="opcode-item-row ${isSel ? 'is-active' : ''}" data-kind="group" data-prefix="${cat.prefix}" aria-selected="${isSel}" data-action="opcode.select-group" data-action-param="${escapeHtml(cat.prefix)}">
          <div>
            ${UIComponent.Keycap(cat.prefix, "index")}
            <strong class="u-text-main">${escapeHtml(cat.name)}</strong>
          </div>
          <span class="opcode-menu-enter">PRESS ENTER &rarr;</span>
        </div>
      `;
      }).join('')}
    `;
    dropdown.classList.remove('hidden');
    return;
  }

  // STAGE 2: User typed 'BR/' or 'BR' or selected a category prefix -> Show Child Codes for that Category ONLY!
  const matchedCategoryGroup = OP_CATEGORY_GROUPS.find(g =>
    rawQ === g.prefix || rawQ === g.prefix.replace('/', '') || rawQ === g.cat || rawQ.startsWith(g.prefix)
  );

  const catalog = (typeof getJobOpcodeCatalog === 'function') ? getJobOpcodeCatalog() : [];
  let matches = [];
  let headerLabel = 'JOB CODES (SELECT WITH ARROWS + ENTER):';

  if (matchedCategoryGroup) {
    headerLabel = `${matchedCategoryGroup.name} (${matchedCategoryGroup.prefix}) — SELECT JOB CODE:`;
    const catName = matchedCategoryGroup.cat;
    const cleanPrefix = matchedCategoryGroup.prefix.replace('/', '');

    // Always include General Custom Line at top of group
    const genItem = {
      code: matchedCategoryGroup.genCode,
      concern: matchedCategoryGroup.genConcern,
      hrs: '1.00',
      parts: '0.00',
      category: catName
    };

    const specificMatches = catalog.filter(c =>
      (c.category && c.category.toUpperCase() === catName) ||
      c.code.toUpperCase().startsWith(cleanPrefix) ||
      c.code.toUpperCase().includes(rawQ)
    );

    matches = [genItem, ...specificMatches.filter(m => m.code !== matchedCategoryGroup.genCode)];
  } else {
    // Stage 3: Direct text search (e.g. 'OIL' or 'ROTOR' or 'DIAG')
    matches = catalog.filter(c =>
      c.code.toUpperCase().includes(rawQ) ||
      c.concern.toUpperCase().includes(rawQ) ||
      (c.category && c.category.toUpperCase().includes(rawQ))
    );
  }

  if (!matches.length) {
    dropdown.innerHTML = '<div class="opcode-menu-empty">NO MATCHING JOB CODES FOUND.</div>';
    dropdown.classList.remove('hidden');
    return;
  }

  dropdown.innerHTML = `
    <div class="opcode-menu-heading">
      ${headerLabel}
    </div>
    ${matches.slice(0, 10).map((m, idx) => {
      const displayCode = m.code.includes('-') ? m.code.replace('-', '/') : m.code;
      const isSelected = idx === 0;
      return `
        <div class="opcode-item-row ${isSelected ? 'is-active' : ''}" data-kind="item" aria-selected="${isSelected}" data-action="opcode.select-job" data-code="${escapeHtml(displayCode)}" data-concern="${escapeHtml(m.concern)}" data-hours="${escapeHtml(m.hrs)}" data-parts="${escapeHtml(m.parts)}">
          <div class="opcode-item-row-content">
            <div>
              ${UIComponent.Keycap(displayCode, "index")}
              <strong class="u-text-main">${escapeHtml(m.concern)}</strong>
            </div>
            <span class="opcode-menu-hours">${m.hrs}h</span>
          </div>
        </div>
      `;
    }).join('')}
  `;

  dropdown.classList.remove('hidden');
}

function selectOpcodeCategoryGroup(el, prefix) {
  const tr = el.closest('tr');
  if (!tr) return;
  const input = tr.querySelector('.appt-opcode-input, .ro-opcode-input');
  const dropdown = tr.querySelector('.appt-opcode-dropdown, .ro-opcode-dropdown');
  if (input && dropdown) {
    input.value = prefix;
    input.focus();
    processOpcodeSearch(prefix, input, dropdown);
  }
}

function selectOpcodeJobItem(el, code, concern, hrs, parts) {
  const tr = el.closest('tr');
  if (!tr) return;
  const dropdown = tr.querySelector('.appt-opcode-dropdown, .ro-opcode-dropdown');
  if (dropdown) dropdown.classList.add('hidden');

  const codeInp = tr.querySelector('.appt-opcode-input, .ro-opcode-input');
  const concernInp = tr.querySelector('.appt-concern-input, .ro-concern-input');
  const hrsInp = tr.querySelector('.appt-hrs-input, .ro-hrs-input');
  const partsInp = tr.querySelector('.appt-parts-input, .ro-parts-input');
  const laborInp = tr.querySelector('.appt-labor-input, .ro-labor-input');

  if (codeInp) codeInp.value = code;
  if (concernInp) concernInp.value = concern;  // always update desc to match selected code
  if (hrsInp) hrsInp.value = hrs;
  if (partsInp) partsInp.value = parts;

  const hrsVal = parseFloat(hrs || 0) || 0;
  if (laborInp) {
    delete laborInp.dataset.userOverridden;
    delete laborInp.dataset.manualOverride;
    if (hrsVal > 0) {
      const rate = tr.querySelector('.ro-opcode-input') ? getActiveRoLaborRate() : shopLaborRate;
      laborInp.value = (hrsVal * rate).toFixed(2);
    } else {
      laborInp.value = '0.00';
    }
  }

  if (tr.querySelector('.ro-opcode-input')) performRoTotalsCalculation();
  else recalculateApptTotals();

  requestAnimationFrame(() => concernInp?.focus());
}

function handleSharedOpcodeKeydown(e, inputEl) {
  let activeOpcodeRowIndex;
  const dropdown = inputEl.parentNode.querySelector('.appt-opcode-dropdown, .ro-opcode-dropdown');
  if (!dropdown) return;
  activeOpcodeRowIndex = activeRows.get(dropdown) || 0;
  if (dropdown.classList.contains('hidden')) {
    if (e.key === '/') {
      setTimeout(() => {
        processOpcodeSearch('/', inputEl, dropdown);
      }, 10);
    }
    return;
  }

  const rows = dropdown.querySelectorAll('.opcode-item-row');
  if (!rows.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeOpcodeRowIndex = Math.min(rows.length - 1, activeOpcodeRowIndex + 1);
    activeRows.set(dropdown, activeOpcodeRowIndex);
    updateOpcodeDropdownHighlight(rows, activeOpcodeRowIndex);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeOpcodeRowIndex = Math.max(0, activeOpcodeRowIndex - 1);
    activeRows.set(dropdown, activeOpcodeRowIndex);
    updateOpcodeDropdownHighlight(rows, activeOpcodeRowIndex);
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    const selectedRow = rows[activeOpcodeRowIndex];
    if (!selectedRow) return;
    const kind = selectedRow.dataset.kind;
    if (kind === 'group') {
      // Expand the group sublist — do NOT select a job item
      const prefix = selectedRow.dataset.prefix;
      if (prefix) {
        inputEl.value = prefix;
        inputEl.focus();
        activeOpcodeRowIndex = 0;  // reset before rendering child list
        processOpcodeSearch(prefix, inputEl, dropdown);
      }
    } else {
      // Select the job code item
      selectedRow.click();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    dropdown.classList.add('hidden');
  }
}

function updateOpcodeDropdownHighlight(rows, activeOpcodeRowIndex) {
  rows.forEach((r, idx) => {
    if (idx === activeOpcodeRowIndex) {
      r.classList.add('is-active');
      r.setAttribute('aria-selected', 'true');
      r.scrollIntoView({ block: 'nearest' });
    } else {
      r.classList.remove('is-active');
      r.setAttribute('aria-selected', 'false');
    }
  });
}

  window.OpcodePicker = { search: processOpcodeSearch, handleKeydown: handleSharedOpcodeKeydown };
  document.addEventListener('DOMContentLoaded', () => {
    const allowed = element => hasPermission(element.closest('tr')?.querySelector('.ro-opcode-input') ? 'repair_orders' : 'appointments');
    EventDelegator.registerAction('opcode.select-group', (param, element) => {
      if (allowed(element)) selectOpcodeCategoryGroup(element, param);
    });
    EventDelegator.registerAction('opcode.select-job', (_, element) => {
      if (allowed(element)) selectOpcodeJobItem(element, element.dataset.code, element.dataset.concern, element.dataset.hours, element.dataset.parts);
    });
  });
})();
