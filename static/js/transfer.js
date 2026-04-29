/**
 * AirShare – File Transfer Module
 * Handles chunked file transfer via SocketIO
 */
class FileTransfer {
  constructor(socket) {
    this.socket = socket;
    this.chunkSize = 64 * 1024; // 64KB chunks
    this.activeTransfers = new Map();
    this.onProgress = null;
    this.onComplete = null;
    this.onIncoming = null;
    this.receivedChunks = new Map();
    this.setupListeners();
  }

  setupListeners() {
    this.socket.on('file-offer', (data) => {
      if (this.onIncoming) this.onIncoming(data);
    });

    this.socket.on('file-accepted', (data) => {
      const transfer = this.activeTransfers.get(data.transferId);
      if (transfer) this.sendChunks(transfer);
    });

    this.socket.on('file-rejected', (data) => {
      this.activeTransfers.delete(data.transferId);
      if (this.onComplete) this.onComplete(data.transferId, false, 'Rejected by receiver');
    });

    this.socket.on('file-chunk', (data) => {
      this.receiveChunk(data);
    });

    this.socket.on('file-complete', (data) => {
      this.finalizeReceive(data);
    });
  }

  /**
   * Initiate sending a file to a target device
   */
  sendFile(file, targetId, gestureType = 'drag') {
    const transferId = 'tf-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    const transfer = {
      id: transferId,
      file: file,
      targetId: targetId,
      gestureType: gestureType,
      startTime: Date.now()
    };
    this.activeTransfers.set(transferId, transfer);

    this.socket.emit('file-offer', {
      targetId: targetId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      gestureType: gestureType,
      transferId: transferId
    });

    return transferId;
  }

  /**
   * Accept an incoming file transfer
   */
  acceptFile(senderId, transferId) {
    this.receivedChunks.set(transferId, { chunks: [], totalChunks: 0, fileName: '' });
    this.socket.emit('file-accept', { senderId, transferId });
  }

  /**
   * Reject an incoming file transfer
   */
  rejectFile(senderId, transferId) {
    this.socket.emit('file-reject', { senderId, transferId });
  }

  /**
   * Send file in chunks
   */
  async sendChunks(transfer) {
    const file = transfer.file;
    const totalChunks = Math.ceil(file.size / this.chunkSize);
    let offset = 0;
    let chunkIndex = 0;

    const readChunk = (start, end) => {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsArrayBuffer(file.slice(start, end));
      });
    };

    while (offset < file.size) {
      const end = Math.min(offset + this.chunkSize, file.size);
      const buffer = await readChunk(offset, end);
      const base64 = this.arrayBufferToBase64(buffer);

      this.socket.emit('file-chunk', {
        transferId: transfer.id,
        targetId: transfer.targetId,
        chunk: base64,
        chunkIndex: chunkIndex,
        totalChunks: totalChunks,
        fileName: file.name
      });

      chunkIndex++;
      offset = end;

      const progress = Math.round((chunkIndex / totalChunks) * 100);
      const elapsed = (Date.now() - transfer.startTime) / 1000;
      const speed = offset / elapsed;

      if (this.onProgress) {
        this.onProgress(transfer.id, progress, speed, file.name, 'sending');
      }

      // Small delay to prevent overwhelming
      await new Promise(r => setTimeout(r, 10));
    }

    this.socket.emit('file-complete', {
      transferId: transfer.id,
      targetId: transfer.targetId,
      fileName: file.name
    });

    this.activeTransfers.delete(transfer.id);
    if (this.onComplete) this.onComplete(transfer.id, true, file.name);
  }

  /**
   * Receive a file chunk
   */
  receiveChunk(data) {
    let recv = this.receivedChunks.get(data.transferId);
    if (!recv) {
      recv = { chunks: [], totalChunks: data.totalChunks, fileName: data.fileName };
      this.receivedChunks.set(data.transferId, recv);
    }

    recv.chunks[data.chunkIndex] = data.chunk;
    recv.totalChunks = data.totalChunks;
    recv.fileName = data.fileName;

    const received = recv.chunks.filter(Boolean).length;
    const progress = Math.round((received / recv.totalChunks) * 100);

    if (this.onProgress) {
      this.onProgress(data.transferId, progress, 0, data.fileName, 'receiving');
    }
  }

  /**
   * Finalize received file and trigger download
   */
  finalizeReceive(data) {
    const recv = this.receivedChunks.get(data.transferId);
    if (!recv) return;

    // Combine chunks
    const buffers = recv.chunks.map(b64 => this.base64ToArrayBuffer(b64));
    const blob = new Blob(buffers);
    const url = URL.createObjectURL(blob);

    // Trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = recv.fileName || data.fileName || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.receivedChunks.delete(data.transferId);
    if (this.onComplete) this.onComplete(data.transferId, true, recv.fileName);
  }

  arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
