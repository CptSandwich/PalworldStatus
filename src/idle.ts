// Per-container idle auto-shutdown
//
// Idle shutdown is armed when a container is started from the panel AND the
// container has palworld-status.idle-shutdown-minutes > 0 label.
//
// Broadcast sequence once player count hits 0 and stays 0:
//   T+0 min  → warning broadcast
//   T+5 min  → warning broadcast
//   T+9 min  → warning broadcast
//   T+10 min → graceful stop + Docker stop + log
//
// If any player connects before T+10, the countdown cancels.

import {
  armIdleShutdown,
  disarmIdleShutdown,
  setIdleSince,
  clearIdleSince,
  getAllArmedIdleStates,
  logAudit,
  insertChatMessage,
} from "./db.js";
import { getContainerIP, stopContainer } from "./docker.js";
import { broadcast, gracefulStop } from "./palworld.js";
import { notifyIntentionalShutdown } from "./crashguard.js";

// ── In-memory idle tracker ────────────────────────────────────────────────────

interface IdleTracker {
  containerId: string;
  containerName: string;
  restPort: number;
  restPassword: string;
  idleShutdownMs: number;
  /** Timestamp (ms) when the last player left. null = players online or not idle */
  idleStartedAt: number | null;
  /** Set of timeouts already scheduled so we don't double-schedule */
  warningsFired: Set<string>;
  /** The final shutdown timeout handle */
  shutdownTimer: ReturnType<typeof setTimeout> | null;
}

const trackers = new Map<string, IdleTracker>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register or refresh a container's idle tracker.
 * Call this whenever a container is discovered or its config changes.
 */
export function registerIdleTracker(opts: {
  containerId: string;
  containerName: string;
  restPort: number;
  restPassword: string;
  idleShutdownMinutes: number;
}) {
  if (opts.idleShutdownMinutes <= 0) return; // not idle-managed
  if (trackers.has(opts.containerId)) return; // already registered

  trackers.set(opts.containerId, {
    containerId: opts.containerId,
    containerName: opts.containerName,
    restPort: opts.restPort,
    restPassword: opts.restPassword,
    idleShutdownMs: opts.idleShutdownMinutes * 60_000,
    idleStartedAt: null,
    warningsFired: new Set(),
    shutdownTimer: null,
  });
}

/** Remove tracker when container is deregistered */
export function unregisterIdleTracker(containerId: string) {
  cancelIdleCountdown(containerId);
  trackers.delete(containerId);
}

/**
 * Arms idle shutdown for a container (called when started from the panel).
 * No-op if the container is not idle-managed.
 */
export function armIdle(containerId: string) {
  const t = trackers.get(containerId);
  if (!t) return;
  cancelIdleCountdown(containerId);
  armIdleShutdown(containerId);
}

/**
 * Update player count for a container.
 * Call this on every status poll.
 */
export async function updateIdleState(
  containerId: string,
  playerCount: number,
  containerIp: string
) {
  const t = trackers.get(containerId);
  if (!t) return;

  // Check if this container is armed in the DB
  const states = getAllArmedIdleStates();
  const isArmed = states.some((s) => s.container_id === containerId && s.armed);
  if (!isArmed) {
    // Not armed — ensure no countdown is running
    cancelIdleCountdown(containerId);
    return;
  }

  if (playerCount > 0) {
    // Players online — cancel any running countdown
    if (t.idleStartedAt !== null) {
      cancelIdleCountdown(containerId);
      clearIdleSince(containerId);
      await broadcast(containerIp, t.restPort, t.restPassword,
        "Welcome! Idle shutdown cancelled — players are online.");
      insertChatMessage(t.containerId, null, "Welcome! Idle shutdown cancelled — players are online.");
    }
  } else {
    // No players — start countdown if not already running
    if (t.idleStartedAt === null) {
      startIdleCountdown(t, containerIp);
    }
  }
}

/**
 * Get remaining seconds until idle shutdown for a container.
 * Returns null if not counting down.
 */
export function getIdleCountdownSeconds(containerId: string): number | null {
  const t = trackers.get(containerId);
  if (!t || t.idleStartedAt === null) return null;
  const elapsed = Date.now() - t.idleStartedAt;
  const remaining = t.idleShutdownMs - elapsed;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * Manually cancel idle shutdown (admin presses Cancel).
 */
export async function cancelIdleManual(containerId: string, containerIp: string) {
  const t = trackers.get(containerId);
  cancelIdleCountdown(containerId);
  clearIdleSince(containerId);
  if (t) {
    await broadcast(containerIp, t.restPort, t.restPassword,
      "Idle shutdown cancelled by admin.");
    insertChatMessage(containerId, null, "Idle shutdown cancelled by admin.");
  }
}

// ── Recover armed states on startup ──────────────────────────────────────────

/**
 * Called once at startup. Recovers idle states from DB so a crash/restart
 * doesn't leave containers permanently armed with no countdown running.
 * We reset to "armed but not counting down" — the next poll will restart the
 * countdown if there are still no players.
 */
export function recoverIdleStates() {
  const states = getAllArmedIdleStates();
  for (const state of states) {
    // idle_since was set before crash — reset to armed but not counting
    // The next updateIdleState() call will restart the countdown if needed
    if (state.idle_since) {
      clearIdleSince(state.container_id);
    }
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

function startIdleCountdown(t: IdleTracker, containerIp: string) {
  t.idleStartedAt = Date.now();
  t.warningsFired.clear();

  const shutdownAt = new Date(t.idleStartedAt + t.idleShutdownMs);
  setIdleSince(
    t.containerId,
    new Date(t.idleStartedAt).toISOString(),
    shutdownAt.toISOString()
  );

  const ttlMin = t.idleShutdownMs / 60_000;

  // T+0: immediate broadcast
  void broadcast(containerIp, t.restPort, t.restPassword,
    `No players online. Server will shut down in ${ttlMin} minutes if no one connects.`
  );
  insertChatMessage(t.containerId, null, `No players online. Server will shut down in ${ttlMin} minutes if no one connects.`);
  t.warningsFired.add("0");

  // T+5 min warning
  if (t.idleShutdownMs > 5 * 60_000) {
    setTimeout(() => {
      if (t.idleStartedAt === null) return;
      void broadcast(containerIp, t.restPort, t.restPassword,
        `Server shutting down in ${ttlMin - 5} minutes (inactive).`
      );
      insertChatMessage(t.containerId, null, `Server shutting down in ${ttlMin - 5} minutes (inactive).`);
      t.warningsFired.add("5");
    }, 5 * 60_000);
  }

  // T+9 min warning (1 min before 10 min shutdown)
  if (t.idleShutdownMs > 9 * 60_000) {
    setTimeout(() => {
      if (t.idleStartedAt === null) return;
      void broadcast(containerIp, t.restPort, t.restPassword,
        "Server shutting down in 1 minute (inactive)."
      );
      insertChatMessage(t.containerId, null, "Server shutting down in 1 minute (inactive).");
      t.warningsFired.add("9");
    }, (t.idleShutdownMs - 60_000));
  }

  // Shutdown timer
  t.shutdownTimer = setTimeout(
    () => void executeIdleShutdown(t, containerIp),
    t.idleShutdownMs
  );
}

function cancelIdleCountdown(containerId: string) {
  const t = trackers.get(containerId);
  if (!t) return;
  t.idleStartedAt = null;
  t.warningsFired.clear();
  if (t.shutdownTimer !== null) {
    clearTimeout(t.shutdownTimer);
    t.shutdownTimer = null;
  }
}

async function executeIdleShutdown(t: IdleTracker, containerIp: string) {
  if (t.idleStartedAt === null) return; // cancelled before firing

  t.idleStartedAt = null;
  t.shutdownTimer = null;

  notifyIntentionalShutdown(t.containerId);
  await gracefulStop(containerIp, t.restPort, t.restPassword,
    "Server is shutting down (no players).");
  insertChatMessage(t.containerId, null, "Server is shutting down (no players).");

  // Give the game server a moment to process the stop command
  await new Promise((res) => setTimeout(res, 3000));

  await stopContainer(t.containerId);

  disarmIdleShutdown(t.containerId);
  clearIdleSince(t.containerId);

  logAudit("IDLE_SHUTDOWN", {
    containerName: t.containerName,
    details: "Idle auto-shutdown executed",
  });

  console.log(`[idle] ${t.containerName} stopped due to idle timeout`);
}
