/**
 * TaktRO — Staff & Access Domain Module (staff/staff.js)
 * Handles staff list rendering, position template permissions, employee profile updates, and master 4-digit PIN resets.
 */

let staffSetup = null;
let activeEmployeeAccessId = null;

function renderStaffLoading() {
  return `<div class="staff-shell"><p class="staff-muted">LOADING STAFF…</p></div>`;
}

function formatEmpNumber(id) {
  const num = Number(id) || 0;
  return num >= 1000 ? String(num) : String(num).padStart(3, '0');
}

async function loadStaffWorkspace() {
  activeEmployeeAccessId = null;
  const contentEl = document.getElementById('workspaceContent');
  try {
    const setup = await api('/api/staff/setup');
    staffSetup = setup;
    const templateOptions = setup.templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    const locationOptions = setup.locations.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
    const rows = setup.employees.map((employee) => `
      <tr tabindex="0" class="staff-row" data-action="staff.openEmployeeAccess" data-action-param="${escapeHtml(employee.id)}">
        <td><span class="data-id">#${formatEmpNumber(employee.id)}</span></td>
        <td><strong>${escapeHtml(employee.name)}</strong></td>
        <td>${escapeHtml(employee.templates.join(', '))}</td>
        <td>${escapeHtml(employee.locations.join(', '))}</td>
        <td><span class="status-active">${employee.active ? 'ACTIVE' : 'INACTIVE'}</span></td>
      </tr>`).join('');
    contentEl.innerHTML = `
      <div class="staff-shell">
        <div class="staff-intro">
          <div><h3>EMPLOYEES</h3><p>Add a person, choose where they work, and select the closest position.</p></div>
          <span>${setup.employees.filter(e => e.active).length} ACTIVE</span>
        </div>
        <form class="staff-add-form" data-submit-action="staff.createEmployee" data-submit-hotkey="ALT+S">
          <label>EMPLOYEE NAME<input id="staffName" required autocomplete="off" placeholder="Full name"></label>
          <label>POSITION<select id="staffTemplate" required>${templateOptions}</select></label>
          <label>LOCATION<select id="staffLocation" required>${locationOptions}</select></label>
          <label>4-DIGIT PIN<input id="staffPin" required inputmode="numeric" maxlength="4" pattern="[0-9]{4}" type="password" placeholder="••••"></label>
          <button type="submit" class="primary-action-btn">ADD EMPLOYEE</button>
        </form>
        <div class="staff-message" id="staffMessage"></div>
        <table class="staff-table"><thead><tr><th>EMP #</th><th>NAME</th><th>POSITION</th><th>LOCATION</th><th>STATUS</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="staff-note">Position templates update access automatically. Detailed exceptions can remain an administrator-only advanced step later.</p>
      </div>`;
  } catch (error) {
    contentEl.innerHTML = `<div class="staff-shell"><p class="staff-error">${escapeHtml(error.message)}</p></div>`;
  }
}

function openEmployeeAccessByNumber(number) {
  const employee = staffSetup?.employees[number - 1];
  if (employee) openEmployeeAccess(employee.id);
}

function handleStaffFormKeydown(e, formElement = e.currentTarget) {
  if (e.altKey && e.key.toUpperCase() === 'S') {
    e.preventDefault();
    if (formElement && typeof formElement.requestSubmit === 'function') {
      formElement.requestSubmit();
    }
  }
}

function handleStaffEscapeNav() {
  if (activeEmployeeAccessId !== null) {
    loadStaffWorkspace();
    return true;
  }
  return false;
}

function openEmployeeAccess(employeeId) {
  const employee = staffSetup?.employees.find(item => item.id === employeeId);
  if (!employee) return;
  activeEmployeeAccessId = employee.id;

  const currentTemplateName = employee.templates[0] || '';
  const currentTemplateObj = staffSetup.templates.find(t => t.name === currentTemplateName);
  const currentTemplateId = currentTemplateObj ? currentTemplateObj.id : (staffSetup.templates[0]?.id || 1);

  const templateOptions = staffSetup.templates.map(t =>
    `<option value="${t.id}" ${t.id === currentTemplateId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
  ).join('');

  const permissionRows = Object.entries(staffSetup.permission_labels).map(([key, label]) => {
    const checked = employee.permissions.includes(key) ? 'checked' : '';
    const inherited = employee.base_permissions.includes(key);
    const customized = Object.prototype.hasOwnProperty.call(employee.overrides, key);
    return `<label class="permission-row">
      <input type="checkbox" name="permission" value="${key}" ${checked}>
      <span><strong>${escapeHtml(label)}</strong><small>${customized ? 'CUSTOM SETTING' : inherited ? 'FROM POSITION' : 'NOT IN POSITION'}</small></span>
    </label>`;
  }).join('');

  document.getElementById('workspaceContent').innerHTML = `
    <div class="staff-shell">
      <div class="staff-intro">
        <div>
          <h3>EMP #${formatEmpNumber(employee.id)} · ${escapeHtml(employee.name)}</h3>
          <p>${escapeHtml(employee.templates.join(', '))} · ${escapeHtml(employee.locations.join(', '))} · <strong style="color:${employee.active ? 'var(--accent-emerald)' : 'var(--accent-crimson)'}">${employee.active ? 'ACTIVE' : 'DEACTIVATED'}</strong></p>
        </div>
        <button class="staff-back" data-action="staff.loadStaffWorkspace">BACK TO STAFF LIST</button>
      </div>

      <!-- MASTER PIN RESET & PROFILE EDITOR -->
      <form data-submit-action="staff.saveEmployeeProfile" data-action-param="${escapeHtml(employee.id)}" data-submit-hotkey="ALT+S" data-keydown-action="staff.handleStaffFormKeydown" style="background:var(--surface-panel); border:1px solid var(--accent-amber); padding:16px; border-radius:4px; margin-bottom:20px; font-family:var(--font-mono);">
        <div class="ui-between-mb-12">
          <strong style="color:var(--accent-amber); font-size:12px;">EMPLOYEE PROFILE &amp; 4-DIGIT PIN RESET (MASTER CONTROL)</strong>
          <span class="ui-label-dim">ENTER NEW 4-DIGIT PIN BELOW TO RESET ACCESS · PRESS ${UIComponent.Keycap("Alt+S", "command", {className: "u-text-amber"})} TO SAVE</span>
        </div>
        <div style="display:grid; grid-template-columns: 2fr 1.5fr 1.2fr 1.5fr; gap:12px; align-items:flex-end;">
          <div>
            <label class="field-label">EMPLOYEE FULL NAME *</label>
            <input type="text" id="editEmpName" required value="${escapeHtml(employee.name)}" style="width:100%; padding:6px 8px; font-size:12px;">
          </div>
          <div>
            <label class="field-label">POSITION TEMPLATE *</label>
            <select id="editEmpTemplate" required class="field-input">
              ${templateOptions}
            </select>
          </div>
          <div>
            <label class="field-label">STATUS</label>
            <select id="editEmpActive" class="field-input">
              <option value="1" ${employee.active ? 'selected' : ''}>ACTIVE</option>
              <option value="0" ${!employee.active ? 'selected' : ''}>DEACTIVATED</option>
            </select>
          </div>
          <div>
            <label style="font-size:10px; color:var(--accent-amber); font-weight:700; display:block; margin-bottom:4px;">RESET 4-DIGIT PIN</label>
            <input type="password" id="editEmpPin" placeholder="Enter new PIN" maxlength="4" pattern="[0-9]{4}" inputmode="numeric" style="width:100%; border:1px solid var(--accent-amber); padding:6px 8px; font-size:12px;">
          </div>
        </div>

        <!-- CANADIAN HR COMPLIANCE & PERSONAL DETAILS -->
        <div style="margin-top:14px; padding-top:12px; border-top:1px dashed var(--border-mid);">
          <div style="font-size:11px; font-weight:700; color:var(--accent-steel); margin-bottom:8px;">CANADIAN HR COMPLIANCE &amp; PERSONAL RECORD</div>
          <div style="display:grid; grid-template-columns: 1fr 1fr 2fr; gap:12px; margin-bottom:8px;">
            <div>
              <label class="field-label">PHONE NUMBER</label>
              <input type="text" id="editEmpPhone" value="${escapeHtml(employee.phone || '')}" placeholder="555-0199" style="width:100%; padding:6px 8px; font-size:12px;">
            </div>
            <div>
              <label class="field-label">SIN (SOCIAL INSURANCE #)</label>
              <input type="text" id="editEmpSin" value="${escapeHtml(employee.sin || '')}" placeholder="955-555-555" style="width:100%; padding:6px 8px; font-size:12px;">
            </div>
            <div>
              <label class="field-label">HOME ADDRESS</label>
              <input type="text" id="editEmpAddress" value="${escapeHtml(employee.address || '')}" placeholder="Street, City AB" style="width:100%; padding:6px 8px; font-size:12px;">
            </div>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr 2fr; gap:12px;">
            <div>
              <label class="field-label">EMERGENCY CONTACT NAME</label>
              <input type="text" id="editEmpEmergName" value="${escapeHtml(employee.emergency_contact_name || '')}" placeholder="Contact Name" style="width:100%; padding:6px 8px; font-size:12px;">
            </div>
            <div>
              <label class="field-label">EMERGENCY CONTACT PHONE</label>
              <input type="text" id="editEmpEmergPhone" value="${escapeHtml(employee.emergency_contact_phone || '')}" placeholder="555-0198" style="width:100%; padding:6px 8px; font-size:12px;">
            </div>
            <div>
              <label class="field-label">MEDICAL ALERT / HEALTH NOTES</label>
              <input type="text" id="editEmpMedical" value="${escapeHtml(employee.medical_alert || '')}" placeholder="Allergies, medical notes, safety gear requirements" style="width:100%; padding:6px 8px; font-size:12px;">
            </div>
          </div>
        </div>

        <!-- TECHNICIAN WORK SCHEDULE & DAILY CAPACITY -->
        <div style="margin-top:14px; padding-top:12px; border-top:1px dashed var(--border-mid);">
          <div style="font-size:11px; font-weight:700; color:var(--accent-emerald); margin-bottom:8px;">TECHNICIAN WORK SCHEDULE &amp; SHOP CAPACITY TARGETS</div>
          <div style="display:flex; gap:20px; align-items:center; flex-wrap:wrap;">
            <div>
              <label class="field-label">DAILY PRODUCTIVE HOURS</label>
              <input type="number" step="0.5" min="0" max="24" id="editEmpDailyHours" value="${employee.daily_productive_hours !== undefined ? employee.daily_productive_hours : 8.0}" style="width:110px; padding:6px 8px; font-size:12px;">
            </div>
            <div>
              <label class="field-label">ACTIVE WORKING DAYS</label>
              <div id="editEmpWorkDays" style="display:flex; gap:8px; margin-top:4px;">
                ${['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map(day => {
                  const activeDays = (employee.work_days || 'MON,TUE,WED,THU,FRI').split(',').map(d => d.trim().toUpperCase());
                  const checked = activeDays.includes(day) ? 'checked' : '';
                  return `<label style="font-size:11px; display:inline-flex; align-items:center; gap:3px; background:var(--bg-main); padding:4px 6px; border:1px solid var(--border-mid); border-radius:3px; cursor:pointer;">
                    <input type="checkbox" value="${day}" ${checked}> ${day}
                  </label>`;
                }).join('')}
              </div>
            </div>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:14px;">
          <span id="staffProfileMessage" class="staff-message"></span>
          <button type="submit" class="primary-action-btn">${UIComponent.Keycap("Alt+S", "inverse", {className: "kbd-invert"})} UPDATE PROFILE &amp; RESET PIN</button>
        </div>
      </form>

      <!-- PERMISSION EXCEPTIONS GRID -->
      <div style="background:var(--surface-panel); border:1px solid var(--border-mid); padding:16px; border-radius:4px;">
        <div class="ui-mb-12">
          <strong class="ui-copy">PERMISSION EXCEPTIONS MATRIX</strong>
          <div class="permission-summary ui-mt-4">Position access is the starting point. Custom selections below are saved as this employee's explicit exceptions. Press ${UIComponent.Keycap("Alt+S", "command", {className: "u-text-amber"})} to save.</div>
        </div>
        <form data-submit-action="staff.saveEmployeeAccess" data-action-param="${escapeHtml(employee.id)}" data-submit-hotkey="ALT+S" data-keydown-action="staff.handleStaffFormKeydown">
          <div class="permission-grid">${permissionRows}</div>
          <div class="permission-actions" style="margin-top:14px;"><span id="staffAccessMessage" class="staff-message"></span><button type="submit" class="primary-action-btn">${UIComponent.Keycap("Alt+S", "inverse", {className: "kbd-invert"})} SAVE PERMISSION EXCEPTIONS</button></div>
        </form>
      </div>
    </div>`;
}

async function saveEmployeeProfile(event, employeeId) {
  event.preventDefault();
  const message = document.getElementById('staffProfileMessage');
  message.textContent = 'SAVING DETAILS…';
  message.className = 'staff-message';

  const name = document.getElementById('editEmpName').value.trim();
  const template_id = parseInt(document.getElementById('editEmpTemplate').value);
  const active = parseInt(document.getElementById('editEmpActive').value);
  const pin = document.getElementById('editEmpPin').value.trim();

  const phone = document.getElementById('editEmpPhone').value.trim();
  const sin = document.getElementById('editEmpSin').value.trim();
  const address = document.getElementById('editEmpAddress').value.trim();
  const emergency_contact_name = document.getElementById('editEmpEmergName').value.trim();
  const emergency_contact_phone = document.getElementById('editEmpEmergPhone').value.trim();
  const medical_alert = document.getElementById('editEmpMedical').value.trim();
  const daily_productive_hours = parseFloat(document.getElementById('editEmpDailyHours').value) || 8.0;

  const work_days = [...document.querySelectorAll('#editEmpWorkDays input[type="checkbox"]:checked')].map(cb => cb.value).join(',');

  try {
    await api(`/api/employees/${employeeId}/profile`, {
      method: 'POST',
      body: JSON.stringify({
        name, template_id, active, pin,
        phone, sin, address,
        emergency_contact_name, emergency_contact_phone, medical_alert,
        work_days, daily_productive_hours
      })
    });
    message.textContent = pin ? 'PROFILE & PIN UPDATED SUCCESSFULLY!' : 'PROFILE UPDATED SUCCESSFULLY!';
    message.style.color = 'var(--accent-emerald)';
    setTimeout(() => loadStaffWorkspace(), 1200);
  } catch (error) {
    message.textContent = error.message.toUpperCase();
    message.className = 'staff-message staff-error';
  }
}

async function saveEmployeeAccess(event, employeeId, formElement = event.currentTarget) {
  event.preventDefault();
  const message = document.getElementById('staffAccessMessage');
  message.textContent = 'SAVING PERMISSIONS…';
  const permissions = [...formElement.querySelectorAll('input[name="permission"]:checked')].map(input => input.value);
  try {
    await api(`/api/employees/${employeeId}/permissions`, {
      method: 'POST', body: JSON.stringify({ permissions })
    });
    await loadStaffWorkspace();
  } catch (error) {
    message.textContent = error.message.toUpperCase();
    message.classList.add('staff-error');
  }
}

async function createEmployee(event) {
  event.preventDefault();
  const message = document.getElementById('staffMessage');
  message.textContent = 'SAVING…';
  try {
    await api('/api/employees', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('staffName').value,
        pin: document.getElementById('staffPin').value,
        template_id: Number(document.getElementById('staffTemplate').value),
        location_id: Number(document.getElementById('staffLocation').value)
      })
    });
    await loadStaffWorkspace();
  } catch (error) {
    message.textContent = error.message.toUpperCase();
    message.classList.add('staff-error');
  }
}


document.addEventListener('DOMContentLoaded', () => {
  const actions = {
    "staff.openEmployeeAccess": (param, element, event) => openEmployeeAccess(Number(param)),
    "staff.createEmployee": (param, element, event) => createEmployee(event),
    "staff.loadStaffWorkspace": (param, element, event) => loadStaffWorkspace(),
    "staff.saveEmployeeProfile": (param, element, event) => saveEmployeeProfile(event, Number(param)),
    "staff.handleStaffFormKeydown": (param, element, event) => handleStaffFormKeydown(event, element),
    "staff.saveEmployeeAccess": (param, element, event) => saveEmployeeAccess(event, Number(param), element),
  };
  for (const [name, handler] of Object.entries(actions)) {
    EventDelegator.registerAction(name, handler, {permission: "staff_admin"});
  }
});
