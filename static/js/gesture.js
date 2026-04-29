/**
 * AirShare - Gesture Detection Engine
 * Uses MediaPipe Hands for real-time hand tracking and gesture recognition
 * 
 * Fixes:
 *  - Debounced gesture detection to prevent random firing
 *  - Improved pinch/fist/throw thresholds with hysteresis
 *  - Throw direction vector tracked for directional sending
 *  - Canvas perfectly aligned with video using ResizeObserver
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
    this.onTwoHandGesture = null; // (leftGesture, rightGesture, leftPos, rightPos, rightThrowDir)
    this.onPushAway = null; // called when push-away decline gesture detected
    this.prevPosition = null;
    this.velocity = { x: 0, y: 0 };
    this.fps = 0;
    this.frameCount = 0;
    this.lastFpsTime = Date.now();
    this.pinchThreshold = 0.055;
    this.pinchReleaseThreshold = 0.08;
    this.throwThreshold = 0.12;
    this.pushAwayThreshold = 0.18; // fast open hand moving away
    this.gestureHistory = [];
    this.smoothingWindow = 7;
    this._rafId = null;
    this._processing = false;
    this._isPinching = false;
    this._throwDirection = { x: 0, y: 0 };
    this._velocityHistory = [];
    this._velocitySmoothWindow = 4;
    this._gestureHoldTimer = {};
    this._gestureHoldMs = 120;
    this._lastConfirmedGesture = 'none';
    this._lastGestureTime = 0;
    this._resizeObserver = null;
    // Two-hand state
    this._leftHand = { gesture: 'none', pos: null, velocity: { x: 0, y: 0 }, prevPos: null, velHistory: [] };
    this._rightHand = { gesture: 'none', pos: null, velocity: { x: 0, y: 0 }, prevPos: null, velHistory: [], throwDir: { x: 0, y: 0 } };
    this._twoHandsDetected = false;
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
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.65,
        minTrackingConfidence: 0.55
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

      // Setup canvas alignment observer
      this._setupCanvasAlignment();

      this.isRunning = true;
      console.log('[Gesture] Camera started, beginning hand tracking loop...');

      // Start the processing loop
      this._tick();

    } catch (err) {
      console.error('[Gesture] Camera error:', err);
      throw err;
    }
  }

  _setupCanvasAlignment() {
    // Ensure canvas always matches video rendering dimensions exactly
    const syncSize = () => {
      const container = this.videoEl.parentElement;
      if (!container) return;
      
      const rect = this.videoEl.getBoundingClientRect();
      // Use the actual rendered dimensions of the video element
      this.canvasEl.width = this.videoEl.videoWidth || 640;
      this.canvasEl.height = this.videoEl.videoHeight || 480;
      // Make canvas cover the exact same area as the video
      this.canvasEl.style.width = rect.width + 'px';
      this.canvasEl.style.height = rect.height + 'px';
      this.canvasEl.style.left = (rect.left - container.getBoundingClientRect().left) + 'px';
      this.canvasEl.style.top = (rect.top - container.getBoundingClientRect().top) + 'px';
    };

    syncSize();
    
    // Watch for container resizes
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(syncSize);
      this._resizeObserver.observe(this.videoEl.parentElement);
    }
    
    // Also sync on window resize
    this._resizeHandler = syncSize;
    window.addEventListener('resize', this._resizeHandler);
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
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
    }
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
      const numHands = results.multiHandLandmarks.length;
      this._twoHandsDetected = numHands >= 2;

      // Process first hand (primary)
      const hand = results.multiHandLandmarks[0];
      this.landmarks = hand;
      this.handedness = results.multiHandedness?.[0]?.label || '--';

      // Draw all hands
      for (let h = 0; h < numHands; h++) {
        this.drawHand(results.multiHandLandmarks[h], cw, ch, h);
      }

      // Detect gesture for primary hand
      const detected = this.detectGesture(hand);
      this.gestureHistory.push(detected);
      if (this.gestureHistory.length > this.smoothingWindow) this.gestureHistory.shift();

      const counts = {};
      this.gestureHistory.forEach(g => counts[g] = (counts[g] || 0) + 1);
      let maxG = 'none', maxC = 0;
      for (const [g, c] of Object.entries(counts)) {
        if (c > maxC) { maxG = g; maxC = c; }
      }
      const supermajority = Math.ceil(this.smoothingWindow * 0.57);
      if (maxC >= supermajority) {
        this.gesture = maxG;
      }
      this.gestureConfidence = Math.round((maxC / this.smoothingWindow) * 100);

      // Velocity for primary hand
      const palmBase = hand[0];
      const currentPos = { x: palmBase.x, y: palmBase.y };
      if (this.prevPosition) {
        const rawVx = currentPos.x - this.prevPosition.x;
        const rawVy = currentPos.y - this.prevPosition.y;
        this._velocityHistory.push({ x: rawVx, y: rawVy });
        if (this._velocityHistory.length > this._velocitySmoothWindow) this._velocityHistory.shift();
        let sx = 0, sy = 0;
        this._velocityHistory.forEach(v => { sx += v.x; sy += v.y; });
        this.velocity.x = sx / this._velocityHistory.length;
        this.velocity.y = sy / this._velocityHistory.length;
      }
      this.prevPosition = currentPos;

      if (this.gesture === 'throw') {
        const speed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);
        if (speed > 0.01) {
          this._throwDirection = { x: this.velocity.x / speed, y: this.velocity.y / speed };
        }
      }

      // ── Two-hand processing ──
      if (numHands >= 2) {
        for (let h = 0; h < 2; h++) {
          const hLandmarks = results.multiHandLandmarks[h];
          const label = results.multiHandedness?.[h]?.label || '';
          // MediaPipe mirrors labels: 'Left' in video = right hand in reality
          const isLeft = label === 'Right'; // mirrored
          const handState = isLeft ? this._leftHand : this._rightHand;
          
          handState.gesture = this.detectGesture(hLandmarks);
          const pos = { x: hLandmarks[0].x, y: hLandmarks[0].y };
          if (handState.prevPos) {
            const vx = pos.x - handState.prevPos.x;
            const vy = pos.y - handState.prevPos.y;
            handState.velHistory.push({ x: vx, y: vy });
            if (handState.velHistory.length > 4) handState.velHistory.shift();
            let svx = 0, svy = 0;
            handState.velHistory.forEach(v => { svx += v.x; svy += v.y; });
            handState.velocity = { x: svx / handState.velHistory.length, y: svy / handState.velHistory.length };
          }
          handState.prevPos = pos;
          handState.pos = pos;

          if (!isLeft) {
            const sp = Math.sqrt(handState.velocity.x ** 2 + handState.velocity.y ** 2);
            if (sp > 0.01) {
              handState.throwDir = { x: handState.velocity.x / sp, y: handState.velocity.y / sp };
            }
          }
        }

        if (this.onTwoHandGesture) {
          this.onTwoHandGesture(
            this._leftHand.gesture, this._rightHand.gesture,
            this._leftHand.pos, this._rightHand.pos,
            this._rightHand.throwDir
          );
        }
      }

      // ── Push-away detection (open hand moving backward fast) ──
      if (this.gesture === 'open') {
        const speed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);
        // Check if hand is moving toward camera (z-velocity if available)
        const zVel = hand[0].z !== undefined && this._prevZ !== undefined
          ? hand[0].z - this._prevZ : 0;
        this._prevZ = hand[0].z;
        // Push away = fast open hand (can be moving sideways or toward cam)
        if (speed > this.pushAwayThreshold || zVel < -0.03) {
          if (this.onPushAway) this.onPushAway();
        }
      } else {
        this._prevZ = hand[0]?.z;
      }

      // Fire primary gesture callbacks
      if (this.onGesture) {
        this.onGesture(this.gesture, this.gestureConfidence, currentPos, this.velocity, this._throwDirection);
      }
      if (this.onHandMove) {
        this.onHandMove(currentPos, this.velocity, hand);
      }
    } else {
      this.landmarks = null;
      this.gesture = 'none';
      this.gestureConfidence = 0;
      this.prevPosition = null;
      this._velocityHistory = [];
      this._twoHandsDetected = false;
      if (this.onGesture) this.onGesture('none', 0, null, null, null);
    }
  }

  detectGesture(landmarks) {
    const wrist = landmarks[0];

    // ── Distance-based finger curl detection (rotation-invariant) ──
    // A finger is CURLED if its tip is closer to the wrist than its MCP (knuckle) joint.

    // Index: tip=8, PIP=6, MCP=5
    const indexTipDist = this.dist(landmarks[8], wrist);
    const indexMcpDist = this.dist(landmarks[5], wrist);
    const indexCurled = indexTipDist < indexMcpDist * 1.05;

    // Middle: tip=12, PIP=10, MCP=9
    const middleTipDist = this.dist(landmarks[12], wrist);
    const middleMcpDist = this.dist(landmarks[9], wrist);
    const middleCurled = middleTipDist < middleMcpDist * 1.05;

    // Ring: tip=16, PIP=14, MCP=13
    const ringTipDist = this.dist(landmarks[16], wrist);
    const ringMcpDist = this.dist(landmarks[13], wrist);
    const ringCurled = ringTipDist < ringMcpDist * 1.05;

    // Pinky: tip=20, PIP=18, MCP=17
    const pinkyTipDist = this.dist(landmarks[20], wrist);
    const pinkyMcpDist = this.dist(landmarks[17], wrist);
    const pinkyCurled = pinkyTipDist < pinkyMcpDist * 1.05;

    // Thumb: compare tip(4) distance to index MCP(5)
    const thumbTipDist = this.dist(landmarks[4], wrist);
    const thumbMcpDist = this.dist(landmarks[2], wrist);
    const thumbCurled = thumbTipDist < thumbMcpDist * 1.15;

    const curledCount = [indexCurled, middleCurled, ringCurled, pinkyCurled].filter(Boolean).length;
    const extendedCount = 4 - curledCount;

    // ── Pinch: thumb tip and index tip very close (with hysteresis) ──
    const pinchDist = this.dist(landmarks[4], landmarks[8]);
    if (this._isPinching) {
      // Need larger distance to release pinch
      if (pinchDist > this.pinchReleaseThreshold) {
        this._isPinching = false;
      } else {
        return 'pinch';
      }
    } else {
      if (pinchDist < this.pinchThreshold && !indexCurled) {
        this._isPinching = true;
        return 'pinch';
      }
    }

    // ── Fist: most/all fingers curled ──
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

    // Fallback
    if (curledCount >= 2) return 'fist';
    return 'none';
  }

  dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + ((a.z || 0) - (b.z || 0)) ** 2);
  }

  /**
   * Get the screen position where the throw gesture is pointing to.
   * Used to determine which device card the hand is throwing toward.
   */
  getThrowTargetPosition(throwDir) {
    const dir = throwDir || this._throwDirection;
    if (!this.prevPosition) return null;
    const screenX = (1 - this.prevPosition.x) * window.innerWidth;
    const screenY = this.prevPosition.y * window.innerHeight;
    const projDist = 300;
    return {
      x: screenX + (-dir.x * projDist),
      y: screenY + (dir.y * projDist)
    };
  }

  /** Get two-hand state for the app to use */
  getTwoHandState() {
    return {
      detected: this._twoHandsDetected,
      left: { ...this._leftHand },
      right: { ...this._rightHand }
    };
  }

  drawHand(landmarks, cw, ch, handIdx = 0) {
    const ctx = this.canvasCtx;
    const isSecondHand = handIdx === 1;
    const baseColor = isSecondHand ? '139, 92, 246' : '99, 102, 241';
    const connections = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [0,9],[9,10],[10,11],[11,12],
      [0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],
      [5,9],[9,13],[13,17]
    ];

    // Glow effect for active gestures
    const curGesture = handIdx === 0 ? this.gesture : (isSecondHand ? this._rightHand.gesture : this._leftHand.gesture);
    if (curGesture !== 'none' && curGesture !== 'open') {
      const palmX = landmarks[9].x * cw;
      const palmY = landmarks[9].y * ch;
      const grad = ctx.createRadialGradient(palmX, palmY, 0, palmX, palmY, 60);
      const colors = {
        'pinch': 'rgba(34, 197, 94, 0.15)',
        'fist': 'rgba(239, 68, 68, 0.12)',
        'throw': 'rgba(245, 158, 11, 0.18)',
        'point': 'rgba(99, 102, 241, 0.12)',
        'peace': 'rgba(167, 139, 250, 0.12)'
      };
      grad.addColorStop(0, colors[this.gesture] || 'transparent');
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cw, ch);
    }

    // Draw connections
    ctx.strokeStyle = `rgba(${baseColor}, 0.7)`;
    ctx.lineWidth = 2.5;
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
      ctx.arc(x, y, i === 0 ? 7 : (i % 4 === 0 ? 6 : 3.5), 0, Math.PI * 2);
      const isFingerTip = [4, 8, 12, 16, 20].includes(i);
      ctx.fillStyle = isFingerTip ? `rgba(${isSecondHand ? '192, 132, 252' : '167, 139, 250'}, 0.95)` : `rgba(${baseColor}, 0.8)`;
      ctx.fill();
      if (isFingerTip) {
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });

    // Highlight pinch
    if (this.gesture === 'pinch') {
      const thumb = landmarks[4], idx = landmarks[8];
      const mx = ((thumb.x + idx.x) / 2) * cw;
      const my = ((thumb.y + idx.y) / 2) * ch;
      ctx.beginPath();
      ctx.arc(mx, my, 18, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(34, 197, 94, 0.25)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.9)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Highlight throw direction
    if (this.gesture === 'throw') {
      const palm = landmarks[9];
      const px = palm.x * cw, py = palm.y * ch;
      const speed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);
      const arrowLen = Math.min(speed * 800, 80);
      const ax = px + this._throwDirection.x * arrowLen;
      const ay = py + this._throwDirection.y * arrowLen;
      
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(ax, ay);
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.9)';
      ctx.lineWidth = 3;
      ctx.stroke();
      
      // Arrow head
      ctx.beginPath();
      ctx.arc(ax, ay, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
      ctx.fill();
    }
  }
}
