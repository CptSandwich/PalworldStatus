import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

const DB_PATH = process.env.DB_PATH ?? "/app/data/palworld-status.db";

let db: Database;

export function getDb(): Database {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    initSchema();
  }
  return db;
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT    NOT NULL DEFAULT (datetime('now')),
      steam_id    TEXT,
      display_name TEXT,
      action      TEXT    NOT NULL,
      container_name TEXT,
      details     TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS known_players (
      steam_id     TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen    TEXT NOT NULL DEFAULT (datetime('now')),
      last_server  TEXT,
      status       TEXT NOT NULL DEFAULT 'blacklisted'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS restart_schedules (
      container_id  TEXT PRIMARY KEY,
      cron_expr     TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      sent_warnings INTEGER NOT NULL DEFAULT 0,
      next_run      TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS idle_state (
      container_id TEXT PRIMARY KEY,
      armed        INTEGER NOT NULL DEFAULT 0,
      idle_since   TEXT,
      shutdown_at  TEXT
    )
  `);
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  timestamp: string;
  steam_id: string | null;
  display_name: string | null;
  action: string;
  container_name: string | null;
  details: string | null;
}

export function logAudit(
  action: string,
  opts: {
    steamId?: string;
    displayName?: string;
    containerName?: string;
    details?: string;
  } = {}
) {
  getDb().run(
    `INSERT INTO audit_log (steam_id, display_name, action, container_name, details)
     VALUES (?, ?, ?, ?, ?)`,
    [
      opts.steamId ?? null,
      opts.displayName ?? null,
      action,
      opts.containerName ?? null,
      opts.details ?? null,
    ]
  );
}

export function getRecentAuditLog(limit = 50): AuditEntry[] {
  return getDb()
    .query(
      `SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as AuditEntry[];
}

// ── Known players ─────────────────────────────────────────────────────────────

export interface KnownPlayer {
  steam_id: string;
  display_name: string;
  first_seen: string;
  last_seen: string;
  last_server: string | null;
  status: "whitelisted" | "blacklisted";
}

export function upsertPlayer(
  steamId: string,
  displayName: string,
  serverName: string
) {
  getDb().run(
    `INSERT INTO known_players (steam_id, display_name, last_seen, last_server)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(steam_id) DO UPDATE SET
       display_name = excluded.display_name,
       last_seen    = excluded.last_seen,
       last_server  = excluded.last_server`,
    [steamId, displayName, serverName]
  );
}

export function getPlayerStatus(
  steamId: string
): "whitelisted" | "blacklisted" | null {
  const row = getDb()
    .query(`SELECT status FROM known_players WHERE steam_id = ?`)
    .get(steamId) as { status: string } | null;
  return (row?.status as "whitelisted" | "blacklisted") ?? null;
}

export function getAllPlayers(): KnownPlayer[] {
  return getDb()
    .query(`SELECT * FROM known_players ORDER BY last_seen DESC`)
    .all() as KnownPlayer[];
}

export function setPlayerStatus(
  steamId: string,
  status: "whitelisted" | "blacklisted"
) {
  getDb().run(
    `UPDATE known_players SET status = ? WHERE steam_id = ?`,
    [status, steamId]
  );
}

// ── Restart schedules ─────────────────────────────────────────────────────────

export interface RestartSchedule {
  container_id: string;
  cron_expr: string;
  enabled: number;
  sent_warnings: number;
  next_run: string | null;
}

export function getSchedule(containerId: string): RestartSchedule | null {
  return getDb()
    .query(`SELECT * FROM restart_schedules WHERE container_id = ?`)
    .get(containerId) as RestartSchedule | null;
}

export function getAllSchedules(): RestartSchedule[] {
  return getDb()
    .query(`SELECT * FROM restart_schedules`)
    .all() as RestartSchedule[];
}

export function upsertSchedule(
  containerId: string,
  cronExpr: string,
  enabled: boolean,
  nextRun?: string
) {
  getDb().run(
    `INSERT INTO restart_schedules (container_id, cron_expr, enabled, sent_warnings, next_run)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(container_id) DO UPDATE SET
       cron_expr     = excluded.cron_expr,
       enabled       = excluded.enabled,
       next_run      = excluded.next_run,
       sent_warnings = 0`,
    [containerId, cronExpr, enabled ? 1 : 0, nextRun ?? null]
  );
}

export function deleteSchedule(containerId: string) {
  getDb().run(
    `DELETE FROM restart_schedules WHERE container_id = ?`,
    [containerId]
  );
}

export function updateSentWarnings(containerId: string, mask: number) {
  getDb().run(
    `UPDATE restart_schedules SET sent_warnings = ? WHERE container_id = ?`,
    [mask, containerId]
  );
}

export function resetScheduleWarnings(containerId: string, nextRun: string) {
  getDb().run(
    `UPDATE restart_schedules SET sent_warnings = 0, next_run = ? WHERE container_id = ?`,
    [nextRun, containerId]
  );
}

// ── Idle state ────────────────────────────────────────────────────────────────

export interface IdleState {
  container_id: string;
  armed: number;
  idle_since: string | null;
  shutdown_at: string | null;
}

export function getIdleState(containerId: string): IdleState | null {
  return getDb()
    .query(`SELECT * FROM idle_state WHERE container_id = ?`)
    .get(containerId) as IdleState | null;
}

export function armIdleShutdown(containerId: string) {
  getDb().run(
    `INSERT INTO idle_state (container_id, armed, idle_since, shutdown_at)
     VALUES (?, 1, NULL, NULL)
     ON CONFLICT(container_id) DO UPDATE SET
       armed = 1, idle_since = NULL, shutdown_at = NULL`,
    [containerId]
  );
}

export function disarmIdleShutdown(containerId: string) {
  getDb().run(
    `INSERT INTO idle_state (container_id, armed, idle_since, shutdown_at)
     VALUES (?, 0, NULL, NULL)
     ON CONFLICT(container_id) DO UPDATE SET
       armed = 0, idle_since = NULL, shutdown_at = NULL`,
    [containerId]
  );
}

export function setIdleSince(containerId: string, idleSince: string, shutdownAt: string) {
  getDb().run(
    `UPDATE idle_state SET idle_since = ?, shutdown_at = ? WHERE container_id = ?`,
    [idleSince, shutdownAt, containerId]
  );
}

export function clearIdleSince(containerId: string) {
  getDb().run(
    `UPDATE idle_state SET idle_since = NULL, shutdown_at = NULL WHERE container_id = ?`,
    [containerId]
  );
}

export function getAllArmedIdleStates(): IdleState[] {
  return getDb()
    .query(`SELECT * FROM idle_state WHERE armed = 1`)
    .all() as IdleState[];
}
