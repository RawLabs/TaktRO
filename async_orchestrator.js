/**
 * TaktRO — Async Behavior Orchestrator (async_orchestrator.js)
 * Standardizes async behavior across all data screens:
 * 1. Loading indicators
 * 2. Request deduplication
 * 3. Stale-response rejection (AbortController)
 * 4. Mutation cache invalidation
 * 5. Error display
 * 6. Retry behavior
 * 7. Disabled state while saving
 * 8. Protection against double submission
 */

class AsyncOrchestratorEngine {
  constructor() {
    this.controllers = new Map();
    this.activeMutations = new Set();
  }

  /**
   * Get an AbortSignal for a route key, aborting any stale prior request.
   */
  getAbortSignal(routeKey) {
    if (this.controllers.has(routeKey)) {
      try {
        this.controllers.get(routeKey).abort();
      } catch (_) { /* ignore abort errors */ }
    }
    const controller = new AbortController();
    this.controllers.set(routeKey, controller);
    return controller.signal;
  }

  /**
   * Clear AbortController for route key after settlement.
   */
  clearAbortSignal(routeKey, signal) {
    if (this.controllers.get(routeKey)?.signal === signal) {
      this.controllers.delete(routeKey);
    }
  }

  /**
   * Execute an async mutation with double-submission protection and button locking.
   * @param {HTMLElement|string} triggerEl - Form or button element to lock
   * @param {Function} mutationFn - Async mutation promise function
   */
  async executeMutation(triggerEl, mutationFn) {
    const el = typeof triggerEl === 'string' ? document.querySelector(triggerEl) : triggerEl;
    const lockKey = el ? (el.id || el) : mutationFn;

    if (this.activeMutations.has(lockKey)) {
      console.warn('AsyncOrchestrator: Double submission prevented for', lockKey);
      return false;
    }

    this.activeMutations.add(lockKey);

    let originalText = '';
    let btnEl = null;

    if (el) {
      btnEl = el.tagName === 'BUTTON' ? el : el.querySelector('button[type="submit"], .primary-action-btn');
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.setAttribute('data-loading', 'true');
        originalText = btnEl.innerHTML;
        btnEl.innerHTML = `<span class="ui-state-icon" aria-hidden="true">⏳</span> SAVING...`;
      }
    }

    try {
      const result = await mutationFn();
      return result;
    } catch (err) {
      console.error('AsyncOrchestrator: Mutation failed:', err);
      throw err;
    } finally {
      this.activeMutations.delete(lockKey);
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.removeAttribute('data-loading');
        btnEl.innerHTML = originalText;
      }
    }
  }

  /**
   * Render standardized loading state into container.
   */
  renderLoading(containerEl, message = 'LOADING DATA...') {
    if (!containerEl) return;
    if (window.UIComponent) {
      containerEl.innerHTML = window.UIComponent.StateMessage({ type: 'loading', message });
    } else {
      containerEl.innerHTML = `<div class="ui-state-message ui-state-loading">⏳ ${message}</div>`;
    }
  }

  /**
   * Render standardized error state into container with retry action.
   */
  renderError(containerEl, errorMessage = 'UNABLE TO LOAD DATA.', retryAction = '') {
    if (!containerEl) return;
    if (window.UIComponent) {
      containerEl.innerHTML = window.UIComponent.StateMessage({ type: 'error', message: errorMessage, retryAction });
    } else {
      containerEl.replaceChildren();
      const message = document.createElement('div');
      message.className = 'ui-state-message ui-state-error';
      message.textContent = `⚠️ ${errorMessage}`;
      if (retryAction) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = retryAction;
        button.textContent = 'RETRY';
        message.append(button);
      }
      containerEl.append(message);
    }
  }
}

window.AsyncOrchestrator = new AsyncOrchestratorEngine();
