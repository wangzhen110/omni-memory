// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Minimal host context.
 *
 * `apply(ctx)` in index.js touches exactly six host services: `tools.register`,
 * `effect`, `on`, `get`, plus the optional `systemPrompt` and `webServer`
 * lookups that silently degrade to `undefined`. That is the whole contract.
 *
 * So an adapter does not need a second copy of the memory engine — it needs a
 * context object that satisfies those calls. Tools then register themselves
 * into `registry`, and the adapter exposes them however its host speaks
 * (MCP tools, CLI subcommands, HTTP routes).
 */

export function createHost({ services = {}, events = null } = {}) {
  const registry = new Map();
  const disposers = [];

  const ctx = {
    // DSH wraps every registration in a reactive effect. For a one-shot adapter
    // "run it now, keep the disposer" is the same semantics.
    effect(fn) {
      const dispose = typeof fn === 'function' ? fn() : undefined;
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },

    // Event subscriptions only exist inside DSH. Returning undefined (rather
    // than a fake disposer) keeps index.js on its documented no-op path.
    on(event, handler) {
      if (events && typeof events.on === 'function') return events.on(event, handler);
      return undefined;
    },

    get(service) {
      return services[service];
    },

    tools: {
      register(def) {
        if (!def || typeof def.name !== 'string' || !def.name) {
          throw new Error('tool registration needs a name');
        }
        registry.set(def.name, def);
        return () => { registry.delete(def.name); };
      },
      get(name) {
        return registry.get(name);
      },
      list() {
        return [...registry.values()];
      },
    },
  };

  return {
    ctx,
    tools: {
      list: () => [...registry.values()],
      get: name => registry.get(name),
      size: () => registry.size,
    },
    dispose() {
      for (const dispose of disposers.slice().reverse()) {
        try { dispose(); } catch { /* already gone */ }
      }
      disposers.length = 0;
      registry.clear();
    },
  };
}
