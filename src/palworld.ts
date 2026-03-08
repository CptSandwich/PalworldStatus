// Palworld REST API client
// API uses HTTP Basic Auth: username "admin", password = server admin password
// Requires RESTAPIEnabled=True in PalWorldSettings.ini

export interface ServerInfo {
  version: string;
  servername: string;
  description: string;
  worldguid: string;
  maxplayers: number;
  currentplayers: number;
  // Resolved fields (mapped from API response)
  serverName: string;
}

export interface ServerMetrics {
  serverfps: number;
  serverframetime: number;
  currentplayernum: number;
  maxplayernum: number;
  uptime: number;         // server uptime in seconds
  days: number | null;    // in-game world days (not present in all versions)
}

export interface PlayerInfo {
  name: string;
  accountId: string;
  accountName: string; // Steam account name
  playerId: string;
  userId: string; // Steam ID
  ip: string;
  ping: number;
  location_x: number;
  location_y: number;
  level: number;
}

function basicAuth(password: string): string {
  return "Basic " + btoa(`admin:${password}`);
}

async function palworldFetch<T>(
  ip: string,
  port: number,
  password: string,
  path: string,
  opts: RequestInit = {}
): Promise<T | null> {
  const url = `http://${ip}:${port}${path}`;
  try {
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: basicAuth(password),
        "Content-Type": "application/json",
        ...(opts.headers ?? {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[palworld] ${opts.method ?? "GET"} ${url} → HTTP ${res.status} ${res.statusText}${body ? ` | ${body.slice(0, 200)}` : ""}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[palworld] ${opts.method ?? "GET"} ${url} → ${msg}`);
    return null;
  }
}

export async function getServerInfo(
  ip: string,
  port: number,
  password: string
): Promise<ServerInfo | null> {
  const data = await palworldFetch<ServerInfo>(ip, port, password, "/v1/api/info");
  if (!data) return null;
  // Normalise: API returns "servername" field; expose as "serverName" for convenience
  return { ...data, serverName: data.servername ?? "" };
}

export async function getMetrics(
  ip: string,
  port: number,
  password: string
): Promise<ServerMetrics | null> {
  return palworldFetch<ServerMetrics>(ip, port, password, "/v1/api/metrics");
}

export async function getPlayers(
  ip: string,
  port: number,
  password: string
): Promise<PlayerInfo[] | null> {
  const data = await palworldFetch<{ players: PlayerInfo[] }>(
    ip,
    port,
    password,
    "/v1/api/players"
  );
  if (!data?.players) return null;
  // The API prefixes Steam IDs with "steam_" — strip it for consistency with
  // the ADMIN_STEAM_ID env var and known_players DB which use bare 64-bit IDs.
  return data.players.map((p) => ({
    ...p,
    userId: p.userId?.replace(/^steam_/i, "") ?? p.userId,
  }));
}

export async function broadcast(
  ip: string,
  port: number,
  password: string,
  message: string
): Promise<boolean> {
  const result = await palworldFetch(ip, port, password, "/v1/api/announce", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  return result !== null;
}

export async function gracefulStop(
  ip: string,
  port: number,
  password: string,
  message = "Server is shutting down."
): Promise<boolean> {
  const result = await palworldFetch(ip, port, password, "/v1/api/stop", {
    method: "POST",
    body: JSON.stringify({ waittime: 1, message }),
  });
  return result !== null;
}

export async function kickPlayer(
  ip: string,
  port: number,
  password: string,
  steamId: string,
  message = "You have been kicked from the server."
): Promise<boolean> {
  const result = await palworldFetch(ip, port, password, `/v1/api/players/${steamId}/kick`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  return result !== null;
}

export async function banPlayer(
  ip: string,
  port: number,
  password: string,
  steamId: string,
  message = "You have been banned from the server."
): Promise<boolean> {
  const result = await palworldFetch(ip, port, password, `/v1/api/players/${steamId}/ban`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  return result !== null;
}

export async function unbanPlayer(
  ip: string,
  port: number,
  password: string,
  steamId: string
): Promise<boolean> {
  const result = await palworldFetch(ip, port, password, `/v1/api/players/${steamId}/unban`, {
    method: "DELETE",
  });
  return result !== null;
}
