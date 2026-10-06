/** Shared event routing for commands and dynamically rendered controls. */
class EventDelegatorEngine {
  constructor() {
    this.actionHandlers = new Map();
    this.registerAction('workspace.legend', () => toggleWorkspaceLegend());
    this.registerAction('ui.modal-close', id => ModalStack.close(id));
    this.initGlobalListeners();
  }

  registerAction(actionName, handlerFn, { permission = null } = {}) {
    if (actionName && typeof handlerFn === 'function') {
      this.actionHandlers.set(actionName, { handler: handlerFn, permission });
    }
  }

  isDisabled(element) {
    return Boolean(element.closest(':disabled, [aria-disabled="true"], [inert]'));
  }

  reportError(error) {
    console.error('EventDelegator: Action failed', error);
    if (window.FeedbackManager) window.FeedbackManager.toast(error.message || 'Action failed', 'error');
  }

  dispatchAction(event, type) {
    const attribute = type === 'click' ? 'data-action' : `data-${type}-action`;
    const element = event.target.closest?.(`[${attribute}]`);
    if (!element || this.isDisabled(element)) return false;
    // An input or nested button owns its interaction, rather than its row.
    const nativeControl = event.target.closest('button, a, input, select, textarea, label');
    if (type === 'click' && nativeControl && nativeControl !== element && !nativeControl.contains(element)) return false;
    const action = this.actionHandlers.get(element.getAttribute(attribute));
    if (!action) return false;
    if (type === 'click' || type === 'submit') event.preventDefault();
    if (action.permission && typeof window.hasPermission === 'function' && !window.hasPermission(action.permission)) return false;
    try {
      const result = action.handler(element.getAttribute('data-action-param'), element, event);
      if (result && typeof result.catch === 'function') result.catch(error => this.reportError(error));
    } catch (error) {
      this.reportError(error);
    }
    return true;
  }

  handleClick(event) {
    const element = event.target.closest?.('[data-command], [data-action]');
    if (!element || this.isDisabled(element)) return;
    const nativeControl = event.target.closest('button, a, input, select, textarea, label');
    if (nativeControl && nativeControl !== element && !nativeControl.contains(element)) return;
    if (element.hasAttribute('data-command') && window.CommandRegistry) {
      event.preventDefault();
      // The registry already reports command failures; consume the rejected promise.
      window.CommandRegistry.execute(element.dataset.command, { element, event }).catch(() => {});
      return;
    }
    this.dispatchAction(event, 'click');
  }

  handleKeydown(event) {
    if (event.defaultPrevented) return;
    // Submit the top visible form through native validation and its submit action.
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const combo = `ALT+${event.key.toUpperCase()}`;
      const eligible = candidate => candidate && candidate.dataset.submitHotkey === combo && candidate.getClientRects().length && !candidate.closest('.hidden, [inert]');
      const focusedForm = event.target.closest?.('form[data-submit-hotkey]');
      const form = eligible(focusedForm) ? focusedForm : [...document.querySelectorAll('form[data-submit-hotkey]')].reverse().find(eligible);
      if (form) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) form.requestSubmit();
        return;
      }
    }
    this.dispatchAction(event, 'keydown');
    if (event.defaultPrevented) {
      event.stopImmediatePropagation();
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('input, textarea, select, button, a')) return;
    const element = event.target.closest('[data-command], [data-action], [tabindex="0"], [role="button"]');
    if (element) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat && !this.isDisabled(element)) element.click();
    }
  }

  initGlobalListeners() {
    document.addEventListener('click', event => this.handleClick(event));
    document.addEventListener('keydown', event => this.handleKeydown(event));
    for (const type of ['input', 'change', 'submit', 'focusout']) {
      document.addEventListener(type, event => this.dispatchAction(event, type));
    }
  }
}

window.EventDelegator = new EventDelegatorEngine();
