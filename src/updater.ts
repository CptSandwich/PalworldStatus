// Palworld server update checker
//
// Every 60 minutes, fetches the latest Palworld Dedicated Server build ID from
// the Steam API and compares it to the last-known build ID stored in the DB.
// If a newer build is found:
//   - Containers with 0 players → graceful stop + restart (steamcmd auto-updates on startup)
//   - Containers with players   → in-game broadcast notifying players an update is available
//
// The update flag persists across restarts via the `settings` DB table.

import { getSetting, setSetting, logAudit, insertChatMessage, getContainerServerName } from "./db.js";
import { discoverPalworldContainers, getContainerIP, restartContainer } from "./docker.js";
import { getPlayers, broadcast, gracefulStop } from "./palworld.js";

const STEAM_APP_ID       = 2394010;
const STEAM_API_URL      = `https://api.steamcmd.net/v1/info/${STEAM_APP_ID}`;
const SETTING_BUILD_ID   = "steam_build_id";
const SETTING_UPDATE_AT  = "update_available_since"; // ISO timestamp, or "" when not pending
const CHECK_INTERVAL_MS  = 60 * 60 * 1000;           // 60 minutes

// In-memory flag — readable by index.ts for the /api/status response
export let updateAvailableSince: string | null = null;

export async function initUpdateChecker(): Promise<void> {
  // Restore persisted state so the badge survives app restarts
  const stored = getSetting(SETTING_UPDATE_AT);
  updateAvailableSince = stored || null;

  // Run immediately on startup, then on a fixed interval
  checkForUpdates().catch((err) => console.warn("[updater] Initial check failed:", err));
  setInterval(() => {
    checkForUpdates().catch((err) => console.warn("[updater] Check failed:", err));
  }, CHECK_INTERVAL_MS);
}

export function clearUpdateAvailable(): void {
  updateAvailableSince = null;
  setSetting(SETTING_UPDATE_AT, "");
}

async function fetchLatestBuildId(): Promise<string | null> {
  try {
    const res = await fetch(STEAM_API_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const json = await res.json() as any;
    const buildId = json?.data?.[String(STEAM_APP_ID)]?.depots?.branches?.public?.buildid;
    return typeof buildId === "string" ? buildId : null;
  } catch {
    return null; // network failure — skip silently
  }
}

async function checkForUpdates(): Promise<void> {
  const latestBuild = await fetchLatestBuildId();
  if (!latestBuild) return;

  const knownBuild = getSetting(SETTING_BUILD_ID);
  if (!knownBuild) {
    // First run — record baseline, no update trigger
    setSetting(SETTING_BUILD_ID, latestBuild);
    console.log(`[updater] Baseline build ID stored: ${latestBuild}`);
    return;
  }

  if (latestBuild === knownBuild) return; // Nothing new

  // New build detected
  console.log(`[updater] New build detected: ${latestBuild} (was ${knownBuild})`);
  setSetting(SETTING_BUILD_ID, latestBuild);

  if (!updateAvailableSince) {
    updateAvailableSince = new Date().toISOString();
    setSetting(SETTING_UPDATE_AT, updateAvailableSince);
  }

  await handleUpdateAvailable(latestBuild);
}

async function handleUpdateAvailable(buildId: string): Promise<void> {
  let containers;
  try {
    containers = await discoverPalworldContainers();
  } catch {
    return;
  }

  for (const c of containers) {
    if (c.dockerStatus !== "running") continue;

    const ip = await getContainerIP(c.id).catch(() => null);
    if (!ip) continue;

    let players: any[] = [];
    try { players = await getPlayers(ip, c.restPort, c.restPassword); } catch {}

    const serverName = getContainerServerName(c.id) ?? c.name;

    if (players.length === 0) {
      // Empty server — restart immediately; steamcmd pulls the update on startup
      await gracefulStop(ip, c.restPort, c.restPassword).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      await restartContainer(c.id).catch((err) =>
        console.warn(`[updater] Failed to restart ${c.name}:`, err)
      );
      logAudit("UPDATE_RESTART", {
        containerName: serverName,
        details: "auto-restart for Palworld server update",
      });
      insertChatMessage(c.id, null, "[System] Update applied! Fresh server, who dis?");
      console.log(`[updater] Restarted ${c.name} for update`);
      // Update flag cleared once restart is issued
      clearUpdateAvailable();
    } else {
      // Players online — broadcast two messages; restart will happen on the next check once empty
      const msg1 = "A new Palworld update is available.";
      const msg2 = `Build ${buildId} will install once all players disconnect.`;
      const msg3 = "Hold onto your butts.";
      await broadcast(ip, c.restPort, c.restPassword, msg1).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
      await broadcast(ip, c.restPort, c.restPassword, msg2).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
      await broadcast(ip, c.restPort, c.restPassword, msg3).catch(() => {});
      insertChatMessage(c.id, null, `[System] ${msg1} ${msg2} ${msg3}`);
      console.log(`[updater] Notified players on ${c.name} about pending update (build ${buildId})`);
    }
  }
}
