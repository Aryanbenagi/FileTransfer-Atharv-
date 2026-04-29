/**
 * AirShare - Gesture Detection Engine
 * Uses MediaPipe Hands for real-time hand tracking and gesture recognition
 */
class GestureEngine {
  constructor() {
    this.hands = null;
    this.camera = null;
    this.isRunning = false;
    this.landmarks = null;
    this.gesture = 'none';
    this.gestureConfidence = 0;
    this.handedness = '--';
    this.onGesture = null;
    this.onHandMove = null;
    this.prevPosition = null;
    this.velocity = { x: 0, y: 0 };
    this.fps = 0;
    this.frameCount = 0;
    this.lastFpsTime = Date.now();
    this.pinchThreshold = 0.06;
    this.throwThreshold = 0.15;
    this.gestureHistory = [];
    this.smoothingWindow = 5;
    this._rafId = null;
    this._processing = false;
  }

  async init(videoEl, canvasEl) {
    this.videoEl = videoEl;
    this.canvasEl = canvasEl;
    this.canvasCtx = canvasEl.getContext('2d');

    console.log('[Gesture] Initializing MediaPipe Hands...');

    try {
      this.hands = new Hands({
        locateFile: (file) => {
          const url = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`;
          console.log('[Gesture] Loading:', file);
          return url;
        }
      });

      this.hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5
      });

      this.hands.onResults((results) => this.processResults(results));

      // Pre-initialize the model by calling initialize()
      console.log('[Gesture] Loading hand tracking model...');
      await this.hands.initialize();
      console.log('[Gesture] Model loaded successfully!');
    } catch (err) {
      console.error('[Gesture] Failed to initialize MediaPipe:', err);
      throw new Error('Failed to load hand tracking model: ' + err.message);
    }
  }

  async start() {
    if (this.isRunning) return;
    console.log('[Gesture] Starting camera...');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        }
      });

      this.videoEl.srcObject = stream;
      this.videoEl.style.display = 'block';

      // Wait for video to be ready
      await new Promise((resolve, reject) => {
        this.videoEl.onloadedmetadata = () => {
          console.log('[Gesture] Video metadata loaded:', this.videoEl.videoWidth, 'x', this.videoEl.videoHeight);
          this.videoEl.play().then(resolve).catch(reject);
        };
        setTimeout(() => reject(new Error('Video load timeout')), 10000);
      });

      // Wait a bit for the video to start producing frames
      await new Promise(r => setTimeout(r, 500));

      this.isRunning = true;
      console.log('[Gesture] Camera started, beginning hand tracking loop...');

      // Start the processing loop
      this._tick();

    } catch (err) {
      console.error('[Gesture] Camera error:', err);
      throw err;
    }
  }

  async _tick() {
    if (!this.isRunning) return;

    if (this.videoEl.readyState >= 2 && !this._processing) {
      this._processing = true;
      try {
        await this.hands.send({ image: this.videoEl });
      } catch (err) {
        console.error('[Gesture] Frame processing error:', err);
      }
      this._processing = false;
    }

    this._rafId = requestAnimationFrame(() => this._tick());
  }

  stop() {
    console.log('[Gesture] Stopping...');
    this.isRunning = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this.videoEl && this.videoEl.srcObject) {
      this.videoEl.srcObject.getTracks().forEach(t => t.stop());
      this.videoEl.srcObject = null;
    }
    this.videoEl.style.display = 'none';
  }

  processResults(results) {
    // FPS counter
    this.frameCount++;
    const now = Date.now();
    if (now - this.lastFpsTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsTime = now;
    }

    const cw = this.canvasEl.width = this.videoEl.videoWidth || 640;
    const ch = this.canvasEl.height = this.videoEl.videoHeight || 480;
    this.canvasCtx.clearRect(0, 0, cw, ch);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      const hand = results.multiHandLandmarks[0];
      this.landmarks = hand;
      this.handedness = results.multiHandedness?.[0]?.label || '--';

      // Draw hand skeleton
      this.drawHand(hand, cw, ch);

      // Detect gesture
      const detected = this.detectGesture(hand);
      this.gestureHistory.push(detected);
      if (this.gestureHistory.length > this.smoothingWindow) this.gestureHistory.shift();

      // Smooth gesture (majority vote)
      const counts = {};
      this.gestureHistory.forEach(g => counts[g] = (counts[g] || 0) + 1);
      let maxG = 'none', maxC = 0;
      for (const [g, c] of Object.entries(counts)) {
        if (c > maxC) { maxG = g; maxC = c; }
      }
      this.gesture = maxG;
      this.gestureConfidence = Math.round((maxC / this.smoothingWindow) * 100);

      // Calculate hand position and velocity
      const palmBase = hand[0];
      const currentPos = { x: palmBase.x, y: palmBase.y };
      if (this.prevPosition) {
        this.velocity.x = currentPos.x - this.prevPosition.x;
        this.velocity.y = currentPos.y - this.prevPosition.y;
      }
      this.prevPosition = currentPos;

      // Fire callbacks
      if (this.onGesture) {
        this.onGesture(this.gesture, this.gestureConfidence, currentPos, this.velocity);
      }
      if (this.onHandMove) {
        this.onHandMove(currentPos, this.velocity, hand);
      }
    } else {
      this.landmarks = null;
      this.gesture = 'none';
      this.gestureConfidence = 0;
      this.prevPosition = null;
      if (this.onGesture) this.onGesture('none', 0, null, null);
    }
  }

  detectGesture(landmarks) {
    const wrist = landmarks[0];

    // ── Distance-based finger curl detection (rotation-invariant) ──
    // A finger is CURLED if its tip is closer to the wrist than its MCP (knuckle) joint.
    // This works regardless of hand orientation.

    // Index: tip=8, PIP=6, MCP=5
    const indexTipDist = this.dist(landmarks[8], wrist);
    const indexMcpDist = this.dist(landmarks[5], wrist);
    const indexCurled = indexTipDist < indexMcpDist * 1.1;

    // Middle: tip=12, PIP=10, MCP=9
    const middleTipDist = this.dist(landmarks[12], wrist);
    const middleMcpDist = this.dist(landmarks[9], wrist);
    const middleCurled = middleTipDist < middleMcpDist * 1.1;

    // Ring: tip=16, PIP=14, MCP=13
    const ringTipDist = this.dist(landmarks[16], wrist);
    const ringMcpDist = this.dist(landmarks[13], wrist);
    const ringCurled = ringTipDist < ringMcpDist * 1.1;

    // Pinky: tip=20, PIP=18, MCP=17
    const pinkyTipDist = this.dist(landmarks[20], wrist);
    const pinkyMcpDist = this.dist(landmarks[17], wrist);
    const pinkyCurled = pinkyTipDist < pinkyMcpDist * 1.1;

    // Thumb: compare tip(4) distance to index MCP(5) — if close, thumb is tucked
    const thumbTipDist = this.dist(landmarks[4], wrist);
    const thumbMcpDist = this.dist(landmarks[2], wrist);
    const thumbCurled = thumbTipDist < thumbMcpDist * 1.2;

    const curledCount = [indexCurled, middleCurled, ringCurled, pinkyCurled].filter(Boolean).length;
    const extendedCount = 4 - curledCount;

    // ── Pinch: thumb tip and index tip very close ──
    const pinchDist = this.dist(landmarks[4], landmarks[8]);
    if (pinchDist < this.pinchThreshold && !indexCurled) {
      return 'pinch';
    }

    // ── Fist: most/all fingers curled ──
    // Allow 1 borderline finger — real fists aren't always perfect
    if (curledCount >= 3 && (thumbCurled || curledCount === 4)) {
      return 'fist';
    }

    // ── Open hand: most/all fingers extended ──
    if (extendedCount >= 3 && !thumbCurled) {
      const speed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);
      if (speed > this.throwThreshold) {
        return 'throw';
      }
      return 'open';
    }

    // ── Point: only index extended ──
    if (!indexCurled && middleCurled && ringCurled && pinkyCurled) {
      return 'point';
    }

    // ── Peace: index + middle extended ──
    if (!indexCurled && !middleCurled && ringCurled && pinkyCurled) {
      return 'peace';
    }

    // Fallback: partial gesture — don't default to 'open'
    if (curledCount >= 2) return 'fist';
    return 'none';
  }

  dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + ((a.z || 0) - (b.z || 0)) ** 2);
  }

  drawHand(landmarks, cw, ch) {
    const ctx = this.canvasCtx;
    const connections = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [0,9],[9,10],[10,11],[11,12],
      [0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],
      [5,9],[9,13],[13,17]
    ];

    // Draw connections
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.6)';
    ctx.lineWidth = 2;
    connections.forEach(([i, j]) => {
      const a = landmarks[i], b = landmarks[j];
      ctx.beginPath();
      ctx.moveTo(a.x * cw, a.y * ch);
      ctx.lineTo(b.x * cw, b.y * ch);
      ctx.stroke();
    });

    // Draw landmarks
    landmarks.forEach((lm, i) => {
      const x = lm.x * cw, y = lm.y * ch;
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? 6 : (i % 4 === 0 ? 5 : 3), 0, Math.PI * 2);
      const isFingerTip = [4, 8, 12, 16, 20].includes(i);
      ctx.fillStyle = isFingerTip ? 'rgba(167, 139, 250, 0.9)' : 'rgba(99, 102, 241, 0.7)';
      ctx.fill();
      if (isFingerTip) {
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });

    // Highlight pinch
    if (this.gesture === 'pinch') {
      const thumb = landmarks[4], idx = landmarks[8];
      const mx = ((thumb.x + idx.x) / 2) * cw;
      const my = ((thumb.y + idx.y) / 2) * ch;
      ctx.beginPath();
      ctx.arc(mx, my, 15, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(34, 197, 94, 0.3)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}
