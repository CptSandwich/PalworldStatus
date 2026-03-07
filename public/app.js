// PalworldStatus — frontend
// Hash-based SPA: # = landing (server cards), #server/{id} = detail page

"use strict";

// ── State ─────────────────────────────────────────────────────────────────────

let currentUser = null;
let mapCalibration = null;
let lastStatus = null;
let pollTimer = null;
const POLL_INTERVAL_MS = 30_000;

// Detail page state
let detailContainerId = null;
let detailHistoryEnabled = false;
let detailHiddenPlayers = new Set(); // steamIds hidden in history view
let detailHistoryData = null;        // cached history response
let detailMapImg = null;             // <img> element for detail map
let detailCanvas = null;             // <canvas> for detail map
let detailMapInner = null;           // <div> that gets CSS zoom/pan transform
let mapZoom = 1;
let mapPanX = 0;
let mapPanY = 0;
let mapEventCleanup = null;          // fn to remove window drag listeners
let calibState = null;               // null | { step, points[], pendingFracX, pendingFracY }
let detailFullyRendered = false;     // true after first detail page render; resets on navigation
let savedCronValues = new Map();     // preserves unsaved cron text across landing page polls

// Player dot colours (cycle through palette)
const DOT_COLORS = ["#3ecfcf", "#4caf6e", "#9b6bdf", "#e05252", "#f0c040", "#5ab4e0"];

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  await loadUser();
  if (currentUser && (currentUser.role === "whitelisted" || currentUser.role === "admin")) {
    mapCalibration = await fetchMapCalibration();
    await startPolling();
  }
  window.addEventListener("hashchange", onHashChange);
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

async function startPolling() {
  clearInterval(pollTimer);
  renderCurrentView(); // show loading state immediately
  await poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

async function poll() {
  const status = await fetchStatus();
  if (status) lastStatus = status.servers;
  renderCurrentView();
}

async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Auth rendering ────────────────────────────────────────────────────────────

function renderAuth() {
  const html = document.documentElement;
  const authMsg = document.getElementById("auth-message");
  const steamLink = document.getElementById("steam-login-link");
  const logoutBtn = document.getElementById("logout-btn");
  const headerUser = document.getElementById("header-user");

  if (!currentUser) {
    html.dataset.role = "guest";
    authMsg.textContent = "Sign in to view server status.";
    authMsg.className = "auth-subtitle";
    steamLink.style.display = "";
    logoutBtn.style.display = "none";
    headerUser.innerHTML = "";
    return;
  }

  if (currentUser.role === "blacklisted" || currentUser.role === "unknown") {
    html.dataset.role = "denied";
    authMsg.textContent = "Your account is not authorised.";
    authMsg.className = "auth-subtitle denied";
    steamLink.style.display = "none";
    logoutBtn.style.display = "";
    logoutBtn.onclick = doLogout;
    headerUser.innerHTML = "";
    return;
  }

  html.dataset.role = currentUser.role;
  authMsg.textContent = "";
  steamLink.style.display = "none";
  logoutBtn.style.display = "none";

  headerUser.innerHTML = `
    <img class="header-avatar" src="${escHtml(currentUser.avatarUrl)}" alt="" />
    <span class="header-name">${escHtml(currentUser.displayName)}</span>
    ${currentUser.role === "admin"
      ? '<span style="font-size:11px;color:var(--accent-purple);font-family:var(--font-mono)">[admin]</span>'
      : ""}
    <button class="btn btn-secondary btn-small" id="header-logout-btn">Logout</button>
  `;
  document.getElementById("header-logout-btn").onclick = doLogout;
}

async function doLogout() {
  await fetch("/auth/logout", { method: "POST" });
  location.reload();
}

// ── Hash routing ──────────────────────────────────────────────────────────────

function getHash() {
  const h = location.hash.replace(/^#\/?/, "");
  return h;
}

function onHashChange() {
  const hash = getHash();
  const serverMatch = hash.match(/^server\/(.+)$/);
  if (serverMatch) {
    detailContainerId = serverMatch[1];
    detailHistoryEnabled = false;
    detailHiddenPlayers = new Set();
    detailHistoryData = null;
    detailMapImg = null;
    detailCanvas = null;
    detailMapInner = null;
    mapZoom = 1; mapPanX = 0; mapPanY = 0;
    calibState = null;
    detailFullyRendered = false;
    if (mapEventCleanup) { mapEventCleanup(); mapEventCleanup = null; }
  } else {
    detailContainerId = null;
  }
  renderCurrentView();
}

function renderCurrentView() {
  const hash = getHash();
  const serverMatch = hash.match(/^server\/(.+)$/);
  if (serverMatch) {
    if (!lastStatus) return;
    const id = serverMatch[1];
    const server = lastStatus.find((s) => s.serverId === id);
    if (server) {
      renderDetailPage(server);
    } else {
      // Server not found — go back to landing
      location.hash = "";
    }
  } else {
    renderLandingPage();
  }
}

// ── Landing page ──────────────────────────────────────────────────────────────

function renderLandingPage() {
  const root = document.getElementById("view-root");
  const existingGrid = document.getElementById("server-grid");

  if (existingGrid) {
    // Subsequent poll: preserve page structure, only update dynamic content

    // Save any unsaved cron expressions
    savedCronValues = new Map();
    root.querySelectorAll("[data-sid]").forEach(row => {
      const input = row.querySelector(".schedule-cron-input");
      if (input) savedCronValues.set(row.dataset.sid, input.value);
    });

    // Rebuild only the server grid cards
    existingGrid.innerHTML = "";
    if (!lastStatus || lastStatus.length === 0) {
      existingGrid.appendChild(el("p", { class: "empty-state" },
        lastStatus === null
          ? "Checking server status\u2026"
          : "No servers configured. Add palworld-status.enabled=true labels to Palworld containers."
      ));
    } else {
      for (const s of lastStatus) existingGrid.appendChild(buildServerCard(s));
    }

    // Refresh data-only sections (they target their own elements)
    fetchAndRenderAuditLog();
    if (currentUser?.role === "admin") {
      fetchAndRenderPlayers();
      fetchAndRenderSchedules();
    }
    return;
  }

  // First render: full page build
  root.innerHTML = "";

  // Server grid
  const gridSection = el("section", { class: "server-grid-section" });
  const gridHeader = el("div", { class: "section-header" });
  gridHeader.appendChild(el("h2", { class: "section-title" }, "Server Status"));
  gridSection.appendChild(gridHeader);

  const grid = el("div", { class: "server-grid", id: "server-grid" });
  if (!lastStatus || lastStatus.length === 0) {
    grid.appendChild(el("p", { class: "empty-state" },
      lastStatus === null
        ? "Checking server status\u2026"
        : "No servers configured. Add palworld-status.enabled=true labels to Palworld containers."
    ));
  } else {
    for (const s of lastStatus) grid.appendChild(buildServerCard(s));
  }
  gridSection.appendChild(grid);
  root.appendChild(gridSection);

  // Audit log
  const auditSection = el("section", { class: "audit-section" });
  const auditHeader = el("div", { class: "section-header" });
  auditHeader.appendChild(el("h2", { class: "section-title" }, "Audit Log"));
  auditSection.appendChild(auditHeader);
  const auditTable = el("table", { class: "data-table", id: "audit-table" });
  const auditHead = el("thead", {});
  const auditHeadRow = el("tr", {});
  for (const h of ["Time", "User", "Action", "Server", "Details"]) {
    auditHeadRow.appendChild(el("th", {}, h));
  }
  auditHead.appendChild(auditHeadRow);
  auditTable.appendChild(auditHead);
  auditTable.appendChild(el("tbody", { id: "audit-body" }));
  auditSection.appendChild(auditTable);
  root.appendChild(auditSection);
  fetchAndRenderAuditLog();

  // Admin: player management + restart schedules
  if (currentUser?.role === "admin") {
    const pmSection = el("section", { class: "admin-section", id: "player-management" });
    const pmHeader = el("div", { class: "section-header" });
    pmHeader.appendChild(el("h2", { class: "section-title" }, "Player Management"));
    pmSection.appendChild(pmHeader);
    const pmTable = el("table", { class: "data-table", id: "players-table" });
    const pmHead = el("thead", {});
    const pmHeadRow = el("tr", {});
    for (const h of ["Name", "First Seen", "Last Seen", "Last Server", "Access"]) {
      pmHeadRow.appendChild(el("th", {}, h));
    }
    pmHead.appendChild(pmHeadRow);
    pmTable.appendChild(pmHead);
    pmTable.appendChild(el("tbody", { id: "players-body" }));
    pmSection.appendChild(pmTable);
    root.appendChild(pmSection);
    fetchAndRenderPlayers();

    const schedSection = el("section", { class: "admin-section", id: "restart-schedules" });
    const schedHeader = el("div", { class: "section-header" });
    schedHeader.appendChild(el("h2", { class: "section-title" }, "Restart Schedules"));
    schedSection.appendChild(schedHeader);
    schedSection.appendChild(el("div", { id: "schedules-list" }));
    root.appendChild(schedSection);
    fetchAndRenderSchedules();
  }
}

// ── Server card (landing) ──────────────────────────────────────────────────────

function buildServerCard(s) {
  const gameStatus = s.dockerStatus !== "running" ? "offline"
    : s.gameStatus === "online"   ? "online"
    : s.gameStatus === "crashed"  ? "crashed"
    : s.gameStatus === "starting" ? "starting"
    : "offline";

  const statusLabel = {
    online:   "Online",
    crashed:  "Crashed",
    starting: "Starting",
    offline:  s.dockerStatus === "starting" ? "Starting" : "Offline",
  }[gameStatus] ?? "Offline";

  const card = el("div", {
    class: "server-card",
    "data-status": gameStatus,
    "data-id": s.serverId,
  });

  // Navigate to detail on card click (but not button clicks)
  card.addEventListener("click", (e) => {
    if (e.target.closest(".btn")) return;
    location.hash = `#server/${encodeURIComponent(s.serverId)}`;
  });

  // Header
  const header = el("div", { class: "server-card-header" });
  header.appendChild(el("span", { class: "status-dot" }));
  header.appendChild(el("span", { class: "server-name" }, s.name));
  const isLegacy = s.idleShutdownMinutes != null && s.idleShutdownMinutes > 0;
  header.appendChild(el("span", { class: `server-era-badge ${isLegacy ? "era-legacy" : "era-current"}` }, isLegacy ? "Legacy" : "Current"));
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
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(s.connectionAddress);
      copyBtn.textContent = "✓";
      setTimeout(() => copyBtn.textContent = "⎘", 1500);
    };
    conn.appendChild(copyBtn);
    meta.appendChild(conn);
  }
  body.appendChild(meta);

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
    cancelBtn.onclick = (e) => { e.stopPropagation(); cancelIdle(s.id); };
    countdown.appendChild(cancelBtn);
    body.appendChild(countdown);
  }

  // Pending timed action
  if (s.pendingTimedAction) {
    const secs = s.pendingTimedAction.remainingSeconds;
    const mins = Math.floor(secs / 60);
    const ss = secs % 60;
    const pa = el("div", { class: "idle-countdown" });
    pa.appendChild(el("span", {},
      `${s.pendingTimedAction.action === "restart" ? "Restart" : "Shutdown"} in ${mins}:${String(ss).padStart(2, "0")}`
    ));
    const cancelBtn = el("button", { class: "btn btn-small btn-secondary" }, "Cancel");
    cancelBtn.onclick = (e) => { e.stopPropagation(); cancelTimedAction(s.id); };
    pa.appendChild(cancelBtn);
    body.appendChild(pa);
  }

  // Crash guard notice
  if (s.crashGuard) {
    const cg = el("div", { class: `crash-guard-notice${s.crashGuard.blocked ? " crash-guard-blocked" : ""}` });
    if (s.crashGuard.blocked) {
      cg.textContent = "⚠ Auto-restart disabled — crash loop detected";
    } else if (s.crashGuard.restartPendingMs !== null) {
      cg.textContent = `↺ Auto-restart in ~${Math.ceil(s.crashGuard.restartPendingMs / 1000)}s (attempt ${s.crashGuard.attempts + 1}/3)`;
    } else if (s.crashGuard.attempts > 0) {
      cg.textContent = `↺ Auto-restarted ${s.crashGuard.attempts}×`;
    }
    if (cg.textContent) body.appendChild(cg);
  }

  card.appendChild(body);

  // Footer actions
  const footer = el("div", { class: "server-card-footer" });
  const isAdmin = currentUser?.role === "admin";
  if (gameStatus === "online" || gameStatus === "crashed" || gameStatus === "starting") {
    const restartBtn = el("button", { class: "btn btn-small" }, "↺ Restart");
    restartBtn.onclick = (e) => { e.stopPropagation(); doContainerAction(s.id, "restart", s.name, restartBtn); };
    footer.appendChild(restartBtn);
    if (isAdmin) {
      const stopBtn = el("button", { class: "btn btn-small btn-danger" }, "■ Stop");
      stopBtn.onclick = (e) => { e.stopPropagation(); doContainerAction(s.id, "stop", s.name, stopBtn); };
      footer.appendChild(stopBtn);
    }
  } else if (gameStatus === "offline" && s.allowStart) {
    const startBtn = el("button", { class: "btn btn-small" }, "▶ Start");
    startBtn.onclick = (e) => { e.stopPropagation(); doContainerAction(s.id, "start", s.name, startBtn); };
    footer.appendChild(startBtn);
  }
  if (isAdmin && s.containerName) {
    footer.appendChild(el("span", { class: "container-name-badge" }, s.containerName));
  }
  if (footer.children.length > 0) card.appendChild(footer);

  return card;
}

// ── Detail page ───────────────────────────────────────────────────────────────

function renderDetailPage(s) {
  const gameStatus = s.dockerStatus !== "running" ? "offline"
    : s.gameStatus === "online"   ? "online"
    : s.gameStatus === "crashed"  ? "crashed"
    : s.gameStatus === "starting" ? "starting"
    : "offline";

  const statusLabel = {
    online:   "Online",
    crashed:  "Crashed",
    starting: "Starting",
    offline:  s.dockerStatus === "starting" ? "Starting" : "Offline",
  }[gameStatus] ?? "Offline";

  // Subsequent poll: only update dynamic section, leave map/chat DOM intact
  if (detailFullyRendered && document.getElementById("dp-dynamic")) {
    const dot = document.getElementById("dp-status-dot");
    if (dot) dot.style.cssText = `background:var(--status-${gameStatus});box-shadow:0 0 7px var(--status-${gameStatus})`;
    const lbl = document.getElementById("dp-status-label");
    if (lbl) { lbl.textContent = statusLabel; lbl.style.color = `var(--status-${gameStatus})`; }
    const dyn = document.getElementById("dp-dynamic");
    dyn.innerHTML = "";
    _buildDetailDynamic(dyn, s, gameStatus);
    renderDetailCanvas(s);
    void refreshChatLog(s.id);
    return;
  }

  // First render: full page build
  const root = document.getElementById("view-root");
  root.innerHTML = "";

  // Detail header (IDs allow targeted status updates on subsequent polls)
  const hdr = el("div", { class: "detail-header" });
  const backBtn = el("button", { class: "back-btn" }, "← Back");
  backBtn.onclick = () => { location.hash = ""; };
  hdr.appendChild(backBtn);
  hdr.appendChild(el("span", {
    id: "dp-status-dot",
    class: "status-dot",
    style: `background:var(--status-${gameStatus});box-shadow:0 0 7px var(--status-${gameStatus})`,
  }));
  hdr.appendChild(el("span", { class: "detail-server-name" }, s.name));
  if (currentUser?.role === "admin" && s.containerName) {
    hdr.appendChild(el("span", { class: "container-name-badge" }, s.containerName));
  }
  hdr.appendChild(el("span", {
    id: "dp-status-label",
    class: "status-label",
    style: `color:var(--status-${gameStatus})`,
  }, statusLabel));
  root.appendChild(hdr);

  // Dynamic section (rebuilt on every poll)
  const dyn = el("div", { id: "dp-dynamic" });
  root.appendChild(dyn);
  _buildDetailDynamic(dyn, s, gameStatus);

  // Static sections (built once, never rebuilt by poll)
  buildDetailMap(root, s);
  void buildChatLog(root, s.id);

  detailFullyRendered = true;
}

function _buildDetailDynamic(dyn, s, gameStatus) {
  // Server info strip
  const infoPanel = el("div", { class: "detail-panel" });
  const metaRow = el("div", { style: "display:flex;gap:24px;flex-wrap:wrap;align-items:center" });
  if (s.version) {
    metaRow.appendChild(el("span", { class: "server-version" }, `v${s.version}`));
  }
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
    metaRow.appendChild(conn);
  }
  if (gameStatus === "online") {
    metaRow.appendChild(el("span", { class: "player-count" },
      `Players: ${s.players.length}${s.maxPlayers ? `/${s.maxPlayers}` : ""}`
    ));
  }
  infoPanel.appendChild(metaRow);

  // Idle countdown
  if (s.idleCountdownSeconds !== null) {
    const mins = Math.floor(s.idleCountdownSeconds / 60);
    const secs = s.idleCountdownSeconds % 60;
    const countdown = el("div", { class: "idle-countdown" });
    countdown.appendChild(el("span", {}, `Idle shutdown in ${mins}:${String(secs).padStart(2, "0")}`));
    const cancelBtn = el("button", { class: "btn btn-small btn-secondary" }, "Cancel");
    cancelBtn.onclick = () => cancelIdle(s.id);
    countdown.appendChild(cancelBtn);
    infoPanel.appendChild(countdown);
  }
  dyn.appendChild(infoPanel);

  // Player list
  if (gameStatus === "online" && s.players.length > 0) {
    const playersPanel = el("div", { class: "detail-panel" });
    playersPanel.appendChild(el("div", { class: "detail-panel-title" }, "Players Online"));
    const list = el("div", { class: "player-list" });
    for (const p of s.players) {
      const row = el("div", { class: "player-row" });
      row.appendChild(el("span", { class: "player-name" }, p.name));
      row.appendChild(el("span", { class: "player-level" }, `Lv.${p.level}`));
      row.appendChild(el("span", { class: "player-coords" },
        `X: ${p.locationX.toFixed(2)}  Y: ${p.locationY.toFixed(2)}`
      ));
      list.appendChild(row);
    }
    playersPanel.appendChild(list);
    dyn.appendChild(playersPanel);
  }

  // Action panels
  if (currentUser?.role === "admin") {
    buildTimedActionPanel(dyn, s);
  } else if (currentUser?.role === "whitelisted") {
    buildWhitelistedRestartPanel(dyn, s, gameStatus);
  }
  if (currentUser?.role === "admin" && gameStatus === "online") {
    buildBroadcastPanel(dyn, s);
  }
}

// ── Timed action panel ────────────────────────────────────────────────────────

function buildTimedActionPanel(root, s) {
  const panel = el("div", { class: "timed-action-panel" });

  if (s.pendingTimedAction) {
    const secs = s.pendingTimedAction.remainingSeconds;
    const mins = Math.floor(secs / 60);
    const ss = secs % 60;
    panel.appendChild(el("span", { class: "pending-action-label" },
      `${s.pendingTimedAction.action === "restart" ? "Restart" : "Shutdown"} pending: ${mins}:${String(ss).padStart(2, "0")}`
    ));
    const cancelBtn = el("button", { class: "btn btn-small btn-secondary" }, "Cancel");
    cancelBtn.onclick = () => cancelTimedAction(s.id);
    panel.appendChild(cancelBtn);
  } else {
    const label = el("label", {}, "In ");
    panel.appendChild(label);
    const minsInput = el("input", {
      class: "minutes-input",
      type: "number",
      min: "0",
      value: "5",
      placeholder: "0",
    });
    panel.appendChild(minsInput);
    panel.appendChild(el("span", { style: "color:var(--text-secondary);font-size:13px" }, " minutes:"));

    const restartBtn = el("button", { class: "btn btn-small" }, "↺ Restart");
    restartBtn.onclick = () => doTimedAction(s.id, "restart", parseInt(minsInput.value) || 0, restartBtn);
    panel.appendChild(restartBtn);

    if (s.dockerStatus === "running") {
      const stopBtn = el("button", { class: "btn btn-small btn-danger" }, "■ Shutdown");
      stopBtn.onclick = () => doTimedAction(s.id, "stop", parseInt(minsInput.value) || 0, stopBtn);
      panel.appendChild(stopBtn);
    }
  }

  root.appendChild(panel);
}

async function doTimedAction(id, action, minutes, btn) {
  const label = minutes === 0 ? "immediately" : `in ${minutes} minute${minutes !== 1 ? "s" : ""}`;
  if (!confirm(`${action === "restart" ? "Restart" : "Shutdown"} server ${label}?`)) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/containers/${encodeURIComponent(id)}/timed-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, minutes }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(`Error: ${d.error ?? res.statusText}`);
    } else {
      await poll();
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function cancelTimedAction(id) {
  await fetch(`/api/containers/${encodeURIComponent(id)}/cancel-timed-action`, { method: "POST" });
  await poll();
}

// ── Whitelisted restart panel (simple restart, server enforces 5-min delay) ──

function buildWhitelistedRestartPanel(root, s, gameStatus) {
  if (gameStatus !== "online" && gameStatus !== "crashed" && gameStatus !== "starting") return;
  const panel = el("div", { class: "timed-action-panel" });

  if (s.pendingTimedAction) {
    const secs = s.pendingTimedAction.remainingSeconds;
    const mins = Math.floor(secs / 60);
    const ss = secs % 60;
    panel.appendChild(el("span", { class: "pending-action-label" },
      `Restart pending: ${mins}:${String(ss).padStart(2, "0")}`
    ));
  } else {
    const restartBtn = el("button", { class: "btn btn-small" }, "↺ Restart");
    restartBtn.onclick = () => doContainerAction(s.id, "restart", s.name, restartBtn);
    panel.appendChild(restartBtn);
    panel.appendChild(el("span", { style: "color:var(--text-secondary);font-size:13px;margin-left:8px" },
      "A 5-minute countdown will be broadcast in-game."
    ));
  }

  root.appendChild(panel);
}

// ── Broadcast panel ───────────────────────────────────────────────────────────

function buildBroadcastPanel(root, s) {
  const MAX_CHARS = 256;
  const panel = el("div", { class: "broadcast-panel" });
  panel.appendChild(el("div", { class: "detail-panel-title" }, "Broadcast Message"));

  const textarea = el("textarea", { class: "broadcast-input", maxlength: MAX_CHARS, placeholder: "Enter message to broadcast in-game…" });
  panel.appendChild(textarea);

  const footer = el("div", { class: "broadcast-footer" });
  const counter = el("span", { class: "char-counter" }, `0 / ${MAX_CHARS}`);
  textarea.oninput = () => {
    counter.textContent = `${textarea.value.length} / ${MAX_CHARS}`;
  };

  const sendBtn = el("button", { class: "btn btn-small" }, "Broadcast");
  sendBtn.onclick = async () => {
    const msg = textarea.value.trim();
    if (!msg) return;
    sendBtn.disabled = true;
    try {
      const res = await fetch(`/api/containers/${encodeURIComponent(s.id)}/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      if (res.ok) {
        textarea.value = "";
        counter.textContent = `0 / ${MAX_CHARS}`;
      } else {
        const d = await res.json().catch(() => ({}));
        alert(`Error: ${d.error ?? res.statusText}`);
      }
    } catch (err) {
      alert(`Network error: ${err.message}`);
    } finally {
      sendBtn.disabled = false;
    }
  };

  footer.appendChild(counter);
  footer.appendChild(sendBtn);
  panel.appendChild(footer);
  root.appendChild(panel);
}

// ── Detail map ────────────────────────────────────────────────────────────────

function applyMapTransform() {
  if (!detailMapInner) return;
  detailMapInner.style.transform = `translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom})`;
}

function renderCalibPanel(panelEl, s, calibBtn, mapContainer) {
  panelEl.innerHTML = "";
  if (!calibState) return;

  const CALIB_COLORS = ["#ff4444", "#ff8800"];
  const step = calibState.points.length + 1; // 1 or 2

  const title = el("div", { class: "calib-panel-title" },
    `Step ${step} of 2 — ${step === 1 ? "First" : "Second"} reference point`);
  panelEl.appendChild(title);

  const hint = el("p", { class: "calib-hint" },
    "Click the map where you know a player's position, then enter their world coordinates below. " +
    "Use two distant points for best accuracy.");
  panelEl.appendChild(hint);

  // Confirmed points summary
  calibState.points.forEach((pt, i) => {
    const row = el("div", { class: "calib-confirmed-point" });
    row.style.borderLeftColor = CALIB_COLORS[i];
    row.textContent = `P${i + 1}: world (${Math.round(pt.worldX)}, ${Math.round(pt.worldY)})  ·  map (${(pt.fracX * 100).toFixed(1)}%, ${(pt.fracY * 100).toFixed(1)}%)`;
    panelEl.appendChild(row);
  });

  // Click status
  const clickStatus = el("div", { class: "calib-click-status" });
  clickStatus.textContent = calibState.pendingFracX !== null
    ? `Map clicked at (${(calibState.pendingFracX * 100).toFixed(1)}%, ${(calibState.pendingFracY * 100).toFixed(1)}%) — now enter world coordinates`
    : "Click on the map to set the reference point";
  panelEl.appendChild(clickStatus);

  // Live players for reference
  if (s.players.length > 0) {
    const refTitle = el("div", { class: "calib-ref-title" }, "Live player coordinates (for reference):");
    panelEl.appendChild(refTitle);
    const refList = el("div", { class: "calib-ref-list" });
    for (const p of s.players) {
      if (!p.locationX && !p.locationY) continue;
      const row = el("div", { class: "calib-ref-row" });
      const nameEl = el("span", { class: "calib-ref-name" }, p.name || p.steamId);
      const coordsEl = el("span", { class: "calib-ref-coords" },
        `X: ${Math.round(p.locationX)}  Y: ${Math.round(p.locationY)}`);
      const useBtn = el("button", { class: "btn btn-small btn-secondary" }, "Use");
      useBtn.onclick = () => {
        wxInput.value = Math.round(p.locationX);
        wyInput.value = Math.round(p.locationY);
      };
      row.appendChild(nameEl); row.appendChild(coordsEl); row.appendChild(useBtn);
      refList.appendChild(row);
    }
    panelEl.appendChild(refList);
  }

  // World coordinate inputs
  const inputRow = el("div", { class: "calib-input-row" });
  const wxLabel = el("label", { class: "calib-label" }, `World X:`);
  const wxInput = el("input", { type: "number", class: "calib-input", placeholder: "e.g. -245000" });
  const wyLabel = el("label", { class: "calib-label" }, `World Y:`);
  const wyInput = el("input", { type: "number", class: "calib-input", placeholder: "e.g. 178000" });
  inputRow.appendChild(wxLabel); inputRow.appendChild(wxInput);
  inputRow.appendChild(wyLabel); inputRow.appendChild(wyInput);
  panelEl.appendChild(inputRow);

  // Action buttons
  const btnRow = el("div", { class: "calib-btn-row" });

  const setBtn = el("button", { class: "btn btn-primary btn-small" },
    step === 1 ? "Set Point 1 →" : "Set Point 2 →");
  setBtn.onclick = () => {
    const worldX = parseFloat(wxInput.value);
    const worldY = parseFloat(wyInput.value);
    if (isNaN(worldX) || isNaN(worldY)) { alert("Enter valid world coordinates."); return; }
    if (calibState.pendingFracX === null) { alert("Click a location on the map first."); return; }
    calibState.points.push({
      worldX, worldY,
      fracX: calibState.pendingFracX,
      fracY: calibState.pendingFracY,
    });
    calibState.pendingFracX = null;
    calibState.pendingFracY = null;
    renderDetailCanvas(s);
    if (calibState.points.length >= 2) {
      renderCalibSavePanel(panelEl, s, calibBtn, mapContainer);
    } else {
      renderCalibPanel(panelEl, s, calibBtn, mapContainer);
    }
  };
  btnRow.appendChild(setBtn);
  panelEl.appendChild(btnRow);
}

function renderCalibSavePanel(panelEl, s, calibBtn, mapContainer) {
  panelEl.innerHTML = "";

  const title = el("div", { class: "calib-panel-title" }, "Review & Save Calibration");
  panelEl.appendChild(title);

  const [p1, p2] = calibState.points;
  const CALIB_COLORS = ["#ff4444", "#ff8800"];
  [p1, p2].forEach((pt, i) => {
    const row = el("div", { class: "calib-confirmed-point" });
    row.style.borderLeftColor = CALIB_COLORS[i];
    row.textContent = `P${i + 1}: world (${Math.round(pt.worldX)}, ${Math.round(pt.worldY)})  ·  map (${(pt.fracX * 100).toFixed(1)}%, ${(pt.fracY * 100).toFixed(1)}%)`;
    panelEl.appendChild(row);
  });

  const btnRow = el("div", { class: "calib-btn-row" });

  const saveBtn = el("button", { class: "btn btn-primary btn-small" }, "Save Calibration");
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const res = await fetch("/api/map-calibration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: calibState.points }),
      });
      if (!res.ok) { alert("Save failed: " + (await res.json()).error); saveBtn.disabled = false; saveBtn.textContent = "Save Calibration"; return; }
      const newCal = await res.json();
      mapCalibration = newCal;
      calibState = null;
      mapContainer.style.cursor = "";
      panelEl.style.display = "none";
      calibBtn.textContent = "Recalibrate";
      renderDetailCanvas(s);
    } catch (e) {
      alert("Save failed: " + e.message);
      saveBtn.disabled = false; saveBtn.textContent = "Save Calibration";
    }
  };

  const resetBtn2 = el("button", { class: "btn btn-secondary btn-small" }, "Start Over");
  resetBtn2.onclick = () => {
    calibState.points = [];
    calibState.pendingFracX = null;
    calibState.pendingFracY = null;
    renderDetailCanvas(s);
    renderCalibPanel(panelEl, s, calibBtn, mapContainer);
  };

  const deleteBtn = el("button", { class: "btn btn-secondary btn-small" }, "Reset to Default");
  deleteBtn.onclick = async () => {
    if (!confirm("Reset map calibration to defaults?")) return;
    await fetch("/api/map-calibration", { method: "DELETE" });
    mapCalibration = await (await fetch("/api/map-calibration")).json();
    calibState = null;
    mapContainer.style.cursor = "";
    panelEl.style.display = "none";
    calibBtn.textContent = mapCalibration?.calibrated ? "Recalibrate" : "Calibrate Map";
    renderDetailCanvas(s);
  };

  btnRow.appendChild(saveBtn); btnRow.appendChild(resetBtn2); btnRow.appendChild(deleteBtn);
  panelEl.appendChild(btnRow);
}

function buildDetailMap(root, s) {
  const section = el("div", {});

  const sectionHeader = el("div", { class: "section-header" });
  sectionHeader.appendChild(el("h2", { class: "section-title" }, "World Map"));

  // History toggle button
  const histBtn = el("button", {
    class: `btn btn-small btn-purple`,
  }, detailHistoryEnabled ? "Hide History" : "Show History");
  histBtn.onclick = async () => {
    detailHistoryEnabled = !detailHistoryEnabled;
    histBtn.textContent = detailHistoryEnabled ? "Hide History" : "Show History";
    if (detailHistoryEnabled && !detailHistoryData) {
      try {
        const res = await fetch(`/api/containers/${encodeURIComponent(s.id)}/location-history`);
        if (res.ok) detailHistoryData = await res.json();
      } catch { detailHistoryData = null; }
    }
    renderDetailCanvas(s);
    renderHistoryLegend(legendEl, s);
  };
  sectionHeader.appendChild(histBtn);
  section.appendChild(sectionHeader);

  // Reset view button
  const resetBtn = el("button", { class: "btn btn-small btn-secondary" }, "Reset View");
  resetBtn.onclick = () => { mapZoom = 1; mapPanX = 0; mapPanY = 0; applyMapTransform(); };
  sectionHeader.appendChild(resetBtn);

  // Calibrate button (admin only)
  let calibPanelEl = null;
  if (currentUser?.role === "admin") {
    const calibBtn = el("button", { class: "btn btn-small btn-secondary" },
      mapCalibration?.calibrated ? "Recalibrate" : "Calibrate Map");
    calibBtn.onclick = () => {
      if (calibState) {
        calibState = null;
        mapContainer.style.cursor = "";
        calibPanelEl.style.display = "none";
        calibBtn.textContent = mapCalibration?.calibrated ? "Recalibrate" : "Calibrate Map";
        renderDetailCanvas(s);
      } else {
        calibState = { step: 1, points: [], pendingFracX: null, pendingFracY: null, refreshPanel: () => {} };
        mapContainer.style.cursor = "crosshair";
        calibBtn.textContent = "Cancel Calibration";
        calibPanelEl.style.display = "";
        renderCalibPanel(calibPanelEl, s, calibBtn, mapContainer);
        calibState.refreshPanel = () => renderCalibPanel(calibPanelEl, s, calibBtn, mapContainer);
      }
    };
    sectionHeader.appendChild(calibBtn);
  }

  // Map container (viewport — clips the inner div)
  const mapContainer = el("div", { class: "map-container" });
  const inner = el("div", { class: "map-inner" });
  const mapImg = el("img", { class: "map-img", src: "/palworld-map.webp", alt: "Palworld World Map" });
  const canvas = el("canvas", { class: "map-canvas" });
  inner.appendChild(mapImg);
  inner.appendChild(canvas);
  mapContainer.appendChild(inner);
  section.appendChild(mapContainer);

  // Calibration panel (admin only, initially hidden)
  if (currentUser?.role === "admin") {
    calibPanelEl = el("div", { class: "calib-panel", style: "display:none" });
    section.appendChild(calibPanelEl);
  }

  // History legend placeholder
  const legendEl = el("div", { class: "history-legend", style: "display:none" });
  section.appendChild(legendEl);

  root.appendChild(section);

  // Store refs for re-renders
  detailMapImg = mapImg;
  detailCanvas = canvas;
  detailMapInner = inner;

  // ── Zoom on scroll wheel ──────────────────────────────────────────────────
  mapContainer.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = mapContainer.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newZoom = Math.min(Math.max(mapZoom * factor, 0.25), 12);
    const ix = (cx - mapPanX) / mapZoom;
    const iy = (cy - mapPanY) / mapZoom;
    mapPanX = cx - ix * newZoom;
    mapPanY = cy - iy * newZoom;
    mapZoom = newZoom;
    applyMapTransform();
  }, { passive: false });

  // ── Pan on drag / calibration click ──────────────────────────────────────
  let drag = null;
  mapContainer.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { startX: e.clientX - mapPanX, startY: e.clientY - mapPanY,
             initX: e.clientX, initY: e.clientY };
    if (!calibState) mapContainer.style.cursor = "grabbing";
  });
  const onMouseMove = (e) => {
    if (!drag) return;
    mapPanX = e.clientX - drag.startX;
    mapPanY = e.clientY - drag.startY;
    applyMapTransform();
  };
  const onMouseUp = (e) => {
    if (!drag) return;
    if (calibState) {
      const dx = e.clientX - drag.initX, dy = e.clientY - drag.initY;
      if (dx * dx + dy * dy < 25) { // < 5px — treat as calibration click
        const rect = mapContainer.getBoundingClientRect();
        const cx = (e.clientX - rect.left - mapPanX) / mapZoom;
        const cy = (e.clientY - rect.top  - mapPanY) / mapZoom;
        calibState.pendingFracX = cx / detailMapImg.offsetWidth;
        calibState.pendingFracY = cy / detailMapImg.offsetHeight;
        renderDetailCanvas(s);
        calibState.refreshPanel();
      }
    }
    drag = null;
    mapContainer.style.cursor = calibState ? "crosshair" : "";
  };
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  mapEventCleanup = () => {
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  };

  mapImg.onload = () => renderDetailCanvas(s);
  window.addEventListener("resize", () => renderDetailCanvas(s), { once: false });

  // Draw after append (image might already be cached)
  requestAnimationFrame(() => renderDetailCanvas(s));
}

function renderDetailCanvas(s) {
  if (!detailCanvas || !detailMapImg) return;
  const ctx = detailCanvas.getContext("2d");

  detailCanvas.width = detailMapImg.offsetWidth;
  detailCanvas.height = detailMapImg.offsetHeight;
  ctx.clearRect(0, 0, detailCanvas.width, detailCanvas.height);

  if (!mapCalibration) return;
  const { scaleX, offsetX, scaleY, offsetY } = mapCalibration;

  function worldToCanvas(wx, wy) {
    return {
      cx: (wx * scaleX + offsetX) * detailCanvas.width,
      cy: (wy * scaleY + offsetY) * detailCanvas.height,
    };
  }

  // Build player → color map (consistent across renders)
  const playerColors = {};
  let colorIdx = 0;
  for (const p of s.players) {
    if (!playerColors[p.steamId]) {
      playerColors[p.steamId] = DOT_COLORS[colorIdx++ % DOT_COLORS.length];
    }
  }

  // Draw exploration fog clouds
  if (detailHistoryEnabled && detailHistoryData) {
    ctx.save();
    ctx.filter = "blur(18px)";
    ctx.globalAlpha = 0.28;
    for (const ph of detailHistoryData.players) {
      if (detailHiddenPlayers.has(ph.steamId)) continue;
      const color = playerColors[ph.steamId] ?? DOT_COLORS[0];
      ctx.fillStyle = color;
      for (const pt of ph.points) {
        const { cx, cy } = worldToCanvas(pt.x, pt.y);
        ctx.beginPath();
        ctx.arc(cx, cy, 14, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // Draw live player dots
  for (const p of s.players) {
    const color = playerColors[p.steamId] ?? DOT_COLORS[0];
    if (!p.locationX && !p.locationY) continue;
    const { cx, cy } = worldToCanvas(p.locationX, p.locationY);

    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.font = "11px 'Noto Sans', sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 4;
    ctx.fillText(p.name, cx + 8, cy + 4);
    ctx.shadowBlur = 0;
  }

  // Draw calibration markers
  if (calibState) {
    const CALIB_COLORS = ["#ff4444", "#ff8800"];

    // Confirmed points
    calibState.points.forEach((pt, i) => {
      const px = pt.fracX * detailCanvas.width;
      const py = pt.fracY * detailCanvas.height;
      const col = CALIB_COLORS[i];
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fillStyle = col + "33";
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px - 14, py); ctx.lineTo(px + 14, py);
      ctx.moveTo(px, py - 14); ctx.lineTo(px, py + 14);
      ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = "bold 11px 'Noto Sans', sans-serif";
      ctx.fillStyle = col;
      ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 4;
      ctx.fillText(`P${i + 1}`, px + 11, py - 9);
      ctx.shadowBlur = 0;
    });

    // Pending click marker (dashed, before world coords confirmed)
    if (calibState.pendingFracX !== null) {
      const i = calibState.points.length;
      const px = calibState.pendingFracX * detailCanvas.width;
      const py = calibState.pendingFracY * detailCanvas.height;
      const col = CALIB_COLORS[i] ?? "#ffffff";
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(px - 14, py); ctx.lineTo(px + 14, py);
      ctx.moveTo(px, py - 14); ctx.lineTo(px, py + 14);
      ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

function renderHistoryLegend(legendEl, s) {
  legendEl.innerHTML = "";
  if (!detailHistoryEnabled || !detailHistoryData) {
    legendEl.style.display = "none";
    return;
  }
  legendEl.style.display = "";

  let colorIdx = 0;
  const allPlayers = new Map();
  // Combine live + history players
  for (const p of s.players) {
    allPlayers.set(p.steamId, p.name);
  }
  if (detailHistoryData) {
    for (const ph of detailHistoryData.players) {
      if (!allPlayers.has(ph.steamId)) {
        allPlayers.set(ph.steamId, ph.characterName ?? ph.steamId);
      }
    }
  }

  for (const [steamId, name] of allPlayers) {
    const color = DOT_COLORS[colorIdx++ % DOT_COLORS.length];
    const item = el("div", {
      class: `history-legend-item ${detailHiddenPlayers.has(steamId) ? "hidden" : ""}`,
    });
    const dot = el("span", { class: "history-legend-dot", style: `background:${color}` });
    item.appendChild(dot);
    item.appendChild(document.createTextNode(name));
    item.onclick = () => {
      if (detailHiddenPlayers.has(steamId)) {
        detailHiddenPlayers.delete(steamId);
        item.classList.remove("hidden");
      } else {
        detailHiddenPlayers.add(steamId);
        item.classList.add("hidden");
      }
      renderDetailCanvas(s);
    };
    legendEl.appendChild(item);
  }
}

// ── Chat log ──────────────────────────────────────────────────────────────────

async function buildChatLog(root, containerId) {
  const section = el("div", {});
  section.appendChild(el("h2", { class: "section-title", style: "margin-bottom:10px" }, "Chat Log"));

  const logEl = el("div", { class: "chat-log", id: "chat-log" });
  section.appendChild(logEl);
  root.appendChild(section);

  await refreshChatLog(containerId);
}

async function refreshChatLog(containerId) {
  const logEl = document.getElementById("chat-log");
  if (!logEl) return;
  try {
    const res = await fetch(`/api/containers/${encodeURIComponent(containerId)}/chat-log?limit=100`);
    if (!res.ok) return;
    const data = await res.json();
    logEl.innerHTML = "";
    if (!data.messages.length) {
      logEl.appendChild(el("span", { class: "chat-log-empty" }, "No messages recorded yet."));
      return;
    }
    for (const m of data.messages) {
      const entry = el("div", { class: "chat-entry" });
      const time = el("span", { class: "chat-time" }, formatTs(m.timestamp, true));
      entry.appendChild(time);
      if (m.player_name) {
        const player = el("span", { class: "chat-player" }, m.player_name + ": ");
        entry.appendChild(player);
      }
      entry.appendChild(document.createTextNode(m.message));
      logEl.appendChild(entry);
    }
    logEl.scrollTop = logEl.scrollHeight;
  } catch { /* silently ignore */ }
}

// ── Container actions ─────────────────────────────────────────────────────────

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
    const tbody = document.getElementById("audit-body");
    if (!tbody) return;
    tbody.innerHTML = "";
    for (const e of data.entries) {
      const tr = el("tr", {});
      tr.appendChild(el("td", { class: "mono" }, formatTs(e.timestamp)));
      tr.appendChild(el("td", {}, e.display_name ?? e.steam_id ?? "system"));
      tr.appendChild(el("td", {}, e.action));
      tr.appendChild(el("td", {}, e.container_name ?? "—"));
      tr.appendChild(el("td", { class: "mono" }, e.details ?? "—"));
      tbody.appendChild(tr);
    }
  } catch { }
}

// ── Player management ─────────────────────────────────────────────────────────

async function fetchAndRenderPlayers() {
  try {
    const res = await fetch("/api/known-players");
    if (!res.ok) return;
    const data = await res.json();
    const tbody = document.getElementById("players-body");
    if (!tbody) return;
    tbody.innerHTML = "";
    for (const p of data.players) {
      const displayName = p.character_name || p.display_name || p.steam_id;
      const tr = el("tr", {});
      tr.appendChild(el("td", {}, displayName));
      tr.appendChild(el("td", { class: "mono" }, formatTs(p.first_seen)));
      tr.appendChild(el("td", { class: "mono" }, formatTs(p.last_seen)));
      tr.appendChild(el("td", {}, p.last_server ?? "—"));
      const actionTd = el("td", {});
      if (p.steam_id === currentUser?.steamId) {
        actionTd.appendChild(el("span", {
          style: "font-size:11px;color:var(--accent-purple);font-family:var(--font-mono);padding:2px 6px",
        }, "[admin]"));
      } else {
        if (p.status === "whitelisted") {
          const blBtn = el("button", { class: "btn btn-small btn-danger" }, "✗ Blacklist");
          blBtn.onclick = () => setPlayerStatus(p.steam_id, "blacklisted", blBtn);
          actionTd.appendChild(blBtn);
        } else {
          const wlBtn = el("button", { class: "btn btn-small" }, "✓ Whitelist");
          wlBtn.onclick = () => setPlayerStatus(p.steam_id, "whitelisted", wlBtn);
          actionTd.appendChild(wlBtn);
        }
        const delBtn = el("button", { class: "btn btn-small btn-danger", title: "Delete record" }, "🗑");
        delBtn.onclick = () => deletePlayerRecord(p.steam_id, delBtn);
        actionTd.appendChild(delBtn);
      }
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    }
  } catch { }
}

async function setPlayerStatus(steamId, status, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/api/known-players/${encodeURIComponent(steamId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(`Error: ${d.error ?? res.statusText}`);
    } else {
      await fetchAndRenderPlayers();
    }
  } finally {
    btn.disabled = false;
  }
}

async function deletePlayerRecord(steamId, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/api/known-players/${encodeURIComponent(steamId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(`Error: ${d.error ?? res.statusText}`);
    } else {
      await fetchAndRenderPlayers();
    }
  } finally {
    btn.disabled = false;
  }
}

// ── Restart schedules ─────────────────────────────────────────────────────────

async function fetchAndRenderSchedules() {
  if (!lastStatus) return;
  try {
    const res = await fetch("/api/schedules");
    if (!res.ok) return;
    const { schedules } = await res.json();
    renderSchedules(schedules, lastStatus);
  } catch { }
}

function renderSchedules(schedules, servers) {
  const container = document.getElementById("schedules-list");
  if (!container) return;
  container.innerHTML = "";

  for (const s of servers) {
    const sched = schedules.find((x) => x.container_id === s.id);
    const cronVal = sched?.cron_expr ?? "";
    const enabledVal = sched?.enabled === 1;

    const row = el("div", { class: `schedule-row ${enabledVal ? "enabled" : ""}`, "data-sid": s.id });
    row.appendChild(el("span", { class: "schedule-name" }, s.name));

    const savedCron = savedCronValues.get(s.id);
    if (savedCron !== undefined) savedCronValues.delete(s.id);
    const cronInput = el("input", {
      class: "schedule-cron-input",
      type: "text",
      placeholder: "cron expression (e.g. 0 4 * * *)",
      value: savedCron !== undefined ? savedCron : cronVal,
    });

    const enableLabel = el("label", { class: "schedule-toggle" });
    const enableChk = el("input", { type: "checkbox" });
    enableChk.checked = enabledVal;
    enableLabel.appendChild(enableChk);
    enableLabel.appendChild(document.createTextNode(" Enabled"));

    const saveBtn = el("button", { class: "btn btn-small" }, "Save");
    saveBtn.onclick = async () => {
      const cron = cronInput.value.trim();
      saveBtn.disabled = true;
      try {
        if (!cron) {
          const res = await fetch(`/api/schedules/${encodeURIComponent(s.id)}`, { method: "DELETE" });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            alert(`Error: ${d.error ?? res.statusText}`);
          }
        } else {
          const res = await fetch(`/api/schedules/${encodeURIComponent(s.id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cronExpr: cron, enabled: enableChk.checked }),
          });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            alert(`Error saving schedule: ${d.error ?? res.statusText}`);
            return;
          }
        }
        await fetchAndRenderSchedules();
      } finally {
        saveBtn.disabled = false;
      }
    };

    row.appendChild(cronInput);
    row.appendChild(enableLabel);
    row.appendChild(saveBtn);
    container.appendChild(row);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function el(tag, attrs = {}, text = undefined) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
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

function formatTs(ts, timeOnly = false) {
  if (!ts) return "—";
  try {
    const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
    if (timeOnly) {
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    return d.toLocaleString(undefined, {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return ts; }
}

// ── Start ──────────────────────────────────────────────────────────────────────

// Handle initial hash on page load
(function checkInitialHash() {
  const hash = getHash();
  const serverMatch = hash.match(/^server\/(.+)$/);
  if (serverMatch) {
    detailContainerId = serverMatch[1];
  }
})();

init();
