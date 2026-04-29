/**
 * AirShare – Sound Effects Engine
 * Generates sound effects using Web Audio API — no external files needed.
 */
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this._initOnInteraction();
  }

  _initOnInteraction() {
    const init = () => {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      document.removeEventListener('click', init);
      document.removeEventListener('touchstart', init);
    };
    document.addEventListener('click', init);
    document.addEventListener('touchstart', init);
  }

  _ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** Whoosh sound for throw gesture */
  playWhoosh() {
    if (!this.enabled) return;
    this._ensureCtx();
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // White noise burst shaped as whoosh
    const dur = 0.35;
    const bufSize = ctx.sampleRate * dur;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      const t = i / bufSize;
      // Envelope: quick rise, slow fall
      const env = Math.sin(t * Math.PI) * (1 - t * 0.5);
      data[i] = (Math.random() * 2 - 1) * env * 0.3;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Bandpass filter for whoosh character
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(2000, now);
    filt.frequency.linearRampToValueAtTime(800, now + dur);
    filt.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.linearRampToValueAtTime(0, now + dur);
    src.connect(filt).connect(gain).connect(ctx.destination);
    src.start(now);
    src.stop(now + dur);
  }

  /** Chime/ping sound for successful receive */
  playReceive() {
    if (!this.enabled) return;
    this._ensureCtx();
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Two-tone chime
    const freqs = [880, 1320]; // A5, E6 — pleasant major interval
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const start = now + i * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.2, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.5);
    });
  }

  /** Soft click for pinch select */
  playSelect() {
    if (!this.enabled) return;
    this._ensureCtx();
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 660;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  /** Error/reject buzzer */
  playReject() {
    if (!this.enabled) return;
    this._ensureCtx();
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 200;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  /** Room join confirmation tone */
  playJoinRoom() {
    if (!this.enabled) return;
    this._ensureCtx();
    const ctx = this.ctx;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((f, i) => { // C5, E5, G5
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const s = now + i * 0.08;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.12, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, s + 0.3);
      osc.connect(g).connect(ctx.destination);
      osc.start(s);
      osc.stop(s + 0.3);
    });
  }
}
