/**
 * TaktRO — System Feedback & Toast Manager (feedback_manager.js)
 * Defines standard rules for 6 feedback tiers:
 * 1. Inline validation (.field-error)
 * 2. Status message (UIComponent.StateMessage)
 * 3. Toast notification (FeedbackManager.toast) — REPLACES routine browser alert() popups!
 * 4. Confirmation dialog (UIComponent.ModalDialog)
 * 5. Blocking alert modal
 * 6. Loading state (AsyncOrchestrator button lock)
 */

class FeedbackManagerEngine {
  constructor() {
    this.toastContainer = null;
  }

  getContainer() {
    if (!this.toastContainer) {
      this.toastContainer = document.getElementById('toastContainer');
      if (!this.toastContainer) {
        this.toastContainer = document.createElement('div');
        this.toastContainer.id = 'toastContainer';
        this.toastContainer.className = 'toast-container';
        this.toastContainer.setAttribute('aria-live', 'polite');
        document.body.appendChild(this.toastContainer);
      }
    }
    return this.toastContainer;
  }

  /**
   * Display a non-intrusive floating toast message.
   * Replaces native browser alert() dialogs on routine save operations!
   * @param {string} message - Toast text
   * @param {'success'|'error'|'info'} [kind='success'] - Toast type
   * @param {number} [duration=3000] - Display duration in ms
   */
  toast(message, kind = 'success', duration = 3000) {
    if (!message) return;
    const container = this.getContainer();

    const icons = {
      success: '✓',
      error: '⚠️',
      info: 'ℹ'
    };

    const toastEl = document.createElement('div');
    toastEl.className = `ui-toast ui-toast--${kind}`;
    toastEl.innerHTML = `
      <span class="ui-toast-icon" aria-hidden="true">${icons[kind] || '✓'}</span>
      <span class="ui-toast-text">${this.escapeHtml(message)}</span>
    `;

    container.appendChild(toastEl);

    setTimeout(() => {
      toastEl.style.opacity = '0';
      toastEl.style.transform = 'translateY(12px)';
      toastEl.style.transition = 'all 0.25s ease-out';
      setTimeout(() => toastEl.remove(), 250);
    }, duration);
  }

  /**
   * Show inline field validation error.
   */
  showInlineError(fieldEl, message) {
    const el = typeof fieldEl === 'string' ? document.querySelector(fieldEl) : fieldEl;
    if (!el) return;
    el.classList.add('field-error');

    let msgEl = el.parentNode.querySelector('.field-error-msg');
    if (!msgEl) {
      msgEl = document.createElement('div');
      msgEl.className = 'field-error-msg';
      el.parentNode.appendChild(msgEl);
    }
    msgEl.textContent = message;
  }

  /**
   * Clear inline field validation error.
   */
  clearInlineError(fieldEl) {
    const el = typeof fieldEl === 'string' ? document.querySelector(fieldEl) : fieldEl;
    if (!el) return;
    el.classList.remove('field-error');
    const msgEl = el.parentNode?.querySelector('.field-error-msg');
    msgEl?.remove();
  }

  /**
   * Show accessible confirmation modal dialog (replaces browser confirm()).
   */
  async confirm(title, message, onConfirm, onCancel) {
    if (window.UIComponent) {
      const modalId = 'feedbackConfirmModal';
      const contentHtml = `
        <div style="font-family:var(--font-mono); color:var(--text-main); font-size:12px; line-height:1.6;">
          <p>${this.escapeHtml(message)}</p>
        </div>
      `;
      const footerHtml = `
        <button type="button" id="btnConfirmCancel" class="secondary-action-btn">${UIComponent.Keycap("ESC", "command")} CANCEL</button>
        <button type="button" id="btnConfirmOk" class="primary-action-btn action-danger">${UIComponent.Keycap("ENTER", "inverse", {className: "kbd-invert"})} CONFIRM</button>
      `;
      const modalHtml = window.UIComponent.ModalDialog({
        id: modalId,
        title: title || 'CONFIRM ACTION',
        contentHtml,
        footerHtml,
        cancelAction: 'feedback.cancel'
      });

      document.body.insertAdjacentHTML('beforeend', modalHtml);
      const modalEl = document.getElementById(modalId);
      const opener = document.activeElement;

      return new Promise((resolve) => {
        let accepted = false;
        let settled = false;
        const closeFn = () => {
          modalEl?.remove();
          if (settled) return;
          settled = true;
          resolve(accepted);
          if (accepted) onConfirm?.();
          else onCancel?.();
        };

        if (window.ModalStack) {
          window.ModalStack.open(modalId, {
            modalEl,
            openerEl: opener,
            closeFn
          });
        }

        const cleanup = async () => {
          if (window.ModalStack && window.ModalStack.stack.some(m => m.id === modalId)) {
            await window.ModalStack.close(modalId);
          } else {
            closeFn();
          }
        };

        document.getElementById('btnConfirmOk')?.addEventListener('click', async () => {
          accepted = true;
          await cleanup();
        });

        document.getElementById('btnConfirmCancel')?.addEventListener('click', async () => {
          await cleanup();
        });
      });
    } else {
      const ok = window.confirm(`${title}\n\n${message}`);
      if (ok && onConfirm) onConfirm();
      else if (!ok && onCancel) onCancel();
      return ok;
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

window.FeedbackManager = new FeedbackManagerEngine();


document.addEventListener('DOMContentLoaded', () => {
  EventDelegator.registerAction('feedback.cancel', () => document.getElementById('btnConfirmCancel')?.click());
});
