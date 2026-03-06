# PalworldStatus — Security Notes

## Threat Model

PalworldStatus is a private dashboard for a trusted friend group. It is not designed for public-facing deployments with untrusted users. The security model is:

- **Authentication**: Real Steam identities via Steam OpenID 2.0
- **Authorisation**: Explicit per-user whitelist managed by a single admin
- **Audit trail**: All actions and denied access attempts are logged
- **Principle of least exposure**: Internal APIs are never exposed to the internet

---

## Docker Socket Access

Mounting `/var/run/docker.sock` grants the container the ability to control ALL Docker containers on the Unraid host — equivalent to root access on the host machine.

**Mitigations in place:**

- PalworldStatus only acts on containers bearing the `palworld-status.enabled=true` label
- No container creation, image pulls, or network changes are performed
- Only `start`, `stop`, and `restart` actions are issued, and only on labelled containers

**Recommendation:** Review the source code before deployment if you are uncomfortable with this level of access. A future enhancement could use Docker's socket proxy (e.g. `tecnativa/docker-socket-proxy`) to scope permissions further.

---

## Palworld REST API Credentials

The Palworld REST API uses HTTP Basic Auth over plain HTTP (no TLS). It is not designed for internet exposure.

**How PalworldStatus handles this:**

- The REST API port (8212) should **never** be mapped to the host or exposed externally
- PalworldStatus queries it over the internal Docker bridge network (container-to-container)
- The `palworld-status.rest-password` Docker label is the **Palworld game server admin password** — it is read by the backend only and never transmitted to browsers or clients

**Risk:** Anyone with access to Unraid's Docker configuration can read the labels and obtain the game admin password. This is acceptable for a homelab — ensure your Unraid UI is not internet-accessible.

---

## Steam OpenID Authentication

PalworldStatus uses Steam OpenID 2.0 for all user authentication.

**What this means:**

- Users authenticate directly with Steam — PalworldStatus never handles or stores passwords of any kind
- After login, Steam returns a verified Steam ID (64-bit integer) that cannot be spoofed or forged
- Sessions are signed with `SESSION_SECRET` and stored in an httpOnly, SameSite cookie

**Session security:**

- Sessions expire after 24 hours
- `SESSION_SECRET` should be a cryptographically random string (32+ characters)
- HTTPS is strongly recommended (via reverse proxy) to prevent session cookie interception

---

## Authorisation Model

| Role                  | How assigned                | Access                                         |
| --------------------- | --------------------------- | ---------------------------------------------- |
| Unauthenticated       | Not logged in               | Login page only                                |
| Blacklisted / Unknown | Default for all Steam users | "Not authorised" screen — attempt logged       |
| Whitelisted           | Admin explicitly promotes   | Full dashboard + admin actions                 |
| Admin                 | `ADMIN_STEAM_ID` env var    | Everything + user management + schedule config |

**Key properties:**

- The admin identity is set at deploy time via `ADMIN_STEAM_ID` — it cannot be changed from the UI and cannot be blacklisted
- All newly authenticated Steam users default to **denied** until explicitly whitelisted by the admin
- Every admin action is logged with Steam ID, display name, action, and UTC timestamp
- The admin is the only one who can promote/demote users — whitelisted users cannot manage each other

---

## Audit Log

All of the following are recorded in the SQLite `audit_log` table:

| Event                             | Logged fields                                                   |
| --------------------------------- | --------------------------------------------------------------- |
| Admin action (restart/start/stop) | timestamp, steam_id, display_name, action, container_name       |
| Scheduled restart execution       | timestamp, trigger=scheduler, action, container_name            |
| Idle auto-shutdown execution      | timestamp, trigger=idle, action, container_name                 |
| Denied login attempt              | timestamp, steam_id, display_name, reason (blacklisted/unknown) |

The audit log is visible in the UI to whitelisted and admin users (last 50 entries).
The full log is in the SQLite database file at `/app/data/palworld-status.db` and can be queried directly with any SQLite client.

---

## Network Exposure Summary

| Port / Service                | Exposed to internet?   | Notes                              |
| ----------------------------- | ---------------------- | ---------------------------------- |
| PalworldStatus (3000)         | Yes, via reverse proxy | Required for Steam OpenID callback |
| Palworld game port (8211/udp) | Yes                    | Required for players to connect    |
| Palworld REST API (8212)      | **No**                 | Internal Docker network only       |
| Palworld RCON (25575)         | **No**                 | Not used by PalworldStatus         |
| Unraid UI (80/443)            | **No**                 | Keep off internet                  |
| Docker socket                 | N/A                    | Internal to host only              |

---

## Recommendations

1. **Use HTTPS** — Set up a reverse proxy with TLS (Nginx Proxy Manager + Let's Encrypt, or Cloudflare Tunnel). Without HTTPS, session cookies can be intercepted on the network.

2. **Keep Unraid off the internet** — The Unraid management UI should not be publicly accessible. Use Tailscale or a VPN for remote Unraid access.

3. **Rotate `SESSION_SECRET`** if you suspect it has been compromised. This immediately invalidates all active sessions, requiring all users to log in again.

4. **Review the audit log periodically** — Unexpected "ACCESS DENIED" entries may indicate someone attempting to access the panel with an unknown Steam account.

5. **Keep the container updated** — Pull the latest image regularly to receive security patches.

6. **Secure your Palworld admin password** — The game server admin password stored in Docker labels gives full RCON/REST control of your Palworld server. Treat it as a sensitive credential.
