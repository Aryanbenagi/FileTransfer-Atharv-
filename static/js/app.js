/**
 * AirShare – Main Application
 * Wires together gesture engine, file transfer, socket connection, and UI
 */

// ─── Globals ─────────────
let socket, gestureEngine, fileTransfer, ui, particles;
let myDeviceId = null;
let cameraActive = false;
let isHolding = false;
let holdingFileIndex = -1;
let currentIncoming = null;
let dbConnected = false;

// ─── Initialize ─────────────
document.addEventListener('DOMContentLoaded', () => {
  ui = new UIController();
  particles = new ParticleSystem('particle-canvas');

  // Loading screen
  setTimeout(() => {
    document.getElementById('loading-screen').classList.add('fade-out');
    document.getElementById('app').classList.remove('hidden');
    initSocket();
  }, 2400);

  setupEventListeners();
});

// ─── Socket Connection ─────────────
function initSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = io(location.origin, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    ui.setConnectionStatus(true);
    ui.showToast('Connected to AirShare server', 'success');

    // Register device
    const savedName = localStorage.getItem('airshare-device-name') || generateDeviceName();
    const savedType = localStorage.getItem('airshare-device-type') || detectDeviceType();
    socket.emit('register', { name: savedName, deviceType: savedType });

    document.getElementById('setting-device-name').value = savedName;
    document.getElementById('setting-device-type').value = savedType;
  });

  socket.on('disconnect', () => {
    ui.setConnectionStatus(false);
    ui.showToast('Disconnected from server', 'error');
  });

  socket.on('welcome', (data) => {
    myDeviceId = data.deviceId;
    document.getElementById('my-device-id').textContent = data.deviceId;
    // MongoDB status
    dbConnected = data.dbConnected || false;
    updateDbStatus(dbConnected);
    // Start stats polling
    fetchStats();
    setInterval(fetchStats, 5000);
  });

  socket.on('device-list', (data) => {
    ui.updateDeviceList(data.devices, myDeviceId);
  });

  socket.on('clipboard-receive', (data) => {
    ui.showToast(`📋 Clipboard from ${data.senderName}: ${data.content.substring(0, 50)}...`, 'info');
    navigator.clipboard.writeText(data.content).catch(() => {});
  });

  // Init file transfer
  fileTransfer = new FileTransfer(socket);

  fileTransfer.onProgress = (id, percent, speed, name, dir) => {
    ui.showProgress(id, percent, speed, name, dir);
  };

  fileTransfer.onComplete = (id, success, name) => {
    if (success) {
      ui.showToast(`\u2705 "${name}" transfer complete!`, 'success');
      ui.showTransferAnimation();
      fetchStats(); // Refresh stats after transfer
    } else {
      ui.showToast(`Transfer of "${name}" was rejected`, 'warning');
    }
    ui.hideProgress();
    ui.hideFloatingFile();
  };

  fileTransfer.onIncoming = (data) => {
    currentIncoming = data;
    const autoAccept = document.getElementById('setting-auto-accept').checked;
    if (autoAccept) {
      fileTransfer.acceptFile(data.senderId, data.transferId);
      ui.showToast(`📥 Receiving "${data.fileName}" from ${data.senderName}`, 'info');
    } else {
      ui.showIncomingModal(data.senderName, data.fileName, data.fileSize);
    }
  };
}

// ─── Event Listeners ─────────────
function setupEventListeners() {
  // Camera toggle
  document.getElementById('btn-toggle-camera').addEventListener('click', toggleCamera);

  // File input
  document.getElementById('btn-add-files').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  document.getElementById('file-input').addEventListener('change', (e) => {
    Array.from(e.target.files).forEach(file => ui.addFileToGrid(file));
    e.target.value = '';
  });

  // Drag and drop
  const dropZone = document.getElementById('file-drop-zone');
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    Array.from(e.dataTransfer.files).forEach(file => ui.addFileToGrid(file));
  });

  // Air Clipboard
  document.getElementById('btn-clipboard').addEventListener('click', () => {
    const el = document.getElementById('air-clipboard');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btn-close-clipboard').addEventListener('click', () => {
    document.getElementById('air-clipboard').style.display = 'none';
  });
  document.getElementById('btn-clipboard-send').addEventListener('click', () => {
    const content = document.getElementById('clipboard-input').value;
    if (!content) return ui.showToast('Clipboard is empty', 'warning');
    if (!ui.selectedDevice) return ui.showToast('Select a device first', 'warning');
    socket.emit('clipboard-share', { targetId: ui.selectedDevice, content, contentType: 'text' });
    ui.showToast('📋 Clipboard sent!', 'success');
    document.getElementById('clipboard-input').value = '';
  });

  // Group Share
  document.getElementById('btn-group-share').addEventListener('click', () => {
    const files = ui.getSelectedFiles();
    if (files.length === 0) return ui.showToast('Select files first', 'warning');
    // Send to all non-self devices
    const deviceItems = document.querySelectorAll('.device-item:not(.device-item-self)');
    deviceItems.forEach(item => {
      const deviceId = item.querySelector('.device-item-id')?.textContent;
      if (deviceId) {
        files.forEach(file => fileTransfer.sendFile(file, deviceId, 'group'));
      }
    });
    ui.showToast(`📤 Sending to all devices!`, 'info');
  });

  // Settings
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'flex';
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'none';
  });
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

  // Connect Devices modal
  document.getElementById('btn-connect').addEventListener('click', async () => {
    document.getElementById('connect-modal').style.display = 'flex';
    try {
      const res = await fetch('/api/connection-info');
      const data = await res.json();
      document.getElementById('connect-url').textContent = data.url;
      // Refresh QR in case IP changed
      document.getElementById('qr-code').src = '/api/qr?' + Date.now();
    } catch (e) {
      document.getElementById('connect-url').textContent = 'Could not detect IP';
    }
  });
  document.getElementById('btn-close-connect').addEventListener('click', () => {
    document.getElementById('connect-modal').style.display = 'none';
  });
  document.getElementById('btn-copy-url').addEventListener('click', () => {
    const url = document.getElementById('connect-url').textContent;
    navigator.clipboard.writeText(url).then(() => {
      ui.showToast('URL copied to clipboard!', 'success');
    }).catch(() => {
      // Fallback: select the text
      const el = document.getElementById('connect-url');
      const range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      ui.showToast('Select and copy the URL manually', 'info');
    });
  });

  // Transfer History
  document.getElementById('btn-history').addEventListener('click', () => {
    document.getElementById('history-modal').style.display = 'flex';
    loadTransferHistory();
  });
  document.getElementById('btn-close-history').addEventListener('click', () => {
    document.getElementById('history-modal').style.display = 'none';
  });
  document.getElementById('btn-clear-history').addEventListener('click', async () => {
    await fetch('/api/transfers/clear', { method: 'POST' });
    loadTransferHistory();
    fetchStats();
    ui.showToast('History cleared', 'success');
  });

  // Incoming file modal
  document.getElementById('btn-accept-file').addEventListener('click', () => {
    if (currentIncoming) {
      fileTransfer.acceptFile(currentIncoming.senderId, currentIncoming.transferId);
      ui.hideIncomingModal();
      ui.showToast(`\ud83d\udce5 Receiving "${currentIncoming.fileName}"`, 'info');
    }
  });
  document.getElementById('btn-reject-file').addEventListener('click', () => {
    if (currentIncoming) {
      fileTransfer.rejectFile(currentIncoming.senderId, currentIncoming.transferId);
      ui.hideIncomingModal();
    }
  });

  // Refresh devices
  document.getElementById('btn-refresh-devices').addEventListener('click', () => {
    ui.showToast('\ud83d\udd0d Scanning for devices...', 'info');
  });

  // Close modal on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  });
}

// ─── Camera & Gestures ─────────────
async function toggleCamera() {
  const btn = document.getElementById('btn-toggle-camera');
  const placeholder = document.getElementById('camera-placeholder');

  if (cameraActive) {
    gestureEngine.stop();
    cameraActive = false;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg> Start Camera`;
    placeholder.style.display = 'flex';
    return;
  }

  try {
    btn.textContent = 'Loading model...';
    btn.disabled = true;
    gestureEngine = new GestureEngine();
    await gestureEngine.init(
      document.getElementById('webcam'),
      document.getElementById('gesture-canvas')
    );
    btn.textContent = 'Starting camera...';
    await gestureEngine.start();
    cameraActive = true;
    placeholder.style.display = 'none';
    btn.disabled = false;
    btn.innerHTML = 'Stop Camera';
    ui.showToast('Camera active - show your hand!', 'success');

    // Gesture callbacks
    gestureEngine.onGesture = handleGesture;

    // FPS update loop
    setInterval(() => {
      if (cameraActive && gestureEngine) {
        ui.updateFps(gestureEngine.fps);
        ui.updateHand(gestureEngine.handedness);
      }
    }, 500);

  } catch (err) {
    console.error('[App] Camera startup failed:', err);
    btn.textContent = 'Start Camera';
    btn.disabled = false;
    ui.showToast('Camera error: ' + err.message, 'error');
  }
}

function handleGesture(gesture, confidence, position, velocity) {
  ui.updateGestureIndicator(gesture, confidence);

  if (!position) {
    if (isHolding) {
      isHolding = false;
      ui.releaseFiles();
      ui.hideFloatingFile();
    }
    return;
  }

  const screenX = (1 - position.x) * window.innerWidth;
  const screenY = position.y * window.innerHeight;

  switch (gesture) {
    case 'pinch':
      if (!isHolding && ui.files.length > 0) {
        // Select nearest file
        holdingFileIndex = ui.selectedFiles.length > 0 ? ui.selectedFiles[0] : 0;
        ui.selectFileByGesture(holdingFileIndex);
        isHolding = true;
        const file = ui.files[holdingFileIndex];
        ui.showFloatingFile(screenX, screenY, file?.name || 'File');
        ui.showToast('🤏 File selected!', 'info');
      } else if (isHolding) {
        ui.moveFloatingFile(screenX - 20, screenY - 20);
      }
      break;

    case 'fist':
      if (isHolding) {
        ui.moveFloatingFile(screenX - 20, screenY - 20);
      }
      break;

    case 'throw':
      if (isHolding) {
        isHolding = false;
        ui.releaseFiles();
        ui.hideFloatingFile();
        sendSelectedFiles();
        ui.showTransferAnimation();
      }
      break;

    case 'open':
      if (isHolding) {
        // Drop / release
        if (ui.selectedDevice) {
          isHolding = false;
          ui.releaseFiles();
          ui.hideFloatingFile();
          sendSelectedFiles();
        } else {
          // Just release without sending
          isHolding = false;
          ui.releaseFiles();
          ui.hideFloatingFile();
          ui.showToast('Select a target device to send files', 'warning');
        }
      }
      break;
  }
}

function sendSelectedFiles() {
  if (!ui.selectedDevice) {
    ui.showToast('⚠️ No device selected! Pick a target device.', 'warning');
    return;
  }

  const files = ui.getSelectedFiles();
  if (files.length === 0) {
    if (holdingFileIndex >= 0 && ui.files[holdingFileIndex]) {
      files.push(ui.files[holdingFileIndex]);
    }
  }

  if (files.length === 0) {
    ui.showToast('No files selected', 'warning');
    return;
  }

  files.forEach(file => {
    fileTransfer.sendFile(file, ui.selectedDevice, 'throw');
  });

  ui.showToast(`📤 Sending ${files.length} file(s)...`, 'info');
  ui.selectedFiles = [];
  ui.renderFileGrid();
}

// ─── Settings ─────────────
function saveSettings() {
  const name = document.getElementById('setting-device-name').value || generateDeviceName();
  const type = document.getElementById('setting-device-type').value;
  const autoAccept = document.getElementById('setting-auto-accept').checked;

  localStorage.setItem('airshare-device-name', name);
  localStorage.setItem('airshare-device-type', type);

  socket.emit('register', { name, deviceType: type });

  // Save to MongoDB
  if (myDeviceId) {
    fetch(`/api/settings/${myDeviceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, deviceType: type, autoAccept })
    }).catch(() => {});
  }

  document.getElementById('settings-modal').style.display = 'none';
  ui.showToast('Settings saved!', 'success');
}

// ─── MongoDB Integration ─────────────
function updateDbStatus(connected) {
  const dot = document.getElementById('db-dot');
  const text = document.getElementById('db-text');
  if (connected) {
    dot.className = 'status-dot db-connected';
    text.textContent = 'MongoDB';
  } else {
    dot.className = 'status-dot db-disconnected';
    text.textContent = 'MongoDB (offline)';
  }
}

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (!data.dbConnected) {
      document.getElementById('stats-bar').style.opacity = '0.4';
      return;
    }
    document.getElementById('stats-bar').style.opacity = '1';
    document.getElementById('stats-transfers').textContent = data.totalTransfers || 0;
    document.getElementById('stats-bytes').textContent = formatSize(data.totalBytes || 0);
    document.getElementById('stats-clips').textContent = data.totalClipboards || 0;
    document.getElementById('stats-devices').textContent = data.totalDevices || 0;
    document.getElementById('stats-active').textContent = data.activeDevices || 0;
  } catch (e) {
    // silently fail
  }
}

async function loadTransferHistory() {
  const list = document.getElementById('history-list');
  try {
    const res = await fetch('/api/transfers');
    const data = await res.json();
    if (!data.dbConnected) {
      list.innerHTML = '<div class="device-list-empty"><p>MongoDB not connected</p></div>';
      return;
    }
    if (!data.transfers || data.transfers.length === 0) {
      list.innerHTML = '<div class="device-list-empty"><p>No transfer history yet</p></div>';
      return;
    }
    list.innerHTML = data.transfers.map(t => {
      const icon = t.status === 'completed' ? '\u2705' : '\u274c';
      const time = t.timestamp ? new Date(t.timestamp).toLocaleString() : '';
      return `<div class="history-item">
        <span class="history-icon">${icon}</span>
        <div class="history-info">
          <div class="history-filename">${t.fileName || 'Unknown'}</div>
          <div class="history-meta">
            <span>${t.senderName || t.senderId} \u2192 ${t.receiverId}</span>
            <span>${formatSize(t.fileSize || 0)}</span>
            <span>${t.gestureType || ''}</span>
          </div>
        </div>
        <span class="history-status ${t.status}">${t.status}</span>
        <span class="history-time">${time}</span>
      </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="device-list-empty"><p>Failed to load history</p></div>';
  }
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ─── Helpers ─────────────
function generateDeviceName() {
  const adj = ['Swift', 'Stellar', 'Cosmic', 'Pixel', 'Neon', 'Cyber', 'Nova', 'Blaze'];
  const noun = ['Fox', 'Hawk', 'Wolf', 'Eagle', 'Phoenix', 'Tiger', 'Falcon', 'Panda'];
  return adj[Math.floor(Math.random() * adj.length)] + ' ' + noun[Math.floor(Math.random() * noun.length)];
}

function detectDeviceType() {
  const ua = navigator.userAgent.toLowerCase();
  if (/mobile|android|iphone/.test(ua)) return 'phone';
  if (/tablet|ipad/.test(ua)) return 'tablet';
  return 'laptop';
}
