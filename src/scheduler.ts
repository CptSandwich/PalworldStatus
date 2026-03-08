// Scheduled restart manager
//
// Loads restart_schedules from DB on startup and registers node-cron jobs.
// Pre-restart broadcast sequence (derived from next cron fire time):
//   -10 min  "Server restarting in 10 minutes."
//   -5 min   "Server restarting in 5 minutes."
//   -3 min   "Server restarting in 3 minutes."
//   -2 min   "Server restarting in 2 minutes."
//   -1 min   "Server restarting in 1 minute."
//   -30 sec  "Server restarting in 30 seconds."
//   T+0      graceful stop → Docker restart → log
//
// sent_warnings is a bitmask to prevent duplicate broadcasts after app restart:
//   bit 0 = 10 min warning sent
//   bit 1 = 5 min warning sent
//   bit 2 = 3 min warning sent
//   bit 3 = 2 min warning sent
//   bit 4 = 1 min warning sent
//   bit 5 = 30 sec warning sent

import cron from "node-cron";
import {
  getAllSchedules,
  resetScheduleWarnings,
  updateSentWarnings,
  logAudit,
} from "./db.js";
import { getContainerIP, restartContainer, discoverPalworldContainers } from "./docker.js";
import { broadcast, gracefulStop } from "./palworld.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WarningDef {
  bit: number;
  offsetMs: number;   // ms before restart
  message: string;
}

const WARNINGS: WarningDef[] = [
  { bit: 0, offsetMs: 10 * 60_000, message: "Server restarting in 10 minutes." },
  { bit: 1, offsetMs:  5 * 60_000, message: "Server restarting in 5 minutes."  },
  { bit: 2, offsetMs:  3 * 60_000, message: "Server restarting in 3 minutes."  },
  { bit: 3, offsetMs:  2 * 60_000, message: "Server restarting in 2 minutes."  },
  { bit: 4, offsetMs:  1 * 60_000, message: "Server restarting in 1 minute."   },
  { bit: 5, offsetMs:    30_000,   message: "Server restarting in 30 seconds." },
];

interface ScheduleJob {
  containerId: string;
  containerName: string;
  cronTask: cron.ScheduledTask;
  warningTimers: ReturnType<typeof setTimeout>[];
}

// ── State ─────────────────────────────────────────────────────────────────────

const jobs = new Map<string, ScheduleJob>();

// ── Public API ────────────────────────────────────────────────────────────────

/** Load all schedules from DB and register cron jobs. Call once at startup. */
export function initScheduler() {
  const schedules = getAllSchedules();
  for (const s of schedules) {
    if (s.enabled) {
      registerJob(s.container_id, s.cron_expr, s.sent_warnings);
    }
  }
  console.log(`[scheduler] Initialised ${jobs.size} restart schedule(s)`);
}

/** Reload a single container's schedule (after admin creates/updates/deletes it). */
export function reloadSchedule(
  containerId: string,
  cronExpr: string | null,
  enabled: boolean
) {
  // Tear down existing job if any
  cancelJob(containerId);

  if (enabled && cronExpr) {
    registerJob(containerId, cronExpr, 0);
  }
}

/** Remove a schedule entirely. */
export function cancelJob(containerId: string) {
  const job = jobs.get(containerId);
  if (!job) return;
  job.cronTask.stop();
  for (const t of job.warningTimers) clearTimeout(t);
  jobs.delete(containerId);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function registerJob(containerId: string, cronExpr: string, sentWarningsMask: number) {
  if (!cron.validate(cronExpr)) {
    console.warn(`[scheduler] Invalid cron expression for ${containerId}: "${cronExpr}"`);
    return;
  }

  let containerName = containerId; // fallback

  const task = cron.schedule(cronExpr, async () => {
    // Discover fresh container info for IP + credentials
    try {
      const containers = await discoverPalworldContainers();
      const c = containers.find((x) => x.id === containerId);
      if (!c) {
        console.warn(`[scheduler] Container ${containerId} not found at restart time`);
        return;
      }
      if (c.status !== "running") {
        console.log(`[scheduler] Skipping restart for ${c.displayName} — container not running (status: ${c.status})`);
        return;
      }
      containerName = c.displayName;

      const ip = await getContainerIP(containerId);
      if (ip) {
        await gracefulStop(ip, c.restPort, c.restPassword, "Scheduled server restart.");
        await new Promise((res) => setTimeout(res, 3000));
      }

      await restartContainer(containerId);

      logAudit("SCHEDULED_RESTART", {
        containerName: c.displayName,
        details: `cron="${cronExpr}"`,
      });

      console.log(`[scheduler] Restarted ${c.displayName}`);

      // Reset warnings for next cycle
      const nextRun = getNextCronDate(cronExpr);
      resetScheduleWarnings(containerId, nextRun.toISOString());

      // Schedule next round of warnings
      scheduleWarnings(containerId, containerName, cronExpr, 0);
    } catch (err) {
      console.error(`[scheduler] Error during restart of ${containerId}:`, err);
    }
  });

  // Derive and schedule pre-restart warnings based on next fire time
  // Re-resolve container name asynchronously (best effort)
  discoverPalworldContainers()
    .then((cs) => {
      const c = cs.find((x) => x.id === containerId);
      if (c) containerName = c.displayName;
    })
    .catch(() => {});

  const warningTimers = scheduleWarnings(containerId, containerName, cronExpr, sentWarningsMask);

  jobs.set(containerId, { containerId, containerName, cronTask: task, warningTimers });
}

function scheduleWarnings(
  containerId: string,
  containerName: string,
  cronExpr: string,
  sentWarningsMask: number
): ReturnType<typeof setTimeout>[] {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const nextRun = getNextCronDate(cronExpr);
  const now = Date.now();

  for (const w of WARNINGS) {
    // Skip if already sent (crash-recovery)
    if (sentWarningsMask & (1 << w.bit)) continue;

    const fireAt = nextRun.getTime() - w.offsetMs;
    const delay = fireAt - now;
    if (delay <= 0) continue; // missed window

    const timer = setTimeout(async () => {
      try {
        const containers = await discoverPalworldContainers();
        const c = containers.find((x) => x.id === containerId);
        if (!c) return;

        const ip = await getContainerIP(containerId);
        if (!ip) return;

        await broadcast(ip, c.restPort, c.restPassword, w.message);

        // Record that we sent this warning
        const current = getAllSchedules().find((s) => s.container_id === containerId);
        if (current) {
          updateSentWarnings(containerId, current.sent_warnings | (1 << w.bit));
        }
      } catch (err) {
        console.error(`[scheduler] Warning broadcast error for ${containerName}:`, err);
      }
    }, delay);

    timers.push(timer);
  }

  return timers;
}

/**
 * Returns the next Date that the cron expression would fire.
 * node-cron doesn't expose this directly, so we parse manually.
 */
function getNextCronDate(cronExpr: string): Date {
  // Use the cron task to get next date by creating a temporary task
  // node-cron doesn't expose nextDate(), so we compute it via a simple
  // next-minute-aligned approximation based on schedule parsing.
  //
  // For warning scheduling accuracy, we parse the cron expression fields.
  // A full cron parser is overkill here — we leverage the fact that our
  // schedules are typically daily (e.g. "0 4 * * *").
  //
  // We use a rolling search: advance by 1 minute until cron matches.
  const now = new Date();
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to 8 days (covers weekly crons)
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (cronMatches(cronExpr, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  // Fallback: 24h from now (shouldn't happen with valid cron)
  return new Date(Date.now() + 24 * 60 * 60_000);
}

function cronMatches(expr: string, date: Date): boolean {
  // Split into standard 5 fields: minute hour dom month dow
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;

  const min  = date.getMinutes();
  const hour = date.getHours();
  const dom  = date.getDate();
  const mon  = date.getMonth() + 1; // 1-based
  const dow  = date.getDay();       // 0=Sun

  return (
    fieldMatches(minF,  min,  0, 59) &&
    fieldMatches(hourF, hour, 0, 23) &&
    fieldMatches(domF,  dom,  1, 31) &&
    fieldMatches(monF,  mon,  1, 12) &&
    fieldMatches(dowF,  dow,  0,  6)
  );
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return true;

  // Step: */n or start/n
  if (field.includes("/")) {
    const [range, step] = field.split("/");
    const stepN = parseInt(step, 10);
    let start = min;
    if (range !== "*") start = parseInt(range, 10);
    if (isNaN(stepN) || stepN <= 0) return false;
    return value >= start && (value - start) % stepN === 0;
  }

  // List: a,b,c
  if (field.includes(",")) {
    return field.split(",").some((f) => fieldMatches(f.trim(), value, min, max));
  }

  // Range: a-b
  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map(Number);
    return value >= lo && value <= hi;
  }

  // Literal
  return parseInt(field, 10) === value;
}
