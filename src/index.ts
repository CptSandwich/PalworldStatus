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
  insertLocationPoint,
  getLastLocationPoint,
  getLocationHistory,
  getMapCalibration,
  saveMapCalibration,
  clearMapCalibration,
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
import { initChatLogStreams, startChatLogStream } from "./chatlog.js";
import { MAP_CALIBRATION } from "./map.js";
import { notifyCrashed, notifyOnline, notifyStopped, getCrashGuardInfo } from "./crashguard.js";

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Init DB (creates tables and runs migrations)
getDb();

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

// In-memory last-known positions for location history anti-aliasing
// Key: `${containerId}:${steamId}` → { x, y }
const lastPositions = new Map<string, { x: number; y: number }>();
const MIN_MOVE_DISTANCE = 5_000; // ~50m in UE4 cm units before recording a new location point

// Cache of last known API-reported server names (populated when server is online)
const apiNameCache = new Map<string, string>();

// Track when each container first appeared as Docker-running so we can give the
// game server a grace period to start before classifying it as "crashed"
const containerFirstRunningAt = new Map<string, number>();
const GAME_STARTUP_GRACE_MS = 2 * 60_000; // 2 minutes

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
        // Container stopped/restarting — clear grace period and crash guard
        containerFirstRunningAt.delete(container.id);
        notifyStopped(container.id);
        return {
          id: container.id,
          serverId: container.serverId,
          name: apiNameCache.get(container.id) ?? container.name,
          dockerStatus: container.status,
          gameStatus: "offline" as const,
          version: null,
          players: [],
          maxPlayers: null,
          connectionAddress: `${PUBLIC_HOST}:${container.gamePort ?? 8211}`,
          gamePort: container.gamePort,
          allowStart: container.allowStart,
          idleShutdownMinutes: container.idleShutdownMinutes ?? null,
          idleCountdownSeconds: null,
          pendingTimedAction: getPendingTimedAction(container.id),
          crashGuard: null,
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
        notifyOnline(container.id);
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

      // Use server name from REST API; cache it for when server goes offline
      if (info?.serverName) apiNameCache.set(container.id, info.serverName);
      const displayName = apiNameCache.get(container.id) ?? container.name;

      // Update player DB records, idle state, and location history
      if (players) {
        for (const p of players) {
          if (p.userId) {
            upsertPlayer(p.userId, p.name, displayName, container.id, p.level ?? 0);
            // Populate Steam display name from the API's accountName field
            if (p.accountName) upsertPlayerAuth(p.userId, p.accountName);

            // Track location history with anti-aliasing
            if (p.location_x !== undefined && p.location_y !== undefined) {
              const key = `${container.id}:${p.userId}`;
              const last = lastPositions.get(key);
              const dx = last ? p.location_x - last.x : Infinity;
              const dy = last ? p.location_y - last.y : Infinity;
              const dist = Math.sqrt(dx * dx + dy * dy);

              if (!last || dist >= MIN_MOVE_DISTANCE) {
                lastPositions.set(key, { x: p.location_x, y: p.location_y });
                insertLocationPoint(
                  container.id,
                  p.userId,
                  p.name,
                  p.location_x,
                  p.location_y
                );
              }
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

    // Rate limiting: max 2 restarts per 24h, min 15 min gap between requests
    const now = Date.now();
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

    // Record this restart attempt before scheduling
    history.push(now);
    whitelistRestartHistory.set(user.steamId, history);

    cancelTimedAction(containerId);

    const executeAt = Date.now() + WHITELISTED_RESTART_MINUTES * 60_000;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const ip = await getContainerIP(containerId);

    // Initial broadcast naming the initiator
    if (ip) {
      await broadcast(ip, container.restPort, container.restPassword,
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
              `Server restarting in ${label}.`);
          }
        }, delay));
      }
    }

    const mainTimer = setTimeout(async () => {
      pendingTimedActions.delete(containerId);
      const lip = await getContainerIP(containerId);
      if (lip) {
        await gracefulStop(lip, container.restPort, container.restPassword, "Server is restarting now.");
        await new Promise((res) => setTimeout(res, 3000));
      }
      await restartContainer(containerId);
      logAudit("RESTART", {
        steamId: user.steamId,
        displayName: user.displayName,
        containerName: apiNameCache.get(containerId) ?? container.name,
        details: `${WHITELISTED_RESTART_MINUTES}-minute delayed restart`,
      });
    }, WHITELISTED_RESTART_MINUTES * 60_000);
    timers.push(mainTimer);

    pendingTimedActions.set(containerId, { action: "restart", scheduledAt: Date.now(), executeAt, timers });
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
}
const pendingTimedActions = new Map<string, TimedAction>();

// ── Whitelisted restart rate limiting ─────────────────────────────────────────
const WHITELIST_MAX_RESTARTS = 2;
const WHITELIST_WINDOW_MS    = 24 * 60 * 60_000; // 24 hours
const WHITELIST_COOLDOWN_MS  = 15 * 60_000;       // 15 min gap between restarts
// steamId → timestamps of scheduled restarts within the current window
const whitelistRestartHistory = new Map<string, number[]>();

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
      await gracefulStop(ip, container.restPort, container.restPassword,
        `Server is ${body.action === "restart" ? "restarting" : "shutting down"} now.`);
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
  const points = getLocationHistory(containerId);

  // Group by steam_id
  const grouped = new Map<string, {
    steamId: string;
    characterName: string | null;
    points: { x: number; y: number; timestamp: string }[];
  }>();

  for (const p of points) {
    if (!grouped.has(p.steam_id)) {
      grouped.set(p.steam_id, { steamId: p.steam_id, characterName: p.character_name, points: [] });
    }
    grouped.get(p.steam_id)!.points.push({ x: p.x, y: p.y, timestamp: p.timestamp });
  }

  return c.json({ players: [...grouped.values()] });
});

// ── Player management (admin only) ────────────────────────────────────────────

app.get("/api/known-players", requireAdmin, (c) => {
  return c.json({ players: getAllPlayers() });
});

app.patch("/api/known-players/:steamId", requireAdmin, async (c) => {
  const user = getCurrentUser(c)!;
  const steamId = c.req.param("steamId");
  const body = await c.req.json<{ status: "whitelisted" | "blacklisted" }>();

  if (body.status !== "whitelisted" && body.status !== "blacklisted") {
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
  const rangeX = worldMaxX - worldMinX;
  const rangeY = worldMaxY - worldMinY;
  return c.json({
    scaleX: 1 / rangeX, offsetX: -worldMinX / rangeX,
    scaleY: 1 / rangeY, offsetY: -worldMinY / rangeY,
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
