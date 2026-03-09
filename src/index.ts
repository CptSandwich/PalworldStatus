import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import {
  handleSteamLogin,
  handleSteamCallback,
  handleLogout,
  handleMe,
  requireWhitelisted,
  requireAdmin,
  getCurrentUser,
} from "./auth.js";
import {
  discoverPalworldContainers,
  getContainerIP,
  startContainer,
  stopContainer,
  restartContainer,
} from "./docker.js";
import { getServerInfo, getPlayers, getMetrics, broadcast, gracefulStop, kickPlayer, banPlayer, unbanPlayer } from "./palworld.js";
import {
  logAudit,
  getRecentAuditLog,
  upsertPlayer,
  upsertPlayerAuth,
  getAllPlayers,
  getAllPlayerServerNames,
  getKnownPlayersByContainer,
  setPlayerStatus,
  setGameBanned,
  deletePlayer,
  getAllSchedules,
  upsertSchedule,
  deleteSchedule,
  getDb,
  getChatLog,
  insertChatMessage,
  getLocationGrid,
  saveLocationGrid,
  getAllLocationGrids,
  worldToGridCoords,
  markGridPath,
  getMapCalibration,
  saveMapCalibration,
  clearMapCalibration,
  upsertContainerMeta,
  getAllContainerMeta,
} from "./db.js";
import {
  registerIdleTracker,
  armIdle,
  updateIdleState,
  getIdleCountdownSeconds,
  cancelIdleManual,
  recoverIdleStates,
} from "./idle.js";
import { initScheduler, reloadSchedule, cancelJob } from "./scheduler.js";
import { initChatLogStreams, startChatLogStream, registerChatHandler, unregisterChatHandler } from "./chatlog.js";
import { MAP_CALIBRATION } from "./map.js";
import { notifyCrashed, notifyOnline, notifyStopped, getCrashGuardInfo } from "./crashguard.js";

// ── In-memory state (declared early for bootstrap use) ────────────────────────

// Cache of last known API-reported server names and versions (populated when server is online)
const apiNameCache    = new Map<string, string>();
const apiVersionCache = new Map<string, string>();

// Track when each container first appeared as Docker-running so we can give the
// game server a grace period to start before classifying it as "crashed"
const containerFirstRunningAt = new Map<string, number>();
const GAME_STARTUP_GRACE_MS = 2 * 60_000; // 2 minutes

// Containers that have had at least one successful REST API response this session.
// Used to skip the startup grace period when REST goes away (shutdown/crash), so
// the server never briefly shows "Starting" after it was already "Online".
const containerWasOnline = new Set<string>();

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Init DB (creates tables and runs migrations)
getDb();

// Pre-populate in-memory caches from persisted container meta
for (const row of getAllContainerMeta()) {
  if (row.version)     apiVersionCache.set(row.container_id, row.version);
  if (row.server_name) apiNameCache.set(row.container_id, row.server_name);
}

// Recover idle state from DB across restarts
recoverIdleStates();

// Start scheduled restart jobs
initScheduler();

// Discover running containers and start chat log streaming + player pre-population
discoverPalworldContainers()
  .then((containers) => initChatLogStreams(containers))
  .catch((err) => console.warn("[startup] Chat log init failed:", err));

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono();

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get("/auth/steam", handleSteamLogin);
app.get("/auth/steam/callback", handleSteamCallback);
app.post("/auth/logout", handleLogout);
app.get("/auth/me", handleMe);

// ── Status API ────────────────────────────────────────────────────────────────

const PUBLIC_HOST = process.env.PUBLIC_HOST ?? "localhost";

// In-memory tracking for grid-based location history
// Key: `${containerId}:${steamId}` → last recorded grid position + world coords
const lastGridPositions = new Map<string, { worldX: number; worldY: number; col: number; row: number; recentSpeeds: number[] }>();
const CLOUD_RADIUS_CELLS       = 7;        // storage grid cells radius per point (~50m)
const MAX_TELEPORT_WORLD_UNITS = 50_000;   // skip interpolation if jump exceeds ~1.5× Jetragon max
const SPEED_JUMP_MULTIPLIER    = 4;        // current speed must be 4× rolling avg to suspect teleport
const MIN_SPEED_TELEPORT       = 8_000;    // min distance (world units) to apply speed-continuity check

app.get("/api/status", requireWhitelisted, async (c) => {
  const containers = await discoverPalworldContainers();

  const results = await Promise.all(
    containers.map(async (container) => {
      // Register idle tracker (no-op if already registered)
      registerIdleTracker({
        containerId: container.id,
        containerName: apiNameCache.get(container.id) ?? container.name,
        restPort: container.restPort,
        restPassword: container.restPassword,
        idleShutdownMinutes: container.idleShutdownMinutes,
      });

      if (container.status !== "running") {
        // Container stopped/restarting — clear grace period tracking and crash guard
        containerFirstRunningAt.delete(container.id);
        containerWasOnline.delete(container.id); // reset so next startup gets grace period
        notifyStopped(container.id);
        return {
          id: container.id,
          serverId: container.serverId,
          name: apiNameCache.get(container.id) ?? container.name,
          dockerStatus: container.status,
          gameStatus: "offline" as const,
          version: apiVersionCache.get(container.id) ?? null,
          containerName: container.name,
          players: [],
          maxPlayers: null,
          connectionAddress: `${PUBLIC_HOST}:${container.gamePort ?? 8211}`,
          gamePort: container.gamePort,
          allowStart: container.allowStart,
          idleShutdownMinutes: container.idleShutdownMinutes ?? null,
          idleCountdownSeconds: null,
          pendingTimedAction: getPendingTimedAction(container.id),
          crashGuard: null,
          joinPassword: container.joinPassword,
        };
      }

      // Record when this container first appeared as running (for startup grace period)
      if (!containerFirstRunningAt.has(container.id)) {
        containerFirstRunningAt.set(container.id, Date.now());
      }

      const ip = await getContainerIP(container.id);
      if (!ip) {
        console.warn(`[status] ${container.name} (${container.id.slice(0, 12)}) → could not resolve container IP`);
      }

      const [info, players, metrics] = await Promise.all([
        ip ? getServerInfo(ip, container.restPort, container.restPassword) : null,
        ip ? getPlayers(ip, container.restPort, container.restPassword) : null,
        ip ? getMetrics(ip, container.restPort, container.restPassword) : null,
      ]);

      let gameStatus: "online" | "starting" | "crashed";
      if (info) {
        gameStatus = "online";
        containerFirstRunningAt.delete(container.id); // grace period no longer needed
        containerWasOnline.add(container.id);
        notifyOnline(container.id);
      } else if (containerWasOnline.has(container.id)) {
        // Container was previously online — REST going away means shutdown or crash, not startup
        gameStatus = "crashed";
        if (ip) {
          console.warn(`[status] ${container.name} → gameStatus=crashed (REST API gone after prior online state)`);
          notifyCrashed(container.id, container.name);
        }
      } else {
        const startedAt = containerFirstRunningAt.get(container.id) ?? Date.now();
        const elapsed = Date.now() - startedAt;
        if (elapsed < GAME_STARTUP_GRACE_MS) {
          gameStatus = "starting";
          console.log(`[status] ${container.name} → gameStatus=starting (${Math.round(elapsed / 1000)}s elapsed)`);
        } else {
          gameStatus = "crashed";
          if (ip) {
            console.warn(`[status] ${container.name} → gameStatus=crashed (REST API unreachable at ${ip}:${container.restPort})`);
            notifyCrashed(container.id, container.name);
          }
        }
      }

      // Cache server name and version for display when server goes offline, and persist to DB
      if (info?.serverName || info?.version) {
        if (info.serverName) apiNameCache.set(container.id, info.serverName);
        if (info.version)    apiVersionCache.set(container.id, info.version);
        upsertContainerMeta(container.id, info.version ?? apiVersionCache.get(container.id) ?? null, info.serverName ?? apiNameCache.get(container.id) ?? null);
      }
      const displayName = apiNameCache.get(container.id) ?? container.name;

      // Update player DB records, idle state, and location history
      if (players) {
        for (const p of players) {
          if (p.userId) {
            upsertPlayer(p.userId, p.name, displayName, container.id, p.level ?? 0);
            // Populate Steam display name from the API's accountName field
            if (p.accountName) upsertPlayerAuth(p.userId, p.accountName);

            // Track location history (grid-based, with teleport detection + path interpolation)
            if (p.location_x !== undefined && p.location_y !== undefined && p.userId) {
              const key = `${container.id}:${p.userId}`;
              const last = lastGridPositions.get(key);
              const { col: newCol, row: newRow } = worldToGridCoords(p.location_x, p.location_y);

              // Compute distance regardless of grid-cell change (needed for speed history)
              const dx   = last ? p.location_x - last.worldX : 0;
              const dy   = last ? p.location_y - last.worldY : 0;
              const dist = last ? Math.sqrt(dx * dx + dy * dy) : 0;

              if (!last || last.col !== newCol || last.row !== newRow) {
                const grid = getLocationGrid(container.id, p.userId);
                if (!last) {
                  markGridPath(grid, newCol, newRow, newCol, newRow, CLOUD_RADIUS_CELLS);
                } else {
                  let isTeleport = dist >= MAX_TELEPORT_WORLD_UNITS;
                  if (!isTeleport && dist >= MIN_SPEED_TELEPORT && last.recentSpeeds.length >= 2) {
                    const avgSpeed = last.recentSpeeds.reduce((a, b) => a + b, 0) / last.recentSpeeds.length;
                    if (avgSpeed > 0 && dist > SPEED_JUMP_MULTIPLIER * avgSpeed) isTeleport = true;
                  }
                  if (isTeleport) {
                    markGridPath(grid, newCol, newRow, newCol, newRow, CLOUD_RADIUS_CELLS);
                  } else {
                    markGridPath(grid, last.col, last.row, newCol, newRow, CLOUD_RADIUS_CELLS);
                  }
                }
                saveLocationGrid(container.id, p.userId, grid);
              }

              const updatedSpeeds = last ? [...last.recentSpeeds.slice(-1), dist] : [];
              lastGridPositions.set(key, { worldX: p.location_x, worldY: p.location_y, col: newCol, row: newRow, recentSpeeds: updatedSpeeds });
            }
          }
        }
        if (ip) {
          await updateIdleState(container.id, players.length, ip);
        }
      }

      return {
        id: container.id,
        serverId: container.serverId,
        name: displayName,
        containerName: container.name,
        dockerStatus: container.status,
        gameStatus,
        version: info?.version ?? null,
        players: (players ?? []).map((p) => ({
          steamId: p.userId,
          playerId: p.playerId,
          name: p.name,
          level: p.level,
          locationX: p.location_x,
          locationY: p.location_y,
          ping: p.ping,
        })),
        metrics: metrics ? {
          fps: metrics.serverfps,
          frameTime: metrics.serverframetime,
          uptime: metrics.uptime,
          days: metrics.days,
        } : null,
        maxPlayers: info?.maxplayers ?? null,
        connectionAddress: `${PUBLIC_HOST}:${container.gamePort ?? 8211}`,
        gamePort: container.gamePort,
        allowStart: container.allowStart,
        idleShutdownMinutes: container.idleShutdownMinutes ?? null,
        idleCountdownSeconds: getIdleCountdownSeconds(container.id),
        pendingTimedAction: getPendingTimedAction(container.id),
        crashGuard: getCrashGuardInfo(container.id),
        joinPassword: container.joinPassword,
      };
    })
  );

  // Deduplicate server names: if two servers share a name, append (2), (3), …
  const nameCounts = new Map<string, number>();
  for (const r of results) nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1);
  const nameSeenSoFar = new Map<string, number>();
  for (const r of results) {
    if ((nameCounts.get(r.name) ?? 0) > 1) {
      const n = (nameSeenSoFar.get(r.name) ?? 0) + 1;
      nameSeenSoFar.set(r.name, n);
      if (n > 1) r.name = `${r.name} (${n})`;
    }
  }

  return c.json({ servers: results });
});

// ── Audit log ─────────────────────────────────────────────────────────────────

app.get("/api/audit-log", requireWhitelisted, (c) => {
  return c.json({ entries: getRecentAuditLog(50) });
});

// ── Container actions ─────────────────────────────────────────────────────────

app.post("/api/containers/:id/restart", requireWhitelisted, async (c) => {
  const user = getCurrentUser(c)!;
  const containerId = c.req.param("id");

  const containers = await discoverPalworldContainers();
  const container = containers.find((x) => x.id === containerId);
  if (!container) return c.json({ error: "Not found" }, 404);

  if (user.role === "admin") {
    // Admin: immediate restart with a brief broadcast
    const ip = await getContainerIP(containerId);
    if (ip) {
      await broadcast(ip, container.restPort, container.restPassword,
        "Server is restarting now.");
      insertChatMessage(containerId, null, "Server is restarting now.");
      await new Promise((res) => setTimeout(res, 1000));
    }
    await restartContainer(containerId);
    logAudit("RESTART", {
      steamId: user.steamId,
      displayName: user.displayName,
      containerName: apiNameCache.get(containerId) ?? container.name,
      details: "immediate (admin)",
    });
  } else {
    // Whitelisted user: 5-minute delayed restart via timed-action machinery
    const WHITELISTED_RESTART_MINUTES = 5;

    const now = Date.now();

    // Veto cooldown: user's last restart was vetoed — 15-min wait, doesn't count toward quota
    const vetoCooldownSince = whitelistVetoCooldown.get(user.steamId);
    if (vetoCooldownSince && now - vetoCooldownSince < WHITELIST_COOLDOWN_MS) {
      const waitMins = Math.ceil((WHITELIST_COOLDOWN_MS - (now - vetoCooldownSince)) / 60_000);
      return c.json({
        error: `Your last restart request was cancelled. Please wait ${waitMins} more minute${waitMins !== 1 ? "s" : ""} before requesting another restart, or another user can initiate the restart immediately.`,
      }, 429);
    }

    // Daily quota: only counts restarts that actually executed
    const history = (whitelistRestartHistory.get(user.steamId) ?? [])
      .filter(ts => now - ts < WHITELIST_WINDOW_MS);

    if (history.length >= WHITELIST_MAX_RESTARTS) {
      const oldestTs = Math.min(...history);
      const resetAt = oldestTs + WHITELIST_WINDOW_MS;
      const waitMins = Math.ceil((resetAt - now) / 60_000);
      return c.json({
        error: `Restart limit reached (${WHITELIST_MAX_RESTARTS} per 24h). ` +
          `You can request another restart in ${waitMins} minute${waitMins !== 1 ? "s" : ""}.`,
      }, 429);
    }

    // Cooldown between executed restarts
    if (history.length > 0) {
      const lastTs = Math.max(...history);
      const cooldownRemaining = WHITELIST_COOLDOWN_MS - (now - lastTs);
      if (cooldownRemaining > 0) {
        const waitMins = Math.ceil(cooldownRemaining / 60_000);
        return c.json({
          error: `Please wait ${waitMins} more minute${waitMins !== 1 ? "s" : ""} before requesting another restart.`,
        }, 429);
      }
    }

    // Helper: record a restart execution in the quota history
    const recordExecution = () => {
      const h = (whitelistRestartHistory.get(user.steamId) ?? [])
        .filter(ts => Date.now() - ts < WHITELIST_WINDOW_MS);
      h.push(Date.now());
      whitelistRestartHistory.set(user.steamId, h);
    };

    cancelTimedAction(containerId);

    const ip = await getContainerIP(containerId);

    // If server is empty right now, restart immediately — no countdown needed
    const currentPlayers = ip ? await getPlayers(ip, container.restPort, container.restPassword) : null;
    if (currentPlayers !== null && currentPlayers.length === 0) {
      if (ip) {
        await broadcast(ip, container.restPort, container.restPassword, "Server is restarting now.");
        insertChatMessage(containerId, null, "Server is restarting now.");
        await new Promise((res) => setTimeout(res, 1000));
      }
      await restartContainer(containerId);
      recordExecution();
      logAudit("RESTART", {
        steamId: user.steamId,
        displayName: user.displayName,
        containerName: apiNameCache.get(containerId) ?? container.name,
        details: "immediate (server empty)",
      });
      return c.json({ ok: true });
    }

    // Players online — schedule 5-minute countdown with veto support
    const executeAt = Date.now() + WHITELISTED_RESTART_MINUTES * 60_000;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const VETO_HINT = "Type /veto in chat to cancel. Restart will proceed immediately if all players disconnect.";

    // Initial broadcast naming the initiator
    if (ip) {
      await broadcast(ip, container.restPort, container.restPassword,
        `${user.displayName} has initiated a server restart. Restarting in ${WHITELISTED_RESTART_MINUTES} minutes. ${VETO_HINT}`);
      insertChatMessage(containerId, null,
        `${user.displayName} has initiated a server restart. Restarting in ${WHITELISTED_RESTART_MINUTES} minutes.`);
    }

    // Warning broadcasts
    const WARN_OFFSETS = [3, 2, 1, 0.5];
    for (const off of WARN_OFFSETS) {
      const delay = (WHITELISTED_RESTART_MINUTES - off) * 60_000;
      if (delay > 0) {
        timers.push(setTimeout(async () => {
          if (!pendingTimedActions.has(containerId)) return;
          const lip = await getContainerIP(containerId);
          if (lip) {
            const label = off >= 1 ? `${off} minute${off === 1 ? "" : "s"}` : "30 seconds";
            await broadcast(lip, container.restPort, container.restPassword,
              `Server restarting in ${label}. ${VETO_HINT}`);
            insertChatMessage(containerId, null, `Server restarting in ${label}.`);
          }
        }, delay));
      }
    }

    const mainTimer = setTimeout(async () => {
      if (!pendingTimedActions.has(containerId)) return; // veto/poll already acted
      pendingTimedActions.delete(containerId);
      const lip = await getContainerIP(containerId);
      if (lip) {
        await gracefulStop(lip, container.restPort, container.restPassword, "Server is restarting now.");
        insertChatMessage(containerId, null, "Server is restarting now.");
        await new Promise((res) => setTimeout(res, 3000));
      }
      await restartContainer(containerId);
      recordExecution();
      logAudit("RESTART", {
        steamId: user.steamId,
        displayName: user.displayName,
        containerName: apiNameCache.get(containerId) ?? container.name,
        details: `${WHITELISTED_RESTART_MINUTES}-minute delayed restart`,
      });
    }, WHITELISTED_RESTART_MINUTES * 60_000);
    timers.push(mainTimer);

    pendingTimedActions.set(containerId, {
      action: "restart", scheduledAt: Date.now(), executeAt, timers,
      vetoable: true, pollInterval: null, chatHandler: null,
    });

    // Chat handler: one /veto immediately cancels the restart
    const chatHandler = async (playerName: string, message: string) => {
      if (message.trim().toLowerCase() !== "/veto") return;
      if (!pendingTimedActions.get(containerId)?.vetoable) return;
      cancelTimedAction(containerId);
      whitelistVetoCooldown.set(user.steamId, Date.now());
      const lip = await getContainerIP(containerId);
      if (lip) {
        await broadcast(lip, container.restPort, container.restPassword,
          `Server restart cancelled — ${playerName} voted to veto.`);
        insertChatMessage(containerId, null, `Server restart cancelled — ${playerName} voted to veto.`);
      }
      logAudit("RESTART_VETOED", {
        steamId: user.steamId,
        displayName: user.displayName,
        containerName: apiNameCache.get(containerId) ?? container.name,
        details: `vetoed by ${playerName}`,
      });
    };
    registerChatHandler(containerId, chatHandler);
    pendingTimedActions.get(containerId)!.chatHandler = chatHandler;

    // Poll every 30s: restart immediately if server becomes empty
    const pollInterval = setInterval(async () => {
      if (!pendingTimedActions.has(containerId)) { clearInterval(pollInterval); return; }
      const lip = await getContainerIP(containerId);
      if (!lip) return;
      const livePlayers = await getPlayers(lip, container.restPort, container.restPassword);
      if (!livePlayers || livePlayers.length > 0) return;
      // Server became empty — restart immediately
      cancelTimedAction(containerId);
      await gracefulStop(lip, container.restPort, container.restPassword, "Server is restarting now (all players disconnected).");
      insertChatMessage(containerId, null, "Server is restarting now (all players disconnected).");
      await new Promise((res) => setTimeout(res, 3000));
      await restartContainer(containerId);
      recordExecution();
      logAudit("RESTART", {
        steamId: user.steamId,
        displayName: user.displayName,
        containerName: apiNameCache.get(containerId) ?? container.name,
        details: "immediate (all players disconnected during countdown)",
      });
    }, 30_000);
    pendingTimedActions.get(containerId)!.pollInterval = pollInterval;

    logAudit("RESTART_SCHEDULED", {
      steamId: user.steamId,
      displayName: user.displayName,
      containerName: apiNameCache.get(containerId) ?? container.name,
      details: `${WHITELISTED_RESTART_MINUTES}-minute restart scheduled by ${user.displayName}`,
    });
  }

  return c.json({ ok: true });
});

app.post("/api/containers/:id/start", requireWhitelisted, async (c) => {
  const user = getCurrentUser(c)!;
  const containerId = c.req.param("id");

  const containers = await discoverPalworldContainers();
  const container = containers.find((x) => x.id === containerId);
  if (!container) return c.json({ error: "Not found" }, 404);
  if (!container.allowStart) return c.json({ error: "Start not permitted for this container" }, 403);

  await startContainer(containerId);
  armIdle(containerId);

  // Start chat log streaming for newly started container
  setTimeout(() => {
    startChatLogStream(container);
  }, 5000); // wait 5s for container to initialise

  logAudit("START", {
    steamId: user.steamId,
    displayName: user.displayName,
    containerName: apiNameCache.get(containerId) ?? container.name,
  });

  return c.json({ ok: true });
});

app.post("/api/containers/:id/stop", requireAdmin, async (c) => {
  const user = getCurrentUser(c)!;
  const containerId = c.req.param("id");

  const containers = await discoverPalworldContainers();
  const container = containers.find((x) => x.id === containerId);
  if (!container) return c.json({ error: "Not found" }, 404);

  const ip = await getContainerIP(containerId);
  if (ip) {
    await broadcast(ip, container.restPort, container.restPassword,
      "Server is shutting down now.");
    insertChatMessage(containerId, null, "Server is shutting down now.");
    await new Promise((res) => setTimeout(res, 1000));
  }

  await stopContainer(containerId);

  logAudit("STOP", {
    steamId: user.steamId,
    displayName: user.displayName,
    containerName: apiNameCache.get(containerId) ?? container.name,
  });

  return c.json({ ok: true });
});

app.post("/api/containers/:id/cancel-idle", requireWhitelisted, async (c) => {
  const containerId = c.req.param("id");
  const ip = await getContainerIP(containerId);
  if (ip) {
    await cancelIdleManual(containerId, ip);
  }
  return c.json({ ok: true });
});

// ── Broadcast ─────────────────────────────────────────────────────────────────

app.post("/api/containers/:id/broadcast", requireAdmin, async (c) => {
  const user = getCurrentUser(c)!;
  const containerId = c.req.param("id");

  const containers = await discoverPalworldContainers();
  const container = containers.find((x) => x.id === containerId);
  if (!container) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ message: string }>();
  if (!body.message?.trim()) return c.json({ error: "message required" }, 400);

  const msg = body.message.trim().slice(0, 256);
  const ip = await getContainerIP(containerId);
  if (!ip) return c.json({ error: "Container not reachable" }, 503);

  await broadcast(ip, container.restPort, container.restPassword, msg);

  insertChatMessage(containerId, null, `[Broadcast] ${msg}`);

  logAudit("BROADCAST", {
    steamId: user.steamId,
    displayName: user.displayName,
    containerName: apiNameCache.get(containerId) ?? container.name,
    details: msg,
  });

  return c.json({ ok: true });
});

// ── Timed action (on-demand shutdown/restart with countdown broadcasts) ────────

// In-memory map of pending timed actions per container
interface TimedAction {
  action: "restart" | "stop";
  scheduledAt: number;
  executeAt: number;
  timers: ReturnType<typeof setTimeout>[];
  // Whitelisted-restart veto tracking (not set for admin timed actions)
  vetoable?: boolean;
  pollInterval?: ReturnType<typeof setInterval> | null;         // polls for empty server
  chatHandler?: ((playerName: string, message: string) => void) | null;
}
const pendingTimedActions = new Map<string, TimedAction>();

// ── Whitelisted restart rate limiting ─────────────────────────────────────────
const WHITELIST_MAX_RESTARTS = 2;
const WHITELIST_WINDOW_MS    = 24 * 60 * 60_000; // 24 hours
const WHITELIST_COOLDOWN_MS  = 15 * 60_000;       // 15 min gap between restarts
// steamId → timestamps of restarts that actually executed within the current window
const whitelistRestartHistory = new Map<string, number[]>();
// steamId → timestamp when their restart was vetoed (cooldown, does not count toward quota)
const whitelistVetoCooldown = new Map<string, number>();

function getPendingTimedAction(containerId: string) {
  const ta = pendingTimedActions.get(containerId);
  if (!ta) return null;
  const remainingSeconds = Math.max(0, Math.ceil((ta.executeAt - Date.now()) / 1000));
  return { action: ta.action, remainingSeconds };
}

app.post("/api/containers/:id/timed-action", requireAdmin, async (c) => {
  const user = getCurrentUser(c)!;
  const containerId = c.req.param("id");

  const containers = await discoverPalworldContainers();
  const container = containers.find((x) => x.id === containerId);
  if (!container) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ action: "restart" | "stop"; minutes: number }>();
  if (body.action !== "restart" && body.action !== "stop") {
    return c.json({ error: "action must be restart or stop" }, 400);
  }
  const minutes = Math.max(0, Number(body.minutes) || 0);

  // Cancel any existing timed action for this container
  cancelTimedAction(containerId);

  const executeAt = Date.now() + minutes * 60_000;
  const timers: ReturnType<typeof setTimeout>[] = [];

  // Warning thresholds in minutes
  const WARN_OFFSETS = [10, 5, 3, 2, 1, 0.5]; // 0.5 = 30 seconds

  async function doAction() {
    pendingTimedActions.delete(containerId);
    const ip = await getContainerIP(containerId);
    if (ip) {
      const finalMsg = `Server is ${body.action === "restart" ? "restarting" : "shutting down"} now.`;
      await gracefulStop(ip, container.restPort, container.restPassword, finalMsg);
      insertChatMessage(containerId, null, finalMsg);
      await new Promise((res) => setTimeout(res, 3000));
    }
    if (body.action === "restart") {
      await restartContainer(containerId);
    } else {
      await stopContainer(containerId);
    }
    logAudit(`TIMED_${body.action.toUpperCase()}`, {
      steamId: user.steamId,
      displayName: user.displayName,
      containerName: apiNameCache.get(containerId) ?? container.name,
      details: `minutes=${minutes}`,
    });
  }

  if (minutes === 0) {
    // Immediate
    void doAction();
  } else {
    // Schedule warning broadcasts
    for (const warnMins of WARN_OFFSETS) {
      if (minutes < warnMins) continue; // skip intervals beyond countdown

      const warnLabel = warnMins >= 1
        ? `${warnMins} minute${warnMins !== 1 ? "s" : ""}`
        : "30 seconds";
      const msg = `Server ${body.action === "restart" ? "restarting" : "shutting down"} in ${warnLabel}.`;
      const delay = (minutes - warnMins) * 60_000;

      const timer = setTimeout(async () => {
        const ip = await getContainerIP(containerId);
        if (!ip) return;
        await broadcast(ip, container.restPort, container.restPassword, msg);
        insertChatMessage(containerId, null, msg);
      }, delay);
      timers.push(timer);
    }

    // Main action timer
    const mainTimer = setTimeout(() => void doAction(), minutes * 60_000);
    timers.push(mainTimer);

    pendingTimedActions.set(containerId, {
      action: body.action,
      scheduledAt: Date.now(),
      executeAt,
      timers,
    });
  }

  logAudit(`SCHEDULE_${body.action.toUpperCase()}`, {
    steamId: user.steamId,
    displayName: user.displayName,
    containerName: apiNameCache.get(containerId) ?? container.name,
    details: `minutes=${minutes}`,
  });

  return c.json({ ok: true });
});

app.post("/api/containers/:id/cancel-timed-action", requireAdmin, async (c) => {
  const containerId = c.req.param("id");
  cancelTimedAction(containerId);
  return c.json({ ok: true });
});

function cancelTimedAction(containerId: string) {
  const ta = pendingTimedActions.get(containerId);
  if (!ta) return;
  for (const t of ta.timers) clearTimeout(t);
  if (ta.pollInterval) clearInterval(ta.pollInterval);
  if (ta.chatHandler) unregisterChatHandler(containerId, ta.chatHandler);
  pendingTimedActions.delete(containerId);
}

// ── Chat log ──────────────────────────────────────────────────────────────────

app.get("/api/containers/:id/chat-log", requireWhitelisted, (c) => {
  const containerId = c.req.param("id");
  const limit = Math.min(500, parseInt(c.req.query("limit") ?? "100", 10));
  return c.json({ messages: getChatLog(containerId, limit) });
});

// ── Location history ──────────────────────────────────────────────────────────

app.get("/api/containers/:id/location-history", requireWhitelisted, (c) => {
  const containerId = c.req.param("id");
  const grids = getAllLocationGrids(containerId);
  const serverNames = getAllPlayerServerNames().filter(s => s.container_id === containerId);
  const nameMap = new Map(serverNames.map(s => [s.steam_id, s.character_name]));
  return c.json({
    players: grids.map(g => ({
      steamId:       g.steamId,
      characterName: nameMap.get(g.steamId) ?? null,
      gridData:      Buffer.from(g.gridData).toString("base64"),
    })),
  });
});

// ── Player management (admin only) ────────────────────────────────────────────

app.get("/api/known-players", requireAdmin, (c) => {
  const players = getAllPlayers();
  const allServerNames = getAllPlayerServerNames();
  const allMeta = getAllContainerMeta();

  const containerDisplayNames = new Map(
    allMeta.map((m) => [m.container_id, m.server_name || m.container_id])
  );

  const byPlayer = new Map<string, { container_id: string; containerName: string; characterName: string }[]>();
  for (const row of allServerNames) {
    if (!byPlayer.has(row.steam_id)) byPlayer.set(row.steam_id, []);
    byPlayer.get(row.steam_id)!.push({
      container_id:  row.container_id,
      containerName: containerDisplayNames.get(row.container_id) ?? row.container_id,
      characterName: row.character_name,
    });
  }

  const enriched = players.map((p) => ({ ...p, serverNames: byPlayer.get(p.steam_id) ?? [] }));
  return c.json({ players: enriched });
});

app.patch("/api/known-players/:steamId", requireAdmin, async (c) => {
  const user = getCurrentUser(c)!;
  const steamId = c.req.param("steamId");
  const body = await c.req.json<{ status: "whitelisted" | "blacklisted" | "pending" }>();

  if (body.status !== "whitelisted" && body.status !== "blacklisted" && body.status !== "pending") {
    return c.json({ error: "Invalid status" }, 400);
  }

  setPlayerStatus(steamId, body.status);

  logAudit(`PLAYER_${body.status.toUpperCase()}`, {
    steamId: user.steamId,
    displayName: user.displayName,
    details: `target=${steamId}`,
  });

  return c.json({ ok: true });
});

app.delete("/api/known-players/:steamId", requireAdmin, async (c) => {
  const user = getCurrentUser(c)!;
  const steamId = c.req.param("steamId");

  // Prevent admin from deleting their own record
  if (steamId === user.steamId) return c.json({ error: "Cannot delete admin record" }, 403);

  deletePlayer(steamId);

  logAudit("PLAYER_DELETED", {
    steamId: user.steamId,
    displayName: user.displayName,
    details: `target=${steamId}`,
  });

  return c.json({ ok: true });
});

// ── Per-container known players ───────────────────────────────────────────────

app.get("/api/containers/:id/known-players", requireWhitelisted, (c) => {
  const containerId = c.req.param("id");
  return c.json({ players: getKnownPlayersByContainer(containerId) });
});

// ── In-game player actions (kick / ban / unban) ────────────────────────────────

app.post("/api/containers/:id/players/:steamId/kick", requireAdmin, async (c) => {
  const user = getCurrentUser(c)!;
  const containerId = c.req.param("id");
  const steamId = c.req.param("steamId");

  const containers = await discoverPalworldContainers();
  const container = containers.find((x) => x.id === containerId);
  if (!container) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ message?: string }>().catch(() => ({}));
  const ip = await getContainerIP(containerId);
  if (!ip) return c.json({ error: "Container not reachable" }, 503);

  const ok = await kickPlayer(ip, container.restPort, container.restPassword, steamId, body.message);

  logAudit("KICK", {
    steamId: user.steamId,
    displayName: user.displayName,
    containerName: apiNameCache.get(containerId) ?? container.name,
    details: `target=${steamId}`,
  });

  return c.json({ ok });
});

app.post("/api/containers/:id/players/:steamId/ban", requireAdmin, async (c) => {
  const user = getCurrentUser(c)!;
  const containerId = c.req.param("id");
  const steamId = c.req.param("steamId");

  const containers = await discoverPalworldContainers();
  const container = containers.find((x) => x.id === containerId);
  if (!container) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ message?: string }>().catch(() => ({}));
  const ip = await getContainerIP(containerId);
  if (!ip) return c.json({ error: "Container not reachable" }, 503);

  const ok = await banPlayer(ip, container.restPort, container.restPassword, steamId, body.message);

  setGameBanned(steamId, true);

  logAudit("BAN", {
    steamId: user.steamId,
    displayName: user.displayName,
    containerName: apiNameCache.get(containerId) ?? container.name,
    details: `target=${steamId}`,
  });

  return c.json({ ok });
});

app.delete("/api/containers/:id/players/:steamId/ban", requireAdmin, async (c) => {
  const user = getCurrentUser(c)!;
  const containerId = c.req.param("id");
  const steamId = c.req.param("steamId");

  const containers = await discoverPalworldContainers();
  const container = containers.find((x) => x.id === containerId);
  if (!container) return c.json({ error: "Not found" }, 404);

  const ip = await getContainerIP(containerId);
  if (!ip) return c.json({ error: "Container not reachable" }, 503);

  const ok = await unbanPlayer(ip, container.restPort, container.restPassword, steamId);

  setGameBanned(steamId, false);

  logAudit("UNBAN", {
    steamId: user.steamId,
    displayName: user.displayName,
    containerName: apiNameCache.get(containerId) ?? container.name,
    details: `target=${steamId}`,
  });

  return c.json({ ok });
});

// ── Restart schedules (admin only) ────────────────────────────────────────────

app.get("/api/schedules", requireAdmin, (c) => {
  return c.json({ schedules: getAllSchedules() });
});

app.put("/api/schedules/:containerId", requireAdmin, async (c) => {
  const containerId = c.req.param("containerId");

  let body: { cronExpr?: string; enabled?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.cronExpr?.trim()) return c.json({ error: "cronExpr required" }, 400);

  const cronExpr = body.cronExpr.trim();
  const enabled = body.enabled !== false; // default true

  try {
    upsertSchedule(containerId, cronExpr, enabled);
    reloadSchedule(containerId, cronExpr, enabled);
  } catch (err) {
    console.error("[schedules] Failed to save schedule:", err);
    return c.json({ error: "Failed to save schedule" }, 500);
  }

  return c.json({ ok: true });
});

app.delete("/api/schedules/:containerId", requireAdmin, (c) => {
  const containerId = c.req.param("containerId");
  deleteSchedule(containerId);
  cancelJob(containerId);
  return c.json({ ok: true });
});

// ── Map calibration ───────────────────────────────────────────────────────────

app.get("/api/map-calibration", requireWhitelisted, (c) => {
  const saved = getMapCalibration();
  if (saved) return c.json({ ...saved, calibrated: true });
  // Derive affine transform from community-estimated world bounds
  const { worldMinX, worldMaxX, worldMinY, worldMaxY } = MAP_CALIBRATION;
  const rangeX = worldMaxX - worldMinX; // locationX range (north-south → fracY/vertical)
  const rangeY = worldMaxY - worldMinY; // locationY range (east-west  → fracX/horizontal)
  return c.json({
    scaleX: 1 / rangeY, offsetX: -worldMinY / rangeY, // locationY (east-west) → fracX
    scaleY: 1 / rangeX, offsetY: -worldMinX / rangeX, // locationX (north-south) → fracY
    calibrated: false,
  });
});

app.post("/api/map-calibration", requireAdmin, async (c) => {
  const body = await c.req.json() as {
    points: { worldX: number; worldY: number; fracX: number; fracY: number }[];
  };
  const points = body?.points;
  if (!Array.isArray(points) || points.length < 2)
    return c.json({ error: "Two calibration points required" }, 400);
  const [p1, p2] = points;
  if (Math.abs(p2.worldX - p1.worldX) < 1 || Math.abs(p2.worldY - p1.worldY) < 1)
    return c.json({ error: "Points are too close together on one axis" }, 400);
  const scaleX  = (p2.fracX - p1.fracX) / (p2.worldX - p1.worldX);
  const offsetX = p1.fracX - p1.worldX * scaleX;
  const scaleY  = (p2.fracY - p1.fracY) / (p2.worldY - p1.worldY);
  const offsetY = p1.fracY - p1.worldY * scaleY;
  saveMapCalibration(p1, p2, scaleX, offsetX, scaleY, offsetY);
  return c.json({ scaleX, offsetX, scaleY, offsetY, calibrated: true });
});

app.delete("/api/map-calibration", requireAdmin, (c) => {
  clearMapCalibration();
  return c.json({ ok: true });
});

// ── Static files ──────────────────────────────────────────────────────────────

app.use("/*", serveStatic({ root: "./public" }));

// Fallback: serve index.html for any unmatched route (SPA)
app.get("/*", serveStatic({ path: "./public/index.html" }));

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000", 10);

export default {
  port: PORT,
  fetch: app.fetch,
};

console.log(`PalworldStatus running on http://0.0.0.0:${PORT}`);
