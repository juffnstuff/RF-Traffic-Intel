/**
 * refresh.js — poll /api/refresh-status until a refresh finishes.
 *
 * A full backfill can take minutes; a fixed post-POST delay reloads stale
 * data and makes the button look broken. Instead poll every `intervalMs`
 * until none of the given lock names appear in `running`, capped at
 * `timeoutMs`. Resolves true when the locks cleared, false on timeout.
 */
export async function waitForRefreshLocks(locks, { intervalMs = 2000, timeoutMs = 15 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, intervalMs));
    try {
      const r = await fetch('/api/refresh-status');
      if (!r.ok) continue;
      const j = await r.json();
      const running = Array.isArray(j?.running) ? j.running : [];
      if (!locks.some(l => running.includes(l))) return true;
    } catch { /* transient network error — keep polling */ }
  }
  return false;
}
