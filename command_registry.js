/**
 * TaktRO — Command Contract Engine (command_registry.js)
 * Defines structured command contracts ensuring buttons (mouse) and hotkeys (keyboard)
 * invoke identical execution handlers with explicit permission, enabled guards, and feedback.
 */

class CommandRegistryEngine {
  constructor() {
    this.commands = new Map();
  }

  /**
   * Register a new command contract.
   * @param {Object} contract
   * @param {string} contract.id - Unique command identifier (e.g. 'ro.create_new')
   * @param {string} contract.label - Human readable label (e.g. 'NEW REPAIR ORDER')
   * @param {string|null} contract.permission - Permission token required (e.g. 'repair_orders')
   * @param {string} contract.workspace - Target workspace identifier ('O', 'A', 'P', 'C', 'V', 'S', 'global')
   * @param {string} contract.layer - Active layer scope ('modal', 'editor', 'workspace', 'global')
   * @param {string} contract.hotkey - Primary keyboard shortcut (e.g. 'N', 'ALT+S', 'ALT+A')
   * @param {string} contract.keycapVariant - Visual keycap style ('warp', 'command', 'nav', 'index', 'inverse')
   * @param {Function} [contract.isEnabled] - Guard function returning boolean
   * @param {Function} contract.execute - Core execution function
   * @param {string|Object} [contract.mouseControl] - Selector or element binding
   * @param {Object} [contract.feedback] - Success and error notification text
   */
  register(contract) {
    if (!contract || !contract.id) {
      console.error('CommandRegistry: Invalid contract registered', contract);
      return;
    }
    const hotkey = String(contract.hotkey || '').toUpperCase().trim();
    if (/^[A-Z0-9?]$/.test(hotkey)) {
      console.error(`CommandRegistry: Plain-letter command '${contract.id}' rejected; actions require ALT+Key.`);
      return;
    }
    if (String(contract.id).startsWith('dash.warp_') && !hotkey.startsWith('SHIFT+')) {
      console.error(`CommandRegistry: Warp command '${contract.id}' rejected; navigation requires SHIFT+Key.`);
      return;
    }
    this.commands.set(contract.id, {
      permission: null,
      workspace: 'global',
      layer: 'global',
      keycapVariant: 'command',
      isEnabled: () => true,
      mouseControl: null,
      feedback: null,
      ...contract
    });
  }

  /**
   * Get a registered command by ID.
   */
  get(commandId) {
    return this.commands.get(commandId) || null;
  }

  /**
   * Execute a command by ID.
   */
  async execute(commandId, context = {}) {
    const cmd = this.commands.get(commandId);
    if (!cmd) {
      console.warn(`CommandRegistry: Command '${commandId}' not found.`);
      return false;
    }

    // 1. Permission Guard Check
    if (cmd.permission && typeof window.hasPermission === 'function') {
      if (!window.hasPermission(cmd.permission)) {
        this.showFeedback(cmd, false, `Access Denied: Missing '${cmd.permission}' permission.`);
        return false;
      }
    }

    // 2. Contextual Enabled Guard Check
    if (cmd.isEnabled && typeof cmd.isEnabled === 'function') {
      if (!cmd.isEnabled(context)) {
        return false;
      }
    }

    // 3. Command Execution
    try {
      const result = await cmd.execute(context);
      if (cmd.feedback && cmd.feedback.success) {
        this.showFeedback(cmd, true, cmd.feedback.success);
      }
      return result;
    } catch (err) {
      console.error(`CommandRegistry: Command '${commandId}' execution error:`, err);
      const errMsg = (cmd.feedback && cmd.feedback.error) || err.message || 'Execution error';
      this.showFeedback(cmd, false, errMsg);
      throw err;
    }
  }

  /**
   * Match keyboard event to registered command and execute.
   */
  handleHotkey(keyCombo, activeWorkspace = 'global', activeLayer = 'global') {
    const normalizedCombo = String(keyCombo).toUpperCase().trim();

    for (const cmd of this.commands.values()) {
      if (cmd.hotkey && String(cmd.hotkey).toUpperCase().trim() === normalizedCombo) {
        // Workspace Scoping
        if (cmd.workspace === 'global' || cmd.workspace === activeWorkspace) {
          // Layer Scoping
          if (cmd.layer === 'global' || cmd.layer === activeLayer) {
            this.execute(cmd.id, { trigger: 'keyboard', combo: keyCombo });
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Show feedback notification.
   */
  showFeedback(cmd, isSuccess, message) {
    if (window.FeedbackManager) {
      window.FeedbackManager.toast(message, isSuccess ? 'success' : 'error');
    } else if (typeof window.showToast === 'function') {
      window.showToast(message, isSuccess ? 'success' : 'error');
    } else {
      console.log(`[Command ${isSuccess ? 'OK' : 'ERR'}] ${cmd.label}: ${message}`);
    }
  }

  /**
   * Get all registered commands for a workspace.
   */
  getCommandsByWorkspace(workspace) {
    const results = [];
    for (const cmd of this.commands.values()) {
      if (cmd.workspace === 'global' || cmd.workspace === workspace) {
        results.push(cmd);
      }
    }
    return results;
  }
}

window.CommandRegistry = new CommandRegistryEngine();
