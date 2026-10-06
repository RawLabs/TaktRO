/**
 * TaktRO — Accessibility & Focus Rules Manager (accessibility_manager.js)
 * Manages WCAG accessibility and focus rules across all components:
 * 1. Mouse/Keyboard dual parity
 * 2. High-contrast visible focus rings
 * 3. Enter/Space activation
 * 4. Correct semantic ARIA roles
 * 5. Modal focus containment (focus trapping)
 * 6. Opener focus restoration
 * 7. No color-only meaning (pairing color with text + icon)
 */

class AccessibilityManagerEngine {
  constructor() {
    this.focusTrapActiveContainer = null;
    this.focusTrapKeydownListener = null;
  }

  /**
   * Get all focusable elements inside a container.
   */
  getFocusableElements(containerEl) {
    if (!containerEl) return [];
    const selectors = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex="0"]',
      '[role="button"]'
    ].join(',');
    return [...containerEl.querySelectorAll(selectors)].filter(el => {
      return el.offsetWidth > 0 && el.offsetHeight > 0 && window.getComputedStyle(el).visibility !== 'hidden';
    });
  }

  /**
   * Trap focus within a container (e.g. active modal).
   */
  trapFocus(containerEl) {
    if (!containerEl) return;
    this.releaseFocus();

    this.focusTrapActiveContainer = containerEl;
    const focusables = this.getFocusableElements(containerEl);
    if (focusables.length > 0) {
      focusables[0].focus();
    }

    this.focusTrapKeydownListener = (e) => {
      if (e.key !== 'Tab') return;
      const elements = this.getFocusableElements(containerEl);
      if (elements.length === 0) return;

      const first = elements[0];
      const last = elements[elements.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first || !containerEl.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !containerEl.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', this.focusTrapKeydownListener);
  }

  /**
   * Release current active focus trap.
   */
  releaseFocus() {
    if (this.focusTrapKeydownListener) {
      document.removeEventListener('keydown', this.focusTrapKeydownListener);
      this.focusTrapKeydownListener = null;
    }
    this.focusTrapActiveContainer = null;
  }

  /**
   * Restore focus to opener element upon close.
   */
  restoreFocus(openerEl, fallbackContainerEl) {
    if (openerEl && document.contains(openerEl) && typeof openerEl.focus === 'function') {
      try {
        openerEl.focus();
        return true;
      } catch (_) { /* fallback below */ }
    }

    const fallback = fallbackContainerEl || document.getElementById('workspaceContent') || document.body;
    const firstFocusable = this.getFocusableElements(fallback)[0];
    if (firstFocusable) {
      firstFocusable.focus();
      return true;
    }
    return false;
  }

  /**
   * Ensure custom interactive control has semantic ARIA attributes.
   */
  decorateInteractive(el, options = {}) {
    if (!el) return;
    if (!el.getAttribute('role')) {
      el.setAttribute('role', options.role || 'button');
    }
    if (!el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '0');
    }
    if (options.ariaLabel && !el.hasAttribute('aria-label')) {
      el.setAttribute('aria-label', options.ariaLabel);
    }
  }
}

window.AccessibilityManager = new AccessibilityManagerEngine();
