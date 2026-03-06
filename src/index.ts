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
import { getServerInfo, getPlayers, broadcast } from "./palworld.js";
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

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Init DB (creates tables if needed)
getDb();

// Recover idle state from DB across restarts
recoverIdleStates();

// Start scheduled restart jobs
initScheduler();

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono();

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get("/auth/steam", handleSteamLogin);
app.get("/auth/steam/callback", handleSteamCallback);
app.post("/auth/logout", handleLogout);
app.get("/auth/me", handleMe);

// ── Status API ────────────────────────────────────────────────────────────────

const PUBLIC_HOST = process.env.PUBLIC_HOST ?? "localhost";

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
        };
      }

      const ip = await getContainerIP(container.id);
      const [info, players] = await Promise.all([
        ip ? getServerInfo(ip, container.restPort, container.restPassword) : null,
        ip ? getPlayers(ip, container.restPort, container.restPassword) : null,
      ]);

      const gameStatus = info ? "online" : "crashed";

      // Update player DB records and idle state
      if (players) {
        for (const p of players) {
          if (p.userId) {
            upsertPlayer(p.userId, p.name, container.displayName);
          }
        }
        if (ip) {
          await updateIdleState(container.id, players.length, ip);
        }
      }

      return {
        id: container.id,
        name: container.displayName,
        dockerStatus: container.status,
        gameStatus,
        version: info?.version ?? null,
        players: (players ?? []).map((p) => ({
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
  const body = await c.req.json<{ cronExpr: string; enabled: boolean }>();

  if (!body.cronExpr) return c.json({ error: "cronExpr required" }, 400);

  upsertSchedule(containerId, body.cronExpr, body.enabled);
  reloadSchedule(containerId, body.cronExpr, body.enabled);

  return c.json({ ok: true });
});

app.delete("/api/schedules/:containerId", requireAdmin, (c) => {
  const containerId = c.req.param("containerId");
  deleteSchedule(containerId);
  cancelJob(containerId);
  return c.json({ ok: true });
});

// ── Map calibration ───────────────────────────────────────────────────────────

import { MAP_CALIBRATION } from "./map.js";

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
