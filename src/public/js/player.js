/**
 * @file player.js
 * @description HTML5 MediaSource Extensions (MSE) WebSocket fMP4 Player for ultra-low latency, stutter-free live video rendering.
 * @functions createMsePlayer, destroyMsePlayer, MSEPlayer
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
    this.mimeCodec = 'video/mp4; codecs="avc1.42E01E"'; // Baseline Profile H.264 fallback
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

    // Periodic stall check every 1 second
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
        this.smoothSyncLive();
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
    };

    this.ws.onmessage = (event) => {
      if (this.isDestroyed) return;
      if (event.data instanceof ArrayBuffer) {
        this.appendChunk(new Uint8Array(event.data));
      }
    };

    this.ws.onclose = () => {
      if (!this.isDestroyed) {
        this.onStatusChange('reconnecting');
        setTimeout(() => this.connectWebSocket(), 3000);
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

      // Start initial playback smoothly
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
      }
    }
  }

  /**
   * Smooth dynamic rate synchronization (Zero hard-seeks to eliminate stutter/choppiness).
   */
  smoothSyncLive() {
    if (!this.video || !this.sourceBuffer || this.sourceBuffer.buffered.length === 0) return;

    const bufLen = this.sourceBuffer.buffered.length;
    const end = this.sourceBuffer.buffered.end(bufLen - 1);
    const delay = end - this.video.currentTime;

    // 1. If playback lagged behind significantly (> 5s e.g. tab was in background), soft jump
    if (delay > 5.0) {
      this.video.currentTime = end - 0.5;
      this.video.playbackRate = 1.0;
      return;
    }

    // 2. Gentle micro-speedup for seamless live edge synchronization without frame drops
    if (delay > 2.0) {
      this.video.playbackRate = 1.08; // 8% gentle speedup (smooth & imperceptible)
    } else if (delay < 0.6) {
      this.video.playbackRate = 1.0;  // Normal 1.0x speed
    }
  }

  /**
   * Gap & Stall Recovery Handler.
   */
  handleStall() {
    if (!this.video || !this.sourceBuffer || this.sourceBuffer.buffered.length === 0) return;

    const curTime = this.video.currentTime;
    for (let i = 0; i < this.sourceBuffer.buffered.length; i++) {
      const bStart = this.sourceBuffer.buffered.start(i);
      const bEnd = this.sourceBuffer.buffered.end(i);

      // If current time is stuck just before or between buffered ranges, skip gap
      if (curTime < bStart && (bStart - curTime) < 0.5) {
        this.video.currentTime = bStart + 0.05;
        this.video.play().catch(() => {});
        return;
      }
    }
  }

  /**
   * Periodic playback health check.
   */
  checkAndRecoverPlayback() {
    if (!this.video || !this.sourceBuffer || this.sourceBuffer.buffered.length === 0) return;

    if (this.video.paused && this.hasInitialPlaybackStarted) {
      this.video.play().catch(() => {});
    }

    // Ensure currentTime is within a valid buffered range
    const curTime = this.video.currentTime;
    const bufLen = this.sourceBuffer.buffered.length;
    const end = this.sourceBuffer.buffered.end(bufLen - 1);

    if (curTime > end) {
      this.video.currentTime = end - 0.2;
    }
  }

  /**
   * Prunes played media buffers to keep client memory minimal.
   */
  pruneBuffer() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.sourceBuffer.buffered.length === 0) return;
    const start = this.sourceBuffer.buffered.start(0);
    const currentTime = this.video.currentTime;

    // Prune buffer older than 15 seconds
    if (currentTime - start > 15) {
      try {
        this.sourceBuffer.remove(start, currentTime - 6);
      } catch (e) {
        // Ignore
      }
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

