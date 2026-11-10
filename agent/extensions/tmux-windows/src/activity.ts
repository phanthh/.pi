/**
 * Background activity registry: extensions that own long-lived work (tmux runs,
 * subagents) register a counter; observers (tmux-indicator) poll the total.
 * Lives on globalThis: each extension may load its own copy of this module, and
 * re-registering the same id (after /reload) replaces the stale getter.
 */
const KEY = Symbol.for("pi-tmux-windows/background-activity");

function sources(): Map<string, () => number> {
  const g = globalThis as any;
  g[KEY] ??= new Map();
  return g[KEY];
}

export function registerBackgroundActivity(id: string, count: () => number): void {
  sources().set(id, count);
}

/** Sum of all registered counters. Throwing getters count as 0. */
export function backgroundActivityCount(): number {
  let total = 0;
  for (const count of sources().values()) {
    try {
      total += Math.max(0, count() || 0);
    } catch {}
  }
  return total;
}
