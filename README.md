# PalworldStatus

A self-hosted dashboard for monitoring Palworld dedicated servers running on Unraid (or any Docker host). Designed for small friend groups — all content is behind a Steam login with an admin-managed whitelist.

![Status: Alpha](https://img.shields.io/badge/status-alpha-orange)

---

## Features

- **Steam login** — friends authenticate with their real Steam accounts; no passwords to manage
- **Server status cards** — live Docker + game state (Online / Crashed / Offline / Starting), version, player count, connection string with one-click copy
- **Live player map** — world-coordinate player dots on a static map image, updated every 30 seconds
- **Admin actions** — restart, start, and stop containers from the dashboard (with in-game broadcast warnings)
- **Idle auto-shutdown** — opt-in per server; shuts down after 10 minutes with no players, with progressive in-game warnings
- **Scheduled restarts** — admin sets a cron expression per server; broadcasts warnings before each restart
- **Whitelist management** — admin promotes/demotes players; all others are denied by default
- **Audit log** — every admin action and denied login attempt is recorded
- **Auto-discovery** — Palworld containers are found via Docker labels; no config file needed

---

## Tech stack

| Layer         | Choice                                                             |
| ------------- | ------------------------------------------------------------------ |
| Runtime       | [Bun](https://bun.sh)                                              |
| HTTP          | [Hono](https://hono.dev)                                           |
| Database      | `bun:sqlite` (built-in)                                            |
| Docker client | [dockerode](https://github.com/apocas/dockerode)                   |
| Steam auth    | [node-steam-openid](https://github.com/nicklvsa/node-steam-openid) |
| Cron          | [node-cron](https://github.com/node-cron/node-cron)                |
| Frontend      | Vanilla HTML/CSS/JS — no build step                                |

---

## Prerequisites

### 1. Enable the Palworld REST API

In each server's `PalWorldSettings.ini` (`Pal/Saved/Config/LinuxServer/` inside the container's appdata volume):

```ini
RESTAPIEnabled=True
RESTAPIPort=8212
```

Restart each Palworld container after making this change.

### 2. Label your Palworld containers

Add these Docker labels to each Palworld container (via Unraid's "Extra Parameters" field or your `docker-compose.yml`):

| Label                                   | Required | Description                                                     |
| --------------------------------------- | -------- | --------------------------------------------------------------- |
| `palworld-status.enabled`               | Yes      | Set to `true` to include this container                         |
| `palworld-status.name`                  | No       | Display name (defaults to container name)                       |
| `palworld-status.rest-port`             | No       | REST API port (default: `8212`)                                 |
| `palworld-status.rest-password`         | Yes      | Palworld server admin password (for REST API auth)              |
| `palworld-status.allow-start`           | No       | Set to `true` to allow starting from the dashboard              |
| `palworld-status.idle-shutdown-minutes` | No       | Auto-shutdown after N minutes idle (omit for always-on servers) |

> **Important:** Do not expose port 8212 to the host or internet. PalworldStatus queries it over the internal Docker network automatically.

---

## Installation (Unraid)

### Step 1 — Add the container

In Unraid → Docker → Add Container:

| Field            | Value                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| Repository       | `ghcr.io/cptsandwich/palworldstatus:latest`                                 |
| Port             | Host `3000` → Container `3000`                                              |
| Extra Parameters | `--mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock` |
| Volume           | `/mnt/user/appdata/palworld-status` → `/app/data`                           |

### Step 2 — Set environment variables

| Variable         | Required | Description                                                                                     |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `ADMIN_STEAM_ID` | Yes      | Your Steam 64-bit ID — grants full admin access. Find yours at [steamid.io](https://steamid.io) |
| `STEAM_API_KEY`  | Yes      | Steam Web API key from [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey)   |
| `STEAM_REALM`    | Yes      | Public base URL of this app, e.g. `https://palworld.yourdomain.com`                             |
| `PUBLIC_HOST`    | Yes      | Hostname shown to users for server connections, e.g. `palworld.yourdomain.com`                  |
| `SESSION_SECRET` | Yes      | Long random string for signing session cookies (32+ chars)                                      |
| `PORT`           | No       | HTTP port (default: `3000`)                                                                     |

### Step 3 — Reverse proxy (required for Steam login)

Steam OpenID requires your app to be reachable from the internet for the login callback to work.

- **Nginx Proxy Manager** — Add a proxy host pointing to `<unraid-ip>:3000`, enable SSL via Let's Encrypt
- **Cloudflare Tunnel** — Run `cloudflared` on Unraid; no port forwarding needed

Set `STEAM_REALM` to the resulting public URL.

### Step 4 — Networking

Ensure all containers (both Palworld servers and `palworld-status`) are on the same Docker network so the status app can reach the REST API internally.

---

## First launch

1. Navigate to your domain
2. Click **Sign in through Steam** using your own account
3. Your `ADMIN_STEAM_ID` is pre-authorised — you land on the full dashboard immediately
4. Friends see "Your account is not authorised" until you whitelist them
5. After a friend connects to either Palworld server, they appear in the **Player Management** panel
6. Toggle their access to **Whitelisted** — they can now view the dashboard

---

## Scheduled restarts

In the admin panel, enter a cron expression per server (e.g. `0 4 * * *` for 4am daily) and enable it. The app will broadcast in-game warnings at −10/−5/−3/−2/−1 min and −30 sec before each restart, then gracefully stop and restart the container.

---

## Building from source

```bash
git clone https://github.com/CptSandwich/PalworldStatus.git
cd PalworldStatus
bun install
bun run src/index.ts
```

Or with Docker:

```bash
docker build -t palworld-status .
docker run -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/data:/app/data \
  -e ADMIN_STEAM_ID=... \
  -e STEAM_API_KEY=... \
  -e STEAM_REALM=http://localhost:3000 \
  -e PUBLIC_HOST=localhost \
  -e SESSION_SECRET=changeme \
  palworld-status
```

---

## Security

- **Docker socket**: Mounting `/var/run/docker.sock` is equivalent to root on the host. PalworldStatus only acts on containers bearing the `palworld-status.enabled=true` label. Review the source code if you're uncomfortable with this.
- **REST API credentials**: The Palworld admin password (stored in Docker labels) is only read server-side and never sent to browsers. Never expose port 8212 externally.
- **Steam auth**: PalworldStatus never handles passwords. All users default to denied until explicitly whitelisted by the admin.
- **HTTPS**: Strongly recommended. Without it, session cookies can be intercepted.

See [SECURITY.md](SECURITY.md) for full details.

---

## Player map

Drop a Palworld world map image at `public/palworld-map.jpg`. The coordinate transform in `src/map.ts` maps UE world coordinates to pixel positions — calibrate the constants against known in-game landmark coordinates once you have a map image.

---

## Troubleshooting

| Problem                         | Check                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| "Not authorised" on first login | Verify `ADMIN_STEAM_ID` matches your Steam 64-bit ID exactly (use steamid.io)                |
| Server shows CRASHED            | Ensure `RESTAPIEnabled=True` in `PalWorldSettings.ini` and `rest-password` label is set      |
| Steam login loops or fails      | Verify `STEAM_REALM` matches your exact public URL including `https://`                      |
| Containers not detected         | Ensure `palworld-status.enabled=true` label is set and all containers share a Docker network |

---

## License

MIT — see [LICENSE](LICENSE)
