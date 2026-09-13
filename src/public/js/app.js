/**
 * @file app.js
 * @description Master Frontend Dashboard Controller managing tab routing, live grid rendering, MSE player lifecycle, discovery, and real-time WebSocket events.
 * @functions initDashboard, setupTabNavigation, loadCameras, renderLiveGrid, triggerDiscoveryScan, handleModelUpload
 * @dependencies api.js, player.js, roi.js
 */

// Application State
const state = {
  cameras: [],
  activePlayers: new Map(), // cameraId -> MSEPlayer instance
  eventsWs: null,
  activeTab: 'live',
  settings: null,
  metrics: null,

  // AI Events Hub State
  eventsPage: 1,
  eventsPageSize: 24,
  eventsViewMode: 'grid', // 'grid' | 'table'
  eventsTotal: 0,
  eventsList: [],
  activeEventDetail: null
};

document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
});

async function initDashboard() {
  setupTabNavigation();
  setGridLayout('4');
  initLiveClock();
  initRoiEditor('roi-canvas');
  initEventWebSocket();

  // Restore sidebar collapsed state
  if (localStorage.getItem('sidebarCollapsed') === '1') {
    document.getElementById('sidebar')?.classList.add('collapsed');
  }

  // Keyboard shortcut: Ctrl+B to toggle sidebar
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleSidebar();
    }
  });

  await loadSettings();
  await loadCameras();
  await loadEvents();

  // Periodic Telemetry Poll (every 3.5s)
  pollSystemMetrics();
  setInterval(pollSystemMetrics, 3500);
}

// -----------------------------------------------------------------------------
// TAB NAVIGATION & TOPBAR CONTROLS
// -----------------------------------------------------------------------------
const TAB_TITLES = {
  live: 'Live Surveillance Grid',
  cameras: 'Cameras & Management',
  events: 'AI Event Log & Gallery',
  recordings: 'Continuous Playback',
  settings: 'Storage & System Settings'
};

function setupTabNavigation() {
  const navItems = document.querySelectorAll('.sidebar-nav .nav-item, .nav-tab');
  navItems.forEach(tab => {
    tab.addEventListener('click', async () => {
      const tabKey = tab.getAttribute('data-tab');
      if (state.activeTab === tabKey) return;

      navItems.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      // Highlight active nav item
      document.querySelectorAll(`[data-tab="${tabKey}"]`).forEach(el => el.classList.add('active'));
      state.activeTab = tabKey;

      // Update Topbar Title
      const topbarTitle = document.getElementById('topbar-title');
      if (topbarTitle) {
        topbarTitle.textContent = TAB_TITLES[tabKey] || tabKey.toUpperCase();
      }

      // Show / hide topbar grid selector based on live tab
      const gridControls = document.getElementById('topbar-grid-controls');
      if (gridControls) {
        gridControls.style.display = (tabKey === 'live') ? 'flex' : 'none';
      }

      const targetContent = document.getElementById(`tab-${tabKey}`);
      if (targetContent) targetContent.classList.add('active');

      if (tabKey === 'live') {
        await loadCameras();
      } else {
        // Destroy active MSE players when switching away from Live tab to save client memory
        state.activePlayers.forEach(player => player.destroy());
        state.activePlayers.clear();

        if (tabKey === 'cameras') {
          await loadCameras();
        } else if (tabKey === 'events') {
          await loadEvents();
        } else if (tabKey === 'recordings') {
          initRecordingsTab();
        } else if (tabKey === 'settings') {
          await loadSettings();
        }
      }
    });
  });

  // Topbar and Toolbar grid layout selector sync
  const bindGridButtons = (selector) => {
    const btns = document.querySelectorAll(selector);
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        const gridType = btn.getAttribute('data-grid');
        setGridLayout(gridType);
      });
    });
  };

  bindGridButtons('.grid-layout-selector button');
  bindGridButtons('.topbar-grid-controls button');
}

function setGridLayout(gridType) {
  // Sync all grid buttons active state
  document.querySelectorAll('[data-grid]').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-grid') === gridType);
  });

  const gridEl = document.getElementById('live-grid');
  if (!gridEl) return;

  if (gridType === '1') {
    gridEl.className = 'camera-grid grid-1x1';
  } else if (gridType === '9') {
    gridEl.className = 'camera-grid grid-3x3';
  } else {
    gridEl.className = 'camera-grid grid-2x2';
  }

  const activeCount = state.cameras.filter(c => c.enabled).length || state.cameras.length;
  if (activeCount === 1 && gridType !== '9') {
    gridEl.classList.add('single-camera-grid');
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed');
  const isCollapsed = sidebar.classList.contains('collapsed');
  localStorage.setItem('sidebarCollapsed', isCollapsed ? '1' : '0');
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else if (document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

function toggleCameraFullscreen(cameraId) {
  const card = document.getElementById(`cam-card-${cameraId}`);
  if (!card) return;
  if (!document.fullscreenElement) {
    card.requestFullscreen().catch(() => {});
  } else if (document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

function initLiveClock() {
  const clockEl = document.getElementById('topbar-clock');
  if (!clockEl) return;
  const updateClock = () => {
    const now = new Date();
    clockEl.textContent = now.toTimeString().split(' ')[0];
  };
  updateClock();
  setInterval(updateClock, 1000);
}

// -----------------------------------------------------------------------------
// REALTIME WEBSOCKET EVENTS
// -----------------------------------------------------------------------------
function initEventWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws/events`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[EventWS] Connected to NVR event stream.');
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerEvent(data);
    } catch (e) {
      // Ignore
    }
  };

  ws.onclose = () => {
    console.warn('[EventWS] Disconnected. Reconnecting in 3s...');
    setTimeout(initEventWebSocket, 3000);
  };
}

let lastAiToastTime = 0;

function handleServerEvent(msg) {
  if (msg.type === 'DETECTION_EVENT') {
    const camName = getCameraName(msg.cameraId);
    const now = Date.now();
    if (now - lastAiToastTime >= 3000) {
      showToast(`AI Alert: ${msg.event.label.toUpperCase()} (${Math.round(msg.event.confidence * 100)}%) on ${camName}`, 'info');
      lastAiToastTime = now;
    }
    drawDetectionOverlay(msg.cameraId, msg.boxes);
    if (state.activeTab === 'events') {
      handleLiveEventArrival(msg.event);
    } else {
      updateNavEventBadge();
    }
  } else if (msg.type === 'STREAM_STATUS_CHANGED') {
    updateCameraCardStatus(msg.cameraId, msg.status);
  }
}

const overlayTimers = new Map();

function drawDetectionOverlay(cameraId, boxes) {
  const canvas = document.getElementById(`overlay-canvas-${cameraId}`);
  if (!canvas || !boxes || boxes.length === 0) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  // Clear previous frame
  ctx.clearRect(0, 0, w, h);

  for (const box of boxes) {
    // Auto-detect and support normalized coordinates (0.0 to 1.0)
    const isNorm = (box.x <= 1.0 && box.width <= 1.0 && box.width > 0);
    const rx = Math.round(isNorm ? box.x * w : box.x);
    const ry = Math.round(isNorm ? box.y * h : box.y);
    const rw = Math.round(isNorm ? box.width * w : box.width);
    const rh = Math.round(isNorm ? box.height * h : box.height);

    // Tactical Color Coding
    const labelLower = (box.label || '').toLowerCase();
    const isPerson = labelLower === 'person';
    const isVehicle = ['car', 'motorcycle', 'bus', 'truck', 'bicycle'].includes(labelLower);
    
    // Safety Orange for Person, Hazard Amber for Vehicles, Tactical Yellow for others
    const primaryColor = isPerson ? '#f97316' : (isVehicle ? '#f59e0b' : '#eab308');
    const bgBadge = 'rgba(8, 10, 13, 0.94)';
    const textBadgeColor = primaryColor;

    // 1. Tactical Bounding Box with subtle glow
    ctx.shadowColor = primaryColor;
    ctx.shadowBlur = 6;
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);

    // 2. Brutalist Corner Bracket Accents
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#fef3c7';
    ctx.lineWidth = 2.5;
    const corner = Math.min(14, rw / 4, rh / 4);

    // Top-Left
    ctx.beginPath();
    ctx.moveTo(rx, ry + corner);
    ctx.lineTo(rx, ry);
    ctx.lineTo(rx + corner, ry);
    ctx.stroke();

    // Top-Right
    ctx.beginPath();
    ctx.moveTo(rx + rw - corner, ry);
    ctx.lineTo(rx + rw, ry);
    ctx.lineTo(rx + rw, ry + corner);
    ctx.stroke();

    // Bottom-Left
    ctx.beginPath();
    ctx.moveTo(rx, ry + rh - corner);
    ctx.lineTo(rx, ry + rh);
    ctx.lineTo(rx + corner, ry + rh);
    ctx.stroke();

    // Bottom-Right
    ctx.beginPath();
    ctx.moveTo(rx + rw - corner, ry + rh);
    ctx.lineTo(rx + rw, ry + rh);
    ctx.lineTo(rx + rw, ry + rh - corner);
    ctx.stroke();

    // 3. Identification Label Badge (Monospace Tactical Style)
    const text = `[${box.label.toUpperCase()}] ${Math.round(box.confidence * 100)}%`;
    ctx.font = '700 11px "JetBrains Mono", monospace';
    const textMetrics = ctx.measureText(text);
    const badgeW = textMetrics.width + 16;
    const badgeH = 20;
    const badgeY = Math.max(0, ry - badgeH);

    // Dark chassis background for label
    ctx.fillStyle = bgBadge;
    ctx.fillRect(rx, badgeY, badgeW, badgeH);

    // Tactical color indicator seam
    ctx.fillStyle = primaryColor;
    ctx.fillRect(rx, badgeY, 3, badgeH);

    // Text in tactical amber/orange
    ctx.fillStyle = textBadgeColor;
    ctx.fillText(text, rx + 8, badgeY + 14);
  }

  // Debounce clear timer: keep bounding box visible for 3.0 seconds after detection
  if (overlayTimers.has(cameraId)) {
    clearTimeout(overlayTimers.get(cameraId));
  }

  const timer = setTimeout(() => {
    ctx.clearRect(0, 0, w, h);
    overlayTimers.delete(cameraId);
  }, 3000);
  overlayTimers.set(cameraId, timer);
}

// -----------------------------------------------------------------------------
// CAMERAS & LIVE SURVEILLANCE
// -----------------------------------------------------------------------------
async function loadCameras() {
  try {
    const res = await API.getCameras();
    if (res.success) {
      state.cameras = res.cameras;
      const camCountText = `${res.cameras.length} Cameras Configured`;
      const liveCamCount = document.getElementById('live-camera-count');
      if (liveCamCount) liveCamCount.textContent = camCountText;
      
      const navCamBadge = document.getElementById('nav-cam-count');
      if (navCamBadge) navCamBadge.textContent = String(res.cameras.length);

      populateCameraDropdowns();
      renderCameraTable();
      if (state.activeTab === 'live') {
        renderLiveGrid();
      }
    }
  } catch (err) {
    console.error('Failed to load cameras:', err);
  }
}

function populateCameraDropdowns() {
  const eventCamSelect = document.getElementById('event-camera-filter');
  if (eventCamSelect) {
    const curVal = eventCamSelect.value;
    eventCamSelect.innerHTML = '<option value="">All Cameras</option>';
    state.cameras.forEach(cam => {
      const opt = document.createElement('option');
      opt.value = cam.id;
      opt.textContent = `📷 ${cam.name}`;
      eventCamSelect.appendChild(opt);
    });
    eventCamSelect.value = curVal;
  }

  const pbCamSelect = document.getElementById('playback-camera-select');
  if (pbCamSelect) {
    const curVal = pbCamSelect.value;
    pbCamSelect.innerHTML = '<option value="">Select Camera</option>';
    state.cameras.forEach(cam => {
      const opt = document.createElement('option');
      opt.value = cam.id;
      opt.textContent = `📷 ${cam.name}`;
      pbCamSelect.appendChild(opt);
    });
    pbCamSelect.value = curVal;
  }
}

function renderLiveGrid() {
  const grid = document.getElementById('live-grid');
  if (!grid) return;

  // Cleanly destroy any previous active players
  state.activePlayers.forEach(player => player.destroy());
  state.activePlayers.clear();

  grid.innerHTML = '';

  if (state.cameras.length === 0) {
    grid.className = 'camera-grid grid-2x2';
    grid.innerHTML = `
      <div class="card p-4 text-center" style="grid-column: 1 / -1; width: 100%; max-width: 600px; margin: 2rem auto;">
        <h3>No Cameras Configured</h3>
        <p class="text-muted mt-2">Scan your local network or click "Add Camera" to ingest your first CCTV feed.</p>
        <div class="mt-3">
          <button class="btn btn-accent" onclick="triggerDiscoveryScan()">Scan Local Network</button>
        </div>
      </div>
    `;
    return;
  }

  const countEl = document.getElementById('live-camera-count');
  if (countEl) {
    const activeStreams = state.cameras.filter(c => c.enabled).length;
    countEl.textContent = `${activeStreams}/${state.cameras.length} STREAMS ONLINE`;
  }

  // Auto-adapt single camera sizing if only 1 camera is configured
  const activeCount = state.cameras.filter(c => c.enabled).length || state.cameras.length;
  if (activeCount === 1) {
    grid.classList.add('single-camera-grid');
  } else {
    grid.classList.remove('single-camera-grid');
  }

  state.cameras.forEach(cam => {
    const card = document.createElement('div');
    card.className = 'camera-card';
    card.id = `cam-card-${cam.id}`;

    const statusClass = cam.streamState?.status ? `status-${cam.streamState.status}` : 'status-stopped';
    const statusText = cam.streamState?.status || (cam.enabled ? 'connecting' : 'stopped');

    card.innerHTML = `
      <div class="camera-card-header">
        <div class="camera-title-wrap">
          <span class="cam-indicator-dot ${statusClass}"></span>
          <span class="cam-name">${cam.name}</span>
          <span class="cam-protocol-tag">RTSP // MSE</span>
        </div>
        <div class="camera-header-actions">
          <span class="cam-status-pill ${statusClass}" id="cam-pill-${cam.id}">[${statusText.toUpperCase()}]</span>
          <button class="cam-header-btn" onclick="openRoiModal('${cam.id}', '${cam.name}', '${encodeURIComponent(cam.roi_config || '')}')" title="Configure ROI Detection Zone">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
          </button>
          <button class="cam-header-btn" onclick="toggleCameraFullscreen('${cam.id}')" title="Expand Fullscreen View">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          </button>
        </div>
      </div>
      <div class="video-container">
        <video id="video-stream-${cam.id}" class="live-video-player" playsinline muted autoplay></video>
        <canvas id="overlay-canvas-${cam.id}" class="detection-overlay-canvas" width="640" height="360"></canvas>
        <div class="video-hud-overlay">
          <div class="hud-corner hud-top-left"></div>
          <div class="hud-corner hud-top-right"></div>
          <div class="hud-corner hud-bottom-left"></div>
          <div class="hud-corner hud-bottom-right"></div>
          <div class="hud-meta-top">
            <span class="hud-live-tag"><span class="hud-pulse-dot"></span> LIVE</span>
            <span class="hud-res-tag">1080P</span>
          </div>
          <div class="hud-meta-bottom">
            ${cam.ai_enabled ? '<span class="hud-ai-tag"><span class="hud-ai-dot"></span> AI ACTIVE</span>' : '<span class="hud-ai-tag disabled">AI OFF</span>'}
          </div>
        </div>
      </div>
      <div class="camera-card-actions">
        <span class="stream-url-tag" title="${cam.rtsp_url}">${cam.rtsp_url.substring(0, 36)}...</span>
        <div class="card-action-btns">
          <button class="btn ${cam.ai_enabled ? 'btn-accent-subtle' : 'btn-secondary'} btn-xs" onclick="toggleCameraAI('${cam.id}', ${!cam.ai_enabled})">
            ${cam.ai_enabled ? 'AI [ON]' : 'AI [OFF]'}
          </button>
          <button class="btn btn-secondary btn-xs" onclick="jumpToPlaybackDirect('${cam.id}', new Date().toISOString())" title="View Recordings">
            PLAYBACK
          </button>
        </div>
      </div>
    `;

    grid.appendChild(card);

    if (cam.enabled) {
      const videoEl = document.getElementById(`video-stream-${cam.id}`);
      const player = new MSEPlayer(videoEl, cam.id, (status) => {
        updateCameraCardStatus(cam.id, status);
      });
      state.activePlayers.set(cam.id, player);
    }
  });
}

function updateCameraCardStatus(cameraId, status) {
  const pill = document.getElementById(`cam-pill-${cameraId}`);
  if (pill) {
    pill.className = `cam-status-pill status-${status}`;
    pill.textContent = `[${status.toUpperCase()}]`;
  }
  const dot = document.querySelector(`#cam-card-${cameraId} .cam-indicator-dot`);
  if (dot) {
    dot.className = `cam-indicator-dot status-${status}`;
  }
}

function renderCameraTable() {
  const tbody = document.getElementById('camera-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  state.cameras.forEach(cam => {
    const tr = document.createElement('tr');
    const statusClass = cam.streamState?.status ? `status-${cam.streamState.status}` : 'status-stopped';
    const statusText = cam.streamState?.status || (cam.enabled ? 'active' : 'stopped');

    tr.innerHTML = `
      <td><span class="cam-status-pill ${statusClass}">${statusText}</span></td>
      <td><strong>${cam.name}</strong></td>
      <td><code style="font-size: 0.8rem;">${cam.rtsp_url}</code></td>
      <td>
        <button class="btn btn-sm ${cam.enabled ? 'btn-secondary' : 'btn-primary'}" onclick="toggleCameraEnabled('${cam.id}', ${!cam.enabled})">
          ${cam.enabled ? 'Stop Ingest' : 'Start Ingest'}
        </button>
      </td>
      <td>
        <button class="btn btn-sm ${cam.ai_enabled ? 'btn-accent' : 'btn-secondary'}" onclick="toggleCameraAI('${cam.id}', ${!cam.ai_enabled})">
          ${cam.ai_enabled ? 'AI Enabled (ON)' : 'AI Disabled (OFF)'}
        </button>
      </td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="openRoiModal('${cam.id}', '${cam.name}', ${cam.roi_config ? JSON.stringify(cam.roi_config).replace(/"/g, '&quot;') : 'null'})">
          Configure Zone
        </button>
      </td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="deleteCamera('${cam.id}')">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// -----------------------------------------------------------------------------
// CAMERA CRUD & ACTIONS
// -----------------------------------------------------------------------------
function openAddCameraModal(prefill = null) {
  document.getElementById('modal-camera-title').textContent = 'Ingest IP Camera';
  document.getElementById('camera-form-id').value = '';
  document.getElementById('cam-name').value = prefill?.name || '';
  document.getElementById('cam-rtsp').value = prefill?.rtspUrl || '';
  document.getElementById('cam-enabled').checked = true;
  document.getElementById('cam-ai-enabled').checked = false;

  document.getElementById('modal-camera').classList.remove('hidden');
}

function closeCameraModal() {
  document.getElementById('modal-camera').classList.add('hidden');
}

async function handleCameraSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('camera-form-id').value;
  const name = document.getElementById('cam-name').value;
  const rtsp_url = document.getElementById('cam-rtsp').value;
  const enabled = document.getElementById('cam-enabled').checked;
  const ai_enabled = document.getElementById('cam-ai-enabled').checked;

  try {
    if (id) {
      await API.updateCamera(id, { name, rtsp_url, enabled, ai_enabled });
      showToast('Camera updated successfully', 'success');
    } else {
      await API.createCamera({ name, rtsp_url, enabled, ai_enabled });
      showToast('Camera added and stream ingestion started', 'success');
    }
    closeCameraModal();
    await loadCameras();
  } catch (err) {
    showToast('Failed to save camera: ' + err.message, 'error');
  }
}

async function toggleCameraEnabled(id, enabled) {
  try {
    await API.toggleCamera(id, enabled);
    showToast(`Camera ingestion ${enabled ? 'started' : 'stopped'}`, 'info');
    await loadCameras();
  } catch (err) {
    showToast('Failed to toggle camera: ' + err.message, 'error');
  }
}

async function toggleCameraAI(id, aiEnabled) {
  try {
    await API.toggleAI(id, aiEnabled);
    showToast(`AI Detection ${aiEnabled ? 'activated' : 'deactivated'}`, 'info');
    await loadCameras();
  } catch (err) {
    showToast('Failed to toggle AI: ' + err.message, 'error');
  }
}

async function deleteCamera(id) {
  if (!confirm('Are you sure you want to delete this camera? Recorded files will be preserved.')) return;
  try {
    await API.deleteCamera(id);
    showToast('Camera removed', 'success');
    await loadCameras();
  } catch (err) {
    showToast('Failed to delete camera: ' + err.message, 'error');
  }
}

// -----------------------------------------------------------------------------
// NETWORK AUTO-DISCOVERY
// -----------------------------------------------------------------------------
async function triggerDiscoveryScan() {
  const btn = document.getElementById('btn-scan-network');
  const spinner = document.getElementById('scan-spinner');
  const panel = document.getElementById('discovery-panel');
  const list = document.getElementById('discovery-list');

  btn.disabled = true;
  spinner.textContent = '⏳';
  panel.classList.remove('hidden');
  list.innerHTML = '<div class="text-center p-4">Scanning ONVIF multicast (UDP 3702) & RTSP subnet ports (554/8554)...</div>';

  try {
    const res = await API.discoverCameras(4000);
    document.getElementById('disc-count').textContent = res.devicesFound;
    list.innerHTML = '';

    if (res.cameras.length === 0) {
      list.innerHTML = '<div class="text-muted p-4 text-center">No IP cameras found on the local subnet. Ensure cameras are powered on and connected to the same LAN.</div>';
    } else {
      res.cameras.forEach(cam => {
        const item = document.createElement('div');
        item.className = 'discovered-item';
        item.innerHTML = `
          <div>
            <div class="discovered-info-title">${cam.name || 'IP Camera'} (${cam.protocol})</div>
            <div class="discovered-info-url mt-1">${cam.rtspUrl}</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick='openAddCameraModal(${JSON.stringify(cam)})'>
            + One-Click Ingest
          </button>
        `;
        list.appendChild(item);
      });
    }
  } catch (err) {
    list.innerHTML = `<div class="text-danger p-4 text-center">Discovery failed: ${err.message}</div>`;
  } finally {
    btn.disabled = false;
    spinner.textContent = '🔍';
  }
}

function closeDiscoveryPanel() {
  document.getElementById('discovery-panel').classList.add('hidden');
}

// -----------------------------------------------------------------------------
// ROI EDITOR MODAL
// -----------------------------------------------------------------------------
function openRoiModal(cameraId, cameraName, roiConfig) {
  loadRoiConfig(cameraId, cameraName, roiConfig);
  document.getElementById('modal-roi').classList.remove('hidden');
}

function closeRoiModal() {
  document.getElementById('modal-roi').classList.add('hidden');
}

async function saveRoiConfig() {
  if (!activeRoiCameraId) return;
  const config = getRoiConfig();
  try {
    await API.updateROI(activeRoiCameraId, config);
    showToast('ROI detection zones saved successfully', 'success');
    closeRoiModal();
    await loadCameras();
  } catch (err) {
    showToast('Failed to save ROI: ' + err.message, 'error');
  }
}

// -----------------------------------------------------------------------------
// AI EVENT LOG & GALLERY ENGINE
// -----------------------------------------------------------------------------

function getCameraName(cameraId) {
  const cam = state.cameras.find(c => c.id === cameraId);
  return cam ? cam.name : (cameraId || 'Unknown Camera');
}

function getDetectionIcon(label) {
  const l = (label || '').toLowerCase();
  switch (l) {
    case 'person':
      return `<svg class="event-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline-block;vertical-align:-2px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    case 'car':
    case 'truck':
    case 'bus':
      return `<svg class="event-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline-block;vertical-align:-2px;"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.5C2.1 10.6 2 10.8 2 11v5c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>`;
    case 'motorcycle':
    case 'bicycle':
      return `<svg class="event-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline-block;vertical-align:-2px;"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5L9 6H6m6 11.5 3-7h3.5"/></svg>`;
    case 'dog':
    case 'cat':
      return `<svg class="event-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline-block;vertical-align:-2px;"><path d="m10 5 1.5 3M14 5l-1.5 3M8 12a4 4 0 0 0 8 0m-8 0v2a4 4 0 0 0 8 0v-2"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/></svg>`;
    default:
      return `<svg class="event-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline-block;vertical-align:-2px;"><circle cx="12" cy="12" r="10"/><path d="m10 15 5-3-5-3v6Z"/></svg>`;
  }
}

function formatEventTime(isoString) {
  if (!isoString) return { full: '-', rel: '-' };
  const d = new Date(isoString);
  const now = new Date();
  const diffSec = Math.floor((now - d) / 1000);
  
  let rel = '';
  if (diffSec < 5) rel = 'Just now';
  else if (diffSec < 60) rel = `${diffSec}s ago`;
  else if (diffSec < 3600) rel = `${Math.floor(diffSec / 60)}m ago`;
  else if (diffSec < 86400) rel = `${Math.floor(diffSec / 3600)}h ago`;
  else rel = `${Math.floor(diffSec / 86400)}d ago`;

  const full = d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  return { full, rel };
}

function getConfidenceBadgeClass(conf) {
  if (conf >= 0.70) return 'conf-high';
  if (conf >= 0.45) return 'conf-med';
  return 'conf-low';
}

async function loadEvents(page = 1) {
  state.eventsPage = page;
  const camFilter = document.getElementById('event-camera-filter')?.value || '';
  const labelFilter = document.getElementById('event-label-filter')?.value || '';
  const confFilter = document.getElementById('event-confidence-filter')?.value || '';
  const dateFilter = document.getElementById('event-date-filter')?.value || '';
  const pageSizeSelect = document.getElementById('event-page-size');
  if (pageSizeSelect) {
    state.eventsPageSize = parseInt(pageSizeSelect.value, 10) || 24;
  }

  let startDate;
  let endDate;
  if (dateFilter) {
    startDate = `${dateFilter}T00:00:00.000Z`;
    endDate = `${dateFilter}T23:59:59.999Z`;
  }

  const offset = (page - 1) * state.eventsPageSize;

  try {
    const res = await API.getEvents({
      cameraId: camFilter,
      label: labelFilter,
      minConfidence: confFilter,
      startDate,
      endDate,
      limit: state.eventsPageSize,
      offset
    });

    if (res.success) {
      state.eventsTotal = res.total || 0;
      state.eventsList = res.events || [];

      // Update Nav Badge
      const navEventBadge = document.getElementById('nav-events-badge');
      if (navEventBadge) {
        navEventBadge.textContent = state.eventsTotal > 0 ? `${state.eventsTotal}` : 'AI';
      }

      // Update KPIs based on total & current dataset
      updateEventKPIs(state.eventsList, state.eventsTotal);

      // Update Summary Counter
      const startIdx = state.eventsTotal === 0 ? 0 : offset + 1;
      const endIdx = Math.min(offset + state.eventsList.length, state.eventsTotal);
      
      const countSummary = document.getElementById('events-count-summary');
      if (countSummary) {
        countSummary.textContent = state.eventsTotal > 0 
          ? `Showing ${startIdx}–${endIdx} of ${state.eventsTotal} detections (Sorted: Newest First)`
          : 'No AI detection events recorded for the current filter';
      }

      const pagSummary = document.getElementById('pagination-summary');
      if (pagSummary) {
        pagSummary.textContent = `Showing ${startIdx}–${endIdx} of ${state.eventsTotal} events`;
      }

      // Render Visualizations
      renderEventCards(state.eventsList);
      renderEventTable(state.eventsList);
      renderEventPagination(state.eventsTotal, state.eventsPage, state.eventsPageSize);
    }
  } catch (err) {
    console.error('Failed to load events:', err);
    showToast('Failed to query events: ' + err.message, 'error');
  }
}

function updateEventKPIs(events, total) {
  const totalEl = document.getElementById('kpi-total-events');
  if (totalEl) totalEl.textContent = total.toLocaleString();

  // Persons count
  const personCount = events.filter(e => e.label.toLowerCase() === 'person').length;
  const personEl = document.getElementById('kpi-person-events');
  if (personEl) personEl.textContent = personCount.toLocaleString();

  // Vehicles count (car, motorcycle, bus, truck, bicycle)
  const vehicleCount = events.filter(e => ['car', 'motorcycle', 'bus', 'truck', 'bicycle'].includes(e.label.toLowerCase())).length;
  const vehicleEl = document.getElementById('kpi-vehicle-events');
  if (vehicleEl) vehicleEl.textContent = vehicleCount.toLocaleString();

  // Today's alerts
  const todayStr = new Date().toISOString().split('T')[0];
  const todayCount = events.filter(e => (e.timestamp || '').startsWith(todayStr)).length;
  const todayEl = document.getElementById('kpi-today-events');
  if (todayEl) todayEl.textContent = todayCount.toLocaleString();
}

function renderEventCards(events) {
  const grid = document.getElementById('events-grid');
  if (!grid) return;
  grid.innerHTML = '';

  if (!events || events.length === 0) {
    grid.innerHTML = `
      <div class="card p-4 text-center" style="grid-column: 1 / -1; width: 100%; max-width: 500px; margin: 2rem auto;">
        <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🔍</div>
        <h3>No AI Events Found</h3>
        <p class="text-muted mt-2">No detection records match your selected camera, class, or date filters.</p>
        <div class="mt-3">
          <button class="btn btn-secondary btn-sm" onclick="resetEventFilters()">Reset Filters</button>
        </div>
      </div>
    `;
    return;
  }

  events.forEach(evt => {
    const card = createEventCardElement(evt);
    grid.appendChild(card);
  });
}

function createEventCardElement(evt) {
  const card = document.createElement('div');
  card.className = 'event-card';
  card.id = `event-card-${evt.id}`;
  
  const imgUrl = evt.snapshot_path ? `/api/v1/snapshots/${evt.snapshot_path}` : '';
  const camName = getCameraName(evt.camera_id);
  const icon = getDetectionIcon(evt.label);
  const timeInfo = formatEventTime(evt.timestamp);
  const confClass = getConfidenceBadgeClass(evt.confidence);
  const confPercent = Math.round(evt.confidence * 100);

  card.innerHTML = `
    <div class="event-snapshot-wrap">
      ${evt.snapshot_path 
        ? `<img src="${imgUrl}" class="event-snapshot-img" alt="${evt.label}" loading="lazy" onerror="this.src='/img/placeholder-snap.png'">` 
        : '<div class="text-muted p-4 text-center font-mono" style="font-size:0.8rem;">[NO SNAPSHOT RECORDED]</div>'}
      <div class="event-snap-badges">
        <span class="event-cam-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;display:inline-block;vertical-align:-1px;margin-right:4px;"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>${camName}</span>
        <span class="event-conf-badge ${confClass}">${confPercent}%</span>
      </div>
      <div class="event-hover-overlay">
        <button class="btn btn-secondary btn-sm" onclick="openEventDetailModal('${evt.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;display:inline-block;vertical-align:-1px;margin-right:4px;"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>INSPECT
        </button>
        <button class="btn btn-primary btn-sm" onclick="jumpToPlaybackDirect('${evt.camera_id}', '${evt.timestamp}')">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width:11px;height:11px;display:inline-block;vertical-align:-1px;margin-right:4px;"><polygon points="5 3 19 12 5 21 5 3"/></svg>PLAY
        </button>
      </div>
    </div>
    <div class="event-card-body" onclick="openEventDetailModal('${evt.id}')">
      <div class="event-card-header">
        <span class="event-label-tag">${icon} ${evt.label.toUpperCase()}</span>
        <span class="event-rel-time">${timeInfo.rel}</span>
      </div>
      <div class="event-time-meta">
        <span class="text-muted font-mono" style="font-size:0.75rem;">${timeInfo.full}</span>
      </div>
    </div>
  `;
  return card;
}

function renderEventTable(events) {
  const tbody = document.getElementById('events-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!events || events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted p-4 font-mono">No AI detection records found in database.</td></tr>';
    return;
  }

  events.forEach(evt => {
    const tr = document.createElement('tr');
    tr.id = `event-row-${evt.id}`;
    const imgUrl = evt.snapshot_path ? `/api/v1/snapshots/${evt.snapshot_path}` : '';
    const camName = getCameraName(evt.camera_id);
    const icon = getDetectionIcon(evt.label);
    const timeInfo = formatEventTime(evt.timestamp);
    const confClass = getConfidenceBadgeClass(evt.confidence);
    const confPercent = Math.round(evt.confidence * 100);

    tr.innerHTML = `
      <td>
        ${evt.snapshot_path 
          ? `<img src="${imgUrl}" class="table-snapshot-thumb" alt="${evt.label}" onclick="openEventDetailModal('${evt.id}')" title="Click to inspect">` 
          : '<span class="text-muted font-mono" style="font-size:0.75rem;">[NO SNAP]</span>'}
      </td>
      <td><strong>${camName}</strong></td>
      <td><span class="event-label-tag">${icon} ${evt.label.toUpperCase()}</span></td>
      <td><span class="event-conf-badge ${confClass}">${confPercent}%</span></td>
      <td>
        <div class="font-mono">${timeInfo.full}</div>
        <div class="text-muted font-mono" style="font-size: 0.75rem;">${timeInfo.rel}</div>
      </td>
      <td>
        <div class="btn-group">
          <button class="btn btn-secondary btn-sm" onclick="openEventDetailModal('${evt.id}')" title="Inspect Snapshot">INSPECT</button>
          <button class="btn btn-primary btn-sm" onclick="jumpToPlaybackDirect('${evt.camera_id}', '${evt.timestamp}')" title="Play Video Archive">PLAY</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderEventPagination(total, currentPage, pageSize) {
  const container = document.getElementById('pagination-buttons');
  if (!container) return;
  container.innerHTML = '';

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return;

  // First Button «
  const firstBtn = document.createElement('button');
  firstBtn.className = `pagination-btn ${currentPage === 1 ? 'disabled' : ''}`;
  firstBtn.innerHTML = '«';
  firstBtn.title = 'First Page';
  firstBtn.onclick = () => { if (currentPage > 1) loadEvents(1); };
  container.appendChild(firstBtn);

  // Prev Button ‹
  const prevBtn = document.createElement('button');
  prevBtn.className = `pagination-btn ${currentPage === 1 ? 'disabled' : ''}`;
  prevBtn.innerHTML = '‹';
  prevBtn.title = 'Previous Page';
  prevBtn.onclick = () => { if (currentPage > 1) loadEvents(currentPage - 1); };
  container.appendChild(prevBtn);

  // Page Numbers with ellipsis window
  const delta = 2;
  const range = [];
  const rangeWithDots = [];
  let l;

  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= currentPage - delta && i <= currentPage + delta)) {
      range.push(i);
    }
  }

  for (const i of range) {
    if (l) {
      if (i - l === 2) {
        rangeWithDots.push(l + 1);
      } else if (i - l !== 1) {
        rangeWithDots.push('...');
      }
    }
    rangeWithDots.push(i);
    l = i;
  }

  rangeWithDots.forEach(p => {
    if (p === '...') {
      const span = document.createElement('span');
      span.className = 'pagination-ellipsis';
      span.textContent = '...';
      span.style.padding = '0 0.25rem';
      span.style.color = 'var(--text-muted)';
      container.appendChild(span);
    } else {
      const btn = document.createElement('button');
      btn.className = `pagination-btn ${p === currentPage ? 'active' : ''}`;
      btn.textContent = p;
      btn.onclick = () => loadEvents(p);
      container.appendChild(btn);
    }
  });

  // Next Button ›
  const nextBtn = document.createElement('button');
  nextBtn.className = `pagination-btn ${currentPage === totalPages ? 'disabled' : ''}`;
  nextBtn.innerHTML = '›';
  nextBtn.title = 'Next Page';
  nextBtn.onclick = () => { if (currentPage < totalPages) loadEvents(currentPage + 1); };
  container.appendChild(nextBtn);

  // Last Button »
  const lastBtn = document.createElement('button');
  lastBtn.className = `pagination-btn ${currentPage === totalPages ? 'disabled' : ''}`;
  lastBtn.innerHTML = '»';
  lastBtn.title = 'Last Page';
  lastBtn.onclick = () => { if (currentPage < totalPages) loadEvents(totalPages); };
  container.appendChild(lastBtn);
}

function onEventFilterChange() {
  loadEvents(1);
}

function onEventPageSizeChange() {
  loadEvents(1);
}

function resetEventFilters() {
  const camFilter = document.getElementById('event-camera-filter');
  if (camFilter) camFilter.value = '';
  const labelFilter = document.getElementById('event-label-filter');
  if (labelFilter) labelFilter.value = '';
  const confFilter = document.getElementById('event-confidence-filter');
  if (confFilter) confFilter.value = '';
  const dateFilter = document.getElementById('event-date-filter');
  if (dateFilter) dateFilter.value = '';
  loadEvents(1);
}

function setEventsViewMode(mode) {
  state.eventsViewMode = mode;
  const gridBtn = document.getElementById('btn-events-view-grid');
  const tableBtn = document.getElementById('btn-events-view-table');
  const gridContainer = document.getElementById('events-grid');
  const tableContainer = document.getElementById('events-table-container');

  if (mode === 'grid') {
    gridBtn?.classList.add('active');
    tableBtn?.classList.remove('active');
    gridContainer?.classList.remove('hidden');
    tableContainer?.classList.add('hidden');
  } else {
    tableBtn?.classList.add('active');
    gridBtn?.classList.remove('active');
    tableContainer?.classList.remove('hidden');
    gridContainer?.classList.add('hidden');
  }
}

function openEventDetailModal(eventOrId) {
  let evt = typeof eventOrId === 'string' 
    ? state.eventsList.find(e => e.id === eventOrId)
    : eventOrId;

  if (!evt) return;
  state.activeEventDetail = evt;

  const camName = getCameraName(evt.camera_id);
  const timeInfo = formatEventTime(evt.timestamp);
  const icon = getDetectionIcon(evt.label);
  const snapUrl = evt.snapshot_path ? `/api/v1/snapshots/${evt.snapshot_path}` : '';

  const titleEl = document.getElementById('event-detail-title');
  if (titleEl) titleEl.innerHTML = `${icon} AI TARGET // ${evt.label.toUpperCase()}`;
  
  const subTitleEl = document.getElementById('event-detail-subtitle');
  if (subTitleEl) subTitleEl.textContent = `CAMERA: ${camName.toUpperCase()} • EVENT_ID: ${evt.id}`;
  
  const imgEl = document.getElementById('event-detail-image');
  if (imgEl) {
    imgEl.src = snapUrl;
    imgEl.alt = `${evt.label} Detection`;
  }

  const camEl = document.getElementById('event-detail-cam');
  if (camEl) camEl.textContent = camName;
  
  const labelEl = document.getElementById('event-detail-label');
  if (labelEl) labelEl.innerHTML = `${icon} ${evt.label.toUpperCase()}`;
  
  const confEl = document.getElementById('event-detail-conf');
  if (confEl) confEl.textContent = `${Math.round(evt.confidence * 100)}%`;
  
  const timeEl = document.getElementById('event-detail-time');
  if (timeEl) timeEl.textContent = `${timeInfo.full} (${timeInfo.rel})`;

  const downloadBtn = document.getElementById('event-detail-download-btn');
  if (downloadBtn) {
    downloadBtn.href = snapUrl;
    downloadBtn.download = `detection_${evt.label}_${evt.camera_id}_${evt.id}.jpg`;
  }

  document.getElementById('modal-event-detail')?.classList.remove('hidden');
}

function closeEventDetailModal() {
  document.getElementById('modal-event-detail')?.classList.add('hidden');
}

function jumpToEventPlayback() {
  if (!state.activeEventDetail) return;
  const evt = state.activeEventDetail;
  closeEventDetailModal();
  jumpToPlaybackDirect(evt.camera_id, evt.timestamp);
}

function jumpToPlaybackDirect(cameraId, timestamp) {
  const dateStr = timestamp ? timestamp.split('T')[0] : new Date().toISOString().split('T')[0];

  // Populate and set playback selects
  const pbCamSelect = document.getElementById('playback-camera-select');
  if (pbCamSelect) pbCamSelect.value = cameraId;
  const pbDateSelect = document.getElementById('playback-date-select');
  if (pbDateSelect) pbDateSelect.value = dateStr;

  // Switch to Playback Tab
  const navRecordings = document.querySelector('[data-tab="recordings"]');
  if (navRecordings) {
    navRecordings.click();
    showToast(`Loading recordings for ${getCameraName(cameraId)} on ${dateStr}...`, 'info');
  }
}

function handleLiveEventArrival(evt) {
  if (!evt) return;

  // If on Page 1 of events tab, prepend new card with glowing animation
  if (state.eventsPage === 1) {
    state.eventsTotal += 1;
    state.eventsList.unshift(evt);

    // Limit in-memory page size
    if (state.eventsList.length > state.eventsPageSize) {
      state.eventsList.pop();
    }

    const grid = document.getElementById('events-grid');
    if (grid) {
      // Remove empty placeholder if any
      if (grid.querySelector('.events-empty-state') || grid.querySelector('.card')) {
        grid.innerHTML = '';
      }
      const newCard = createEventCardElement(evt);
      newCard.classList.add('new-arrival');
      grid.prepend(newCard);

      // Remove excess card from DOM if exceeded
      const cards = grid.querySelectorAll('.event-card');
      if (cards.length > state.eventsPageSize) {
        cards[cards.length - 1].remove();
      }
    }

    const tbody = document.getElementById('events-table-body');
    if (tbody) {
      const tr = document.createElement('tr');
      tr.id = `event-row-${evt.id}`;
      tr.className = 'new-arrival';
      const imgUrl = evt.snapshot_path ? `/api/v1/snapshots/${evt.snapshot_path}` : '';
      const camName = getCameraName(evt.camera_id);
      const icon = getDetectionIcon(evt.label);
      const timeInfo = formatEventTime(evt.timestamp);
      const confClass = getConfidenceBadgeClass(evt.confidence);
      const confPercent = Math.round(evt.confidence * 100);

      tr.innerHTML = `
        <td>
          ${evt.snapshot_path 
            ? `<img src="${imgUrl}" class="table-snapshot-thumb" alt="${evt.label}" onclick="openEventDetailModal('${evt.id}')">` 
            : '<span class="text-muted">No snap</span>'}
        </td>
        <td><strong>📷 ${camName}</strong></td>
        <td><span class="event-label-tag">${icon} ${evt.label.toUpperCase()}</span></td>
        <td><span class="event-conf-badge ${confClass}">${confPercent}%</span></td>
        <td>
          <div>${timeInfo.full}</div>
          <div class="text-muted" style="font-size: 0.75rem;">${timeInfo.rel}</div>
        </td>
        <td>
          <div class="btn-group">
            <button class="btn btn-secondary btn-sm" onclick="openEventDetailModal('${evt.id}')">🔍</button>
            <button class="btn btn-primary btn-sm" onclick="jumpToPlaybackDirect('${evt.camera_id}', '${evt.timestamp}')">▶</button>
          </div>
        </td>
      `;
      tbody.prepend(tr);

      const rows = tbody.querySelectorAll('tr');
      if (rows.length > state.eventsPageSize) {
        rows[rows.length - 1].remove();
      }
    }

    updateEventKPIs(state.eventsList, state.eventsTotal);
    renderEventPagination(state.eventsTotal, state.eventsPage, state.eventsPageSize);
  }

  updateNavEventBadge();
}

function updateNavEventBadge() {
  const navBadge = document.getElementById('nav-events-badge');
  if (navBadge) {
    const cur = parseInt(navBadge.textContent, 10) || 0;
    navBadge.textContent = String(cur + 1);
  }
}

// -----------------------------------------------------------------------------
// PLAYBACK & RECORDINGS
// -----------------------------------------------------------------------------
function initRecordingsTab() {
  const select = document.getElementById('playback-camera-select');
  select.innerHTML = '<option value="">Select Camera</option>';
  state.cameras.forEach(cam => {
    const opt = document.createElement('option');
    opt.value = cam.id;
    opt.textContent = cam.name;
    select.appendChild(opt);
  });

  const dateInput = document.getElementById('playback-date-select');
  if (!dateInput.value) {
    dateInput.value = new Date().toISOString().split('T')[0];
  }

  loadRecordings();
}

async function loadRecordings() {
  const cameraId = document.getElementById('playback-camera-select')?.value;
  const listEl = document.getElementById('recordings-list');
  if (!listEl) return;

  listEl.innerHTML = '<div class="p-3 text-muted">Loading recorded chunks...</div>';

  try {
    const res = await API.getRecordings({ cameraId, limit: 50 });
    listEl.innerHTML = '';

    if (res.recordings.length === 0) {
      listEl.innerHTML = '<div class="p-4 text-muted text-center">No video recording segments found for this filter.</div>';
      return;
    }

    res.recordings.forEach((rec, idx) => {
      const item = document.createElement('div');
      item.className = `rec-item ${idx === 0 ? 'active' : ''}`;
      const sizeMb = Math.round((rec.file_size / (1024 * 1024)) * 10) / 10;
      const startStr = new Date(rec.start_time).toLocaleTimeString();
      const endStr = new Date(rec.end_time).toLocaleTimeString();

      item.innerHTML = `
        <div>
          <div style="font-weight: 600; font-size: 0.85rem;">${startStr} - ${endStr}</div>
          <div class="text-muted" style="font-size: 0.75rem;">${sizeMb} MB • 5-min Chunk</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="playRecording('${rec.id}', '${startStr}')">Play</button>
      `;

      listEl.appendChild(item);
    });

    if (res.recordings.length > 0) {
      playRecording(res.recordings[0].id, new Date(res.recordings[0].start_time).toLocaleTimeString());
    }
  } catch (err) {
    listEl.innerHTML = `<div class="p-3 text-danger">Error: ${err.message}</div>`;
  }
}

function playRecording(id, label) {
  const video = document.getElementById('playback-video');
  const info = document.getElementById('playback-info-bar');
  if (video) {
    video.src = `/api/v1/recordings/file/${id}`;
    video.play().catch(() => {});
  }
  if (info) {
    info.textContent = `Now Playing: Chunk from ${label} (Direct MP4 Passthrough)`;
  }
}

// -----------------------------------------------------------------------------
// SETTINGS & STORAGE MANAGEMENT
// -----------------------------------------------------------------------------
const POPULAR_CLASSES = [
  'person', 'car', 'motorcycle', 'bicycle', 'bus', 'truck', 'dog', 'cat',
  'cell phone', 'laptop', 'chair', 'backpack', 'handbag', 'bottle', 'cup',
  'knife', 'sports ball', 'couch', 'tv', 'remote', 'book', 'clock'
];

async function loadSettings() {
  try {
    const res = await API.getSettings();
    if (res.success) {
      state.settings = res.settings;
      document.getElementById('input-recording-path').value = res.settings.recording_path || '';
      document.getElementById('input-model-path').value = res.settings.ai_model_path || '';
      document.getElementById('input-disk-threshold').value = res.settings.disk_threshold_percent || 85;

      // Retention & Auto-Delete Settings
      const autoDeleteCheck = document.getElementById('check-auto-delete-enabled');
      if (autoDeleteCheck) {
        autoDeleteCheck.checked = (res.settings.auto_delete_enabled !== 0 && res.settings.auto_delete_enabled !== '0');
      }

      const snapCheck = document.getElementById('check-auto-delete-snapshots');
      if (snapCheck) {
        snapCheck.checked = (res.settings.auto_delete_snapshots !== 0 && res.settings.auto_delete_snapshots !== '0');
      }

      const retentionValInput = document.getElementById('input-retention-val');
      const retentionUnitSelect = document.getElementById('select-retention-unit');
      if (retentionValInput && retentionUnitSelect) {
        const totalHours = Number(res.settings.retention_hours) || (Number(res.settings.retention_days || 7) * 24);
        if (totalHours >= 24 && totalHours % 24 === 0) {
          retentionValInput.value = totalHours / 24;
          retentionUnitSelect.value = 'days';
        } else {
          retentionValInput.value = totalHours;
          retentionUnitSelect.value = 'hours';
        }
        updateRetentionSummaryHint();
        updateAutoDeleteUIState();
      }

      // Load retention telemetry
      loadRetentionTelemetry();

      // AI Settings
      const confPercent = Math.round((Number(res.settings.ai_confidence_threshold) || 0.40) * 100);
      const iouPercent = Math.round((Number(res.settings.ai_iou_threshold) || 0.45) * 100);
      
      const confSlider = document.getElementById('input-ai-confidence');
      if (confSlider) {
        confSlider.value = confPercent;
        updateConfidenceDisplay(confPercent);
      }

      const iouSlider = document.getElementById('input-ai-iou');
      if (iouSlider) {
        iouSlider.value = iouPercent;
        updateIouDisplay(iouPercent);
      }

      const modeSelect = document.getElementById('select-ai-mode');
      if (modeSelect) {
        modeSelect.value = res.settings.ai_continuous_mode !== undefined ? String(res.settings.ai_continuous_mode) : '0';
      }

      const targetClasses = res.settings.ai_target_classes || 'person,car,motorcycle,bicycle,bus,truck,dog,cat,cell phone,laptop,chair,backpack,handbag';
      const classInput = document.getElementById('input-ai-target-classes');
      if (classInput) {
        classInput.value = targetClasses;
      }
      renderClassPicker(targetClasses);

      updateDiskGauge(res.disk);
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

function updateConfidenceDisplay(val) {
  const badge = document.getElementById('val-ai-confidence');
  if (badge) badge.textContent = `${val}%`;
}

function updateIouDisplay(val) {
  const badge = document.getElementById('val-ai-iou');
  if (badge) badge.textContent = `${val}%`;
}

function renderClassPicker(activeClassesString) {
  const container = document.getElementById('class-tags-picker');
  if (!container) return;
  container.innerHTML = '';

  const isAll = (activeClassesString || '').toLowerCase().trim() === 'all';
  const activeSet = new Set(
    (activeClassesString || '')
      .toLowerCase()
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );

  POPULAR_CLASSES.forEach(cls => {
    const pill = document.createElement('div');
    const isActive = isAll || activeSet.has(cls);
    pill.className = `class-tag-pill ${isActive ? 'active' : ''}`;
    pill.textContent = cls.toUpperCase();
    pill.onclick = () => toggleClassPill(cls);
    container.appendChild(pill);
  });
}

function toggleClassPill(cls) {
  const classInput = document.getElementById('input-ai-target-classes');
  let current = (classInput.value || '').toLowerCase().trim();

  let activeList = [];
  if (current === 'all') {
    activeList = [...POPULAR_CLASSES];
  } else {
    activeList = current.split(',').map(s => s.trim()).filter(Boolean);
  }

  const idx = activeList.indexOf(cls);
  if (idx >= 0) {
    activeList.splice(idx, 1);
  } else {
    activeList.push(cls);
  }

  if (activeList.length === 0) {
    activeList = ['person']; // Minimum safeguard
  }

  const newVal = activeList.join(',');
  classInput.value = newVal;
  renderClassPicker(newVal);
}

function applyClassPreset(preset) {
  const classInput = document.getElementById('input-ai-target-classes');
  let target = '';

  if (preset === 'security') {
    target = 'person,car,motorcycle,bicycle,bus,truck,dog,cat';
  } else if (preset === 'devices') {
    target = 'person,cell phone,laptop,chair,backpack,handbag,cup,book';
  } else if (preset === 'all') {
    target = 'all';
  }

  classInput.value = target;
  renderClassPicker(target);
  showToast(`Applied preset: ${preset.toUpperCase()}`, 'info');
}

async function saveAiDetectionSettings(e) {
  e.preventDefault();
  const ai_model_path = document.getElementById('input-model-path').value;
  const confVal = parseInt(document.getElementById('input-ai-confidence').value, 10);
  const iouVal = parseInt(document.getElementById('input-ai-iou').value, 10);
  const ai_continuous_mode = parseInt(document.getElementById('select-ai-mode').value, 10);
  const ai_target_classes = document.getElementById('input-ai-target-classes').value;

  const ai_confidence_threshold = Math.round((confVal / 100) * 100) / 100;
  const ai_iou_threshold = Math.round((iouVal / 100) * 100) / 100;

  try {
    await API.updateSettings({
      ai_model_path,
      ai_confidence_threshold,
      ai_iou_threshold,
      ai_continuous_mode,
      ai_target_classes
    });
    showToast(`AI Detection settings saved & hot-reloaded! (Confidence: ${confVal}%)`, 'success');
  } catch (err) {
    showToast('Failed to save AI settings: ' + err.message, 'error');
  }
}

async function saveModelPathDirect() {
  const ai_model_path = document.getElementById('input-model-path').value;
  try {
    await API.updateSettings({ ai_model_path });
    showToast('ONNX model path updated & worker hot-reloaded', 'success');
  } catch (err) {
    showToast('Failed to update model path: ' + err.message, 'error');
  }
}

function updateDiskGauge(disk) {
  if (!disk) return;
  const usedGb = (disk.usedBytes / (1024 * 1024 * 1024)).toFixed(1);
  const totalGb = (disk.totalBytes / (1024 * 1024 * 1024)).toFixed(1);
  const freeGb = (disk.freeBytes / (1024 * 1024 * 1024)).toFixed(1);

  const diskUsedText = document.getElementById('disk-used-text');
  if (diskUsedText) diskUsedText.textContent = `${usedGb} GB / ${totalGb} GB (${disk.usedPercent}%)`;
  
  // Sidebar Disk Telemetry
  const sbDiskVal = document.getElementById('sb-disk-val');
  const sbDiskBar = document.getElementById('sb-disk-bar');
  if (sbDiskVal) sbDiskVal.textContent = `${disk.usedPercent}%`;
  if (sbDiskBar) {
    sbDiskBar.style.width = `${disk.usedPercent}%`;
    sbDiskBar.style.background = disk.isOverThreshold ? 'var(--accent-danger)' : 'var(--accent-primary)';
  }

  const bar = document.getElementById('disk-progress-bar');
  if (bar) {
    bar.style.width = `${disk.usedPercent}%`;
    if (disk.isOverThreshold) {
      bar.style.background = 'var(--accent-danger)';
    }
  }

  const freeBadge = document.getElementById('disk-free-badge');
  if (freeBadge) freeBadge.textContent = `Free: ${freeGb} GB`;
  const threshBadge = document.getElementById('disk-thresh-badge');
  if (threshBadge) threshBadge.textContent = `Threshold: ${disk.thresholdPercent}%`;
}

async function saveStorageSettings(e) {
  e.preventDefault();
  const recording_path = document.getElementById('input-recording-path').value;
  try {
    const res = await API.updateSettings({ recording_path });
    showToast('Storage recording path updated successfully', 'success');
    updateDiskGauge(res.disk);
  } catch (err) {
    showToast('Failed to update path: ' + err.message, 'error');
  }
}

async function saveModelPathSettings(e) {
  e.preventDefault();
  saveModelPathDirect();
}

// -----------------------------------------------------------------------------
// AUTO-DELETE & RETENTION CONTROLS
// -----------------------------------------------------------------------------
function updateAutoDeleteUIState() {
  const check = document.getElementById('check-auto-delete-enabled');
  const badge = document.getElementById('retention-status-badge');
  const isEnabled = check ? check.checked : true;

  if (badge) {
    if (isEnabled) {
      badge.className = 'badge badge-amber';
      badge.textContent = 'AUTO-DELETE: ACTIVE';
      badge.style.background = 'rgba(245, 158, 11, 0.15)';
      badge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
      badge.style.color = '#fbbf24';
    } else {
      badge.className = 'badge';
      badge.textContent = 'AUTO-DELETE: DISABLED';
      badge.style.background = 'rgba(100, 116, 139, 0.15)';
      badge.style.borderColor = 'rgba(100, 116, 139, 0.4)';
      badge.style.color = '#94a3b8';
    }
  }

  const valInput = document.getElementById('input-retention-val');
  const unitSelect = document.getElementById('select-retention-unit');
  const snapCheck = document.getElementById('check-auto-delete-snapshots');
  if (valInput) valInput.disabled = !isEnabled;
  if (unitSelect) unitSelect.disabled = !isEnabled;
  if (snapCheck) snapCheck.disabled = !isEnabled;
}

function updateRetentionSummaryHint() {
  const valInput = document.getElementById('input-retention-val');
  const unitSelect = document.getElementById('select-retention-unit');
  const hintEl = document.getElementById('retention-summary-hint');
  const hiddenDays = document.getElementById('input-retention-days');

  if (!valInput || !unitSelect || !hintEl) return;

  const rawVal = Math.max(1, parseInt(valInput.value, 10) || 1);
  const unit = unitSelect.value || 'days';
  const totalHours = unit === 'days' ? rawVal * 24 : rawVal;
  const daysEquiv = (totalHours / 24).toFixed(1);

  if (hiddenDays) {
    hiddenDays.value = Math.max(1, Math.round(totalHours / 24));
  }

  if (unit === 'days') {
    hintEl.textContent = `Recordings older than ${rawVal} Day(s) (${totalHours} Hours) will be automatically purged.`;
  } else {
    hintEl.textContent = `Recordings older than ${rawVal} Hour(s) (approx. ${daysEquiv} Days) will be automatically purged.`;
  }
}

function applyRetentionPreset(val, unit) {
  const valInput = document.getElementById('input-retention-val');
  const unitSelect = document.getElementById('select-retention-unit');

  if (valInput) valInput.value = val;
  if (unitSelect) unitSelect.value = unit;

  updateRetentionSummaryHint();
  showToast(`Retention set to ${val} ${unit}`, 'info');
}

async function loadRetentionTelemetry() {
  try {
    const res = await API.getRetentionStatus();
    if (!res.success) return;

    // Oldest recording
    const oldestEl = document.getElementById('retention-oldest-date');
    if (oldestEl) {
      if (res.status.oldest_recording && res.status.oldest_recording.start_time) {
        const oldestDate = new Date(res.status.oldest_recording.start_time);
        const ageHours = Math.round((Date.now() - oldestDate.getTime()) / (3600 * 1000));
        oldestEl.textContent = `${oldestDate.toLocaleDateString()} ${oldestDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${ageHours}h ago)`;
      } else {
        oldestEl.textContent = 'No recordings stored yet';
        oldestEl.className = 'font-mono text-muted';
      }
    }

    // Last purge run
    const lastRunEl = document.getElementById('retention-last-run');
    if (lastRunEl) {
      if (res.status.last_stats && res.status.last_stats.lastRunTime) {
        const lastDate = new Date(res.status.last_stats.lastRunTime);
        const minsAgo = Math.max(0, Math.round((Date.now() - lastDate.getTime()) / 60000));
        lastRunEl.textContent = `${minsAgo} min(s) ago (${res.status.last_stats.lastTrigger.toUpperCase()})`;
      } else {
        lastRunEl.textContent = 'Scheduled on 5-min timer';
      }
    }

    // Last cycle cleaned
    const lastCleanedEl = document.getElementById('retention-last-purged');
    if (lastCleanedEl) {
      if (res.status.last_stats && res.status.last_stats.lastRunTime) {
        const recs = res.status.last_stats.purgedRecordings || 0;
        const snaps = res.status.last_stats.purgedSnapshots || 0;
        const freed = res.status.last_stats.freedHuman || '0 B';
        lastCleanedEl.textContent = `${recs} video(s), ${snaps} snapshot(s) (${freed} freed)`;
      } else {
        lastCleanedEl.textContent = '0 files (0 B)';
      }
    }
  } catch (err) {
    // Non-blocking telemetry load failure
  }
}

async function saveRetentionSettings(e) {
  e.preventDefault();
  const autoDeleteCheck = document.getElementById('check-auto-delete-enabled');
  const auto_delete_enabled = autoDeleteCheck ? (autoDeleteCheck.checked ? 1 : 0) : 1;

  const snapCheck = document.getElementById('check-auto-delete-snapshots');
  const auto_delete_snapshots = snapCheck ? (snapCheck.checked ? 1 : 0) : 1;

  const valInput = document.getElementById('input-retention-val');
  const unitSelect = document.getElementById('select-retention-unit');
  const rawVal = Math.max(1, parseInt(valInput ? valInput.value : '7', 10));
  const unit = unitSelect ? unitSelect.value : 'days';
  const retention_hours = unit === 'days' ? rawVal * 24 : rawVal;
  const retention_days = Math.max(1, Math.round(retention_hours / 24));

  const disk_threshold_percent = parseInt(document.getElementById('input-disk-threshold').value, 10);

  const saveBtn = document.getElementById('btn-save-retention');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }

  try {
    await API.updateSettings({
      auto_delete_enabled,
      retention_hours,
      retention_days,
      auto_delete_snapshots,
      disk_threshold_percent
    });
    showToast('Auto-delete & retention policies saved successfully!', 'success');
    updateAutoDeleteUIState();
    loadRetentionTelemetry();
  } catch (err) {
    showToast('Failed to save retention: ' + err.message, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Retention Policies';
    }
  }
}

async function triggerManualPurge() {
  const btn = document.getElementById('btn-manual-purge');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="text-muted">Purging expired files...</span>';
  }

  try {
    const res = await API.triggerPurge();
    if (res.success) {
      const recs = res.result.purgedByAge + res.result.purgedByDisk;
      const snaps = res.result.purgedSnapshots;
      const freed = res.result.freedHuman || '0 B';
      showToast(`Auto-purge finished: ${recs} video(s) and ${snaps} snapshot(s) deleted (${freed} freed)`, 'success');
      loadRetentionTelemetry();
      if (res.disk) {
        updateDiskDisplay(res.disk);
      }
    } else {
      showToast('Purge failed: ' + (res.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    showToast('Purge request error: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:-2px;margin-right:4px;">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        Purge Expired Now
      `;
    }
  }
}

async function handleModelUpload(input) {
  const file = input.files[0];
  if (!file) return;

  const statusEl = document.getElementById('upload-status');
  statusEl.innerHTML = '<span class="text-muted">Uploading .onnx model & hot-reloading AI worker...</span>';

  try {
    const res = await API.uploadModel(file);
    if (res.success) {
      statusEl.innerHTML = `<span style="color: #34d399;">Model loaded: ${res.fileName} (Worker Hot-Reloaded!)</span>`;
      document.getElementById('input-model-path').value = res.modelPath;
      showToast('Custom ONNX model uploaded and hot-reloaded', 'success');
    }
  } catch (err) {
    statusEl.innerHTML = `<span class="text-danger">Upload failed: ${err.message}</span>`;
  }
}

// -----------------------------------------------------------------------------
// TELEMETRY & HARDWARE METRICS (HG680-P)
// -----------------------------------------------------------------------------
async function pollSystemMetrics() {
  try {
    const res = await API.getSystemMetrics();
    if (res.success) {
      const m = res.metrics;
      state.metrics = m;

      // Sidebar Telemetry Console
      const cpuVal = m.processCpuPercent !== undefined ? m.processCpuPercent : m.cpuUsagePercent;
      const sbCpuVal = document.getElementById('sb-cpu-val');
      const sbCpuBar = document.getElementById('sb-cpu-bar');
      if (sbCpuVal) sbCpuVal.textContent = `${cpuVal}%`;
      if (sbCpuBar) {
        sbCpuBar.style.width = `${Math.min(100, cpuVal)}%`;
        sbCpuBar.style.background = cpuVal > 80 ? 'var(--accent-danger)' : cpuVal > 50 ? 'var(--accent-warning)' : 'var(--accent-primary)';
      }

      const sbRamVal = document.getElementById('sb-ram-val');
      const sbRamBar = document.getElementById('sb-ram-bar');
      if (sbRamVal) sbRamVal.textContent = `${m.processMemory.rssMb} MB`;
      if (sbRamBar) {
        // Assume 1024MB total STB RAM budget target
        const ramPercent = Math.min(100, Math.round((m.processMemory.rssMb / 1024) * 100));
        sbRamBar.style.width = `${ramPercent}%`;
        sbRamBar.style.background = m.processMemory.rssMb > 350 ? 'var(--accent-danger)' : 'var(--accent-purple)';
      }

      // Settings Diagnostics Card
      const diagRss = document.getElementById('diag-rss');
      if (diagRss) {
        diagRss.textContent = `${m.processMemory.rssMb} MB`;
        document.getElementById('diag-heap').textContent = `Heap: ${m.processMemory.heapUsedMb} / ${m.processMemory.heapTotalMb} MB`;
        document.getElementById('diag-sys-ram').textContent = `${m.usedMemMb} / ${m.totalMemMb} MB`;
        document.getElementById('diag-free-ram').textContent = `Free: ${m.freeMemMb} MB`;
        document.getElementById('diag-cpu').textContent = `${cpuVal}%`;
        const diagCores = document.getElementById('diag-cores');
        if (diagCores && m.systemCpuPercent !== undefined) {
          diagCores.textContent = `NVR: ${cpuVal}% • System: ${m.systemCpuPercent}%`;
        }
        document.getElementById('diag-uptime').textContent = `${m.uptimeSeconds}s`;
      }
    }
  } catch (err) {
    // Ignore
  }
}

// -----------------------------------------------------------------------------
// TOAST NOTIFICATIONS
// -----------------------------------------------------------------------------
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3500);
}
