/**
 * AirShare – UI Controller
 * Manages all UI interactions, toasts, and visual feedback
 */
class UIController {
  constructor() {
    this.selectedFiles = [];
    this.selectedDevice = null;
    this.files = [];
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

      // List item
      const item = document.createElement('div');
      item.className = `device-item${isSelf ? ' device-item-self' : ''}${device.id === this.selectedDevice ? ' selected' : ''}`;
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

      // Radar dot
      if (!isSelf) {
        const r = 55 + Math.random() * 20;
        const x = 90 + r * Math.cos(angle) - 6;
        const y = 90 + r * Math.sin(angle) - 6;
        angle += angleStep;

        const dot = document.createElement('div');
        dot.className = 'radar-dot';
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
        <div class="file-card-name" title="${file.name}">${file.name}</div>
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
    document.getElementById('progress-speed').textContent = speed > 0 ? this.formatSize(speed) + '/s' : '';
    document.getElementById('progress-eta').textContent = percent < 100 ? 'Transferring...' : 'Complete!';
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

  // ─── Floating File Visual ─────────────
  showFloatingFile(x, y, fileName) {
    const el = document.getElementById('floating-file');
    el.style.display = 'flex';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    document.getElementById('floating-file-name').textContent = fileName;
  }

  hideFloatingFile() {
    document.getElementById('floating-file').style.display = 'none';
  }

  moveFloatingFile(x, y) {
    const el = document.getElementById('floating-file');
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  // ─── Transfer Animation ─────────────
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

  // ─── Helpers ─────────────
  formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}
