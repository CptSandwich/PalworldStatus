import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

const DB_PATH = process.env.DB_PATH ?? "/app/data/palworld-status.db";
const LOCATION_DB_PATH = process.env.LOCATION_DB_PATH ?? "/app/data/palworld-location.db";

let db: Database;
let locationDb: Database;

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

export function getLocationDb(): Database {
  if (!locationDb) {
    mkdirSync(dirname(LOCATION_DB_PATH), { recursive: true });
    locationDb = new Database(LOCATION_DB_PATH, { create: true });
    locationDb.run("PRAGMA journal_mode = WAL");
    initLocationSchema();
  }
  return locationDb;
}

function initLocationSchema() {
  locationDb.run(`
    CREATE TABLE IF NOT EXISTS location_grid (
      container_id   TEXT NOT NULL,
      player_id      TEXT NOT NULL,
      steam_id       TEXT,
      character_name TEXT,
      grid_data      BLOB NOT NULL,
      PRIMARY KEY (container_id, player_id)
    )
  `);
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
      steam_id      TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      character_name TEXT,
      first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
      last_server   TEXT,
      status        TEXT NOT NULL DEFAULT 'blacklisted'
    )
  `);

  // Migrate existing known_players table: add columns if missing
  const migrations = [
    "ALTER TABLE known_players ADD COLUMN character_name TEXT",
    "ALTER TABLE known_players ADD COLUMN last_container_id TEXT",
    "ALTER TABLE known_players ADD COLUMN level INTEGER",
    "ALTER TABLE known_players ADD COLUMN build_object_count INTEGER",
    "ALTER TABLE known_players ADD COLUMN game_banned INTEGER NOT NULL DEFAULT 0",
  ];
  for (const sql of migrations) {
    try { db.run(sql); } catch { /* column already exists */ }
  }

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

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id  TEXT NOT NULL,
      timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
      player_name   TEXT,
      message       TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_chat_log_container
      ON chat_log(container_id, id DESC)
  `);


  db.run(`
    CREATE TABLE IF NOT EXISTS map_calibration (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      p1_world_x REAL NOT NULL, p1_world_y REAL NOT NULL,
      p1_frac_x  REAL NOT NULL, p1_frac_y  REAL NOT NULL,
      p2_world_x REAL NOT NULL, p2_world_y REAL NOT NULL,
      p2_frac_x  REAL NOT NULL, p2_frac_y  REAL NOT NULL,
      scale_x    REAL NOT NULL, offset_x   REAL NOT NULL,
      scale_y    REAL NOT NULL, offset_y   REAL NOT NULL
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
  character_name: string | null;
  first_seen: string;
  last_seen: string;
  last_server: string | null;
  last_container_id: string | null;
  level: number | null;
  status: "whitelisted" | "blacklisted";
  game_banned: number; // 1 if banned via this app's Ban button, 0 otherwise
}

export function upsertPlayer(
  steamId: string,
  characterName: string,
  serverName: string,
  containerId: string,
  level: number
) {
  getDb().run(
    `INSERT INTO known_players
       (steam_id, display_name, character_name, last_seen, last_server, last_container_id, level)
     VALUES (?, '', ?, datetime('now'), ?, ?, ?)
     ON CONFLICT(steam_id) DO UPDATE SET
       character_name      = excluded.character_name,
       last_seen           = excluded.last_seen,
       last_server         = excluded.last_server,
       last_container_id   = excluded.last_container_id,
       level               = excluded.level`,
    [steamId, characterName, serverName, containerId, level]
  );
}

export function getKnownPlayersByContainer(containerId: string): KnownPlayer[] {
  return getDb()
    .query(`SELECT * FROM known_players WHERE last_container_id = ? ORDER BY last_seen DESC`)
    .all(containerId) as KnownPlayer[];
}

/** Upsert a player from Steam auth — updates display_name (Steam name) and last_seen only,
 *  preserving last_server and character_name if already set. */
export function upsertPlayerAuth(steamId: string, displayName: string) {
  getDb().run(
    `INSERT INTO known_players (steam_id, display_name, last_seen)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(steam_id) DO UPDATE SET
       display_name = excluded.display_name,
       last_seen    = excluded.last_seen`,
    [steamId, displayName]
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

export function setGameBanned(steamId: string, banned: boolean) {
  getDb().run(
    `UPDATE known_players SET game_banned = ? WHERE steam_id = ?`,
    [banned ? 1 : 0, steamId]
  );
}

export function deletePlayer(steamId: string) {
  getDb().run(`DELETE FROM known_players WHERE steam_id = ?`, [steamId]);
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

// ── Chat log ──────────────────────────────────────────────────────────────────

export interface ChatEntry {
  id: number;
  container_id: string;
  timestamp: string;
  player_name: string | null;
  message: string;
}

export function insertChatMessage(
  containerId: string,
  playerName: string | null,
  message: string
) {
  try {
    getDb().run(
      `INSERT INTO chat_log (container_id, player_name, message) VALUES (?, ?, ?)`,
      [containerId, playerName ?? null, message]
    );
  } catch (err) {
    console.warn("[db] Failed to insert chat message:", err);
  }
}

export function getChatLog(containerId: string, limit = 100): ChatEntry[] {
  const rows = getDb()
    .query(`SELECT * FROM chat_log WHERE container_id = ? ORDER BY id DESC LIMIT ?`)
    .all(containerId, limit) as ChatEntry[];
  return rows.reverse();
}

// ── Location grid (marching squares fog-of-war) ────────────────────────────

export const GRID_SIZE  = 2048;
export const GRID_BYTES = (GRID_SIZE * GRID_SIZE) >> 3; // 524 288 bytes = 512 KB
const GRID_CELL_SIZE    = 1_447_840 / GRID_SIZE;        // ~706.96 world units per cell
const WORLD_MIN_X       = -999_940;                     // locationX (north-south) min
const WORLD_MIN_Y       = -738_920;                     // locationY (east-west) min

function setCell(grid: Uint8Array, col: number, row: number): void {
  if (col < 0 || col >= GRID_SIZE || row < 0 || row >= GRID_SIZE) return;
  const bit = row * GRID_SIZE + col;
  grid[bit >> 3] |= 1 << (bit & 7);
}

function markCircle(grid: Uint8Array, col: number, row: number, radius: number): void {
  const r2 = radius * radius;
  for (let dr = -radius; dr <= radius; dr++)
    for (let dc = -radius; dc <= radius; dc++)
      if (dr * dr + dc * dc <= r2) setCell(grid, col + dc, row + dr);
}

export function worldToGridCoords(locationX: number, locationY: number): { col: number; row: number } {
  return {
    col: Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((locationY - WORLD_MIN_Y) / GRID_CELL_SIZE))),
    row: Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((locationX - WORLD_MIN_X) / GRID_CELL_SIZE))),
  };
}

export function markGridPath(
  grid: Uint8Array,
  col1: number, row1: number,
  col2: number, row2: number,
  radius: number
): void {
  const steps = Math.max(Math.abs(col2 - col1), Math.abs(row2 - row1));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    markCircle(grid, Math.round(col1 + (col2 - col1) * t), Math.round(row1 + (row2 - row1) * t), radius);
  }
}

export function getLocationGrid(containerId: string, playerId: string): Uint8Array {
  const row = getLocationDb()
    .query(`SELECT grid_data FROM location_grid WHERE container_id = ? AND player_id = ?`)
    .get(containerId, playerId) as { grid_data: Buffer } | null;
  if (!row?.grid_data) return new Uint8Array(GRID_BYTES);
  return new Uint8Array(row.grid_data.buffer, row.grid_data.byteOffset, row.grid_data.byteLength);
}

export function saveLocationGrid(
  containerId: string, playerId: string,
  steamId: string, characterName: string,
  grid: Uint8Array
): void {
  getLocationDb().run(
    `INSERT INTO location_grid (container_id, player_id, steam_id, character_name, grid_data)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(container_id, player_id) DO UPDATE SET
       steam_id = excluded.steam_id,
       character_name = excluded.character_name,
       grid_data = excluded.grid_data`,
    [containerId, playerId, steamId, characterName, grid]
  );
}

export function getAllLocationGrids(containerId: string): {
  playerId: string; steamId: string; characterName: string | null; gridData: Buffer
}[] {
  const rows = getLocationDb()
    .query(`SELECT player_id, steam_id, character_name, grid_data FROM location_grid WHERE container_id = ?`)
    .all(containerId) as { player_id: string; steam_id: string; character_name: string | null; grid_data: Buffer }[];
  return rows.map(r => ({ playerId: r.player_id, steamId: r.steam_id, characterName: r.character_name, gridData: r.grid_data }));
}

// ── Map calibration ────────────────────────────────────────────────────────────

export interface MapCalibData {
  scaleX: number; offsetX: number;
  scaleY: number; offsetY: number;
  p1WorldX: number; p1WorldY: number; p1FracX: number; p1FracY: number;
  p2WorldX: number; p2WorldY: number; p2FracX: number; p2FracY: number;
}

export function getMapCalibration(): MapCalibData | null {
  const row = getDb().query(`SELECT * FROM map_calibration WHERE id = 1`).get() as Record<string, number> | null;
  if (!row) return null;
  return {
    scaleX: row.scale_x,   offsetX: row.offset_x,
    scaleY: row.scale_y,   offsetY: row.offset_y,
    p1WorldX: row.p1_world_x, p1WorldY: row.p1_world_y,
    p1FracX:  row.p1_frac_x,  p1FracY:  row.p1_frac_y,
    p2WorldX: row.p2_world_x, p2WorldY: row.p2_world_y,
    p2FracX:  row.p2_frac_x,  p2FracY:  row.p2_frac_y,
  };
}

export function saveMapCalibration(
  p1: { worldX: number; worldY: number; fracX: number; fracY: number },
  p2: { worldX: number; worldY: number; fracX: number; fracY: number },
  scaleX: number, offsetX: number,
  scaleY: number, offsetY: number,
) {
  getDb().run(
    `INSERT INTO map_calibration
       (id, p1_world_x, p1_world_y, p1_frac_x, p1_frac_y,
            p2_world_x, p2_world_y, p2_frac_x, p2_frac_y,
            scale_x, offset_x, scale_y, offset_y)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       p1_world_x=excluded.p1_world_x, p1_world_y=excluded.p1_world_y,
       p1_frac_x=excluded.p1_frac_x,   p1_frac_y=excluded.p1_frac_y,
       p2_world_x=excluded.p2_world_x, p2_world_y=excluded.p2_world_y,
       p2_frac_x=excluded.p2_frac_x,   p2_frac_y=excluded.p2_frac_y,
       scale_x=excluded.scale_x, offset_x=excluded.offset_x,
       scale_y=excluded.scale_y, offset_y=excluded.offset_y`,
    [p1.worldX, p1.worldY, p1.fracX, p1.fracY,
     p2.worldX, p2.worldY, p2.fracX, p2.fracY,
     scaleX, offsetX, scaleY, offsetY],
  );
}

export function clearMapCalibration() {
  getDb().run(`DELETE FROM map_calibration WHERE id = 1`);
}
