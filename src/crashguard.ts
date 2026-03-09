// Crash guard — auto-restart Palworld containers that are "crashed" (Docker running, game unreachable)
//
// Behaviour:
//   - After a container is detected as crashed, wait RESTART_DELAY_MS before restarting
//   - Record each auto-restart attempt
//   - If MAX_AUTO_RESTARTS attempts occur within CRASH_WINDOW_MS, stop attempting (blocked)
//   - Blocked state self-clears once the window expires with no new crashes
//   - If the server comes online, the attempt history is preserved for the window but the
//     restart timer is cancelled

import { restartContainer } from "./docker.js";
import { logAudit } from "./db.js";

const RESTART_DELAY_MS   = 60_000;       // 1 minute after crash detected → restart
const CRASH_WINDOW_MS    = 10 * 60_000;  // rolling window for attempt counting
const MAX_AUTO_RESTARTS  = 3;            // max attempts within the window

interface CrashTracker {
  containerId:    string;
  containerName:  string;
  restartTimer:   ReturnType<typeof setTimeout> | null;
  attempts:       number[]; // timestamps of each auto-restart attempt
  blocked:        boolean;
}

const trackers = new Map<string, CrashTracker>();

// Containers currently undergoing an intentional stop or restart.
// While present, REST going dark is not treated as a crash.
const intentionalShutdowns = new Set<string>();

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Call before initiating any deliberate stop or restart so that the next poll
 * cycle(s) do not classify the resulting REST outage as a crash.
 */
export function notifyIntentionalShutdown(containerId: string): void {
  intentionalShutdowns.add(containerId);
}

/**
 * Call every poll cycle when gameStatus==="crashed" and the container IP resolved
 * (i.e. we're sure the game itself is unresponsive, not just a network issue).
 */
export function notifyCrashed(containerId: string, containerName: string): void {
  if (intentionalShutdowns.has(containerId)) return; // deliberate — not a crash
  let t = trackers.get(containerId);

  if (!t) {
    t = { containerId, containerName, restartTimer: null, attempts: [], blocked: false };
    trackers.set(containerId, t);
  }

  // Prune attempts outside the rolling window
  const now = Date.now();
  t.attempts = t.attempts.filter(ts => now - ts < CRASH_WINDOW_MS);

  if (t.blocked) {
    // Re-check whether the window has expired and we can unblock
    if (t.attempts.length < MAX_AUTO_RESTARTS) {
      t.blocked = false;
      console.log(`[crashguard] ${containerName} — unblocked (attempt window expired)`);
    } else {
      return; // still blocked
    }
  }

  if (t.restartTimer !== null) return; // restart already scheduled

  console.log(`[crashguard] ${containerName} — scheduling auto-restart in ${RESTART_DELAY_MS / 1000}s`);

  t.restartTimer = setTimeout(async () => {
    t.restartTimer = null;

    // Re-prune in case time has passed since scheduling
    const ts = Date.now();
    t.attempts = t.attempts.filter(a => ts - a < CRASH_WINDOW_MS);

    if (t.attempts.length >= MAX_AUTO_RESTARTS) {
      t.blocked = true;
      console.warn(
        `[crashguard] ${containerName} — auto-restart BLOCKED` +
        ` (${t.attempts.length} attempts in last ${CRASH_WINDOW_MS / 60_000} min)`
      );
      logAudit("AUTO_RESTART_BLOCKED", {
        containerName,
        details: `Auto-restart disabled after ${t.attempts.length} attempts — possible crash loop`,
      });
      return;
    }

    t.attempts.push(ts);
    const attempt = t.attempts.length;
    console.log(`[crashguard] ${containerName} — auto-restarting (attempt ${attempt}/${MAX_AUTO_RESTARTS})`);

    try {
      await restartContainer(containerId);
      logAudit("AUTO_RESTART", {
        containerName,
        details: `Crash auto-restart attempt ${attempt} of ${MAX_AUTO_RESTARTS}`,
      });
    } catch (err) {
      console.error(`[crashguard] ${containerName} — restart failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, RESTART_DELAY_MS);
}

/**
 * Call when the game comes back online. Cancels any pending restart timer.
 * Attempt history is kept until the window expires so the rate-limit remains accurate.
 */
export function notifyOnline(containerId: string): void {
  intentionalShutdowns.delete(containerId);
  const t = trackers.get(containerId);
  if (!t) return;

  if (t.restartTimer !== null) {
    clearTimeout(t.restartTimer);
    t.restartTimer = null;
    console.log(`[crashguard] ${t.containerName} — back online, restart cancelled`);
  }

  // Prune expired attempts; clean up tracker if nothing left to track
  const now = Date.now();
  t.attempts = t.attempts.filter(ts => now - ts < CRASH_WINDOW_MS);
  if (t.attempts.length === 0) {
    trackers.delete(containerId);
  } else {
    t.blocked = false; // can restart again once window clears
  }
}

/**
 * Cancel any pending restart and fully remove state (e.g. container stopped intentionally).
 */
export function notifyStopped(containerId: string): void {
  intentionalShutdowns.delete(containerId);
  const t = trackers.get(containerId);
  if (!t) return;
  if (t.restartTimer !== null) clearTimeout(t.restartTimer);
  trackers.delete(containerId);
}

/**
 * Returns current crash guard state for the status API response.
 */
export function getCrashGuardInfo(containerId: string): {
  blocked: boolean;
  attempts: number;
  restartPendingMs: number | null;
} | null {
  const t = trackers.get(containerId);
  if (!t) return null;
  const now = Date.now();
  const validAttempts = t.attempts.filter(ts => now - ts < CRASH_WINDOW_MS);
  if (validAttempts.length === 0 && !t.restartTimer && !t.blocked) return null;
  return {
    blocked: t.blocked,
    attempts: validAttempts.length,
    restartPendingMs: t.restartTimer !== null ? RESTART_DELAY_MS : null,
  };
}
