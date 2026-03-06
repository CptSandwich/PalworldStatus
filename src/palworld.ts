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
}

export interface PlayerInfo {
  name: string;
  accountId: string;
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
  try {
    const res = await fetch(`http://${ip}:${port}${path}`, {
      ...opts,
      headers: {
        Authorization: basicAuth(password),
        "Content-Type": "application/json",
        ...(opts.headers ?? {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getServerInfo(
  ip: string,
  port: number,
  password: string
): Promise<ServerInfo | null> {
  return palworldFetch<ServerInfo>(ip, port, password, "/v1/api/server/info");
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
  return data?.players ?? null;
}

export async function broadcast(
  ip: string,
  port: number,
  password: string,
  message: string
): Promise<boolean> {
  const result = await palworldFetch(ip, port, password, "/v1/api/server/announce", {
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
  const result = await palworldFetch(ip, port, password, "/v1/api/server/stop", {
    method: "POST",
    body: JSON.stringify({ waittime: 1, message }),
  });
  return result !== null;
}
