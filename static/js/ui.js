/**
 * AirShare – UI Controller
 * Manages all UI interactions, toasts, visual feedback,
 * file flying animation, device glow effects, and mobile responsive receive UI
 */
class UIController {
  constructor() {
    this.selectedFiles = [];
    this.selectedDevice = null;
    this.files = [];
    this._devicePositions = new Map();
    this._receivingDevices = new Set();
    this._isMobile = /mobile|android|iphone|ipad|tablet/i.test(navigator.userAgent);
    this._thumbnailCache = new Map(); // file index -> dataURL
    this._currentRoom = null;
  }

  // ─── Toast Notifications ─────────────
  showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ─── Connection Status ─────────────
  setConnectionStatus(connected) {
    const el = document.getElementById('connection-status');
    const dot = el.querySelector('.status-dot');
    const text = el.querySelector('.status-text');
    if (connected) {
      dot.classList.add('connected');
      text.textContent = 'Connected';
    } else {
      dot.classList.remove('connected');
      text.textContent = 'Disconnected';
    }
  }

  // ─── Device List ─────────────
  updateDeviceList(devices, myId) {
    const list = document.getElementById('device-list');
    const radar = document.getElementById('device-radar');

    // Clear old radar dots
    radar.querySelectorAll('.radar-dot').forEach(d => d.remove());

    if (devices.length <= 1) {
      list.innerHTML = `<div class="device-list-empty">
        <p>No other devices found</p>
        <p class="hint">Open AirShare on another device on the same network</p>
      </div>`;
      return;
    }

    list.innerHTML = '';
    const typeIcons = { laptop: '💻', desktop: '🖥️', phone: '📱', tablet: '📋', unknown: '🔷' };
    let angle = 0;
    const angleStep = (2 * Math.PI) / (devices.length - 1 || 1);

    devices.forEach((device, i) => {
      const isSelf = device.id === myId;
      const icon = typeIcons[device.type] || '🔷';
      const isReceiving = this._receivingDevices.has(device.id);

      // List item
      const item = document.createElement('div');
      item.className = `device-item${isSelf ? ' device-item-self' : ''}${device.id === this.selectedDevice ? ' selected' : ''}${isReceiving ? ' device-receiving' : ''}`;
      item.dataset.deviceId = device.id;
      item.innerHTML = `
        <span class="device-item-icon">${icon}</span>
        <div class="device-item-info">
          <div class="device-item-name">${device.name}</div>
          <div class="device-item-id">${device.id}</div>
        </div>
        <div class="device-item-status"></div>
      `;
      if (!isSelf) {
        item.addEventListener('click', () => {
          this.selectedDevice = device.id;
          document.querySelectorAll('.device-item').forEach(d => d.classList.remove('selected'));
          item.classList.add('selected');
          document.getElementById('btn-group-share').disabled = false;
        });
      }
      list.appendChild(item);

      // Store position for throw targeting
      requestAnimationFrame(() => {
        const rect = item.getBoundingClientRect();
        this._devicePositions.set(device.id, {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          id: device.id,
          isSelf: isSelf
        });
      });

      // Radar dot
      if (!isSelf) {
        const r = 55 + Math.random() * 20;
        const x = 90 + r * Math.cos(angle) - 6;
        const y = 90 + r * Math.sin(angle) - 6;
        angle += angleStep;

        const dot = document.createElement('div');
        dot.className = `radar-dot${isReceiving ? ' radar-dot-receiving' : ''}`;
        dot.style.left = x + 'px';
        dot.style.top = y + 'px';
        dot.innerHTML = `<span class="radar-dot-label">${device.name}</span>`;
        dot.addEventListener('click', () => {
          this.selectedDevice = device.id;
          this.updateDeviceList(devices, myId);
        });
        radar.appendChild(dot);
      }
    });
  }

  /**
   * Find the closest device to a screen position (for directional throw).
   * Returns the device ID of the nearest non-self device, or null.
   */
  findClosestDevice(screenX, screenY) {
    let closest = null;
    let closestDist = Infinity;

    this._devicePositions.forEach((pos) => {
      if (pos.isSelf) return;
      const dx = screenX - pos.x;
      const dy = screenY - pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        closest = pos.id;
      }
    });

    return closest;
  }

  /**
   * Mark a device as receiving (add glow effect)
   */
  setDeviceReceiving(deviceId, receiving) {
    if (receiving) {
      this._receivingDevices.add(deviceId);
    } else {
      this._receivingDevices.delete(deviceId);
    }
    // Update DOM
    const items = document.querySelectorAll('.device-item');
    items.forEach(item => {
      if (item.dataset.deviceId === deviceId) {
        item.classList.toggle('device-receiving', receiving);
      }
    });
    // Update radar dots
    const dots = document.querySelectorAll('.radar-dot');
    // Radar dots don't have device IDs readily, so we re-render via the list
  }

  // ─── File Grid ─────────────
  addFileToGrid(file) {
    this.files.push(file);
    this.renderFileGrid();
  }

  renderFileGrid() {
    const grid = document.getElementById('file-grid');
    const empty = document.getElementById('drop-zone-empty');

    if (this.files.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'flex';
      return;
    }

    empty.style.display = 'none';
    grid.innerHTML = '';

    const icons = {
      'image': '🖼️', 'video': '🎬', 'audio': '🎵',
      'application/pdf': '📕', 'text': '📝',
      'application/zip': '📦', 'default': '📄'
    };

    this.files.forEach((file, i) => {
      let icon = icons.default;
      for (const [key, val] of Object.entries(icons)) {
        if (file.type.startsWith(key) || file.type === key) { icon = val; break; }
      }

      const card = document.createElement('div');
      card.className = `file-card${this.selectedFiles.includes(i) ? ' selected' : ''}`;
      card.dataset.index = i;
      card.innerHTML = `
        <div class="file-card-check">✓</div>
        <div class="file-card-icon">${icon}</div>
        <div class="file-card-name" title="${file.webkitRelativePath || file.name}">${file.webkitRelativePath || file.name}</div>
        <div class="file-card-size">${this.formatSize(file.size)}</div>
      `;
      card.addEventListener('click', () => this.toggleFileSelect(i));
      grid.appendChild(card);
    });
  }

  toggleFileSelect(index) {
    const pos = this.selectedFiles.indexOf(index);
    if (pos > -1) {
      this.selectedFiles.splice(pos, 1);
    } else {
      this.selectedFiles.push(index);
    }
    this.renderFileGrid();
  }

  selectFileByGesture(index) {
    if (!this.selectedFiles.includes(index)) {
      this.selectedFiles.push(index);
    }
    this.renderFileGrid();
    // Add float animation
    const cards = document.querySelectorAll('.file-card');
    if (cards[index]) cards[index].classList.add('gesture-held');
  }

  releaseFiles() {
    document.querySelectorAll('.file-card').forEach(c => c.classList.remove('gesture-held'));
  }

  getSelectedFiles() {
    return this.selectedFiles.map(i => this.files[i]).filter(Boolean);
  }

  // ─── Transfer Progress ─────────────
  showProgress(transferId, percent, speed, fileName, direction) {
    const el = document.getElementById('transfer-progress');
    el.style.display = 'block';
    document.getElementById('progress-title').textContent = `${direction === 'sending' ? '📤 Sending' : '📥 Receiving'}: ${fileName}`;
    document.getElementById('progress-percent').textContent = percent + '%';
    document.getElementById('progress-bar-fill').style.width = percent + '%';
    
    // Speed in MB/s
    if (speed > 0) {
      const mbSpeed = (speed / (1024 * 1024)).toFixed(2);
      document.getElementById('progress-speed').textContent = mbSpeed + ' MB/s';
    } else {
      document.getElementById('progress-speed').textContent = '';
    }
    
    // ETA calculation
    if (percent < 100 && speed > 0 && percent > 0) {
      // Rough ETA based on current speed
      document.getElementById('progress-eta').textContent = 'Transferring...';
    } else if (percent >= 100) {
      document.getElementById('progress-eta').textContent = 'Complete!';
    } else {
      document.getElementById('progress-eta').textContent = 'Starting...';
    }
  }

  hideProgress() {
    setTimeout(() => {
      document.getElementById('transfer-progress').style.display = 'none';
    }, 2000);
  }

  // ─── Gesture Indicator ─────────────
  updateGestureIndicator(gesture, confidence) {
    const el = document.getElementById('gesture-indicator');
    const iconEl = document.getElementById('gesture-icon');
    const labelEl = document.getElementById('gesture-label');

    const gestureMap = {
      'pinch': { icon: '🤏', label: 'Pinch – Select' },
      'fist': { icon: '✊', label: 'Fist – Hold' },
      'open': { icon: '✋', label: 'Open Hand' },
      'throw': { icon: '🫳', label: 'Throw – Send!' },
      'point': { icon: '👆', label: 'Pointing' },
      'peace': { icon: '✌️', label: 'Peace' },
      'none': { icon: '—', label: 'No Hand' }
    };

    const info = gestureMap[gesture] || gestureMap.none;
    iconEl.textContent = info.icon;
    labelEl.textContent = info.label;
    el.classList.toggle('visible', gesture !== 'none');

    // Update stats
    document.getElementById('stat-gesture').textContent = gesture || 'None';
    document.getElementById('stat-confidence').textContent = confidence + '%';
  }

  updateFps(fps) {
    document.getElementById('stat-fps').textContent = fps;
  }

  updateHand(hand) {
    document.getElementById('stat-hand').textContent = hand;
  }

  // ─── Floating File Visual (with thumbnail preview) ─────────────
  showFloatingFile(x, y, fileName, file) {
    const el = document.getElementById('floating-file');
    el.style.display = 'flex';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    document.getElementById('floating-file-name').textContent = fileName;

    // Generate thumbnail if image
    const iconEl = document.getElementById('floating-file-icon');
    if (file && file.type && file.type.startsWith('image/')) {
      const fileIdx = this.files.indexOf(file);
      if (this._thumbnailCache.has(fileIdx)) {
        iconEl.innerHTML = `<img src="${this._thumbnailCache.get(fileIdx)}" class="floating-thumb">`;
      } else {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const maxSize = 48;
            const scale = Math.min(maxSize / img.width, maxSize / img.height);
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            const dataURL = canvas.toDataURL('image/jpeg', 0.7);
            if (fileIdx >= 0) this._thumbnailCache.set(fileIdx, dataURL);
            iconEl.innerHTML = `<img src="${dataURL}" class="floating-thumb">`;
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      }
    } else {
      const icons = { 'video': '🎬', 'audio': '🎵', 'application/pdf': '📕', 'text': '📝', 'application/zip': '📦' };
      let icon = '📄';
      if (file && file.type) {
        for (const [k, v] of Object.entries(icons)) {
          if (file.type.startsWith(k) || file.type === k) { icon = v; break; }
        }
      }
      iconEl.textContent = icon;
    }
  }

  hideFloatingFile() {
    document.getElementById('floating-file').style.display = 'none';
  }

  moveFloatingFile(x, y) {
    const el = document.getElementById('floating-file');
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  // ─── Flying File Animation ─────────────
  /**
   * Show a file icon flying from a start position to a target position.
   * Creates a real animated file flying through the air.
   */
  showFileFlyAnimation(startX, startY, targetDeviceId, fileName) {
    const targetPos = this._devicePositions.get(targetDeviceId);
    let endX, endY;
    
    if (targetPos) {
      endX = targetPos.x;
      endY = targetPos.y;
    } else {
      // Fallback: fly toward right side of screen
      endX = window.innerWidth - 100;
      endY = window.innerHeight / 2;
    }

    // Create flying file element
    const flyer = document.createElement('div');
    flyer.className = 'flying-file';
    flyer.innerHTML = `
      <div class="flying-file-icon">📄</div>
      <div class="flying-file-trail"></div>
      <div class="flying-file-glow"></div>
    `;
    flyer.style.left = startX + 'px';
    flyer.style.top = startY + 'px';
    document.body.appendChild(flyer);

    // Create particle trail
    const trailCount = 12;
    for (let i = 0; i < trailCount; i++) {
      setTimeout(() => {
        const particle = document.createElement('div');
        particle.className = 'fly-particle';
        const progress = i / trailCount;
        const px = startX + (endX - startX) * progress + (Math.random() - 0.5) * 30;
        const py = startY + (endY - startY) * progress - Math.sin(progress * Math.PI) * 80 + (Math.random() - 0.5) * 20;
        particle.style.left = px + 'px';
        particle.style.top = py + 'px';
        document.body.appendChild(particle);
        setTimeout(() => particle.remove(), 600);
      }, i * 50);
    }

    // Animate the flyer along a curved path
    const duration = 800;
    const startTime = performance.now();

    const animate = (now) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      
      // Ease out cubic
      const ease = 1 - Math.pow(1 - t, 3);
      
      // Arc trajectory (bezier-like curve)
      const midX = (startX + endX) / 2;
      const midY = Math.min(startY, endY) - 120; // arc above
      
      const cx = (1-ease)*(1-ease)*startX + 2*(1-ease)*ease*midX + ease*ease*endX;
      const cy = (1-ease)*(1-ease)*startY + 2*(1-ease)*ease*midY + ease*ease*endY;
      
      flyer.style.left = cx + 'px';
      flyer.style.top = cy + 'px';
      flyer.style.transform = `scale(${1 - t * 0.3}) rotate(${t * 360}deg)`;
      flyer.style.opacity = 1 - t * 0.5;

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        // Impact effect at destination
        const impact = document.createElement('div');
        impact.className = 'fly-impact';
        impact.style.left = endX + 'px';
        impact.style.top = endY + 'px';
        document.body.appendChild(impact);
        setTimeout(() => impact.remove(), 600);
        flyer.remove();
      }
    };

    requestAnimationFrame(animate);
  }

  // ─── Transfer Animation (simple beam fallback) ─────────────
  showTransferAnimation() {
    const el = document.getElementById('transfer-animation');
    el.style.display = 'flex';
    setTimeout(() => { el.style.display = 'none'; }, 1000);
  }

  // ─── Incoming File Modal ─────────────
  showIncomingModal(senderName, fileName, fileSize) {
    const el = document.getElementById('incoming-modal');
    document.getElementById('incoming-from').textContent = `From: ${senderName}`;
    document.getElementById('incoming-file-name').textContent = fileName;
    document.getElementById('incoming-file-size').textContent = this.formatSize(fileSize);
    el.style.display = 'flex';
  }

  hideIncomingModal() {
    document.getElementById('incoming-modal').style.display = 'none';
  }

  // ─── Download Complete Toast ─────────────
  showDownloadToast(fileName, fileSize) {
    const sizeStr = fileSize > 0 ? ` (${this.formatSize(fileSize)})` : '';
    this.showToast(`📥 Download complete: "${fileName}"${sizeStr}`, 'success', 5000);
  }

  // ─── Room Code UI ─────────────
  setRoomCode(code) {
    this._currentRoom = code;
    const badge = document.getElementById('room-badge');
    if (badge) {
      badge.style.display = code ? 'flex' : 'none';
      const codeEl = document.getElementById('room-code-display');
      if (codeEl) codeEl.textContent = code || '';
    }
  }

  updateRoomDeviceList(devices, myId) {
    // Merge room devices into main list
    this.updateDeviceList(devices, myId);
  }

  // ─── Mobile PWA Receive Mode ─────────────
  showMobilePWAMode() {
    if (!this._isMobile) return;
    // Add large receive-focused styles
    document.body.classList.add('pwa-receive-mode');
    // Ensure the incoming modal is big and friendly on mobile
    const style = document.createElement('style');
    style.textContent = `
      .pwa-receive-mode .incoming-modal {
        width: 95vw !important;
        max-width: 400px !important;
        padding: 40px 24px !important;
      }
      .pwa-receive-mode .incoming-modal h2 {
        font-size: 28px !important;
      }
      .pwa-receive-mode .incoming-modal .incoming-file-name {
        font-size: 20px !important;
      }
      .pwa-receive-mode #btn-accept-file {
        font-size: 18px !important;
        padding: 14px 40px !important;
        min-width: 160px;
      }
      .pwa-receive-mode #btn-reject-file {
        font-size: 16px !important;
        padding: 12px 32px !important;
      }
      .pwa-receive-mode .toast {
        font-size: 16px !important;
        padding: 14px 20px !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Helpers ─────────────
  formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}
