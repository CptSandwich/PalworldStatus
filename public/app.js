// PalworldStatus — frontend
// Hash-based SPA: # = landing (server cards), #server/{id} = detail page

"use strict";

// ── State ─────────────────────────────────────────────────────────────────────

let currentUser = null;
let viewAsWhitelisted = false;
let mapCalibration = null;
let lastStatus = null;
let pollTimer = null;
const pmExpandedIds = new Set(); // steam IDs whose PM sub-rows should stay expanded
const pmWasOnline = new Set();   // steam IDs that were online in the previous render
const POLL_INTERVAL_MS = 10_000;
let _chatLastTs = null;          // timestamp of last seen chat message

// Detail page state
let detailContainerId = null;
let detailHistoryEnabled = false;
let detailHiddenPlayers = new Set(); // steamIds hidden in history view
let detailHistoryData = null;        // cached history response
let detailKnownPlayers = null;       // known_players for current container
let detailExpandedPlayers = new Set(); // steamIds with expanded rows
let detailMapImg = null;             // <img> element for detail map
let detailCanvas = null;             // <canvas> for detail map
let detailMapInner = null;           // <div> that gets CSS zoom/pan transform
let mapZoom = 1;
let mapPanX = 0;
let mapPanY = 0;
let mapEventCleanup = null;          // fn to remove window drag listeners
let calibState = null;               // null | { step, points[], pendingFracX, pendingFracY }
let detailFullyRendered = false;     // true after first detail page render; resets on navigation
let detailDotsOverlay = null;        // <div> overlay for player dots (outside zoom/pan inner)
const playerColorMap = {};           // steamId → color string (persists across renders)
let savedCronValues = new Map();     // preserves unsaved cron text across landing page polls

// Player dot colours (cycle through palette)
const DOT_COLORS = ["#3ecfcf", "#4caf6e", "#9b6bdf", "#e05252", "#f0c040", "#5ab4e0"];

// ── In-game coordinate conversion ─────────────────────────────────────────────
// Converts raw UE4 cm coordinates (from the REST API) to the in-game coordinate
// system shown on the Palworld HUD and community maps.
// Formula from the palworld-coord project (offsets verified against live data).
// NOTE: UE4 axes are intentionally swapped — the map's X axis corresponds to
// UE4's Y axis and vice versa.
const MAP_COORD_OFFSET_X = 123_888;
const MAP_COORD_OFFSET_Y = 158_000;
const MAP_COORD_SCALE    =     459;

function toMapCoords(rawX, rawY) {
  const mx = Math.round((rawY - MAP_COORD_OFFSET_Y) / MAP_COORD_SCALE);
  const my = Math.round((rawX + MAP_COORD_OFFSET_X) / MAP_COORD_SCALE);
  return `${mx}, ${my}`;
}

// Inverse: in-game display coords (as shown on Palworld HUD) → raw UE4 API coords
// displayX = first number shown (mx), displayY = second number shown (my)
function fromMapCoords(displayX, displayY) {
  // HUD X (displayX) = (locationY - OFFSET_Y) / SCALE → locationY = displayX * SCALE + OFFSET_Y (east-west → fracX/horizontal)
  // HUD Y (displayY) = (locationX + OFFSET_X) / SCALE → locationX = displayY * SCALE - OFFSET_X (north-south → fracY/vertical)
  return {
    worldX: displayX * MAP_COORD_SCALE + MAP_COORD_OFFSET_Y, // = locationY (east-west, for fracX)
    worldY: displayY * MAP_COORD_SCALE - MAP_COORD_OFFSET_X, // = locationX (north-south, for fracY)
  };
}

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

function isAdmin() {
  return currentUser?.role === "admin" && !viewAsWhitelisted;
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

  html.dataset.role = currentUser.role === "admin" && viewAsWhitelisted ? "whitelisted" : currentUser.role;
  authMsg.textContent = "";
  steamLink.style.display = "none";
  logoutBtn.style.display = "none";

  headerUser.innerHTML = `
    <img class="header-avatar" src="${escHtml(currentUser.avatarUrl)}" alt="" />
    <span class="header-name">${escHtml(currentUser.displayName)}</span>
    ${currentUser.role === "admin"
      ? `<button class="btn btn-small" id="role-toggle-btn" style="font-size:11px;font-family:var(--font-mono);color:${viewAsWhitelisted ? "var(--text-muted)" : "var(--accent-purple)"}">${viewAsWhitelisted ? "[user view]" : "[admin]"}</button>`
      : ""}
    <button class="btn btn-secondary btn-small" id="header-logout-btn">Logout</button>
  `;
  document.getElementById("header-logout-btn").onclick = doLogout;
  if (currentUser.role === "admin") {
    document.getElementById("role-toggle-btn").onclick = () => {
      viewAsWhitelisted = !viewAsWhitelisted;
      renderAuth();
      // Force full landing page rebuild so admin sections appear/disappear immediately
      const root = document.getElementById("view-root");
      if (root) root.innerHTML = "";
      renderCurrentView();
    };
  }
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
    detailKnownPlayers = null;
    detailExpandedPlayers = new Set();
    detailMapImg = null;
    detailCanvas = null;
    detailMapInner = null;
    detailDotsOverlay = null;
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

    // Save any unsaved cron expressions and checkbox states
    savedCronValues = new Map();
    root.querySelectorAll("[data-sid]").forEach(row => {
      const input = row.querySelector(".schedule-cron-input");
      const chk   = row.querySelector("input[type=checkbox]");
      savedCronValues.set(row.dataset.sid, {
        cron:    input ? input.value : undefined,
        enabled: chk   ? chk.checked : undefined,
      });
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
    if (isAdmin()) {
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

  // Admin: player management + restart schedules (above audit log)
  if (isAdmin()) {
    const pmSection = el("section", { class: "admin-section", id: "player-management" });
    const pmHeader = el("div", { class: "section-header" });
    pmHeader.appendChild(el("h2", { class: "section-title" }, "Player Management"));
    pmSection.appendChild(pmHeader);
    const pmTable = el("table", { class: "data-table", id: "players-table" });
    const pmHead = el("thead", {});
    const pmHeadRow = el("tr", {});
    for (const [i, h] of ["", "Steam Name", "Steam ID", "First Seen", "Last Seen", "Last Server", "Access"].entries()) {
      pmHeadRow.appendChild(el("th", i === 0 ? { style: "width:32px" } : {}, h));
    }
    pmHead.appendChild(pmHeadRow);
    pmTable.appendChild(pmHead);
    pmTable.appendChild(el("tbody", { id: "players-body" }));
    const pmWrap = el("div", { class: "table-scroll-wrap" });
    pmWrap.appendChild(pmTable);
    pmSection.appendChild(pmWrap);
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

  // Audit log
  const auditSection = el("section", { class: "audit-section" });
  const auditHeader = el("div", { class: "section-header" });
  auditHeader.appendChild(el("h2", { class: "section-title" }, "Audit Log"));
  auditSection.appendChild(auditHeader);
  const auditScroll = el("div", { class: "table-scroll-wrap" });
  const auditTable = el("table", { class: "data-table", id: "audit-table" });
  const auditHead = el("thead", {});
  const auditHeadRow = el("tr", {});
  for (const h of ["Time", "User", "Action", "Server", "Details"]) {
    auditHeadRow.appendChild(el("th", {}, h));
  }
  auditHead.appendChild(auditHeadRow);
  auditTable.appendChild(auditHead);
  auditTable.appendChild(el("tbody", { id: "audit-body" }));
  auditScroll.appendChild(auditTable);
  auditSection.appendChild(auditScroll);
  root.appendChild(auditSection);
  fetchAndRenderAuditLog();
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
  if (s.joinPassword) {
    const pwRow = el("div", { class: "server-connection" });
    pwRow.appendChild(el("span", {}, `Password: ${s.joinPassword}`));
    const copyPwBtn = el("button", { class: "copy-btn", title: "Copy password" }, "⎘");
    copyPwBtn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(s.joinPassword);
      copyPwBtn.textContent = "✓";
      setTimeout(() => copyPwBtn.textContent = "⎘", 1500);
    };
    pwRow.appendChild(copyPwBtn);
    meta.appendChild(pwRow);
  }
  body.appendChild(meta);

  if (gameStatus === "online") {
    body.appendChild(el("div", { class: "player-count" },
      `Players: ${s.players.length}${s.maxPlayers ? `/${s.maxPlayers}` : ""}`
    ));
  }

  if (s.containerStats) {
    body.appendChild(el("div", { class: "card-resource-stats" },
      `CPU ${s.containerStats.cpuPercent.toFixed(1)}%  ·  RAM ${fmtMB(s.containerStats.memUsageMB)}`
    ));
  }

  // Idle countdown
  if (s.idleCountdownSeconds !== null) {
    const mins = Math.floor(s.idleCountdownSeconds / 60);
    const secs = s.idleCountdownSeconds % 60;
    const countdown = el("div", { class: "idle-countdown" });
    countdown.appendChild(el("span", {}, `Idle shutdown in ${mins}:${String(secs).padStart(2, "0")}`));
    if (isAdmin()) {
      const cancelBtn = el("button", { class: "btn btn-small btn-secondary" }, "Cancel");
      cancelBtn.onclick = (e) => { e.stopPropagation(); cancelIdle(s.id); };
      countdown.appendChild(cancelBtn);
    }
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
  const _isAdmin = isAdmin();
  if (gameStatus === "online" || gameStatus === "crashed" || gameStatus === "starting") {
    const restartBtn = el("button", { class: "btn btn-small btn-warning" }, "↺ Restart");
    restartBtn.onclick = (e) => { e.stopPropagation(); doContainerAction(s.id, "restart", s.name, restartBtn); };
    footer.appendChild(restartBtn);
    if (_isAdmin) {
      const stopBtn = el("button", { class: "btn btn-small btn-danger" }, "■ Stop");
      stopBtn.onclick = (e) => { e.stopPropagation(); doContainerAction(s.id, "stop", s.name, stopBtn); };
      footer.appendChild(stopBtn);
    }
  } else if (gameStatus === "offline" && s.allowStart) {
    const startBtn = el("button", { class: "btn btn-small" }, "▶ Start");
    startBtn.onclick = (e) => { e.stopPropagation(); doContainerAction(s.id, "start", s.name, startBtn); };
    footer.appendChild(startBtn);
  }
  if (_isAdmin && s.containerName) {
    footer.appendChild(el("span", { class: "footer-container-name" }, s.containerName));
  }
  if (footer.children.length > 0) card.appendChild(footer);

  return card;
}

// ── Detail page ───────────────────────────────────────────────────────────────

async function renderDetailPage(s) {
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
    // Refresh known players in background
    try {
      const r = await fetch(`/api/containers/${encodeURIComponent(s.id)}/known-players`);
      if (r.ok) detailKnownPlayers = (await r.json()).players;
    } catch { /* keep stale data */ }
    const dyn = document.getElementById("dp-dynamic");
    dyn.innerHTML = "";
    _buildDetailDynamic(dyn, s, gameStatus);
    if (calibState) {
      calibState.latestServer = s;
      calibState.refreshPanel();
    }
    renderDetailCanvas(s);
    updateDotsOverlay(s);
    void refreshChatLog(s.id);
    return;
  }

  // First render: full page build
  const root = document.getElementById("view-root");
  root.innerHTML = "";

  // Detail header (IDs allow targeted status updates on subsequent polls)
  // Line 1: back | dot | server name | [status right-aligned]
  // Line 2 (admin only):              | [container name right-aligned]
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
  // Right side: status on row 1, container name on row 2
  const hdrRight = el("div", { class: "detail-header-right" });
  hdrRight.appendChild(el("span", {
    id: "dp-status-label",
    class: "status-label",
    style: `color:var(--status-${gameStatus})`,
  }, statusLabel));
  if (isAdmin() && s.containerName) {
    hdrRight.appendChild(el("span", { class: "container-name-badge" }, s.containerName));
  }
  hdr.appendChild(hdrRight);
  root.appendChild(hdr);

  // Dynamic section (rebuilt on every poll)
  const dyn = el("div", { id: "dp-dynamic" });
  root.appendChild(dyn);

  // Fetch known players for this container, then render
  try {
    const r = await fetch(`/api/containers/${encodeURIComponent(s.id)}/known-players`);
    if (r.ok) detailKnownPlayers = (await r.json()).players;
  } catch { /* ignore */ }
  _buildDetailDynamic(dyn, s, gameStatus);

  // Static sections (built once, never rebuilt by poll)
  buildDetailMap(root, s);
  void buildChatLog(root, s.id);

  detailFullyRendered = true;
}

function _buildDetailDynamic(dyn, s, gameStatus) {
  // Server info strip
  const infoPanel = el("div", { class: "detail-panel" });
  const metaRow = el("div", { class: "server-meta" });
  metaRow.appendChild(el("span", { class: "server-version" }, s.version ? `v${s.version}` : "—"));
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
  if (s.joinPassword) {
    const pwRow = el("div", { class: "server-connection" });
    pwRow.appendChild(el("span", {}, `Password: ${s.joinPassword}`));
    const copyPwBtn = el("button", { class: "copy-btn", title: "Copy password" }, "⎘");
    copyPwBtn.onclick = () => {
      navigator.clipboard.writeText(s.joinPassword);
      copyPwBtn.textContent = "✓";
      setTimeout(() => copyPwBtn.textContent = "⎘", 1500);
    };
    pwRow.appendChild(copyPwBtn);
    metaRow.appendChild(pwRow);
  }
  if (gameStatus === "online") {
    metaRow.appendChild(el("span", { class: "player-count" },
      `Players: ${s.players.length}${s.maxPlayers ? `/${s.maxPlayers}` : ""}`
    ));
  }
  infoPanel.appendChild(metaRow);

  // Metrics strip
  if (s.metrics) {
    const m = s.metrics;
    const metricsRow = el("div", { class: "metrics-strip" });
    const addMetric = (label, value) => {
      const cell = el("div", { class: "metric-cell" });
      cell.appendChild(el("span", { class: "metric-value" }, value));
      cell.appendChild(el("span", { class: "metric-label" }, label));
      metricsRow.appendChild(cell);
    };
    addMetric("FPS", m.fps != null ? m.fps.toFixed(1) : "—");
    addMetric("Frame time", m.frameTime != null ? `${m.frameTime.toFixed(1)}ms` : "—");
    if (m.days != null) addMetric("Days", String(m.days));
    if (m.uptime != null) {
      const h = Math.floor(m.uptime / 3600);
      const min = Math.floor((m.uptime % 3600) / 60);
      addMetric("Uptime", h > 0 ? `${h}h ${min}m` : `${min}m`);
    }
    if (s.containerStats) {
      addMetric("CPU", s.containerStats.cpuPercent.toFixed(1) + "%");
      addMetric("RAM", fmtMB(s.containerStats.memUsageMB));
    }
    infoPanel.appendChild(metricsRow);
  }

  // Idle countdown
  if (s.idleCountdownSeconds !== null) {
    const mins = Math.floor(s.idleCountdownSeconds / 60);
    const secs = s.idleCountdownSeconds % 60;
    const countdown = el("div", { class: "idle-countdown" });
    countdown.appendChild(el("span", {}, `Idle shutdown in ${mins}:${String(secs).padStart(2, "0")}`));
    if (isAdmin()) {
      const cancelBtn = el("button", { class: "btn btn-small btn-secondary" }, "Cancel");
      cancelBtn.onclick = () => cancelIdle(s.id);
      countdown.appendChild(cancelBtn);
    }
    infoPanel.appendChild(countdown);
  }
  dyn.appendChild(infoPanel);

  // Player list (merged: connected + historical)
  {
    const connectedIds = new Set(s.players.map(p => p.steamId));
    const connectedMap = new Map(s.players.map(p => [p.steamId, p]));

    // Build unified list: connected players first, then known-but-offline players for this server
    const knownHere = detailKnownPlayers ?? [];
    const offlinePlayers = knownHere.filter(kp => !connectedIds.has(kp.steam_id));
    const hasAny = s.players.length > 0 || offlinePlayers.length > 0;

    if (hasAny) {
      const playersPanel = el("div", { class: "detail-panel" });
      const titleRow = el("div", { style: "display:flex;justify-content:space-between;align-items:center" });
      const titleText = gameStatus === "online"
        ? `Players Online (${s.players.length}${s.maxPlayers ? `/${s.maxPlayers}` : ""})`
        : "Player History";
      titleRow.appendChild(el("div", { class: "detail-panel-title" }, titleText));
      if (offlinePlayers.length > 0) {
        titleRow.appendChild(el("span", { style: "font-size:12px;color:var(--text-secondary)" },
          `+${offlinePlayers.length} seen previously`));
      }
      playersPanel.appendChild(titleRow);

      const list = el("div", { class: "player-list" });

      const buildPlayerRow = (name, steamId, isConnected, liveData, knownData) => {
        const row = el("div", { class: `player-row ${isConnected ? "player-row--connected" : "player-row--offline"}` });
        const isExpanded = detailExpandedPlayers.has(steamId);

        // Header row (always visible)
        const header = el("div", { class: "player-row-header" });

        const statusDot = el("span", { class: "player-status-dot", style: `background:${isConnected ? "var(--status-online)" : "var(--text-muted)"}` });
        header.appendChild(statusDot);

        const nameEl = el("span", { class: "player-name" }, name || steamId);
        header.appendChild(nameEl);

        if (isConnected && liveData?.level) {
          header.appendChild(el("span", { class: "player-level" }, `Lv.${liveData.level}`));
        } else if (!isConnected && knownData?.level) {
          header.appendChild(el("span", { class: "player-level" }, `Lv.${knownData.level}`));
        }

        if (!isConnected && knownData?.last_seen) {
          const d = new Date(knownData.last_seen + "Z");
          header.appendChild(el("span", { class: "player-last-seen" }, `Last seen ${d.toLocaleDateString()}`));
        }

        // Toggle expand button
        const expandBtn = el("button", { class: "btn btn-small btn-secondary player-expand-btn" }, isExpanded ? "▲" : "▼");
        expandBtn.onclick = () => {
          if (detailExpandedPlayers.has(steamId)) detailExpandedPlayers.delete(steamId);
          else detailExpandedPlayers.add(steamId);
          // Re-render just this row
          const newRow = buildPlayerRow(name, steamId, isConnected, liveData, knownData);
          row.replaceWith(newRow);
        };
        header.appendChild(expandBtn);

        // Admin actions (not shown for admin's own character)
        if (isAdmin() && steamId !== currentUser?.steamId) {
          const actionsEl = el("div", { class: "player-actions" });
          const isBanned = knownData?.game_banned === 1;
          if (isBanned) {
            // Player was banned via this app — only show Unban
            const unbanBtn = el("button", { class: "btn btn-small btn-secondary" }, "Unban");
            unbanBtn.onclick = () => doPlayerAction(s.id, steamId, "unban", name, unbanBtn);
            actionsEl.appendChild(unbanBtn);
          } else {
            // Default: Kick (connected only) + Ban
            if (isConnected) {
              const kickBtn = el("button", { class: "btn btn-small btn-secondary" }, "Kick");
              kickBtn.onclick = () => doPlayerAction(s.id, steamId, "kick", name, kickBtn);
              actionsEl.appendChild(kickBtn);
            }
            const banBtn = el("button", { class: "btn btn-small btn-danger" }, "Ban");
            banBtn.onclick = () => doPlayerAction(s.id, steamId, "ban", name, banBtn);
            actionsEl.appendChild(banBtn);
          }
          header.appendChild(actionsEl);
        }

        row.appendChild(header);

        // Expanded details
        if (isExpanded) {
          const details = el("div", { class: "player-row-details" });
          const addDetail = (label, value) => {
            const item = el("span", { class: "player-detail-item" });
            item.appendChild(el("span", { class: "player-detail-label" }, label + ": "));
            item.appendChild(el("span", {}, value));
            details.appendChild(item);
          };

          if (isConnected && liveData) {
            if (liveData.locationX !== undefined) addDetail("Coords", toMapCoords(liveData.locationX, liveData.locationY));
            if (liveData.ping !== undefined) addDetail("Ping", `${Math.round(liveData.ping)}ms`);
          }
          if (steamId) addDetail("Steam ID", steamId);
          if (knownData?.character_name && knownData.character_name !== name) addDetail("Character", knownData.character_name);
          if (knownData?.display_name) addDetail("Steam name", knownData.display_name);
          if (knownData?.first_seen) {
            const d = new Date(knownData.first_seen + "Z");
            addDetail("First seen", d.toLocaleDateString());
          }

          if (details.children.length > 0) row.appendChild(details);
        }

        return row;
      };

      // Connected players
      for (const p of s.players) {
        const known = knownHere.find(k => k.steam_id === p.steamId);
        const displayName = p.name || known?.character_name || known?.display_name || p.steamId;
        list.appendChild(buildPlayerRow(displayName, p.steamId, true, p, known ?? null));
      }

      // Offline known players (seen on this server before)
      for (const kp of offlinePlayers) {
        const displayName = kp.character_name || kp.display_name || kp.steam_id;
        list.appendChild(buildPlayerRow(displayName, kp.steam_id, false, null, kp));
      }

      playersPanel.appendChild(list);
      dyn.appendChild(playersPanel);
    }
  }

  // Action panels
  if (isAdmin()) {
    buildTimedActionPanel(dyn, s);
  } else if (currentUser?.role === "whitelisted" || (currentUser?.role === "admin" && viewAsWhitelisted)) {
    buildWhitelistedRestartPanel(dyn, s, gameStatus);
  }
  if (isAdmin() && gameStatus === "online") {
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

    const restartBtn = el("button", { class: "btn btn-small btn-warning" }, "↺ Restart");
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

// ── Player in-game actions ────────────────────────────────────────────────────

async function doPlayerAction(containerId, steamId, action, playerName, btn) {
  const labels = { kick: "Kick", ban: "Ban", unban: "Unban" };
  if (!confirm(`${labels[action]} player "${playerName}"?`)) return;
  btn.disabled = true;
  try {
    let res;
    if (action === "kick") {
      res = await fetch(`/api/containers/${encodeURIComponent(containerId)}/players/${encodeURIComponent(steamId)}/kick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    } else if (action === "ban") {
      res = await fetch(`/api/containers/${encodeURIComponent(containerId)}/players/${encodeURIComponent(steamId)}/ban`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    } else {
      res = await fetch(`/api/containers/${encodeURIComponent(containerId)}/players/${encodeURIComponent(steamId)}/ban`, { method: "DELETE" });
    }
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
    const restartBtn = el("button", { class: "btn btn-small btn-warning" }, "↺ Restart");
    restartBtn.onclick = () => doContainerAction(s.id, "restart", s.name, restartBtn);
    panel.appendChild(restartBtn);
    const hasPlayers = (s.players?.length ?? 0) > 0;
    const hint = hasPlayers
      ? "A 5-minute countdown will be broadcast in-game. Server will restart immediately if all in-game players disconnect. In-game players may cancel your restart with veto."
      : "Server will restart immediately.";
    panel.appendChild(el("span", { style: "color:var(--text-secondary);font-size:13px;margin-left:8px;display:inline-block;max-width:420px;vertical-align:top;line-height:1.4" },
      hint
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

// Auto-fit the map view on first load:
//   0 players  → centre of map, ~50% of map visible
//   1 player   → centred on them, ~50% of map visible
//   2+ players → bounding box of all dots with 12% margin padding
function fitMapToPlayers(s) {
  if (!detailMapImg || !detailMapInner || !mapCalibration) return;
  const imgW = detailMapImg.offsetWidth;
  const imgH = detailMapImg.offsetHeight;
  const vW   = detailMapInner.parentElement.offsetWidth;
  const vH   = detailMapInner.parentElement.offsetHeight;
  if (!imgW || !imgH || !vW || !vH) return;

  const { scaleX, offsetX, scaleY, offsetY } = mapCalibration;
  const fracs = s.players
    .filter(p => p.locationX !== undefined && p.locationY !== undefined)
    .map(p => ({ fx: p.locationY * scaleX + offsetX, fy: p.locationX * scaleY + offsetY }))
    .filter(f => f.fx >= -0.1 && f.fx <= 1.1 && f.fy >= -0.1 && f.fy <= 1.1);

  // "~50% of map visible" = viewport covers half the image dimensions → zoom ≈ 2
  const halfZoom = Math.min(2 * vW / imgW, 2 * vH / imgH);

  if (fracs.length === 0) {
    mapZoom = Math.max(0.25, Math.min(halfZoom, 12));
    mapPanX = vW / 2 - 0.5 * imgW * mapZoom;
    mapPanY = vH / 2 - 0.5 * imgH * mapZoom;
  } else if (fracs.length === 1) {
    mapZoom = Math.max(0.25, Math.min(halfZoom, 12));
    mapPanX = vW / 2 - fracs[0].fx * imgW * mapZoom;
    mapPanY = vH / 2 - fracs[0].fy * imgH * mapZoom;
  } else {
    const minFx = Math.min(...fracs.map(f => f.fx));
    const maxFx = Math.max(...fracs.map(f => f.fx));
    const minFy = Math.min(...fracs.map(f => f.fy));
    const maxFy = Math.max(...fracs.map(f => f.fy));
    const MARGIN = 0.12; // expand span so dots sit 12% in from each edge
    const spanFx = Math.max((maxFx - minFx) / (1 - 2 * MARGIN), 0.05);
    const spanFy = Math.max((maxFy - minFy) / (1 - 2 * MARGIN), 0.05);
    mapZoom = Math.max(0.25, Math.min(vW / (spanFx * imgW), vH / (spanFy * imgH), 12));
    mapPanX = vW / 2 - ((minFx + maxFx) / 2) * imgW * mapZoom;
    mapPanY = vH / 2 - ((minFy + maxFy) / 2) * imgH * mapZoom;
  }

  applyMapTransform();
  updateDotsOverlay(s);
}

function applyMapTransform() {
  if (!detailMapInner) return;
  detailMapInner.style.transform = `translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom})`;
  if (lastStatus && detailContainerId) {
    const s = lastStatus.find(sv => sv.serverId === detailContainerId);
    if (s) updateDotsOverlay(s);
  }
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
    "Click the map where you know a player's position, then enter the coordinates shown on the Palworld HUD. " +
    "Use two distant points for best accuracy.");
  panelEl.appendChild(hint);

  // Confirmed points summary
  calibState.points.forEach((pt, i) => {
    const row = el("div", { class: "calib-confirmed-point" });
    row.style.borderLeftColor = CALIB_COLORS[i];
    row.textContent = `P${i + 1}: HUD (${toMapCoords(pt.worldX, pt.worldY)})  ·  map (${(pt.fracX * 100).toFixed(1)}%, ${(pt.fracY * 100).toFixed(1)}%)`;
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
      const dispCoords = toMapCoords(p.locationX, p.locationY).split(", ");
      const coordsEl = el("span", { class: "calib-ref-coords" },
        `${dispCoords[0]}, ${dispCoords[1]}`);
      const useBtn = el("button", { class: "btn btn-small btn-secondary" }, "Use");
      useBtn.onclick = () => {
        wxInput.value = dispCoords[0];
        wyInput.value = dispCoords[1];
        calibState.inputX = dispCoords[0];
        calibState.inputY = dispCoords[1];
      };
      row.appendChild(nameEl); row.appendChild(coordsEl); row.appendChild(useBtn);
      refList.appendChild(row);
    }
    panelEl.appendChild(refList);
  }

  // In-game coordinate inputs (as shown on the Palworld HUD)
  const inputRow = el("div", { class: "calib-input-row" });
  const wxLabel = el("label", { class: "calib-label" }, `HUD X:`);
  const wxInput = el("input", { type: "number", class: "calib-input", placeholder: "e.g. -346" });
  const wyLabel = el("label", { class: "calib-label" }, `HUD Y:`);
  const wyInput = el("input", { type: "number", class: "calib-input", placeholder: "e.g. -252" });
  // Restore previously entered values (persist across 30s panel rebuilds)
  if (calibState.inputX) wxInput.value = calibState.inputX;
  if (calibState.inputY) wyInput.value = calibState.inputY;
  wxInput.oninput = () => { calibState.inputX = wxInput.value; };
  wyInput.oninput = () => { calibState.inputY = wyInput.value; };
  inputRow.appendChild(wxLabel); inputRow.appendChild(wxInput);
  inputRow.appendChild(wyLabel); inputRow.appendChild(wyInput);
  panelEl.appendChild(inputRow);

  // Action buttons
  const btnRow = el("div", { class: "calib-btn-row" });

  const setBtn = el("button", { class: "btn btn-primary btn-small" },
    step === 1 ? "Set Point 1 →" : "Set Point 2 →");
  setBtn.onclick = () => {
    const displayX = parseFloat(wxInput.value);
    const displayY = parseFloat(wyInput.value);
    if (isNaN(displayX) || isNaN(displayY)) { alert("Enter valid in-game coordinates from the Palworld HUD."); return; }
    if (calibState.pendingFracX === null) { alert("Click a location on the map first."); return; }
    const { worldX, worldY } = fromMapCoords(displayX, displayY);
    calibState.points.push({
      worldX, worldY,
      fracX: calibState.pendingFracX,
      fracY: calibState.pendingFracY,
    });
    calibState.pendingFracX = null;
    calibState.pendingFracY = null;
    calibState.inputX = "";
    calibState.inputY = "";
    renderDetailCanvas(s);
    calibState.refreshPanel();
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
    row.textContent = `P${i + 1}: HUD (${toMapCoords(pt.worldX, pt.worldY)})  ·  map (${(pt.fracX * 100).toFixed(1)}%, ${(pt.fracY * 100).toFixed(1)}%)`;
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
      detailHistoryData = null; // force re-fetch so clouds realign to new calibration
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
    calibState.inputX = "";
    calibState.inputY = "";
    renderDetailCanvas(s);
    renderCalibPanel(panelEl, s, calibBtn, mapContainer);
  };

  const deleteBtn = el("button", { class: "btn btn-secondary btn-small" }, "Reset to Default");
  deleteBtn.onclick = async () => {
    if (!confirm("Reset map calibration to defaults?")) return;
    await fetch("/api/map-calibration", { method: "DELETE" });
    mapCalibration = await (await fetch("/api/map-calibration")).json();
    detailHistoryData = null; // force re-fetch so clouds realign to new calibration
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
  }, detailHistoryEnabled ? "Hide Exploration" : "Show Exploration");
  histBtn.onclick = async () => {
    detailHistoryEnabled = !detailHistoryEnabled;
    histBtn.textContent = detailHistoryEnabled ? "Hide Exploration" : "Show Exploration";
    if (!detailHistoryEnabled) detailHistoryData = null; // clear cache so next show re-fetches fresh data
    if (detailHistoryEnabled && !detailHistoryData) {
      try {
        const res = await fetch(`/api/containers/${encodeURIComponent(s.id)}/location-history`);
        if (res.ok) {
          const data = await res.json();
          detailHistoryData = {
            players: data.players.map(p => ({
              steamId:       p.steamId,
              characterName: p.characterName,
              polygons: p.gridData
                ? marchingSquaresPolygons(buildRenderGrid(decodeGridBase64(p.gridData)))
                : [],
            })),
          };
        }
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
  if (isAdmin()) {
    const calibBtn = el("button", { class: "btn btn-small btn-secondary" },
      mapCalibration?.calibrated ? "Recalibrate" : "Calibrate Map");
    calibBtn.onclick = () => {
      if (calibState) {
        calibState = null;
        mapContainer.style.cursor = "";
        calibPanelEl.style.display = "none";
        calibBtn.textContent = mapCalibration?.calibrated ? "Recalibrate" : "Calibrate Map";
        renderDetailCanvas(s);
        updateDotsOverlay(s);
      } else {
        calibState = { step: 1, points: [], pendingFracX: null, pendingFracY: null, inputX: "", inputY: "", latestServer: s, refreshPanel: () => {} };
        mapContainer.style.cursor = "crosshair";
        calibBtn.textContent = "Cancel Calibration";
        calibPanelEl.style.display = "";
        renderCalibPanel(calibPanelEl, s, calibBtn, mapContainer);
        calibState.refreshPanel = () => {
          if (!calibState) return;
          if (calibState.points.length >= 2) {
            renderCalibSavePanel(calibPanelEl, calibState.latestServer, calibBtn, mapContainer);
          } else {
            renderCalibPanel(calibPanelEl, calibState.latestServer, calibBtn, mapContainer);
          }
          requestAnimationFrame(() => { if (calibState) updateDotsOverlay(calibState.latestServer); });
        };
      }
    };
    sectionHeader.appendChild(calibBtn);
  }

  // Map container (viewport — clips the inner div)
  const mapContainer = el("div", { class: "map-container" });
  const inner = el("div", { class: "map-inner" });
  const mapImg = el("img", { class: "map-img", src: "/palworld-map.webp", alt: "Palworld World Map" });
  const canvas = el("canvas", { class: "map-canvas" });
  const dotsOverlay = el("div", { class: "map-dots-overlay" });
  inner.appendChild(mapImg);
  inner.appendChild(canvas);
  mapContainer.appendChild(inner);
  mapContainer.appendChild(dotsOverlay);
  detailDotsOverlay = dotsOverlay;
  section.appendChild(mapContainer);

  // Calibration panel (admin only, initially hidden)
  if (isAdmin()) {
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

  // Auto-fit view to players once the image dimensions are known
  const doInitialFit = () => requestAnimationFrame(() => {
    fitMapToPlayers(s);
    renderDetailCanvas(s);
  });
  if (mapImg.complete && mapImg.naturalWidth) {
    doInitialFit();
  } else {
    mapImg.addEventListener("load", doInitialFit, { once: true });
  }

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
        updateDotsOverlay(s);
        calibState.refreshPanel();
      }
    }
    drag = null;
    mapContainer.style.cursor = calibState ? "crosshair" : "";
  };
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  // ── Touch: single-finger pan, two-finger pinch-to-zoom ────────────────────
  let touch = null; // { startX, startY, initX, initY } for single-touch pan
  let pinch = null; // { midX, midY, dist, zoom, panX, panY } for pinch

  mapContainer.addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touch = { startX: t.clientX - mapPanX, startY: t.clientY - mapPanY,
                initX: t.clientX, initY: t.clientY };
      pinch = null;
    } else if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      const rect = mapContainer.getBoundingClientRect();
      const midX = (a.clientX + b.clientX) / 2 - rect.left;
      const midY = (a.clientY + b.clientY) / 2 - rect.top;
      pinch = { midX, midY, dist, zoom: mapZoom, panX: mapPanX, panY: mapPanY };
      touch = null;
    }
  }, { passive: false });

  mapContainer.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && touch) {
      const t = e.touches[0];
      mapPanX = t.clientX - touch.startX;
      mapPanY = t.clientY - touch.startY;
      applyMapTransform();
    } else if (e.touches.length === 2 && pinch) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      const scale = dist / pinch.dist;
      const newZoom = Math.min(Math.max(pinch.zoom * scale, 0.25), 12);
      const rect = mapContainer.getBoundingClientRect();
      const midX = (a.clientX + b.clientX) / 2 - rect.left;
      const midY = (a.clientY + b.clientY) / 2 - rect.top;
      // Zoom centred on the pinch midpoint
      const ix = (pinch.midX - pinch.panX) / pinch.zoom;
      const iy = (pinch.midY - pinch.panY) / pinch.zoom;
      mapPanX = midX - ix * newZoom;
      mapPanY = midY - iy * newZoom;
      mapZoom = newZoom;
      applyMapTransform();
    }
  }, { passive: false });

  mapContainer.addEventListener("touchend", (e) => {
    e.preventDefault();
    if (e.touches.length === 0) {
      // Single-tap for calibration (no movement)
      if (touch && calibState) {
        const last = e.changedTouches[0];
        const dx = last.clientX - touch.initX, dy = last.clientY - touch.initY;
        if (dx * dx + dy * dy < 25) {
          const rect = mapContainer.getBoundingClientRect();
          const cx = (last.clientX - rect.left - mapPanX) / mapZoom;
          const cy = (last.clientY - rect.top  - mapPanY) / mapZoom;
          calibState.pendingFracX = cx / detailMapImg.offsetWidth;
          calibState.pendingFracY = cy / detailMapImg.offsetHeight;
          renderDetailCanvas(s);
          updateDotsOverlay(s);
          calibState.refreshPanel();
        }
      }
      touch = null;
      pinch = null;
    } else if (e.touches.length === 1) {
      // Lifted one finger during pinch — switch back to single-touch pan
      const t = e.touches[0];
      touch = { startX: t.clientX - mapPanX, startY: t.clientY - mapPanY,
                initX: t.clientX, initY: t.clientY };
      pinch = null;
    }
  }, { passive: false });

  mapEventCleanup = () => {
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  };

  mapImg.onload = () => { renderDetailCanvas(s); updateDotsOverlay(s); };
  window.addEventListener("resize", () => {
    const server = lastStatus?.find(sv => sv.serverId === detailContainerId) ?? s;
    renderDetailCanvas(server);
    updateDotsOverlay(server);
  }, { once: false });

  renderDetailCanvas(s);
  updateDotsOverlay(s);
}

// ── Location history: marching squares rendering ───────────────────────────

const STORAGE_GRID = 2048;
const RENDER_GRID  = 512;
const RENDER_DS    = STORAGE_GRID / RENDER_GRID; // 4 storage cells per render cell

// World coordinate bounds — must match WORLD_MIN_X/Y and GRID_CELL_SIZE in db.ts
const GRID_WORLD_SIZE      = 1_447_840;  // total world range covered by the grid (both axes equal)
const GRID_MIN_LOCATION_Y  = -738_920;   // locationY (east-west)  at render col 0
const GRID_MIN_LOCATION_X  = -999_940;   // locationX (north-south) at render row 0
// World units spanned by one render-grid cell (RENDER_DS storage cells × GRID_CELL_SIZE)
const RENDER_CELL_WORLD    = RENDER_DS * GRID_WORLD_SIZE / STORAGE_GRID; // ≈ 2832.5

// Lookup: 4-bit case (TL=bit3,TR=bit2,BR=bit1,BL=bit0) → [[edge1,edge2],...]
// Edges: 0=N 1=E 2=S 3=W
const MS_TABLE = [
  [],            // 0
  [[3,2]],       // 1  BL
  [[2,1]],       // 2  BR
  [[3,1]],       // 3  BL+BR
  [[0,1]],       // 4  TR
  [[0,1],[3,2]], // 5  TR+BL (ambiguous)
  [[0,2]],       // 6  TR+BR
  [[0,3]],       // 7  TR+BR+BL
  [[0,3]],       // 8  TL
  [[0,2]],       // 9  TL+BL
  [[0,3],[2,1]], // 10 TL+BR (ambiguous)
  [[0,1]],       // 11 TL+BR+BL
  [[3,1]],       // 12 TL+TR
  [[2,1]],       // 13 TL+TR+BL
  [[3,2]],       // 14 TL+TR+BR
  [],            // 15
];

// Edge offsets in doubled-coordinate space relative to cell (col, row)
const MS_EDGE_HALF = [
  [1, 0], // N: (col*2+1, row*2)
  [2, 1], // E: (col*2+2, row*2+1)
  [1, 2], // S: (col*2+1, row*2+2)
  [0, 1], // W: (col*2,   row*2+1)
];

function decodeGridBase64(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function buildRenderGrid(storageGrid) {
  const rg = new Uint8Array(RENDER_GRID * RENDER_GRID);
  for (let r = 0; r < RENDER_GRID; r++) {
    for (let c = 0; c < RENDER_GRID; c++) {
      outer: for (let dr = 0; dr < RENDER_DS; dr++) {
        for (let dc = 0; dc < RENDER_DS; dc++) {
          const bit = (r * RENDER_DS + dr) * STORAGE_GRID + (c * RENDER_DS + dc);
          if (storageGrid[bit >> 3] & (1 << (bit & 7))) { rg[r * RENDER_GRID + c] = 1; break outer; }
        }
      }
    }
  }
  return rg;
}

function marchingSquaresPolygons(rg) {
  const G = RENDER_GRID;
  const W = G * 2 + 1; // doubled-coord row stride

  function cell(c, r) { return (c >= 0 && c < G && r >= 0 && r < G) ? rg[r * G + c] : 0; }
  function ekey(col, row, e) {
    const [dhx, dhy] = MS_EDGE_HALF[e];
    return (row * 2 + dhy) * W + (col * 2 + dhx);
  }

  const adj = new Map();
  function link(k1, k2) {
    let a = adj.get(k1); if (!a) adj.set(k1, a = []); a.push(k2);
    let b = adj.get(k2); if (!b) adj.set(k2, b = []); b.push(k1);
  }

  for (let r = 0; r < G - 1; r++) {
    for (let c = 0; c < G - 1; c++) {
      const idx = cell(c,r)*8 + cell(c+1,r)*4 + cell(c+1,r+1)*2 + cell(c,r+1);
      for (const [e1, e2] of MS_TABLE[idx]) link(ekey(c,r,e1), ekey(c,r,e2));
    }
  }

  const visited = new Set();
  const polygons = [];
  for (const [start] of adj) {
    if (visited.has(start)) continue;
    visited.add(start);
    const path = [start];
    let prev = -1, curr = start;
    for (;;) {
      const nbrs = adj.get(curr);
      let next = -1;
      for (const n of nbrs) { if (n !== prev && (!visited.has(n) || n === start)) { next = n; break; } }
      if (next === -1 || (next === start && path.length < 3)) break;
      if (next === start) break;
      visited.add(next); path.push(next); prev = curr; curr = next;
    }
    if (path.length >= 3) polygons.push(path.map(k => [k % W / 2, Math.floor(k / W) / 2]));
  }
  return polygons;
}

function updateDotsOverlay(s) {
  if (!detailDotsOverlay || !mapCalibration || !detailMapImg) return;
  const { scaleX, offsetX, scaleY, offsetY } = mapCalibration;
  const imgW = detailMapImg.offsetWidth;
  const imgH = detailMapImg.offsetHeight;
  detailDotsOverlay.innerHTML = "";
  for (const p of s.players) {
    if (!p.locationX && !p.locationY) continue;
    // Same axis convention as worldToCanvas: locationY → horizontal, locationX → vertical
    const fracX = p.locationY * scaleX + offsetX;
    const fracY = p.locationX * scaleY + offsetY;
    const sx = fracX * imgW * mapZoom + mapPanX;
    const sy = fracY * imgH * mapZoom + mapPanY;
    if (!playerColorMap[p.steamId]) {
      playerColorMap[p.steamId] = DOT_COLORS[Object.keys(playerColorMap).length % DOT_COLORS.length];
    }
    const color = playerColorMap[p.steamId];
    const wrap = el("div", { class: "player-dot-wrap" });
    wrap.style.left = sx + "px";
    wrap.style.top = sy + "px";
    const pulse = el("div", { class: "player-dot-pulse" });
    pulse.style.setProperty("--dot-color", color);
    const dot = el("div", { class: "player-dot" });
    dot.style.background = color;
    dot.style.boxShadow = `0 0 8px ${color}`;
    const label = el("div", { class: "player-dot-label" }, p.name || p.steamId.slice(-6));
    wrap.appendChild(pulse);
    wrap.appendChild(dot);
    wrap.appendChild(label);
    detailDotsOverlay.appendChild(wrap);
  }

  // Calibration markers (zoom-invariant — in overlay, not canvas)
  if (calibState) {
    const CALIB_COLORS = ["#ff4444", "#ff8800"];
    const addCalibMarker = (fracX, fracY, color, label, pending) => {
      const sx = fracX * imgW * mapZoom + mapPanX;
      const sy = fracY * imgH * mapZoom + mapPanY;
      const marker = el("div", { class: "calib-marker" });
      marker.style.left = sx + "px";
      marker.style.top = sy + "px";
      marker.style.setProperty("--calib-color", color);
      marker.appendChild(el("div", { class: pending ? "calib-circle calib-circle-pending" : "calib-circle" }));
      marker.appendChild(el("div", { class: "calib-h-line" }));
      marker.appendChild(el("div", { class: "calib-v-line" }));
      if (label) marker.appendChild(el("div", { class: "calib-label" }, label));
      detailDotsOverlay.appendChild(marker);
    };
    calibState.points.forEach((pt, i) =>
      addCalibMarker(pt.fracX, pt.fracY, CALIB_COLORS[i], `P${i + 1}`, false));
    if (calibState.pendingFracX !== null)
      addCalibMarker(calibState.pendingFracX, calibState.pendingFracY,
        CALIB_COLORS[calibState.points.length] ?? "#ffffff", null, true);
  }
}

function renderDetailCanvas(s) {
  if (!detailCanvas || !detailMapImg) return;
  const ctx = detailCanvas.getContext("2d");

  // Render at natural image resolution so canvas stays crisp when CSS-zoomed
  const natW = detailMapImg.naturalWidth  || detailMapImg.offsetWidth;
  const natH = detailMapImg.naturalHeight || detailMapImg.offsetHeight;
  if (!natW || !natH) return;
  if (detailCanvas.width !== natW || detailCanvas.height !== natH) {
    detailCanvas.width  = natW;
    detailCanvas.height = natH;
  }
  ctx.clearRect(0, 0, natW, natH);

  if (!mapCalibration) return;
  const { scaleX, offsetX, scaleY, offsetY } = mapCalibration;

  // ds: scale factor so dot/text sizes are consistent at natural resolution
  const ds = natW / (detailMapImg.offsetWidth || natW);

  function worldToCanvas(wx, wy) {
    // wx = locationX (north-south → vertical), wy = locationY (east-west → horizontal)
    return {
      cx: (wy * scaleX + offsetX) * natW,
      cy: (wx * scaleY + offsetY) * natH,
    };
  }

  // Draw exploration clouds via marching squares polygons
  if (detailHistoryEnabled && detailHistoryData) {
    // Map render-grid [col, row] → canvas [x, y] via calibration.
    // Each render cell covers RENDER_CELL_WORLD world units; col 0 starts at GRID_MIN_LOCATION_Y.
    const rcToCanvas = (rc, rr) => [
      (rc * RENDER_CELL_WORLD + GRID_MIN_LOCATION_Y) * scaleX * natW + offsetX * natW,
      (rr * RENDER_CELL_WORLD + GRID_MIN_LOCATION_X) * scaleY * natH + offsetY * natH,
    ];

    // Helper: draw all visible player polygons
    const drawClouds = () => {
      for (const ph of detailHistoryData.players) {
        if (detailHiddenPlayers.has(ph.steamId) || !ph.polygons?.length) continue;
        ctx.fillStyle = playerColorMap[ph.steamId] ?? DOT_COLORS[0];
        for (const poly of ph.polygons) {
          ctx.beginPath();
          const [x0, y0] = rcToCanvas(poly[0][0], poly[0][1]);
          ctx.moveTo(x0, y0);
          for (let i = 1; i < poly.length; i++) {
            const [x, y] = rcToCanvas(poly[i][0], poly[i][1]);
            ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fill('evenodd');
        }
      }
    };

    // Pass 1: wide soft glow base
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.filter = `blur(${Math.round(7 * ds)}px)`;
    drawClouds();
    ctx.restore();

    // Pass 2: tighter bright fill for definition
    ctx.save();
    ctx.globalAlpha = 0.82;
    ctx.filter = `blur(${Math.round(2 * ds)}px)`;
    drawClouds();
    ctx.restore();

    ctx.filter = "none";
  }

  // Calibration exclusion mask (step 2: darken area near Point 1)
  if (calibState && calibState.points.length === 1) {
    const p1 = calibState.points[0];
    const p1x = p1.fracX * natW;
    const p1y = p1.fracY * natH;
    const excR = Math.min(natW, natH) * 0.30;

    ctx.save();

    // Subtle global dim
    ctx.fillStyle = "rgba(0, 0, 0, 0.30)";
    ctx.fillRect(0, 0, natW, natH);

    // Heavy solid fill inside exclusion circle
    ctx.beginPath();
    ctx.arc(p1x, p1y, excR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0, 0, 0, 0.80)";
    ctx.fill();

    // Reddish glow at edge
    const edgeGrad = ctx.createRadialGradient(p1x, p1y, excR * 0.88, p1x, p1y, excR * 1.08);
    edgeGrad.addColorStop(0,   "rgba(200, 50, 50, 0.70)");
    edgeGrad.addColorStop(0.5, "rgba(200, 50, 50, 0.35)");
    edgeGrad.addColorStop(1,   "rgba(200, 50, 50, 0)");
    ctx.fillStyle = edgeGrad;
    ctx.fillRect(0, 0, natW, natH);

    ctx.font = `bold ${Math.round(14 * ds)}px 'Rajdhani', 'Noto Sans', sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255, 120, 120, 1.0)";
    ctx.shadowColor = "rgba(0,0,0,1)"; ctx.shadowBlur = 8 * ds;
    ctx.fillText("⚠ Too close — pick a more distant point", p1x, p1y + excR * 0.55);

    ctx.restore();
  }

}

function renderHistoryLegend(legendEl, s) {
  legendEl.innerHTML = "";
  if (!detailHistoryEnabled || !detailHistoryData) {
    legendEl.style.display = "none";
    return;
  }
  legendEl.style.display = "";

  // Build a unified player map keyed by steamId
  const allPlayers = new Map(); // steamId → { name, id }
  if (detailHistoryData) {
    for (const ph of detailHistoryData.players) {
      allPlayers.set(ph.steamId, { name: ph.characterName ?? ph.steamId, id: ph.steamId });
    }
  }
  // Live players: merge by steamId (live name overrides if not already in history)
  for (const p of s.players) {
    if (!allPlayers.has(p.steamId)) {
      allPlayers.set(p.steamId, { name: p.name, id: p.steamId });
    }
  }

  for (const [pid, { name }] of allPlayers) {
    if (!playerColorMap[pid]) {
      playerColorMap[pid] = DOT_COLORS[Object.keys(playerColorMap).length % DOT_COLORS.length];
    }
    const color = playerColorMap[pid];
    const item = el("div", {
      class: `history-legend-item ${detailHiddenPlayers.has(pid) ? "hidden" : ""}`,
    });
    const dot = el("span", { class: "history-legend-dot", style: `background:${color}` });
    item.appendChild(dot);
    item.appendChild(document.createTextNode(name));
    item.onclick = () => {
      if (detailHiddenPlayers.has(pid)) {
        detailHiddenPlayers.delete(pid);
        item.classList.remove("hidden");
      } else {
        detailHiddenPlayers.add(pid);
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

  const chatHeader = el("div", { style: "display:flex;align-items:center;gap:12px;margin-bottom:10px" });
  chatHeader.appendChild(el("h2", { class: "section-title", style: "margin:0" }, "Chat Log"));
  const sysLabel = el("label", { style: "display:flex;align-items:center;gap:6px;font-size:0.82rem;color:var(--text-secondary);cursor:pointer;margin-left:auto" });
  const sysCheck = el("input", { type: "checkbox", id: "chat-show-system" });
  sysCheck.addEventListener("change", () => applySystemMessageFilter());
  sysLabel.appendChild(sysCheck);
  sysLabel.appendChild(document.createTextNode("Show system messages"));
  chatHeader.appendChild(sysLabel);
  section.appendChild(chatHeader);

  _chatLastTs = null;

  const logEl = el("div", { class: "chat-log", id: "chat-log" });
  const chatWrapper = el("div", { class: "chat-log-wrapper" });
  chatWrapper.appendChild(logEl);

  const toast = el("div", { class: "chat-new-msg-toast hidden", id: "chat-new-msg-toast" }, "New messages received");
  toast.addEventListener("click", () => {
    logEl.lastElementChild?.scrollIntoView(false);
    toast.classList.add("hidden");
  });
  chatWrapper.appendChild(toast);

  logEl.addEventListener("scroll", () => {
    if (isChatAtBottom(logEl)) toast.classList.add("hidden");
  });

  section.appendChild(chatWrapper);
  root.appendChild(section);

  await refreshChatLog(containerId);
}

function applySystemMessageFilter() {
  const logEl = document.getElementById("chat-log");
  if (!logEl) return;
  const show = document.getElementById("chat-show-system")?.checked ?? false;
  for (const entry of logEl.querySelectorAll(".chat-entry--system")) {
    entry.hidden = !show;
  }
}

async function refreshChatLog(containerId) {
  const logEl = document.getElementById("chat-log");
  if (!logEl) return;
  try {
    const res = await fetch(`/api/containers/${encodeURIComponent(containerId)}/chat-log?limit=100`);
    if (!res.ok) return;
    const data = await res.json();
    const wasAtBottom = isChatAtBottom(logEl);
    logEl.innerHTML = "";
    if (!data.messages.length) {
      logEl.appendChild(el("span", { class: "chat-log-empty" }, "No messages recorded yet."));
      return;
    }
    const showSystem = document.getElementById("chat-show-system")?.checked ?? false;
    for (const m of data.messages) {
      const isSystem = !m.player_name;
      const entry = el("div", { class: isSystem ? "chat-entry chat-entry--system" : "chat-entry" });
      if (isSystem) entry.hidden = !showSystem;
      const time = el("span", { class: "chat-time" }, formatTs(m.timestamp));
      entry.appendChild(time);
      if (m.player_name) {
        const player = el("span", { class: "chat-player" }, m.player_name + ": ");
        entry.appendChild(player);
      }
      entry.appendChild(document.createTextNode(m.message));
      logEl.appendChild(entry);
    }
    const latestTs = data.messages[data.messages.length - 1].timestamp;
    const hasNew = latestTs !== _chatLastTs;
    _chatLastTs = latestTs;
    if (wasAtBottom) {
      requestAnimationFrame(() => { logEl.lastElementChild?.scrollIntoView(false); });
    } else if (hasNew) {
      document.getElementById("chat-new-msg-toast")?.classList.remove("hidden");
    }
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

// Actions only admins should see in the audit log
const ADMIN_ONLY_ACTIONS = new Set(["KICK", "BAN", "UNBAN"]);
const ADMIN_ONLY_ACTION_PREFIX = "PLAYER_";

async function fetchAndRenderAuditLog() {
  try {
    const res = await fetch("/api/audit-log");
    if (!res.ok) return;
    const data = await res.json();
    const tbody = document.getElementById("audit-body");
    if (!tbody) return;
    tbody.innerHTML = "";
    const admin = isAdmin();
    for (const e of data.entries) {
      if (!admin && (ADMIN_ONLY_ACTIONS.has(e.action) || e.action.startsWith(ADMIN_ONLY_ACTION_PREFIX))) continue;
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

function reapplyPmRowColors() {
  const tbody = document.getElementById("players-body");
  if (!tbody) return;
  let visIdx = 0;
  let parentBg = "";
  for (const tr of tbody.querySelectorAll("tr")) {
    if (tr.hidden) { tr.style.background = ""; continue; }
    if (tr.classList.contains("pm-subrow")) {
      tr.style.background = parentBg;
    } else {
      const bg = tr.classList.contains("pm-row--online")
        ? "rgba(62,207,207,0.05)"
        : visIdx % 2 === 1 ? "var(--bg-panel-alt)" : "";
      tr.style.background = bg;
      parentBg = bg;
      visIdx++;
    }
  }
}

async function fetchAndRenderPlayers() {
  try {
    const res = await fetch("/api/known-players");
    if (!res.ok) return;
    const data = await res.json();
    const tbody = document.getElementById("players-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    // Build online map from lastStatus: steamId → [{containerId, serverName, characterName}]
    const onlineMap = new Map();
    const containerIdToServerId = new Map();
    for (const server of lastStatus ?? []) {
      containerIdToServerId.set(server.id, server.serverId);
      for (const player of server.players ?? []) {
        if (!onlineMap.has(player.steamId)) onlineMap.set(player.steamId, []);
        onlineMap.get(player.steamId).push({ containerId: server.id, serverName: server.name, characterName: player.name });
      }
    }

    // Sort: online players first (by online count desc), then by last_seen desc (API order)
    const sorted = [...data.players].sort((a, b) => {
      const ao = (onlineMap.get(a.steam_id) ?? []).length;
      const bo = (onlineMap.get(b.steam_id) ?? []).length;
      return bo - ao; // ties preserve original order (last_seen desc from API)
    });

    const STATUS_CYCLE  = { pending: "blacklisted", blacklisted: "whitelisted", whitelisted: "blacklisted" };
    const STATUS_LABEL  = { pending: "Pending", blacklisted: "Blacklisted", whitelisted: "Whitelisted" };
    const STATUS_CLASS  = { pending: "status-badge--pending", blacklisted: "status-badge--blacklisted", whitelisted: "status-badge--whitelisted" };
    const COL_COUNT = 7; // expand + Steam Name + Steam ID + First Seen + Last Seen + Last Server + Access

    // Transition-based auto-expand/collapse (only on status change, not every render)
    for (const p of sorted) {
      const isOnlineNow = (onlineMap.get(p.steam_id) ?? []).length > 0;
      const wasOnline = pmWasOnline.has(p.steam_id);
      if (isOnlineNow && !wasOnline) {
        pmExpandedIds.add(p.steam_id);
        pmWasOnline.add(p.steam_id);
      } else if (!isOnlineNow && wasOnline) {
        pmExpandedIds.delete(p.steam_id);
        pmWasOnline.delete(p.steam_id);
      }
    }

    for (const p of sorted) {
      const onlineEntries = onlineMap.get(p.steam_id) ?? [];
      const isOnline = onlineEntries.length > 0;
      const hasServerNames = p.serverNames.length > 0;
      const isExpanded = pmExpandedIds.has(p.steam_id);

      // ── Main row ──
      const tr = el("tr", { class: isOnline ? "pm-row pm-row--online" : "pm-row" });

      // Expand/collapse chevron cell
      const chevronTd = el("td", { class: "pm-chevron-cell" });
      let subRows = [];
      if (hasServerNames) {
        const chevron = el("button", { class: "pm-chevron", "data-expanded": isExpanded ? "true" : "false" },
          isExpanded ? "▼" : "▶");
        chevron.onclick = () => {
          const expanded = chevron.dataset.expanded === "true";
          chevron.dataset.expanded = expanded ? "false" : "true";
          chevron.textContent = expanded ? "▶" : "▼";
          if (expanded) pmExpandedIds.delete(p.steam_id);
          else pmExpandedIds.add(p.steam_id);
          subRows.forEach(r => { r.hidden = expanded; });
          reapplyPmRowColors();
        };
        chevronTd.appendChild(chevron);
      }
      tr.appendChild(chevronTd);

      tr.appendChild(el("td", {}, p.display_name || "—"));
      tr.appendChild(el("td", { class: "mono", style: "font-size:0.78rem" }, p.steam_id));
      tr.appendChild(el("td", { class: "mono" }, formatTs(p.first_seen)));
      tr.appendChild(el("td", { class: "mono" }, formatTs(p.last_seen)));
      tr.appendChild(el("td", {}, p.last_server ?? "—"));

      const actionTd = el("td", {});
      if (p.steam_id === currentUser?.steamId) {
        actionTd.appendChild(el("span", {
          style: "font-size:11px;color:var(--accent-purple);font-family:var(--font-mono);padding:2px 6px",
        }, "[admin]"));
      } else {
        const badge = el("span", { class: `status-badge ${STATUS_CLASS[p.status] ?? "status-badge--pending"}`, title: "Click to change access level" }, STATUS_LABEL[p.status] ?? "Pending");
        badge.onclick = async () => {
          const next = STATUS_CYCLE[p.status] ?? "blacklisted";
          badge.style.opacity = "0.5";
          badge.style.pointerEvents = "none";
          await setPlayerStatus(p.steam_id, next, badge);
        };
        actionTd.appendChild(badge);
        const delBtn = el("button", { class: "btn btn-small btn-danger", title: "Delete record", style: "margin-left:6px" }, "🗑");
        delBtn.onclick = () => deletePlayerRecord(p.steam_id, delBtn);
        actionTd.appendChild(delBtn);
      }
      tr.appendChild(actionTd);
      tbody.appendChild(tr);

      // ── Sub-rows (one per server the player has been seen on) ──
      if (hasServerNames) {
        const onlineContainerIds = new Set(onlineEntries.map(e => e.containerId));
        const isAdminRow = p.steam_id === currentUser?.steamId;

        const sortedServerNames = [...p.serverNames].sort((a, b) =>
          (onlineContainerIds.has(b.container_id) ? 1 : 0) - (onlineContainerIds.has(a.container_id) ? 1 : 0)
        );
        for (const sn of sortedServerNames) {
          const serverOnline = onlineContainerIds.has(sn.container_id);
          const subServerId = containerIdToServerId.get(sn.container_id);
          const subTr = el("tr", { class: "pm-subrow" });
          subTr.hidden = !isExpanded;
          const subTd = el("td", { colspan: String(COL_COUNT) });
          const subContent = el("div", { class: "pm-subrow-content" });
          subTd.appendChild(subContent);
          subContent.appendChild(el("span", { class: "pm-subrow-indent" }));

          const dot = el("span", { class: serverOnline ? "pm-online-dot" : "pm-offline-dot" }, "●");
          subContent.appendChild(dot);

          // Character name — clickable if server is in lastStatus
          if (subServerId) {
            const charLink = el("span", { class: "pm-name-link" }, sn.characterName);
            charLink.onclick = () => { location.hash = `server/${subServerId}`; };
            subContent.appendChild(charLink);
          } else {
            subContent.appendChild(el("span", {}, sn.characterName));
          }
          subContent.appendChild(el("span", {}, ` — ${sn.containerName}`));

          // Action buttons (not shown for admin's own row)
          if (!isAdminRow) {
            const isBanned = p.game_banned === 1;
            const actionsDiv = el("div", { class: "pm-subrow-actions" });
            if (isBanned) {
              const unbanBtn = el("button", { class: "btn btn-small btn-secondary" }, "Unban");
              unbanBtn.onclick = () => doPlayerAction(sn.container_id, p.steam_id, "unban", sn.characterName, unbanBtn);
              actionsDiv.appendChild(unbanBtn);
            } else {
              if (serverOnline) {
                const kickBtn = el("button", { class: "btn btn-small btn-secondary" }, "Kick");
                kickBtn.onclick = () => doPlayerAction(sn.container_id, p.steam_id, "kick", sn.characterName, kickBtn);
                actionsDiv.appendChild(kickBtn);
              }
              const banBtn = el("button", { class: "btn btn-small btn-danger" }, "Ban");
              banBtn.onclick = () => doPlayerAction(sn.container_id, p.steam_id, "ban", sn.characterName, banBtn);
              actionsDiv.appendChild(banBtn);
            }
            subContent.appendChild(actionsDiv);
          }

          subTr.appendChild(subTd);
          subRows.push(subTr);
          tbody.appendChild(subTr);
        }
      }
    }
    reapplyPmRowColors();
  } catch { }
}

async function setPlayerStatus(steamId, status, el) {
  try {
    const res = await fetch(`/api/known-players/${encodeURIComponent(steamId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(`Error: ${d.error ?? res.statusText}`);
      el.style.opacity = "";
      el.style.pointerEvents = "";
    } else {
      await fetchAndRenderPlayers();
    }
  } catch {
    el.style.opacity = "";
    el.style.pointerEvents = "";
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

  // Capture focus state before wiping so we can restore it after rebuild
  const active = document.activeElement;
  let focusSid = null, focusField = null, focusSelStart = 0, focusSelEnd = 0;
  if (active && container.contains(active)) {
    const focusRow = active.closest("[data-sid]");
    if (focusRow) {
      focusSid = focusRow.dataset.sid;
      if (active.classList.contains("schedule-cron-input")) {
        focusField = "cron";
        focusSelStart = active.selectionStart ?? 0;
        focusSelEnd   = active.selectionEnd   ?? 0;
      }
    }
  }

  container.innerHTML = "";

  for (const s of servers) {
    const sched = schedules.find((x) => x.container_id === s.id);
    const cronVal = sched?.cron_expr ?? "";
    const enabledVal = sched?.enabled === 1;

    const row = el("div", { class: `schedule-row ${enabledVal ? "enabled" : ""}`, "data-sid": s.id });
    row.appendChild(el("span", { class: "schedule-name" }, s.name));

    const saved = savedCronValues.get(s.id);
    if (saved !== undefined) savedCronValues.delete(s.id);
    const cronInput = el("input", {
      class: "schedule-cron-input",
      type: "text",
      placeholder: "cron expression (e.g. 0 4 * * *)",
      value: saved?.cron !== undefined ? saved.cron : cronVal,
    });

    const enableLabel = el("label", { class: "schedule-toggle" });
    const enableChk = el("input", { type: "checkbox" });
    enableChk.checked = saved?.enabled !== undefined ? saved.enabled : enabledVal;
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

  // Restore focus to whichever input had it before the rebuild
  if (focusSid && focusField === "cron") {
    const restored = container.querySelector(`[data-sid="${focusSid}"] .schedule-cron-input`);
    if (restored) {
      restored.focus();
      restored.setSelectionRange(focusSelStart, focusSelEnd);
    }
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

function fmtMB(mb) {
  return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB";
}

function isChatAtBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 10;
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
