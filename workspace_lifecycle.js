/**
 * TaktRO — Workspace Lifecycle & Compact State Engine (workspace_lifecycle.js)
 * Manages standardized workspace lifecycles: mount -> load -> render -> interact -> save -> refresh -> unmount
 * Tracks compact state objects ({ filters, selectedId, page, editorMode }) instead of snapshotting innerHTML.
 */

class WorkspaceLifecycleEngine {
  constructor() {
    this.workspaces = new Map();
    this.stateStore = new Map();
    this.activeWorkspaceKey = null;
  }

  /**
   * Register a workspace lifecycle contract.
   * @param {string} key - Workspace key ('O', 'A', 'P', 'C', 'V', 'S', etc.)
   * @param {Object} contract
   * @param {Function} contract.getInitialState - Returns default compact state object
   * @param {Function} [contract.mount] - Setup workspace DOM structure
   * @param {Function} [contract.load] - Async data loading matching state
   * @param {Function} [contract.render] - Pure UI rendering from state and loaded data
   * @param {Function} [contract.interact] - Attach event listeners & focus handling
   * @param {Function} [contract.save] - Save / mutation handler
   * @param {Function} [contract.refresh] - Re-fetch data and re-render
   * @param {Function} [contract.unmount] - Teardown / cleanup
   */
  register(key, contract) {
    if (!key || !contract) return;
    this.workspaces.set(key, contract);
    const initialState = contract.getInitialState ? contract.getInitialState() : {};
    this.stateStore.set(key, initialState);
  }

  /**
   * Get current compact state for a workspace.
   */
  getState(key) {
    return this.stateStore.get(key) || {};
  }

  /**
   * Update compact state for a workspace.
   */
  setState(key, partialState) {
    const prev = this.getState(key);
    const updated = { ...prev, ...partialState };
    this.stateStore.set(key, updated);
    return updated;
  }

  /**
   * Transition to a target workspace following standard lifecycle:
   * unmount (old) -> mount -> load -> render -> interact
   */
  async transitionTo(key, targetContainerEl) {
    if (!targetContainerEl) return false;

    // Unmount current active workspace if changing
    if (this.activeWorkspaceKey && this.activeWorkspaceKey !== key) {
      this.unmountActive();
    }

    this.activeWorkspaceKey = key;
    const workspace = this.workspaces.get(key);
    if (!workspace) return false;

    const compactState = this.getState(key);

    // 1. MOUNT Phase
    if (workspace.mount) {
      workspace.mount(targetContainerEl);
    }

    // 2. LOAD Phase
    let data = null;
    if (workspace.load) {
      data = await workspace.load(compactState);
    }

    // 3. RENDER Phase
    if (workspace.render) {
      const markup = workspace.render(compactState, data);
      if (typeof markup === 'string') {
        targetContainerEl.innerHTML = markup;
      }
    }

    // 4. INTERACT Phase
    if (workspace.interact) {
      workspace.interact(targetContainerEl, compactState, data);
    }

    return true;
  }

  /**
   * Refresh active workspace: load -> render -> interact
   */
  async refreshActive() {
    if (!this.activeWorkspaceKey) return;
    const key = this.activeWorkspaceKey;
    const workspace = this.workspaces.get(key);
    const containerEl = document.getElementById('workspaceContent');
    if (!workspace || !containerEl) return;

    const compactState = this.getState(key);

    let data = null;
    if (workspace.load) {
      data = await workspace.load(compactState);
    }

    if (workspace.render) {
      const markup = workspace.render(compactState, data);
      if (typeof markup === 'string') {
        containerEl.innerHTML = markup;
      }
    }

    if (workspace.interact) {
      workspace.interact(containerEl, compactState, data);
    }
  }

  /**
   * Save handler: runs save logic then triggers refresh.
   */
  async saveActive(payload = {}) {
    if (!this.activeWorkspaceKey) return;
    const key = this.activeWorkspaceKey;
    const workspace = this.workspaces.get(key);
    if (!workspace || !workspace.save) return;

    const compactState = this.getState(key);
    const result = await workspace.save(compactState, payload);
    await this.refreshActive();
    return result;
  }

  /**
   * Unmount active workspace.
   */
  unmountActive() {
    if (!this.activeWorkspaceKey) return;
    const workspace = this.workspaces.get(this.activeWorkspaceKey);
    if (workspace && workspace.unmount) {
      workspace.unmount();
    }
    this.activeWorkspaceKey = null;
  }
}

window.WorkspaceLifecycle = new WorkspaceLifecycleEngine();
