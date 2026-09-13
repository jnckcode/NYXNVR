/**
 * @file player.js
 * @description HTML5 MediaSource Extensions (MSE) WebSocket fMP4 Player with anti-freeze protection.
 * 
 * Anti-Freeze Features:
 * - Live-edge chase: Aggressive sync keeps playback within 1-2s of live
 * - Queue overflow protection: Drops old chunks when queue exceeds limit
 * - Stale stream detection: Auto-resets MSE pipeline after 8s of no data
 * - WebSocket fast reconnect: 1.5s reconnect for surveillance use-case
 * - Buffer pruning: Keeps only 10s of played buffer in memory
 * 
 * @functions MSEPlayer
 * @dependencies none
 */

class MSEPlayer {
  constructor(videoElement, cameraId, onStatusChange) {
    this.video = videoElement;
    this.cameraId = cameraId;
    this.onStatusChange = onStatusChange || (() => {});
    this.ws = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.isDestroyed = false;
    this.hasInitialPlaybackStarted = false;
    this.stallCheckTimer = null;
    this.lastDataTime = Date.now();
    this.mimeCodec = 'video/mp4; codecs="avc1.42E01E"';

    /** Max chunks to queue before dropping old ones (prevents memory blowup) */
    this.MAX_QUEUE_SIZE = 60;
    /** If no WebSocket data for this long, force MSE reset (ms) */
    this.STALE_THRESHOLD_MS = 8000;

    this.init();
  }

  init() {
    if (!window.MediaSource) {
      console.error('[MSEPlayer] MediaSource Extensions not supported in this browser.');
      this.onStatusChange('unsupported');
      return;
    }

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;

    this.onSourceOpen = () => {
      if (this.isDestroyed) return;
      this.setupSourceBuffer();
      this.connectWebSocket();
    };
    this.mediaSource.addEventListener('sourceopen', this.onSourceOpen);

    this.mediaSource.addEventListener('sourceended', () => {
      console.warn('[MSEPlayer] MediaSource ended.');
    });

    this.video.addEventListener('waiting', () => {
      this.handleStall();
    });

    this.video.addEventListener('stalled', () => {
      this.handleStall();
    });

    this.video.addEventListener('error', () => {
      if (!this.isDestroyed) {
        console.error('[MSEPlayer] Video element error:', this.video.error);
      }
    });

    // Health check every 1 second
    this.stallCheckTimer = setInterval(() => {
      if (!this.isDestroyed) {
        this.checkAndRecoverPlayback();
      }
    }, 1000);
  }

  setupSourceBuffer() {
    try {
      // Pick best supported H.264 profile
      if (MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"')) {
        this.mimeCodec = 'video/mp4; codecs="avc1.640028"'; // High Profile
      } else if (MediaSource.isTypeSupported('video/mp4; codecs="avc1.4D401F"')) {
        this.mimeCodec = 'video/mp4; codecs="avc1.4D401F"'; // Main Profile
      } else if (MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')) {
        this.mimeCodec = 'video/mp4; codecs="avc1.42E01E"'; // Baseline Profile
      }

      this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeCodec);
      this.sourceBuffer.mode = 'segments';

      this.sourceBuffer.addEventListener('updateend', () => {
        this.processQueue();
        this.chaseLiveEdge();
        this.pruneBuffer();
      });

      this.sourceBuffer.addEventListener('error', (err) => {
        console.error('[MSEPlayer] SourceBuffer error:', err);
      });
    } catch (err) {
      console.error('[MSEPlayer] Error adding SourceBuffer:', err);
    }
  }

  connectWebSocket() {
    if (this.isDestroyed) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/live/${this.cameraId}`;

    this.onStatusChange('connecting');
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.onStatusChange('streaming');
      this.lastDataTime = Date.now();
    };

    this.ws.onmessage = (event) => {
      if (this.isDestroyed) return;
      if (event.data instanceof ArrayBuffer) {
        this.lastDataTime = Date.now();
        this.appendChunk(new Uint8Array(event.data));
      }
    };

    this.ws.onclose = () => {
      if (!this.isDestroyed) {
        this.onStatusChange('reconnecting');
        // Fast reconnect for surveillance - 1.5s
        setTimeout(() => this.connectWebSocket(), 1500);
      }
    };

    this.ws.onerror = () => {
      if (!this.isDestroyed) {
        this.onStatusChange('error');
      }
    };
  }

  appendChunk(chunk) {
    if (this.isDestroyed) return;

    // Queue overflow protection: drop oldest chunks if queue is too large
    // This prevents memory from growing unbounded when MSE can't keep up
    while (this.queue.length >= this.MAX_QUEUE_SIZE) {
      this.queue.shift(); // Drop oldest
    }

    this.queue.push(chunk);
    this.processQueue();
  }

  processQueue() {
    if (this.isDestroyed || !this.sourceBuffer || this.sourceBuffer.updating || this.queue.length === 0) {
      return;
    }

    try {
      if (this.mediaSource && this.mediaSource.readyState !== 'open') {
        return;
      }
      const chunk = this.queue.shift();
      this.sourceBuffer.appendBuffer(chunk);

      // Start initial playback
      if (!this.hasInitialPlaybackStarted && this.sourceBuffer.buffered.length > 0) {
        const start = this.sourceBuffer.buffered.start(0);
        this.video.currentTime = start;
        this.video.play().then(() => {
          this.hasInitialPlaybackStarted = true;
        }).catch(() => {});
      } else if (this.video.paused && this.hasInitialPlaybackStarted) {
        this.video.play().catch(() => {});
      }
    } catch (err) {
      if (!this.isDestroyed) {
        console.warn('[MSEPlayer] Buffer append warning:', err);
        // If QuotaExceededError, aggressively prune and retry
        if (err.name === 'QuotaExceededError') {
          this.emergencyPrune();
        }
      }
    }
  }

  /**
   * Aggressive live-edge chase - keeps playback within 1-2s of live.
   * Tighter thresholds than before to eliminate perceived "freeze" (which was actually lag).
   */
  chaseLiveEdge() {
    if (!this.video || !this.sourceBuffer || this.sourceBuffer.buffered.length === 0) return;

    const bufLen = this.sourceBuffer.buffered.length;
    const end = this.sourceBuffer.buffered.end(bufLen - 1);
    const delay = end - this.video.currentTime;

    // 1. If lagged > 2.5s (e.g. tab backgrounded), jump to near-live immediately
    if (delay > 2.5) {
      this.video.currentTime = end - 0.3;
      this.video.playbackRate = 1.0;
      return;
    }

    // 2. If lagged 1-2.5s, gentle 5% speedup (imperceptible to human eye)
    if (delay > 1.0) {
      this.video.playbackRate = 1.05;
    } else if (delay < 0.4) {
      this.video.playbackRate = 1.0;
    }
  }

  /**
   * Gap & Stall Recovery - skips over MSE buffer gaps.
   */
  handleStall() {
    if (!this.video || !this.sourceBuffer || this.sourceBuffer.buffered.length === 0) return;

    const curTime = this.video.currentTime;
    for (let i = 0; i < this.sourceBuffer.buffered.length; i++) {
      const bStart = this.sourceBuffer.buffered.start(i);
      const bEnd = this.sourceBuffer.buffered.end(i);

      if (curTime < bStart && (bStart - curTime) < 1.0) {
        this.video.currentTime = bStart + 0.05;
        this.video.play().catch(() => {});
        return;
      }
    }

    // If we're past all buffered ranges, jump to latest
    if (this.sourceBuffer.buffered.length > 0) {
      const lastEnd = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1);
      if (curTime > lastEnd + 0.5 || curTime < this.sourceBuffer.buffered.start(0)) {
        this.video.currentTime = lastEnd - 0.1;
        this.video.play().catch(() => {});
      }
    }
  }

  /**
   * Periodic playback health check with stale stream detection.
   */
  checkAndRecoverPlayback() {
    if (!this.video || !this.sourceBuffer) return;

    // Stale stream detection: if no data received for STALE_THRESHOLD_MS, force full reset
    const timeSinceData = Date.now() - this.lastDataTime;
    if (timeSinceData > this.STALE_THRESHOLD_MS && this.hasInitialPlaybackStarted) {
      console.warn(`[MSEPlayer] Stream stale for ${(timeSinceData / 1000).toFixed(1)}s - forcing full MSE reset...`);
      this.resetPipeline();
      return;
    }

    if (this.sourceBuffer.buffered.length === 0) return;

    if (this.video.paused && this.hasInitialPlaybackStarted) {
      this.video.play().catch(() => {});
    }

    // Ensure currentTime is within valid range
    const curTime = this.video.currentTime;
    const bufLen = this.sourceBuffer.buffered.length;
    const end = this.sourceBuffer.buffered.end(bufLen - 1);

    if (curTime > end) {
      this.video.currentTime = end - 0.1;
    }
  }

  /**
   * Full MSE pipeline reset - destroys and recreates MediaSource.
   * Used when stream goes stale to force a clean reconnect.
   */
  resetPipeline() {
    if (this.isDestroyed) return;

    // Close WebSocket
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }

    // Abort source buffer
    if (this.sourceBuffer && this.mediaSource && this.mediaSource.readyState === 'open') {
      try { this.sourceBuffer.abort(); } catch (e) {}
    }
    this.sourceBuffer = null;

    // Clean up old MediaSource
    if (this.mediaSource) {
      if (this.onSourceOpen) {
        this.mediaSource.removeEventListener('sourceopen', this.onSourceOpen);
      }
    }
    this.mediaSource = null;

    if (this.objectUrl) {
      try { URL.revokeObjectURL(this.objectUrl); } catch (e) {}
      this.objectUrl = null;
    }

    // Reset state
    this.queue = [];
    this.hasInitialPlaybackStarted = false;
    this.lastDataTime = Date.now();

    // Recreate fresh MediaSource pipeline
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);

    this.onSourceOpen = () => {
      if (this.isDestroyed) return;
      this.setupSourceBuffer();
      this.connectWebSocket();
    };
    this.mediaSource.addEventListener('sourceopen', this.onSourceOpen);

    this.video.src = this.objectUrl;
    this.onStatusChange('reconnecting');
  }

  /**
   * Prunes played media buffers to keep client memory minimal.
   * Keeps only 10s of played-back buffer.
   */
  pruneBuffer() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.sourceBuffer.buffered.length === 0) return;
    const start = this.sourceBuffer.buffered.start(0);
    const currentTime = this.video.currentTime;

    if (currentTime - start > 10) {
      try {
        this.sourceBuffer.remove(start, currentTime - 4);
      } catch (e) {
        // Ignore
      }
    }
  }

  /**
   * Emergency buffer prune when QuotaExceededError occurs.
   */
  emergencyPrune() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.sourceBuffer.buffered.length === 0) return;
    try {
      const start = this.sourceBuffer.buffered.start(0);
      const end = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1);
      // Remove everything except last 2 seconds
      if (end - start > 2) {
        this.sourceBuffer.remove(start, end - 2);
      }
    } catch (e) {
      // Ignore
    }
  }

  destroy() {
    this.isDestroyed = true;
    if (this.stallCheckTimer) {
      clearInterval(this.stallCheckTimer);
      this.stallCheckTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    if (this.mediaSource) {
      if (this.onSourceOpen) {
        this.mediaSource.removeEventListener('sourceopen', this.onSourceOpen);
        this.onSourceOpen = null;
      }
      if (this.sourceBuffer && this.mediaSource.readyState === 'open') {
        try {
          this.sourceBuffer.abort();
        } catch (e) {}
      }
      this.sourceBuffer = null;
      this.mediaSource = null;
    }
    if (this.video) {
      try {
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
      } catch (e) {}
      this.video = null;
    }
    if (this.objectUrl) {
      try {
        URL.revokeObjectURL(this.objectUrl);
      } catch (e) {}
      this.objectUrl = null;
    }
    this.queue = [];
  }
}

window.MSEPlayer = MSEPlayer;
