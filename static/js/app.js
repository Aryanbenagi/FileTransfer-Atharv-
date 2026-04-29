/**
 * AirShare – Main Application
 * Wires together gesture engine, file transfer, socket connection, and UI
 * 
 * Features:
 *  - Directional throw (sends to device the hand is moving toward)
 *  - Flying file animation on transfer
 *  - Real-time clipboard sync as you type
 *  - Device glow when receiving
 *  - Download complete toast on receiver
 */

// ─── Globals ─────────────
let socket, gestureEngine, fileTransfer, ui, particles, sounds;
let myDeviceId = null;
let cameraActive = false;
let isHolding = false;
let holdingFileIndex = -1;
let currentIncoming = null;
let dbConnected = false;
let currentDevices = [];
let _clipboardSyncTimer = null;
let currentRoomCode = null;
let _twoHandHolding = false; // left hand fist hold state

// ─── Initialize ─────────────
document.addEventListener('DOMContentLoaded', () => {
  ui = new UIController();
  particles = new ParticleSystem('particle-canvas');
  sounds = new SoundEngine();

  setTimeout(() => {
    document.getElementById('loading-screen').classList.add('fade-out');
    document.getElementById('app').classList.remove('hidden');
    initSocket();
  }, 2400);

  setupEventListeners();

  // Mobile: hide camera panel, show receive-focused UI
  if (/mobile|android|iphone|ipad|tablet/i.test(navigator.userAgent)) {
    document.body.classList.add('mobile-device');
    ui.showMobilePWAMode();
  }
});

// ─── Socket Connection ─────────────
function initSocket() {
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
    dbConnected = data.dbConnected || false;
    updateDbStatus(dbConnected);
    fetchStats();
    setInterval(fetchStats, 5000);
  });

  socket.on('device-list', (data) => {
    currentDevices = data.devices;
    ui.updateDeviceList(data.devices, myDeviceId);
  });

  socket.on('clipboard-receive', (data) => {
    ui.showToast(`📋 Clipboard from ${data.senderName}: ${data.content.substring(0, 50)}...`, 'info');
    navigator.clipboard.writeText(data.content).catch(() => {});
  });

  // Real-time clipboard typing sync
  socket.on('clipboard-typing', (data) => {
    const input = document.getElementById('clipboard-input');
    const clipboardPanel = document.getElementById('air-clipboard');
    // Only update if clipboard panel is visible and user isn't focused on it
    if (clipboardPanel.style.display !== 'none' && document.activeElement !== input) {
      input.value = data.content;
      input.classList.add('clipboard-syncing');
      setTimeout(() => input.classList.remove('clipboard-syncing'), 300);
    }
  });

  // Device receiving glow effect
  socket.on('device-receiving', (data) => {
    ui.setDeviceReceiving(data.deviceId, data.receiving);
  });

  // Room code events
  socket.on('room-joined', (data) => {
    currentRoomCode = data.code;
    ui.setRoomCode(data.code);
    ui.showToast(`🔗 Joined room ${data.code} (${data.members} members)`, 'success');
    sounds.playJoinRoom();
  });

  socket.on('room-device-list', (data) => {
    ui.updateRoomDeviceList(data.devices, myDeviceId);
  });

  // Init file transfer
  fileTransfer = new FileTransfer(socket);

  fileTransfer.onProgress = (id, percent, speed, name, dir) => {
    ui.showProgress(id, percent, speed, name, dir);
  };

  fileTransfer.onComplete = (id, success, name) => {
    if (success) {
      ui.showToast(`✅ "${name}" transfer complete!`, 'success');
      fetchStats();
    } else {
      ui.showToast(`Transfer of "${name}" was rejected`, 'warning');
    }
    ui.hideProgress();
    ui.hideFloatingFile();
  };

  // Download complete toast + sound for receiver
  fileTransfer.onDownloadComplete = (fileName, fileSize) => {
    ui.showDownloadToast(fileName, fileSize);
    sounds.playReceive();
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

  // Folder input
  const btnAddFolder = document.getElementById('btn-add-folder');
  if (btnAddFolder) {
    btnAddFolder.addEventListener('click', () => {
      document.getElementById('folder-input').click();
    });
  }

  const folderInput = document.getElementById('folder-input');
  if (folderInput) {
    folderInput.addEventListener('change', (e) => {
      Array.from(e.target.files).forEach(file => ui.addFileToGrid(file));
      e.target.value = '';
    });
  }

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

  // Real-time clipboard sync as user types
  const clipboardInput = document.getElementById('clipboard-input');
  clipboardInput.addEventListener('input', () => {
    if (_clipboardSyncTimer) clearTimeout(_clipboardSyncTimer);
    _clipboardSyncTimer = setTimeout(() => {
      if (!ui.selectedDevice) return;
      const content = clipboardInput.value;
      socket.emit('clipboard-typing', {
        targetId: ui.selectedDevice,
        content: content
      });
    }, 150); // debounce 150ms
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
    const deviceItems = document.querySelectorAll('.device-item:not(.device-item-self)');
    deviceItems.forEach(item => {
      const deviceId = item.dataset.deviceId;
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
      // Refresh QR
      const qrImg = document.getElementById('qr-code');
      qrImg.src = '/api/qr?' + Date.now();
      qrImg.onerror = () => {
        qrImg.style.display = 'none';
        const fallback = document.getElementById('qr-fallback');
        if (fallback) fallback.style.display = 'block';
      };
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
      ui.showToast(`📥 Receiving "${currentIncoming.fileName}"`, 'info');
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
    ui.showToast('🔍 Scanning for devices...', 'info');
  });

  // Close modal on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  });

  // Room code buttons
  const btnCreateRoom = document.getElementById('btn-create-room');
  if (btnCreateRoom) btnCreateRoom.addEventListener('click', createRoom);
  const btnJoinRoom = document.getElementById('btn-join-room');
  if (btnJoinRoom) btnJoinRoom.addEventListener('click', joinRoom);
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  if (btnLeaveRoom) btnLeaveRoom.addEventListener('click', leaveRoom);
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

    // Two-hand gesture callback
    gestureEngine.onTwoHandGesture = handleTwoHandGesture;

    // Push-away decline gesture callback
    gestureEngine.onPushAway = handlePushAway;

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

function handleGesture(gesture, confidence, position, velocity, throwDirection) {
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
        ui.showFloatingFile(screenX, screenY, file?.name || 'File', file);
        ui.showToast('🤏 File selected!', 'info');
        sounds.playSelect();
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
        
        // Find the device the hand is moving toward
        const throwTarget = gestureEngine.getThrowTargetPosition();
        if (throwTarget) {
          const closestDevice = ui.findClosestDevice(throwTarget.x, throwTarget.y);
          if (closestDevice) {
            // Override selected device with throw target
            ui.selectedDevice = closestDevice;
            // Highlight the target device briefly
            document.querySelectorAll('.device-item').forEach(d => d.classList.remove('selected'));
            const targetItem = document.querySelector(`.device-item[data-device-id="${closestDevice}"]`);
            if (targetItem) targetItem.classList.add('selected');
          }
        }
        
        // Send files with flying animation
        sendSelectedFilesWithAnimation(screenX, screenY);
        ui.hideFloatingFile();
      }
      break;

    case 'open':
      if (isHolding) {
        if (ui.selectedDevice) {
          isHolding = false;
          ui.releaseFiles();
          sendSelectedFilesWithAnimation(screenX, screenY);
          ui.hideFloatingFile();
        } else {
          isHolding = false;
          ui.releaseFiles();
          ui.hideFloatingFile();
          ui.showToast('Select a target device to send files', 'warning');
        }
      }
      break;
  }
}

/** Handle two-hand gestures: left fist holds file, right hand points/throws */
function handleTwoHandGesture(leftGesture, rightGesture, leftPos, rightPos, rightThrowDir) {
  if (!leftPos || !rightPos) return;

  const leftScreenX = (1 - leftPos.x) * window.innerWidth;
  const leftScreenY = leftPos.y * window.innerHeight;

  // Left fist = hold file
  if (leftGesture === 'fist' && !_twoHandHolding && ui.files.length > 0) {
    holdingFileIndex = ui.selectedFiles.length > 0 ? ui.selectedFiles[0] : 0;
    ui.selectFileByGesture(holdingFileIndex);
    _twoHandHolding = true;
    const file = ui.files[holdingFileIndex];
    ui.showFloatingFile(leftScreenX, leftScreenY, file?.name || 'File', file);
    sounds.playSelect();
  } else if (leftGesture === 'fist' && _twoHandHolding) {
    ui.moveFloatingFile(leftScreenX - 20, leftScreenY - 20);
  } else if (leftGesture !== 'fist' && _twoHandHolding) {
    _twoHandHolding = false;
    ui.releaseFiles();
    ui.hideFloatingFile();
  }

  // Right hand throw while left is holding
  if (_twoHandHolding && rightGesture === 'throw') {
    _twoHandHolding = false;
    ui.releaseFiles();
    
    const throwTarget = gestureEngine.getThrowTargetPosition(rightThrowDir);
    if (throwTarget) {
      const closestDevice = ui.findClosestDevice(throwTarget.x, throwTarget.y);
      if (closestDevice) {
        ui.selectedDevice = closestDevice;
        document.querySelectorAll('.device-item').forEach(d => d.classList.remove('selected'));
        const targetItem = document.querySelector(`.device-item[data-device-id="${closestDevice}"]`);
        if (targetItem) targetItem.classList.add('selected');
      }
    }
    sendSelectedFilesWithAnimation(leftScreenX, leftScreenY);
    ui.hideFloatingFile();
  }

  // Right hand point = highlight closest device
  if (rightGesture === 'point' && rightPos) {
    const rightScreenX = (1 - rightPos.x) * window.innerWidth;
    const rightScreenY = rightPos.y * window.innerHeight;
    const closest = ui.findClosestDevice(rightScreenX, rightScreenY);
    if (closest) {
      document.querySelectorAll('.device-item').forEach(d => d.classList.remove('hover-target'));
      const el = document.querySelector(`.device-item[data-device-id="${closest}"]`);
      if (el) el.classList.add('hover-target');
    }
  }
}

/** Push-away gesture handler — declines incoming file transfer */
function handlePushAway() {
  if (currentIncoming) {
    fileTransfer.rejectFile(currentIncoming.senderId, currentIncoming.transferId);
    ui.hideIncomingModal();
    ui.showToast('✋ Declined incoming file', 'warning');
    sounds.playReject();
    currentIncoming = null;
  }
}

function sendSelectedFilesWithAnimation(startX, startY) {
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

  // Show flying animation
  ui.showFileFlyAnimation(startX, startY, ui.selectedDevice, files[0].name);
  sounds.playWhoosh();

  // Send files
  files.forEach(file => {
    fileTransfer.sendFile(file, ui.selectedDevice, 'throw');
  });

  ui.showToast(`📤 Sending ${files.length} file(s) to target...`, 'info');
  ui.selectedFiles = [];
  ui.renderFileGrid();
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

  // Save to storage
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

// ─── Stats & History ─────────────
function updateDbStatus(connected) {
  const dot = document.getElementById('db-dot');
  const text = document.getElementById('db-text');
  if (connected) {
    dot.className = 'status-dot db-connected';
    text.textContent = 'MongoDB';
  } else {
    dot.className = 'status-dot db-disconnected';
    text.textContent = 'Memory Storage';
  }
}

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
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
    if (!data.transfers || data.transfers.length === 0) {
      list.innerHTML = '<div class="device-list-empty"><p>No transfer history yet</p></div>';
      return;
    }
    list.innerHTML = data.transfers.map(t => {
      const icon = t.status === 'completed' ? '✅' : '❌';
      const time = t.timestamp ? new Date(t.timestamp).toLocaleString() : '';
      return `<div class="history-item">
        <span class="history-icon">${icon}</span>
        <div class="history-info">
          <div class="history-filename">${t.fileName || 'Unknown'}</div>
          <div class="history-meta">
            <span>${t.senderName || t.senderId} → ${t.receiverId}</span>
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

// ─── Room Code Functions ─────────────
async function createRoom() {
  try {
    const res = await fetch('/api/room/create', { method: 'POST' });
    const data = await res.json();
    socket.emit('join-room', { code: data.code });
    const codeInput = document.getElementById('room-code-input');
    if (codeInput) codeInput.value = data.code;
  } catch (e) {
    ui.showToast('Failed to create room', 'error');
  }
}

function joinRoom() {
  const codeInput = document.getElementById('room-code-input');
  const code = codeInput ? codeInput.value.trim() : '';
  if (code.length !== 6 || !/^\d{6}$/.test(code)) {
    ui.showToast('Enter a valid 6-digit room code', 'warning');
    return;
  }
  socket.emit('join-room', { code });
}

function leaveRoom() {
  if (currentRoomCode) {
    socket.emit('leave-room', { code: currentRoomCode });
    currentRoomCode = null;
    ui.setRoomCode(null);
    ui.showToast('Left the room', 'info');
  }
}
