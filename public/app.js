// PalworldStatus — frontend
// Polls /api/status every 30s, updates DOM, renders player map via canvas.

"use strict";

// ── State ─────────────────────────────────────────────────────────────────────

let currentUser = null;
let mapCalibration = null;
let lastStatus = null;
let activeMapServerId = null;
const POLL_INTERVAL_MS = 30_000;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  await loadUser();
  if (currentUser && (currentUser.role === "whitelisted" || currentUser.role === "admin")) {
    mapCalibration = await fetchMapCalibration();
    await poll();
    setInterval(poll, POLL_INTERVAL_MS);
  }
}

async function loadUser() {
  try {
    const res = await fetch("/auth/me");
    const data = await res.json();
    currentUser = data.user;
  } catch {
    currentUser = null;
  }
  renderAuth();
}

async function fetchMapCalibration() {
  try {
    const res = await fetch("/api/map-calibration");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function poll() {
  await Promise.all([
    fetchAndRenderStatus(),
    fetchAndRenderAuditLog(),
    currentUser?.role === "admin" ? fetchAndRenderPlayers() : Promise.resolve(),
    currentUser?.role === "admin" ? fetchAndRenderSchedules() : Promise.resolve(),
  ]);
}

// ── Auth rendering ────────────────────────────────────────────────────────────

function renderAuth() {
  const body = document.documentElement;
  const authMsg = document.getElementById("auth-message");
  const steamLink = document.getElementById("steam-login-link");
  const logoutBtn = document.getElementById("logout-btn");
  const headerUser = document.getElementById("header-user");

  if (!currentUser) {
    body.dataset.role = "guest";
    authMsg.textContent = "Sign in to view server status.";
    authMsg.className = "auth-subtitle";
    steamLink.style.display = "";
    logoutBtn.style.display = "none";
    headerUser.innerHTML = "";
    return;
  }

  if (currentUser.role === "blacklisted" || currentUser.role === "unknown") {
    body.dataset.role = "denied";
    authMsg.textContent = "Your account is not authorised.";
    authMsg.className = "auth-subtitle denied";
    steamLink.style.display = "none";
    logoutBtn.style.display = "";
    logoutBtn.onclick = doLogout;
    headerUser.innerHTML = "";
    return;
  }

  // Whitelisted or admin
  body.dataset.role = currentUser.role;
  authMsg.textContent = "";
  steamLink.style.display = "none";
  logoutBtn.style.display = "none";

  headerUser.innerHTML = `
    <img class="header-avatar" src="${escHtml(currentUser.avatarUrl)}" alt="" />
    <span class="header-name">${escHtml(currentUser.displayName)}</span>
    ${currentUser.role === "admin" ? '<span class="text-muted" style="font-size:11px;color:var(--accent)">[admin]</span>' : ""}
    <button class="btn btn-secondary btn-small" id="header-logout-btn">Logout</button>
  `;
  document.getElementById("header-logout-btn").onclick = doLogout;
}

async function doLogout() {
  await fetch("/auth/logout", { method: "POST" });
  location.reload();
}

// ── Status / server cards ─────────────────────────────────────────────────────

async function fetchAndRenderStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const data = await res.json();
    lastStatus = data.servers;
    renderServerGrid(data.servers);
    renderMapTabs(data.servers);
    renderMap(data.servers);
  } catch { /* network error — keep last state */ }
}

function renderServerGrid(servers) {
  const grid = document.getElementById("server-grid");
  grid.innerHTML = "";

  for (const s of servers) {
    const card = buildServerCard(s);
    grid.appendChild(card);
  }
}

function buildServerCard(s) {
  const gameStatus = s.dockerStatus !== "running" ? "offline"
    : s.gameStatus === "online" ? "online"
    : s.gameStatus === "crashed" ? "crashed"
    : "offline";

  const statusLabel = {
    online: "Online",
    crashed: "Crashed",
    offline: s.dockerStatus === "starting" ? "Starting" : "Offline",
    starting: "Starting",
  }[s.dockerStatus === "starting" ? "starting" : gameStatus];

  const card = el("div", { class: "server-card", "data-status": s.dockerStatus === "starting" ? "starting" : gameStatus, "data-id": s.id });

  // Header
  const header = el("div", { class: "server-card-header" });
  header.appendChild(el("span", { class: "status-dot" }));
  header.appendChild(el("span", { class: "server-name" }, s.name));
  header.appendChild(el("span", { class: "status-label" }, statusLabel));
  card.appendChild(header);

  // Body
  const body = el("div", { class: "server-card-body" });

  // Version + connection
  const meta = el("div", { class: "server-meta" });
  meta.appendChild(el("span", { class: "server-version" }, s.version ? `v${s.version}` : "—"));

  if (s.connectionAddress) {
    const conn = el("div", { class: "server-connection" });
    conn.appendChild(el("span", {}, s.connectionAddress));
    const copyBtn = el("button", { class: "copy-btn", title: "Copy address" }, "⎘");
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(s.connectionAddress);
      copyBtn.textContent = "✓";
      setTimeout(() => copyBtn.textContent = "⎘", 1500);
    };
    conn.appendChild(copyBtn);
    meta.appendChild(conn);
  }
  body.appendChild(meta);

  // Player count
  if (gameStatus === "online") {
    body.appendChild(el("div", { class: "player-count" },
      `Players: ${s.players.length}${s.maxPlayers ? `/${s.maxPlayers}` : ""}`
    ));
  }

  // Idle countdown
  if (s.idleCountdownSeconds !== null) {
    const mins = Math.floor(s.idleCountdownSeconds / 60);
    const secs = s.idleCountdownSeconds % 60;
    const countdown = el("div", { class: "idle-countdown" });
    countdown.appendChild(el("span", {}, `Idle shutdown in ${mins}:${String(secs).padStart(2, "0")}`));
    const cancelBtn = el("button", { class: "btn btn-small btn-secondary" }, "Cancel");
    cancelBtn.onclick = () => cancelIdle(s.id);
    countdown.appendChild(cancelBtn);
    body.appendChild(countdown);
  }

  // Player list
  if (gameStatus === "online" && s.players.length > 0) {
    const list = el("div", { class: "player-list" });
    for (const p of s.players) {
      const row = el("div", { class: "player-row" });
      row.appendChild(el("span", { class: "player-name" }, p.name));
      row.appendChild(el("span", { class: "player-stats" },
        `Lv.${p.level}  ${Math.round(p.locationX)}, ${Math.round(p.locationY)}`
      ));
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  card.appendChild(body);

  // Footer actions
  const footer = el("div", { class: "server-card-footer" });

  if (gameStatus === "online" || gameStatus === "crashed") {
    const restartBtn = el("button", { class: "btn btn-small" }, "↺ Restart");
    restartBtn.onclick = () => doContainerAction(s.id, "restart", s.name, restartBtn);
    footer.appendChild(restartBtn);

    const stopBtn = el("button", { class: "btn btn-small btn-danger" }, "■ Stop");
    stopBtn.onclick = () => doContainerAction(s.id, "stop", s.name, stopBtn);
    footer.appendChild(stopBtn);
  } else if (gameStatus === "offline" && s.allowStart) {
    const startBtn = el("button", { class: "btn btn-small" }, "▶ Start");
    startBtn.onclick = () => doContainerAction(s.id, "start", s.name, startBtn);
    footer.appendChild(startBtn);
  }

  if (footer.children.length > 0) card.appendChild(footer);

  return card;
}

async function doContainerAction(id, action, name, btn) {
  if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} "${name}"?`)) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/containers/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Error: ${data.error ?? res.statusText}`);
    } else {
      await poll();
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function cancelIdle(id) {
  await fetch(`/api/containers/${encodeURIComponent(id)}/cancel-idle`, { method: "POST" });
  await poll();
}

// ── Audit log ─────────────────────────────────────────────────────────────────

async function fetchAndRenderAuditLog() {
  try {
    const res = await fetch("/api/audit-log");
    if (!res.ok) return;
    const data = await res.json();
    renderAuditLog(data.entries);
  } catch { }
}

function renderAuditLog(entries) {
  const tbody = document.getElementById("audit-body");
  tbody.innerHTML = "";
  for (const e of entries) {
    const tr = el("tr", {});
    tr.appendChild(el("td", { class: "mono" }, formatTs(e.timestamp)));
    tr.appendChild(el("td", {}, e.display_name ?? e.steam_id ?? "system"));
    tr.appendChild(el("td", {}, e.action));
    tr.appendChild(el("td", {}, e.container_name ?? "—"));
    tr.appendChild(el("td", { class: "mono" }, e.details ?? "—"));
    tbody.appendChild(tr);
  }
}

// ── Player management ─────────────────────────────────────────────────────────

async function fetchAndRenderPlayers() {
  try {
    const res = await fetch("/api/known-players");
    if (!res.ok) return;
    const data = await res.json();
    renderPlayers(data.players);
  } catch { }
}

function renderPlayers(players) {
  const tbody = document.getElementById("players-body");
  tbody.innerHTML = "";
  for (const p of players) {
    const tr = el("tr", {});
    tr.appendChild(el("td", {}, p.display_name));
    tr.appendChild(el("td", { class: "mono" }, formatTs(p.first_seen)));
    tr.appendChild(el("td", { class: "mono" }, formatTs(p.last_seen)));
    tr.appendChild(el("td", {}, p.last_server ?? "—"));

    const actionTd = el("td", {});
    if (p.status === "whitelisted") {
      const blBtn = el("button", { class: "btn btn-small btn-danger" }, "✗ Blacklist");
      blBtn.onclick = () => setPlayerStatus(p.steam_id, "blacklisted", blBtn);
      actionTd.appendChild(blBtn);
    } else {
      const wlBtn = el("button", { class: "btn btn-small" }, "✓ Whitelist");
      wlBtn.onclick = () => setPlayerStatus(p.steam_id, "whitelisted", wlBtn);
      actionTd.appendChild(wlBtn);
    }
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }
}

async function setPlayerStatus(steamId, status, btn) {
  btn.disabled = true;
  try {
    await fetch(`/api/known-players/${encodeURIComponent(steamId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await fetchAndRenderPlayers();
  } finally {
    btn.disabled = false;
  }
}

// ── Restart schedules ─────────────────────────────────────────────────────────

async function fetchAndRenderSchedules() {
  try {
    const [schedulesRes, statusRes] = await Promise.all([
      fetch("/api/schedules"),
      fetch("/api/status"),
    ]);
    if (!schedulesRes.ok || !statusRes.ok) return;
    const { schedules } = await schedulesRes.json();
    const { servers } = await statusRes.json();

    renderSchedules(schedules, servers);
  } catch { }
}

function renderSchedules(schedules, servers) {
  const container = document.getElementById("schedules-list");
  container.innerHTML = "";

  // Show a row for every discovered container
  for (const s of servers) {
    const sched = schedules.find((x) => x.container_id === s.id);
    const cronVal = sched?.cron_expr ?? "";
    const enabledVal = sched?.enabled === 1;

    const row = el("div", { class: `schedule-row ${enabledVal ? "enabled" : ""}` });
    row.appendChild(el("span", { class: "schedule-name" }, s.name));

    const cronInput = el("input", {
      class: "schedule-cron-input",
      type: "text",
      placeholder: "cron expression (e.g. 0 4 * * *)",
      value: cronVal,
    });

    const enableLabel = el("label", { class: "schedule-toggle" });
    const enableChk = el("input", { type: "checkbox" });
    enableChk.checked = enabledVal;
    enableLabel.appendChild(enableChk);
    enableLabel.appendChild(document.createTextNode(" Enabled"));

    const saveBtn = el("button", { class: "btn btn-small" }, "Save");
    saveBtn.onclick = async () => {
      const cron = cronInput.value.trim();
      if (!cron) {
        await fetch(`/api/schedules/${encodeURIComponent(s.id)}`, { method: "DELETE" });
      } else {
        await fetch(`/api/schedules/${encodeURIComponent(s.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cronExpr: cron, enabled: enableChk.checked }),
        });
      }
      await fetchAndRenderSchedules();
    };

    row.appendChild(cronInput);
    row.appendChild(enableLabel);
    row.appendChild(saveBtn);
    container.appendChild(row);
  }
}

// ── World map ──────────────────────────────────────────────────────────────────

function renderMapTabs(servers) {
  const tabsEl = document.getElementById("map-tabs");
  const onlineServers = servers.filter((s) => s.gameStatus === "online");

  // Only rebuild tabs if server list changed
  const newIds = onlineServers.map((s) => s.id).join(",");
  if (tabsEl.dataset.ids === newIds) return;
  tabsEl.dataset.ids = newIds;
  tabsEl.innerHTML = "";

  if (onlineServers.length === 0) {
    activeMapServerId = null;
    return;
  }

  if (!activeMapServerId || !onlineServers.find((s) => s.id === activeMapServerId)) {
    activeMapServerId = onlineServers[0].id;
  }

  for (const s of onlineServers) {
    const tab = el("button", { class: `map-tab ${s.id === activeMapServerId ? "active" : ""}` }, s.name);
    tab.onclick = () => {
      activeMapServerId = s.id;
      document.querySelectorAll(".map-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      renderMap(lastStatus ?? []);
    };
    tabsEl.appendChild(tab);
  }
}

function renderMap(servers) {
  const canvas = document.getElementById("map-canvas");
  const mapImg = document.getElementById("map-image");
  const ctx = canvas.getContext("2d");

  const server = servers.find((s) => s.id === activeMapServerId);

  // Size canvas to match displayed image
  const rect = mapImg.getBoundingClientRect();
  canvas.width = rect.width || mapImg.offsetWidth;
  canvas.height = rect.height || mapImg.offsetHeight;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!server || server.gameStatus !== "online" || !mapCalibration) return;

  const { worldMinX, worldMaxX, worldMinY, worldMaxY } = mapCalibration;

  // Player dot colours (cycle through a palette)
  const DOT_COLORS = ["#e07b17", "#4caf6e", "#5ab4e0", "#e05252", "#c97ce0", "#f0c040"];

  server.players.forEach((p, i) => {
    const color = DOT_COLORS[i % DOT_COLORS.length];

    // World → canvas pixel
    const cx = ((p.locationX - worldMinX) / (worldMaxX - worldMinX)) * canvas.width;
    const cy = ((p.locationY - worldMinY) / (worldMaxY - worldMinY)) * canvas.height;

    // Dot
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Label
    ctx.font = "11px 'Noto Sans', sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 4;
    ctx.fillText(p.name, cx + 8, cy + 4);
    ctx.shadowBlur = 0;
  });
}

// Re-render map when the image loads/resizes
document.getElementById("map-image").onload = () => {
  if (lastStatus) renderMap(lastStatus);
};

window.addEventListener("resize", () => {
  if (lastStatus) renderMap(lastStatus);
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function el(tag, attrs = {}, text = undefined) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  if (text !== undefined) e.textContent = text;
  return e;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTs(ts) {
  if (!ts) return "—";
  try {
    const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
    return d.toLocaleString(undefined, {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return ts; }
}

// ── Start ──────────────────────────────────────────────────────────────────────

init();
