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
import { getServerInfo, getPlayers, broadcast, gracefulStop } from "./palworld.js";
import {
  logAudit,
  getRecentAuditLog,
  upsertPlayer,
  getAllPlayers,
  setPlayerStatus,
  getAllSchedules,
  upsertSchedule,
  deleteSchedule,
  getDb,
  getChatLog,
  insertLocationPoint,
  getLastLocationPoint,
  getLocationHistory,
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
const MIN_MOVE_DISTANCE = 5000; // ~50m in Unreal Engine world units

app.get("/api/status", requireWhitelisted, async (c) => {
  const containers = await discoverPalworldContainers();

  const results = await Promise.all(
    containers.map(async (container) => {
      // Register idle tracker (no-op if already registered)
      registerIdleTracker({
        containerId: container.id,
        containerName: container.displayName,
        restPort: container.restPort,
        restPassword: container.restPassword,
        idleShutdownMinutes: container.idleShutdownMinutes,
      });

      if (container.status !== "running") {
        return {
          id: container.id,
          name: container.displayName,
          dockerStatus: container.status,
          gameStatus: "offline" as const,
          version: null,
          players: [],
          maxPlayers: null,
          connectionAddress: `${PUBLIC_HOST}:${container.gamePort ?? 8211}`,
          gamePort: container.gamePort,
          allowStart: container.allowStart,
          idleCountdownSeconds: null,
          pendingTimedAction: getPendingTimedAction(container.id),
        };
      }

      const ip = await getContainerIP(container.id);
      const [info, players] = await Promise.all([
        ip ? getServerInfo(ip, container.restPort, container.restPassword) : null,
        ip ? getPlayers(ip, container.restPort, container.restPassword) : null,
      ]);

      const gameStatus = info ? "online" : "crashed";

      // Use server name from REST API; fall back to Docker label
      const displayName = info?.serverName || container.displayName;

      // Update player DB records, idle state, and location history
      if (players) {
        for (const p of players) {
          if (p.userId) {
            // Store character name in both display_name and character_name fields
            upsertPlayer(p.userId, p.name, displayName, p.name);

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
        name: displayName,
        dockerStatus: container.status,
        gameStatus,
        version: info?.version ?? null,
        players: (players ?? []).map((p) => ({
          steamId: p.userId,
          name: p.name,
          level: p.level,
          locationX: p.location_x,
          locationY: p.location_y,
        })),
        maxPlayers: info?.maxplayers ?? null,
        connectionAddress: `${PUBLIC_HOST}:${container.gamePort ?? 8211}`,
        gamePort: container.gamePort,
        allowStart: container.allowStart,
        idleCountdownSeconds: getIdleCountdownSeconds(container.id),
        pendingTimedAction: getPendingTimedAction(container.id),
      };
    })
  );

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
    containerName: container.displayName,
  });

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
    containerName: container.displayName,
  });

  return c.json({ ok: true });
});

app.post("/api/containers/:id/stop", requireWhitelisted, async (c) => {
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
    containerName: container.displayName,
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

app.post("/api/containers/:id/broadcast", requireWhitelisted, async (c) => {
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

  logAudit("BROADCAST", {
    steamId: user.steamId,
    displayName: user.displayName,
    containerName: container.displayName,
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

function getPendingTimedAction(containerId: string) {
  const ta = pendingTimedActions.get(containerId);
  if (!ta) return null;
  const remainingSeconds = Math.max(0, Math.ceil((ta.executeAt - Date.now()) / 1000));
  return { action: ta.action, remainingSeconds };
}

app.post("/api/containers/:id/timed-action", requireWhitelisted, async (c) => {
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
      containerName: container.displayName,
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
    containerName: container.displayName,
    details: `minutes=${minutes}`,
  });

  return c.json({ ok: true });
});

app.post("/api/containers/:id/cancel-timed-action", requireWhitelisted, async (c) => {
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
  return c.json(MAP_CALIBRATION);
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
