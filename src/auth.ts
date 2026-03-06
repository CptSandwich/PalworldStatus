import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { logAudit, getPlayerStatus } from "./db.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type UserRole = "admin" | "whitelisted" | "blacklisted" | "unknown";

export interface SessionUser {
  steamId: string;
  displayName: string;
  avatarUrl: string;
  role: UserRole;
}

// ── Steam OpenID (node-steam-openid) ──────────────────────────────────────────

// node-steam-openid doesn't ship types; declare what we need
declare class SteamOpenID {
  constructor(opts: { realm: string; returnUrl: string; apiKey: string });
  getRedirectUrl(): Promise<string>;
  authenticate(req: { url: string }): Promise<{
    steamid: string;
    username: string;
    name: string;
    profile: string;
    avatar: { small: string; medium: string; large: string };
  }>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SteamOpenIDCtor = require("node-steam-openid") as typeof SteamOpenID;

const STEAM_REALM = process.env.STEAM_REALM ?? "http://localhost:3000";
const STEAM_API_KEY = process.env.STEAM_API_KEY ?? "";
const ADMIN_STEAM_ID = process.env.ADMIN_STEAM_ID ?? "";

const steam = new SteamOpenIDCtor({
  realm: STEAM_REALM,
  returnUrl: `${STEAM_REALM}/auth/steam/callback`,
  apiKey: STEAM_API_KEY,
});

// ── Session store (in-memory) ─────────────────────────────────────────────────

const SESSION_SECRET = process.env.SESSION_SECRET ?? "changeme";
const SESSION_COOKIE = "ps_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface SessionRecord {
  user: SessionUser;
  expiresAt: number;
}

const sessions = new Map<string, SessionRecord>();

function makeSessionId(): string {
  return crypto.randomUUID();
}

function signSession(id: string): string {
  // Simple HMAC-SHA256 signature appended after a dot
  // In production Bun supports crypto.subtle
  return `${id}.${Buffer.from(id + SESSION_SECRET).toString("base64url").slice(0, 16)}`;
}

function verifySession(signed: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot === -1) return null;
  const id = signed.slice(0, dot);
  if (signSession(id) !== signed) return null;
  return id;
}

export function createSession(user: SessionUser): string {
  const id = makeSessionId();
  const signed = signSession(id);
  sessions.set(id, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  // Prune expired sessions occasionally
  if (Math.random() < 0.05) pruneExpiredSessions();
  return signed;
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [id, rec] of sessions) {
    if (rec.expiresAt < now) sessions.delete(id);
  }
}

export function getSession(signed: string): SessionUser | null {
  const id = verifySession(signed);
  if (!id) return null;
  const rec = sessions.get(id);
  if (!rec || rec.expiresAt < Date.now()) {
    sessions.delete(id ?? "");
    return null;
  }
  return rec.user;
}

export function destroySession(signed: string) {
  const id = verifySession(signed);
  if (id) sessions.delete(id);
}

// ── Role resolution ───────────────────────────────────────────────────────────

function resolveRole(steamId: string): UserRole {
  if (steamId === ADMIN_STEAM_ID) return "admin";
  const dbStatus = getPlayerStatus(steamId);
  if (dbStatus === "whitelisted") return "whitelisted";
  if (dbStatus === "blacklisted") return "blacklisted";
  return "unknown";
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

export async function handleSteamLogin(c: Context) {
  const url = await steam.getRedirectUrl();
  return c.redirect(url);
}

export async function handleSteamCallback(c: Context) {
  try {
    const profile = await steam.authenticate({ url: c.req.url, method: "GET" });
    const role = resolveRole(profile.steamid);

    if (role === "blacklisted" || role === "unknown") {
      logAudit("ACCESS_DENIED", {
        steamId: profile.steamid,
        displayName: profile.username,
        details: `role=${role}`,
      });
      // Set a minimal denied session so the frontend can show the "not authorised" screen
      const user: SessionUser = {
        steamId: profile.steamid,
        displayName: profile.username,
        avatarUrl: profile.avatar?.medium ?? "",
        role,
      };
      const token = createSession(user);
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 3600, // short TTL for denied users
      });
      return c.redirect("/");
    }

    const user: SessionUser = {
      steamId: profile.steamid,
      displayName: profile.username,
      avatarUrl: profile.avatar?.medium ?? "",
      role,
    };
    const token = createSession(user);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.redirect("/");
  } catch (err) {
    console.error("Steam auth callback error:", err);
    return c.redirect("/?error=auth_failed");
  }
}

export async function handleLogout(c: Context) {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) destroySession(cookie);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/");
}

export async function handleMe(c: Context) {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) return c.json({ user: null });
  const user = getSession(cookie);
  if (!user) return c.json({ user: null });
  // Refresh role from DB in case admin changed it
  const freshRole = resolveRole(user.steamId);
  return c.json({ user: { ...user, role: freshRole } });
}

// ── Middleware ────────────────────────────────────────────────────────────────

export function getCurrentUser(c: Context): SessionUser | null {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) return null;
  const user = getSession(cookie);
  if (!user) return null;
  // Always resolve fresh role from DB
  return { ...user, role: resolveRole(user.steamId) };
}

export async function requireWhitelisted(c: Context, next: Next) {
  const user = getCurrentUser(c);
  if (!user || (user.role !== "whitelisted" && user.role !== "admin")) {
    return c.json({ error: "Forbidden" }, 403);
  }
  c.set("user", user);
  await next();
}

export async function requireAdmin(c: Context, next: Next) {
  const user = getCurrentUser(c);
  if (!user || user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  c.set("user", user);
  await next();
}
