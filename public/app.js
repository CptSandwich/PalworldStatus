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
    const server = lastStatus.find((s) => s.id === id);
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
  root.innerHTML = "";

  // Server grid
  const gridSection = el("section", { class: "server-grid-section" });
  const gridHeader = el("div", { class: "section-header" });
  gridHeader.appendChild(el("h2", { class: "section-title" }, "Server Status"));
  gridSection.appendChild(gridHeader);

  const grid = el("div", { class: "server-grid", id: "server-grid" });
  if (!lastStatus || lastStatus.length === 0) {
    const empty = el("p", { class: "empty-state" },
      lastStatus === null
        ? "Checking server status\u2026"
        : "No servers configured. Add palworld-status.enabled=true labels to Palworld containers."
    );
    grid.appendChild(empty);
  } else {
    for (const s of lastStatus) {
      grid.appendChild(buildServerCard(s));
    }
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
  const auditBody = el("tbody", { id: "audit-body" });
  auditTable.appendChild(auditBody);
  auditSection.appendChild(auditTable);
  root.appendChild(auditSection);

  // Load and render audit log
  fetchAndRenderAuditLog();

  // Admin: player management
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

    // Admin: restart schedules
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
    : s.gameStatus === "online" ? "online"
    : s.gameStatus === "crashed" ? "crashed"
    : "offline";

  const statusLabel = {
    online: "Online",
    crashed: "Crashed",
    offline: s.dockerStatus === "starting" ? "Starting" : "Offline",
    starting: "Starting",
  }[s.dockerStatus === "starting" ? "starting" : gameStatus];

  const card = el("div", {
    class: "server-card",
    "data-status": s.dockerStatus === "starting" ? "starting" : gameStatus,
    "data-id": s.id,
  });

  // Navigate to detail on card click (but not button clicks)
  card.addEventListener("click", (e) => {
    if (e.target.closest(".btn")) return;
    location.hash = `#server/${encodeURIComponent(s.id)}`;
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

  card.appendChild(body);

  // Footer actions
  const footer = el("div", { class: "server-card-footer" });
  if (gameStatus === "online" || gameStatus === "crashed") {
    const restartBtn = el("button", { class: "btn btn-small" }, "↺ Restart");
    restartBtn.onclick = (e) => { e.stopPropagation(); doContainerAction(s.id, "restart", s.name, restartBtn); };
    footer.appendChild(restartBtn);
    const stopBtn = el("button", { class: "btn btn-small btn-danger" }, "■ Stop");
    stopBtn.onclick = (e) => { e.stopPropagation(); doContainerAction(s.id, "stop", s.name, stopBtn); };
    footer.appendChild(stopBtn);
  } else if (gameStatus === "offline" && s.allowStart) {
    const startBtn = el("button", { class: "btn btn-small" }, "▶ Start");
    startBtn.onclick = (e) => { e.stopPropagation(); doContainerAction(s.id, "start", s.name, startBtn); };
    footer.appendChild(startBtn);
  }
  if (footer.children.length > 0) card.appendChild(footer);

  return card;
}

// ── Detail page ───────────────────────────────────────────────────────────────

function renderDetailPage(s) {
  const root = document.getElementById("view-root");
  root.innerHTML = "";

  const gameStatus = s.dockerStatus !== "running" ? "offline"
    : s.gameStatus === "online" ? "online"
    : s.gameStatus === "crashed" ? "crashed"
    : "offline";

  const statusLabel = {
    online: "Online",
    crashed: "Crashed",
    offline: s.dockerStatus === "starting" ? "Starting" : "Offline",
  }[gameStatus] ?? "Offline";

  // Detail header
  const hdr = el("div", { class: "detail-header" });
  const backBtn = el("button", { class: "back-btn" }, "← Back");
  backBtn.onclick = () => { location.hash = ""; };
  hdr.appendChild(backBtn);
  const nameDot = el("span", { class: "status-dot", style: `background:var(--status-${gameStatus});box-shadow:0 0 7px var(--status-${gameStatus})` });
  hdr.appendChild(nameDot);
  const nameEl = el("span", { class: "detail-server-name" }, s.name);
  hdr.appendChild(nameEl);
  const labelEl = el("span", { class: "status-label", style: `color:var(--status-${gameStatus})` }, statusLabel);
  hdr.appendChild(labelEl);
  root.appendChild(hdr);

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

  // Idle countdown in detail
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
  root.appendChild(infoPanel);

  // Player list panel
  if (gameStatus === "online" && s.players.length > 0) {
    const playersPanel = el("div", { class: "detail-panel" });
    playersPanel.appendChild(el("div", { class: "detail-panel-title" }, "Players Online"));
    const list = el("div", { class: "player-list" });
    for (const p of s.players) {
      const row = el("div", { class: "player-row" });
      row.appendChild(el("span", { class: "player-name" }, p.name));
      row.appendChild(el("span", { class: "player-stats" },
        `Lv.${p.level}  ${Math.round(p.locationX)}, ${Math.round(p.locationY)}`
      ));
      list.appendChild(row);
    }
    playersPanel.appendChild(list);
    root.appendChild(playersPanel);
  }

  // Admin: timed action panel
  if (currentUser?.role === "admin" || currentUser?.role === "whitelisted") {
    buildTimedActionPanel(root, s);
  }

  // Admin: broadcast panel
  if (currentUser?.role === "admin" || currentUser?.role === "whitelisted") {
    if (gameStatus === "online") {
      buildBroadcastPanel(root, s);
    }
  }

  // Map section
  buildDetailMap(root, s);

  // Chat log
  buildChatLog(root, s.id);
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

  // Map container
  const mapContainer = el("div", { class: "map-container" });
  const mapImg = el("img", { class: "map-img", src: "/palworld-map.jpg", alt: "Palworld World Map" });
  const canvas = el("canvas", { class: "map-canvas" });
  mapContainer.appendChild(mapImg);
  mapContainer.appendChild(canvas);
  section.appendChild(mapContainer);

  // History legend placeholder
  const legendEl = el("div", { class: "history-legend", style: "display:none" });
  section.appendChild(legendEl);

  root.appendChild(section);

  // Store refs for re-renders
  detailMapImg = mapImg;
  detailCanvas = canvas;

  mapImg.onload = () => renderDetailCanvas(s);
  window.addEventListener("resize", () => renderDetailCanvas(s), { once: false });

  // Draw after append (image might already be cached)
  requestAnimationFrame(() => renderDetailCanvas(s));
}

function renderDetailCanvas(s) {
  if (!detailCanvas || !detailMapImg) return;
  const ctx = detailCanvas.getContext("2d");

  const rect = detailMapImg.getBoundingClientRect();
  detailCanvas.width = rect.width || detailMapImg.offsetWidth;
  detailCanvas.height = rect.height || detailMapImg.offsetHeight;
  ctx.clearRect(0, 0, detailCanvas.width, detailCanvas.height);

  if (!mapCalibration) return;
  const { worldMinX, worldMaxX, worldMinY, worldMaxY } = mapCalibration;

  function worldToCanvas(wx, wy) {
    return {
      cx: ((wx - worldMinX) / (worldMaxX - worldMinX)) * detailCanvas.width,
      cy: ((wy - worldMinY) / (worldMaxY - worldMinY)) * detailCanvas.height,
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

  // Draw history trails
  if (detailHistoryEnabled && detailHistoryData) {
    for (const ph of detailHistoryData.players) {
      if (detailHiddenPlayers.has(ph.steamId)) continue;
      const color = playerColors[ph.steamId] ?? DOT_COLORS[0];
      ctx.fillStyle = color + "66"; // 40% opacity hex suffix
      for (const pt of ph.points) {
        const { cx, cy } = worldToCanvas(pt.x, pt.y);
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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
