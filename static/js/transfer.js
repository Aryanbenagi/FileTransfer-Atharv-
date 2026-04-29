/**
 * AirShare – File Transfer Module v2
 * WebRTC DataChannel for P2P transfers with Socket.IO fallback.
 * Features: resumable transfers, speed tracking, ordered chunk reassembly.
 */
class FileTransfer {
  constructor(socket) {
    this.socket = socket;
    this.chunkSize = 64 * 1024; // 64KB chunks
    this.activeTransfers = new Map();
    this.onProgress = null;
    this.onComplete = null;
    this.onIncoming = null;
    this.onDownloadComplete = null;
    this.receivedChunks = new Map();
    this._ackCallbacks = new Map();
    this._concurrentChunks = 4;
    this._peerConnections = new Map(); // transferId -> RTCPeerConnection
    this._dataChannels = new Map(); // transferId -> RTCDataChannel
    this._webrtcSupported = !!(window.RTCPeerConnection);
    this._iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
    this.setupListeners();
  }

  setupListeners() {
    this.socket.on('file-offer', (data) => {
      if (this.onIncoming) this.onIncoming(data);
    });

    this.socket.on('file-accepted', (data) => {
      const transfer = this.activeTransfers.get(data.transferId);
      if (transfer) {
        if (this._webrtcSupported) {
          this._initWebRTCSender(transfer);
        } else {
          this._sendChunksSocket(transfer, 0);
        }
      }
    });

    this.socket.on('file-rejected', (data) => {
      this._cleanupPeer(data.transferId);
      this.activeTransfers.delete(data.transferId);
      if (this.onComplete) this.onComplete(data.transferId, false, 'Rejected by receiver');
    });

    // Socket.IO fallback chunk handling
    this.socket.on('file-chunk', (data) => this.receiveChunk(data));
    this.socket.on('file-complete', (data) => this.finalizeReceive(data));
    this.socket.on('chunk-ack', (data) => {
      const cb = this._ackCallbacks.get(data.transferId + '-' + data.chunkIndex);
      if (cb) { cb(); this._ackCallbacks.delete(data.transferId + '-' + data.chunkIndex); }
    });

    // WebRTC signaling
    this.socket.on('webrtc-offer', (data) => this._handleWebRTCOffer(data));
    this.socket.on('webrtc-answer', (data) => this._handleWebRTCAnswer(data));
    this.socket.on('webrtc-ice', (data) => this._handleICECandidate(data));

    // Resume transfer
    this.socket.on('resume-transfer', (data) => {
      const transfer = this.activeTransfers.get(data.transferId);
      if (transfer) {
        console.log(`[Transfer] Resuming from chunk ${data.lastChunkIndex}`);
        this._sendChunksSocket(transfer, data.lastChunkIndex + 1);
      }
    });
  }

  // ─── Send File ─────────────
  sendFile(file, targetId, gestureType = 'drag') {
    const transferId = 'tf-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    const transfer = {
      id: transferId, file, targetId, gestureType,
      startTime: Date.now(), bytesSent: 0, lastConfirmedChunk: -1
    };
    this.activeTransfers.set(transferId, transfer);
    this.socket.emit('file-offer', {
      targetId, fileName: file.webkitRelativePath || file.name, fileSize: file.size,
      fileType: file.type, gestureType, transferId
    });
    this.socket.emit('device-receiving', { deviceId: targetId, receiving: true, transferId });
    return transferId;
  }

  acceptFile(senderId, transferId) {
    this.receivedChunks.set(transferId, {
      chunks: new Map(), totalChunks: 0, fileName: '',
      startTime: Date.now(), bytesReceived: 0, lastChunkIndex: -1
    });
    this.socket.emit('file-accept', { senderId, transferId });
  }

  rejectFile(senderId, transferId) {
    this.socket.emit('file-reject', { senderId, transferId });
    this._cleanupPeer(transferId);
  }

  // ─── WebRTC P2P Transfer (Sender) ─────────────
  async _initWebRTCSender(transfer) {
    try {
      const pc = new RTCPeerConnection({ iceServers: this._iceServers });
      this._peerConnections.set(transfer.id, pc);

      const dc = pc.createDataChannel('filetransfer', { ordered: true });
      this._dataChannels.set(transfer.id, dc);

      dc.binaryType = 'arraybuffer';
      dc.onopen = () => {
        console.log('[WebRTC] DataChannel open, sending via P2P');
        this._sendChunksWebRTC(transfer, dc, 0);
      };
      dc.onerror = (e) => {
        console.warn('[WebRTC] DataChannel error, falling back to Socket.IO', e);
        this._cleanupPeer(transfer.id);
        this._sendChunksSocket(transfer, transfer.lastConfirmedChunk + 1);
      };
      dc.onclose = () => console.log('[WebRTC] DataChannel closed');

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          this.socket.emit('webrtc-ice', {
            targetId: transfer.targetId, candidate: e.candidate, transferId: transfer.id
          });
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('webrtc-offer', {
        targetId: transfer.targetId, offer: pc.localDescription, transferId: transfer.id
      });

      // Timeout: if WebRTC doesn't connect in 5s, fall back
      setTimeout(() => {
        if (dc.readyState !== 'open' && this.activeTransfers.has(transfer.id)) {
          console.warn('[WebRTC] Connection timeout, falling back to Socket.IO');
          this._cleanupPeer(transfer.id);
          this._sendChunksSocket(transfer, 0);
        }
      }, 5000);

    } catch (err) {
      console.warn('[WebRTC] Setup failed, using Socket.IO fallback:', err);
      this._sendChunksSocket(transfer, 0);
    }
  }

  // ─── WebRTC P2P Transfer (Receiver) ─────────────
  async _handleWebRTCOffer(data) {
    try {
      const pc = new RTCPeerConnection({ iceServers: this._iceServers });
      this._peerConnections.set(data.transferId, pc);

      pc.ondatachannel = (event) => {
        const dc = event.channel;
        dc.binaryType = 'arraybuffer';
        this._dataChannels.set(data.transferId, dc);

        dc.onmessage = (evt) => {
          if (typeof evt.data === 'string') {
            const msg = JSON.parse(evt.data);
            if (msg.type === 'chunk-meta') {
              // Next message will be the binary chunk data
              dc._pendingMeta = msg;
            } else if (msg.type === 'complete') {
              this.finalizeReceive({ transferId: data.transferId, fileName: msg.fileName, fileSize: msg.fileSize });
            }
          } else {
            // Binary chunk data
            const meta = dc._pendingMeta;
            if (meta) {
              this._receiveWebRTCChunk(data.transferId, meta, evt.data);
              dc._pendingMeta = null;
            }
          }
        };
        dc.onerror = (e) => console.warn('[WebRTC] Receiver channel error:', e);
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          this.socket.emit('webrtc-ice', {
            targetId: data.senderId, candidate: e.candidate, transferId: data.transferId
          });
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('webrtc-answer', {
        targetId: data.senderId, answer: pc.localDescription, transferId: data.transferId
      });
    } catch (err) {
      console.warn('[WebRTC] Receiver setup failed:', err);
    }
  }

  async _handleWebRTCAnswer(data) {
    const pc = this._peerConnections.get(data.transferId);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  }

  async _handleICECandidate(data) {
    const pc = this._peerConnections.get(data.transferId);
    if (pc && data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
      catch (e) { console.warn('[WebRTC] ICE error:', e); }
    }
  }

  // ─── Send chunks via WebRTC DataChannel ─────────────
  async _sendChunksWebRTC(transfer, dc, startChunk) {
    const file = transfer.file;
    const totalChunks = Math.ceil(file.size / this.chunkSize);
    let chunkIndex = startChunk;

    while (chunkIndex < totalChunks && dc.readyState === 'open') {
      const offset = chunkIndex * this.chunkSize;
      const end = Math.min(offset + this.chunkSize, file.size);
      const buffer = await this._readChunk(file, offset, end);

      // Send metadata first, then binary
      dc.send(JSON.stringify({
        type: 'chunk-meta', chunkIndex, totalChunks, fileName: file.webkitRelativePath || file.name
      }));

      // Wait for buffer to drain if needed
      while (dc.bufferedAmount > 1024 * 1024) {
        await new Promise(r => setTimeout(r, 10));
      }
      dc.send(buffer);

      transfer.lastConfirmedChunk = chunkIndex;
      transfer.bytesSent = end;
      chunkIndex++;

      const progress = Math.round((chunkIndex / totalChunks) * 100);
      const elapsed = (Date.now() - transfer.startTime) / 1000;
      const speed = elapsed > 0 ? end / elapsed : 0;
      if (this.onProgress) this.onProgress(transfer.id, progress, speed, file.name, 'sending');

      // Yield every 8 chunks
      if (chunkIndex % 8 === 0) await new Promise(r => setTimeout(r, 1));
    }

    if (dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'complete', fileName: file.webkitRelativePath || file.name, fileSize: file.size }));
      this.socket.emit('file-complete', {
        transferId: transfer.id, targetId: transfer.targetId,
        fileName: file.webkitRelativePath || file.name, fileSize: file.size, gestureType: transfer.gestureType
      });
      this.socket.emit('device-receiving', { deviceId: transfer.targetId, receiving: false, transferId: transfer.id });
      this.activeTransfers.delete(transfer.id);
      if (this.onComplete) this.onComplete(transfer.id, true, file.name);
      this._cleanupPeer(transfer.id);
    }
  }

  _receiveWebRTCChunk(transferId, meta, buffer) {
    let recv = this.receivedChunks.get(transferId);
    if (!recv) {
      recv = { chunks: new Map(), totalChunks: meta.totalChunks, fileName: meta.fileName, startTime: Date.now(), bytesReceived: 0, lastChunkIndex: -1 };
      this.receivedChunks.set(transferId, recv);
    }
    recv.chunks.set(meta.chunkIndex, buffer); // Store raw ArrayBuffer
    recv.totalChunks = meta.totalChunks;
    recv.fileName = meta.fileName;
    recv.bytesReceived += buffer.byteLength;
    recv.lastChunkIndex = Math.max(recv.lastChunkIndex, meta.chunkIndex);

    const progress = Math.round((recv.chunks.size / recv.totalChunks) * 100);
    const elapsed = (Date.now() - recv.startTime) / 1000;
    const speed = elapsed > 0 ? recv.bytesReceived / elapsed : 0;
    if (this.onProgress) this.onProgress(transferId, progress, speed, meta.fileName, 'receiving');
  }

  // ─── Send chunks via Socket.IO (fallback) ─────────────
  async _sendChunksSocket(transfer, startChunk) {
    const file = transfer.file;
    const totalChunks = Math.ceil(file.size / this.chunkSize);
    let chunkIndex = startChunk;

    while (chunkIndex < totalChunks) {
      const offset = chunkIndex * this.chunkSize;
      const end = Math.min(offset + this.chunkSize, file.size);
      try {
        const buffer = await this._readChunk(file, offset, end);
        const base64 = this._ab2b64(buffer);
        this.socket.emit('file-chunk', {
          transferId: transfer.id, targetId: transfer.targetId,
          chunk: base64, chunkIndex, totalChunks, fileName: file.webkitRelativePath || file.name
        });
      } catch (err) {
        console.error('[Transfer] Chunk error at', chunkIndex, err);
        try {
          const buffer = await this._readChunk(file, offset, end);
          this.socket.emit('file-chunk', {
            transferId: transfer.id, targetId: transfer.targetId,
            chunk: this._ab2b64(buffer), chunkIndex, totalChunks, fileName: file.webkitRelativePath || file.name
          });
        } catch (e2) {
          if (this.onComplete) this.onComplete(transfer.id, false, 'Transfer failed');
          return;
        }
      }

      transfer.lastConfirmedChunk = chunkIndex;
      transfer.bytesSent = end;
      chunkIndex++;

      const progress = Math.round((chunkIndex / totalChunks) * 100);
      const elapsed = (Date.now() - transfer.startTime) / 1000;
      const speed = elapsed > 0 ? end / elapsed : 0;
      if (this.onProgress) this.onProgress(transfer.id, progress, speed, file.name, 'sending');

      if (chunkIndex % this._concurrentChunks === 0) {
        await new Promise(r => setTimeout(r, 15));
      } else {
        await new Promise(r => setTimeout(r, 2));
      }
    }

    this.socket.emit('file-complete', {
      transferId: transfer.id, targetId: transfer.targetId,
      fileName: file.webkitRelativePath || file.name, fileSize: file.size, gestureType: transfer.gestureType
    });
    this.socket.emit('device-receiving', { deviceId: transfer.targetId, receiving: false, transferId: transfer.id });
    this.activeTransfers.delete(transfer.id);
    if (this.onComplete) this.onComplete(transfer.id, true, file.name);
  }

  // ─── Receive Socket.IO chunk ─────────────
  receiveChunk(data) {
    let recv = this.receivedChunks.get(data.transferId);
    if (!recv) {
      recv = { chunks: new Map(), totalChunks: data.totalChunks, fileName: data.fileName, startTime: Date.now(), bytesReceived: 0, lastChunkIndex: -1 };
      this.receivedChunks.set(data.transferId, recv);
    }
    recv.chunks.set(data.chunkIndex, data.chunk);
    recv.totalChunks = data.totalChunks;
    recv.fileName = data.fileName;
    recv.lastChunkIndex = Math.max(recv.lastChunkIndex, data.chunkIndex);
    const estimatedSize = data.chunk ? (data.chunk.length * 3 / 4) : 0;
    recv.bytesReceived += estimatedSize;
    const progress = Math.round((recv.chunks.size / recv.totalChunks) * 100);
    const elapsed = (Date.now() - recv.startTime) / 1000;
    const speed = elapsed > 0 ? recv.bytesReceived / elapsed : 0;
    if (this.onProgress) this.onProgress(data.transferId, progress, speed, data.fileName, 'receiving');
  }

  // ─── Finalize ─────────────
  finalizeReceive(data) {
    const recv = this.receivedChunks.get(data.transferId);
    if (!recv) return;

    const buffers = [];
    for (let i = 0; i < recv.totalChunks; i++) {
      const chunk = recv.chunks.get(i);
      if (chunk) {
        if (chunk instanceof ArrayBuffer) {
          buffers.push(chunk); // WebRTC raw buffer
        } else {
          buffers.push(this._b642ab(chunk)); // Socket.IO base64
        }
      } else {
        console.warn(`[Transfer] Chunk ${i} missing`);
        buffers.push(new ArrayBuffer(0));
      }
    }

    const blob = new Blob(buffers);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = recv.fileName || data.fileName || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    this.receivedChunks.delete(data.transferId);
    this._cleanupPeer(data.transferId);
    const fileName = recv.fileName || data.fileName;
    if (this.onComplete) this.onComplete(data.transferId, true, fileName);
    if (this.onDownloadComplete) this.onDownloadComplete(fileName, data.fileSize || 0);
  }

  /** Request resume from receiver side */
  requestResume(transferId, senderId) {
    const recv = this.receivedChunks.get(transferId);
    const lastChunk = recv ? recv.lastChunkIndex : -1;
    this.socket.emit('resume-transfer', { transferId, senderId, lastChunkIndex: lastChunk });
  }

  // ─── Helpers ─────────────
  _readChunk(file, start, end) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error('File read error'));
      reader.readAsArrayBuffer(file.slice(start, end));
    });
  }

  _ab2b64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    return btoa(binary);
  }

  _b642ab(base64) {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    } catch (e) { return new ArrayBuffer(0); }
  }

  _cleanupPeer(transferId) {
    const dc = this._dataChannels.get(transferId);
    if (dc) { try { dc.close(); } catch(e){} this._dataChannels.delete(transferId); }
    const pc = this._peerConnections.get(transferId);
    if (pc) { try { pc.close(); } catch(e){} this._peerConnections.delete(transferId); }
  }
}
