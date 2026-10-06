/**
 * TaktRO — Reusable UI Component Standard Library (ui_components.js)
 * Defines standardized, composable UI component builders across all shop modules.
 */

window.UIComponent = {

  ActionAttributes(action, param = '', eventType = 'click') {
    if (!action) return '';
    if (!['click', 'input', 'change', 'submit', 'keydown', 'focusout'].includes(eventType)) {
      throw new Error('Unsupported component event type');
    }
    const attribute = eventType === 'click' ? 'data-action' : `data-${eventType}-action`;
    return `${attribute}="${this.escapeHtml(action)}" data-action-param="${this.escapeHtml(String(param))}"`;
  },

  // 1. WORKSPACE HEADER
  WorkspaceHeader({ title, subtitle = '', badgeText = '', badgeKind = 'neutral', actionsHtml = '', legendKey = '' }) {
    const badgeMarkup = badgeText ? this.StatusBadge(badgeText, badgeKind) : '';
    return `
      <div class="ui-workspace-header">
        <div class="ui-workspace-header-main">
          <div class="ui-workspace-header-title-group">
            <h2 id="activeTaskTitle" tabindex="-1" class="ui-workspace-header-title">${this.escapeHtml(title)}</h2>
            ${badgeMarkup}
          </div>
          ${subtitle ? `<div class="ui-workspace-header-subtitle">${this.escapeHtml(subtitle)}</div>` : ''}
        </div>
        <div class="ui-workspace-header-actions">
          ${actionsHtml}
          ${legendKey ? `<button type="button" class="secondary-action-btn ui-button-compact" data-action="workspace.legend">${this.Keycap('ALT+K', 'command')} COLOR KEY</button>` : ''}
        </div>
      </div>
    `;
  },

  // 2. SEARCH BAR & FILTER RAIL
  SearchBar({ id, placeholder = 'Search...', value = '', inputAction = '', keyboardHint = '/', extraControlsHtml = '' }) {
    return `
      <div class="ui-search-bar">
        <div class="ui-search-bar-input-wrapper">
          <input type="text" id="${id}" class="ui-search-bar-input control-full" placeholder="${this.escapeHtml(placeholder)}" value="${this.escapeHtml(value)}" ${this.ActionAttributes(inputAction, '', 'input')} autocomplete="off">
          ${keyboardHint ? `${this.Keycap(keyboardHint, 'command', {className: 'ui-search-bar-hint'})}` : ''}
        </div>
        ${extraControlsHtml ? `<div class="ui-search-bar-extra">${extraControlsHtml}</div>` : ''}
      </div>
    `;
  },

  // 3. RESULT TABLE / LIST CONTAINER
  ResultTable({ id = '', columns = [], rows = [], activeRowIndex = 0, emptyMessage = 'NO RECORDS FOUND.', rowAction = '', rowKeydownAction = '', sortAction = '' }) {
    if (!rows.length) {
      return this.StateMessage({ type: 'empty', message: emptyMessage });
    }

    const headersHtml = columns.map(col => {
      const alignStyle = col.align ? `text-align:${col.align};` : '';
      const widthStyle = col.width ? `width:${col.width};` : '';
      const sortable = col.sortKey;
      const sortIcon = sortable && typeof getSortIcon === 'function' ? getSortIcon(col.sortKey) : '';
      const clickAttr = sortable ? this.ActionAttributes(sortAction, col.sortKey) : '';
      
      return `
        <th style="${alignStyle} ${widthStyle}">
          ${sortable ? `<button type="button" class="ui-table-header-btn" ${clickAttr}>${this.escapeHtml(col.label)}${sortIcon}</button>` : this.escapeHtml(col.label)}
        </th>
      `;
    }).join('');

    const bodyHtml = rows.map((row, idx) => {
      const isSelected = idx === activeRowIndex;
      const rowClass = this.SelectedRow({ isSelected, extraClasses: row.className || '' });
      const rowIdAttr = row.id ? `id="${row.id}"` : '';
      const rowClick = this.ActionAttributes(row.action || rowAction, row.dataId ?? idx);
      const keydownAction = row.keydownAction || rowKeydownAction;
      const rowKeydown = keydownAction ? `data-keydown-action="${this.escapeHtml(keydownAction)}"` : '';

      return `
        <tr ${rowIdAttr} tabindex="0" class="${rowClass}" ${rowClick} ${rowKeydown}>
          ${row.cells.map((cell, cIdx) => {
            const col = columns[cIdx] || {};
            const alignStyle = col.align ? `text-align:${col.align};` : '';
            return `<td style="${alignStyle}">${cell}</td>`;
          }).join('')}
        </tr>
      `;
    }).join('');

    return `
      <div ${id ? `id="${id}"` : ''} class="ui-result-table-container">
        <table class="ui-result-table">
          <thead>
            <tr>${headersHtml}</tr>
          </thead>
          <tbody>
            ${bodyHtml}
          </tbody>
        </table>
      </div>
    `;
  },

  // 4. SELECTED ROW STYLING HELPERS
  SelectedRow({ isSelected = false, extraClasses = '' }) {
    const classes = ['ui-table-row', extraClasses];
    if (isSelected) classes.push('is-selected');
    return classes.filter(Boolean).join(' ');
  },

  // 5. EMPTY / LOADING / ERROR STATES
  StateMessage({ type = 'empty', message = '', icon = '', retryAction = '' }) {
    let typeClass = 'ui-state-empty';
    let defaultIcon = '📂';
    
    if (type === 'loading') {
      typeClass = 'ui-state-loading';
      defaultIcon = '⏳';
    } else if (type === 'error') {
      typeClass = 'ui-state-error';
      defaultIcon = '⚠️';
    }

    const displayIcon = icon || defaultIcon;

    return `
      <div class="ui-state-message ${typeClass}">
        <div class="ui-state-icon" aria-hidden="true">${displayIcon}</div>
        <div class="ui-state-text">${this.escapeHtml(message || 'No data available.')}</div>
        ${retryAction ? `<button type="button" class="secondary-action-btn ui-button-compact" ${this.ActionAttributes(retryAction)}>RETRY</button>` : ''}
      </div>
    `;
  },

  // 6. EDITOR FORM LAYOUT
  EditorForm({ id, title = '', fieldsGridHtml = '', actionsHtml = '', submitAction = '', cancelAction = '' }) {
    return `
      <form id="${id}" class="ui-editor-form" ${this.ActionAttributes(submitAction, '', 'submit')}>
        <div class="ui-editor-form-header">
          <h3 class="ui-editor-form-title">${this.escapeHtml(title)}</h3>
          ${cancelAction ? `<button type="button" class="secondary-action-btn ui-button-compact" ${this.ActionAttributes(cancelAction)}>${this.Keycap('ESC', 'nav')} CANCEL</button>` : ''}
        </div>
        <div class="ui-editor-form-body">
          ${fieldsGridHtml}
        </div>
        <div class="ui-editor-form-footer">
          ${actionsHtml}
        </div>
      </form>
    `;
  },

  // 7. ACTION BAR / CONTROL TOOLBAR
  ActionBar({ primaryActions = '', secondaryActions = '', hintText = '' }) {
    return `
      <div class="ui-action-bar">
        <div class="ui-action-bar-secondary">
          ${secondaryActions}
        </div>
        ${hintText ? `<div class="ui-action-bar-hint">${this.escapeHtml(hintText)}</div>` : ''}
        <div class="ui-action-bar-primary">
          ${primaryActions}
        </div>
      </div>
    `;
  },

  // 8. MODAL & CONFIRMATION DIALOG
  ModalDialog({ id, title = '', bodyHtml = '', contentHtml = '', footerHtml = '', confirmLabel = 'CONFIRM', cancelLabel = 'CANCEL', confirmAction = '', cancelAction = 'ui.modal-close', isDanger = false }) {
    const confirmBtnClass = isDanger ? 'primary-action-btn action-danger' : 'primary-action-btn';
    const bodyContent = contentHtml || bodyHtml;
    const footerContent = footerHtml || `
      <button type="button" class="secondary-action-btn" ${this.ActionAttributes(cancelAction, id)}>${this.escapeHtml(cancelLabel)}</button>
      ${confirmAction ? `<button type="button" class="${confirmBtnClass}" ${this.ActionAttributes(confirmAction, id)}>${this.escapeHtml(confirmLabel)}</button>` : ''}
    `;

    return `
      <div id="${id}" class="ui-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="${id}Title">
        <div class="ui-modal-dialog">
          <div class="ui-modal-header">
            <h3 id="${id}Title" class="ui-modal-title">${this.escapeHtml(title)}</h3>
            <button type="button" class="secondary-action-btn ui-button-compact" ${this.ActionAttributes(cancelAction, id)} aria-label="Close dialog">${this.Keycap('ESC', 'command')}</button>
          </div>
          <div class="ui-modal-body">
            ${bodyContent}
          </div>
          <div class="ui-modal-footer">
            ${footerContent}
          </div>
        </div>
      </div>
    `;
  },

  // 9. STATUS BADGES
  StatusBadge(statusText = '', kind = 'neutral') {
    const kindClassMap = {
      positive: 'badge-emerald',
      caution: 'badge-amber',
      danger: 'badge-crimson',
      info: 'badge-cyan',
      neutral: 'badge-steel'
    };
    const kindIconMap = {
      positive: '✓ ',
      caution: '⚠️ ',
      danger: '❌ ',
      info: 'ℹ ',
      neutral: ''
    };
    const badgeClass = kindClassMap[kind] || 'badge-steel';
    const icon = kindIconMap[kind] || '';
    return `<span class="ui-status-badge ${badgeClass}" role="status"><span aria-hidden="true">${icon}</span>${this.escapeHtml(String(statusText).toUpperCase())}</span>`;
  },

  // 10. PAGINATION CONTROLS
  Pagination({ currentPage = 1, totalPages = 1, totalItems = 0, pageSize = 20, pageAction = '' }) {
    const hasPrev = currentPage > 1;
    const hasNext = currentPage < totalPages;

    return `
      <div class="ui-pagination-bar">
        <div class="ui-pagination-info">
          SHOWING <strong>${totalItems ? ((currentPage - 1) * pageSize + 1) : 0}–${Math.min(currentPage * pageSize, totalItems)}</strong> OF <strong>${totalItems}</strong> RECORDS
        </div>
        <div class="ui-pagination-controls">
          <button type="button" class="secondary-action-btn ui-button-compact" ${hasPrev && pageAction ? this.ActionAttributes(pageAction, currentPage - 1) : 'disabled'}>${this.Keycap('PREV', 'command')}</button>
          <span class="ui-pagination-label">PAGE <strong>${currentPage}</strong> / ${totalPages || 1}</span>
          <button type="button" class="secondary-action-btn ui-button-compact" ${hasNext && pageAction ? this.ActionAttributes(pageAction, currentPage + 1) : 'disabled'}>${this.Keycap('NEXT', 'command')}</button>
        </div>
      </div>
    `;
  },

  // 11. KEYCAP COMPONENT BUILDER
  Keycap(keyText = '', variant = 'command', { id = '', className = '', style = '' } = {}) {
    const variantClassMap = {
      warp: 'keycap--warp',
      command: 'keycap--command',
      nav: 'keycap--nav',
      index: 'keycap--index',
      inverse: 'keycap--inverse',
      hero: 'keycap--hero keycap--warp',
      dashboard: 'keycap--dashboard keycap--warp'
    };
    const variantClass = variantClassMap[variant] || 'keycap--command';
    const attributes = `${id ? ` id="${this.escapeHtml(id)}"` : ''}${style ? ` style="${this.escapeHtml(style)}"` : ''}`;
    return `<kbd class="keycap ${variantClass}${className ? ` ${this.escapeHtml(className)}` : ''}"${attributes}>${this.escapeHtml(String(keyText).toUpperCase())}</kbd>`;
  },

  // 12. SEMANTIC CHIP BUILDER
  Chip({ text = '', type = 'code', variant = '' }) {
    const escaped = this.escapeHtml(String(text).toUpperCase());
    if (type === 'data-id' || type === 'emp') {
      return `<span class="data-id">${escaped}</span>`;
    }
    if (type === 'pay') {
      const p = String(text).toLowerCase();
      return `<span class="pay-chip pay-${p}">${escaped}</span>`;
    }
    if (type === 'status') {
      const badgeKind = variant || 'steel';
      return `<span class="status-chip badge-${badgeKind}">${escaped}</span>`;
    }
    return `<span class="code-chip">${escaped}</span>`;
  },

  // 13. COMMAND BUTTON BUILDER
  CommandButton(commandId, options = {}) {
    const cmd = window.CommandRegistry ? window.CommandRegistry.get(commandId) : null;
    const label = options.label || (cmd ? cmd.label : commandId);
    const hotkey = options.hotkey || (cmd ? cmd.hotkey : '');
    const variant = options.variant || (cmd ? cmd.keycapVariant : 'command');
    const buttonClass = options.className || (variant === 'inverse' ? 'primary-action-btn' : 'secondary-action-btn');
    const keycapHtml = hotkey ? this.Keycap(hotkey, variant) : '';
    const disabledAttr = options.disabled ? 'disabled' : '';

    return `
      <button type="button" class="${buttonClass}" data-command="${commandId}" ${disabledAttr}>
        ${keycapHtml}${this.escapeHtml(label)}
      </button>
    `;
  },

  // UTILITY: HTML ESCAPING
  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};
