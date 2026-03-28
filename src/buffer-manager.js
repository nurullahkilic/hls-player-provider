/**
 * buffer-manager.js — Manages the MediaSource and its SourceBuffers
 *
 * Responsibilities:
 *   - Create / open the MediaSource
 *   - Attach it to an HTMLVideoElement
 *   - Queue appends (SourceBuffer can only accept one append at a time)
 *   - Remove old buffered data to prevent quota exceeded errors
 *   - Signal when the player can start / has caught up
 */

import { logger } from './utils.js';

/** How many seconds of data to keep BEHIND the current position. */
const BACK_BUFFER_LENGTH = 30;

export class BufferManager {
  /**
   * @param {HTMLVideoElement} videoEl
   */
  constructor(videoEl) {
    this._videoEl       = videoEl;
    this._mediaSource   = null;
    this._sourceBuffers = {};   // 'video' | 'audio' → SourceBuffer
    this._appendQueues  = {};   // 'video' | 'audio' → ArrayBuffer[]
    this._appending     = {};   // 'video' | 'audio' → boolean
    this._objectUrl     = null;
    this._ready         = false;
    this._endOfStream   = false;
    this._onReady       = null; // resolve function for open()
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create and attach the MediaSource.  Resolves when sourceopen fires.
   * @returns {Promise<void>}
   */
  open() {
    return new Promise((resolve, reject) => {
      this._onReady = resolve;

      this._mediaSource = new MediaSource();
      this._objectUrl   = URL.createObjectURL(this._mediaSource);

      this._mediaSource.addEventListener('sourceopen',  () => this._onSourceOpen(), { once: true });
      this._mediaSource.addEventListener('sourceclose', () => logger.warn('MediaSource closed'));
      this._mediaSource.addEventListener('sourceerror', () => reject(new Error('MediaSource error')));

      this._videoEl.src = this._objectUrl;
    });
  }

  _onSourceOpen() {
    logger.log('MediaSource open');
    URL.revokeObjectURL(this._objectUrl);
    this._ready = true;
    this._onReady?.();
  }

  /**
   * Add a SourceBuffer for a given track type.
   * Must be called after open() resolves.
   *
   * @param {'video'|'audio'} type
   * @param {string}          mimeCodec  e.g. 'video/mp4; codecs="avc1.42E01E"'
   */
  addSourceBuffer(type, mimeCodec) {
    if (!MediaSource.isTypeSupported(mimeCodec)) {
      throw new Error(`Unsupported MIME type: ${mimeCodec}`);
    }
    const sb = this._mediaSource.addSourceBuffer(mimeCodec);
    sb.mode  = 'segments'; // needed for proper fMP4 playback
    this._sourceBuffers[type] = sb;
    this._appendQueues[type]  = [];
    this._appending[type]     = false;

    sb.addEventListener('updateend', () => this._onUpdateEnd(type));
    sb.addEventListener('error',     (e) => logger.error(`SourceBuffer[${type}] error`, e));
  }

  // ---------------------------------------------------------------------------
  // Appending
  // ---------------------------------------------------------------------------

  /**
   * Enqueue an ArrayBuffer to be appended to the SourceBuffer.
   */
  append(type, buffer) {
    if (!this._sourceBuffers[type]) {
      logger.warn(`No SourceBuffer for type: ${type}`);
      return;
    }
    this._appendQueues[type].push(buffer);
    this._drainQueue(type);
  }

  _drainQueue(type) {
    const sb = this._sourceBuffers[type];
    if (!sb || this._appending[type] || this._appendQueues[type].length === 0) return;
    if (sb.updating) return;

    const buf = this._appendQueues[type].shift();
    this._appending[type] = true;
    try {
      sb.appendBuffer(buf);
    } catch (err) {
      this._appending[type] = false;
      if (err.name === 'QuotaExceededError') {
        logger.warn('QuotaExceededError — evicting old data');
        this._evict(type);
        // Re-enqueue the buffer we just tried
        this._appendQueues[type].unshift(buf);
      } else {
        logger.error('appendBuffer error', err);
      }
    }
  }

  _onUpdateEnd(type) {
    this._appending[type] = false;
    this._evictIfNeeded(type);
    this._drainQueue(type);
  }

  // ---------------------------------------------------------------------------
  // Buffer eviction
  // ---------------------------------------------------------------------------

  _evictIfNeeded(type) {
    const sb       = this._sourceBuffers[type];
    const currentT = this._videoEl.currentTime;
    if (!sb || sb.updating || currentT < BACK_BUFFER_LENGTH) return;

    const evictEnd = currentT - BACK_BUFFER_LENGTH;
    const ranges   = sb.buffered;

    if (ranges.length > 0 && ranges.start(0) < evictEnd) {
      try {
        sb.remove(ranges.start(0), evictEnd);
      } catch { /* ignore */ }
    }
  }

  _evict(type) {
    const sb = this._sourceBuffers[type];
    if (!sb || sb.updating) return;
    const currentT = this._videoEl.currentTime;
    const ranges   = sb.buffered;
    if (ranges.length === 0) return;
    try {
      // Aggressively remove everything more than 5 s behind
      sb.remove(ranges.start(0), Math.max(ranges.start(0), currentT - 5));
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Buffered range queries
  // ---------------------------------------------------------------------------

  /**
   * Returns the number of seconds buffered ahead of currentTime.
   */
  bufferedAhead() {
    const t  = this._videoEl.currentTime;
    const sb = this._sourceBuffers['video'] ?? this._sourceBuffers['audio'];
    if (!sb) return 0;
    const ranges = sb.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= t + 0.5 && ranges.end(i) > t) {
        return ranges.end(i) - t;
      }
    }
    return 0;
  }

  /**
   * Returns total duration currently in the SourceBuffer,
   * or the MediaSource duration if set.
   */
  duration() {
    return isFinite(this._mediaSource?.duration) ? this._mediaSource.duration : 0;
  }

  /**
   * Set the MediaSource duration (for VOD streams once playlist is parsed).
   */
  setDuration(seconds) {
    if (this._mediaSource && this._mediaSource.readyState === 'open') {
      try { this._mediaSource.duration = seconds; } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // End of stream
  // ---------------------------------------------------------------------------

  /**
   * Signal no more data will be appended.
   * Waits for all pending appends to finish, then calls endOfStream().
   */
  async endOfStream() {
    if (this._endOfStream) return;
    // Wait for all queues to drain
    await this._waitForIdle();
    if (this._mediaSource?.readyState === 'open') {
      this._mediaSource.endOfStream();
      this._endOfStream = true;
      logger.log('MediaSource endOfStream');
    }
  }

  _waitForIdle() {
    return new Promise(resolve => {
      const check = () => {
        const busy = Object.keys(this._sourceBuffers).some(
          k => this._appending[k] || this._appendQueues[k].length > 0,
        );
        if (!busy) return resolve();
        setTimeout(check, 100);
      };
      check();
    });
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  destroy() {
    for (const type of Object.keys(this._sourceBuffers)) {
      this._appendQueues[type] = [];
    }
    if (this._mediaSource?.readyState === 'open') {
      try { this._mediaSource.endOfStream(); } catch { /* ignore */ }
    }
    this._videoEl.src = '';
    this._ready = false;
  }
}
