(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
  typeof define === 'function' && define.amd ? define(['exports'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.HLS = {}));
})(this, (function (exports) { 'use strict';

  /**
   * utils.js — Shared helpers used across the player
   */

  /**
   * Minimal EventEmitter so the player can emit/listen to events
   * without any external library.
   */
  class EventEmitter {
    constructor() {
      this._handlers = {};
    }

    on(event, fn) {
      (this._handlers[event] ??= []).push(fn);
      return this;
    }

    off(event, fn) {
      if (!this._handlers[event]) return this;
      this._handlers[event] = this._handlers[event].filter(h => h !== fn);
      return this;
    }

    once(event, fn) {
      const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
      return this.on(event, wrapper);
    }

    emit(event, ...args) {
      (this._handlers[event] ?? []).slice().forEach(h => h(...args));
    }

    removeAllListeners(event) {
      if (event) delete this._handlers[event];
      else this._handlers = {};
    }
  }

  /**
   * Resolve a potentially relative URL against a base URL.
   */
  function resolveUrl(base, url) {
    if (/^https?:\/\//i.test(url)) return url;
    return new URL(url, base).href;
  }

  /**
   * Check if an ArrayBuffer contains an MPEG-TS stream (sync byte 0x47 at
   * position 0, 188, 376, …).
   */
  function isMpegTS(buffer) {
    const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 564));
    return bytes[0] === 0x47 && bytes[188] === 0x47;
  }

  /**
   * Check if an ArrayBuffer starts with an fMP4 / ISOBMFF box
   * (first four bytes are a size, next four are an ASCII box type).
   */
  function isMP4(buffer) {
    if (buffer.byteLength < 8) return false;
    const bytes = new Uint8Array(buffer, 4, 4);
    const type = String.fromCharCode(...bytes);
    return ['ftyp', 'moof', 'mdat', 'moov', 'styp'].includes(type);
  }

  /**
   * Simple logger that can be silenced.
   */
  const logger = {
    enabled: true,
    log:   (...a) => logger.enabled && console.log('[HLS]', ...a),
    warn:  (...a) => logger.enabled && console.warn('[HLS]', ...a),
    error: (...a) =>                   console.error('[HLS]', ...a),
  };

  /**
   * m3u8-parser.js — Full M3U8 playlist parser (master + media playlists)
   *
   * Handles:
   *   Master playlists  — #EXT-X-STREAM-INF, #EXT-X-MEDIA
   *   Media playlists   — #EXTINF, #EXT-X-KEY, #EXT-X-BYTERANGE,
   *                       #EXT-X-DISCONTINUITY, #EXT-X-ENDLIST, …
   */

  /** Parse a tag attribute string like  KEY=VALUE,KEY2="VALUE 2"  into a plain object. */
  function parseAttrs(str) {
    const attrs = {};
    // Match KEY=VALUE or KEY="VALUE"
    const re = /([A-Z0-9_-]+)=(?:"([^"]*)"|([^,]*))/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
    }
    return attrs;
  }

  /**
   * Parse an M3U8 text into a structured playlist object.
   *
   * @param {string} text   Raw M3U8 text
   * @param {string} baseUrl  URL the playlist was fetched from (used to resolve URIs)
   * @returns {Playlist}
   */
  function parseM3U8(text, baseUrl = '') {
    if (!text.startsWith('#EXTM3U')) {
      throw new Error('Not a valid M3U8 playlist (missing #EXTM3U header)');
    }

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    // Determine playlist type on first pass
    const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));

    return isMaster
      ? parseMasterPlaylist(lines, baseUrl)
      : parseMediaPlaylist(lines, baseUrl);
  }

  // ---------------------------------------------------------------------------
  // Master playlist
  // ---------------------------------------------------------------------------

  function parseMasterPlaylist(lines, baseUrl) {
    /** @type {MasterPlaylist} */
    const playlist = {
      type: 'master',
      version: 1,
      variants: [],   // video renditions sorted by bandwidth
      audio: [],      // alternative audio tracks
      subtitles: [],  // subtitle tracks
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-VERSION:')) {
        playlist.version = parseInt(line.split(':')[1], 10);

      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
        const uri   = resolveUri(baseUrl, lines[++i]);
        playlist.variants.push({
          uri,
          bandwidth:  parseInt(attrs['BANDWIDTH']  ?? '0', 10),
          avgBandwidth: parseInt(attrs['AVERAGE-BANDWIDTH'] ?? '0', 10),
          codecs:     attrs['CODECS']     ?? '',
          resolution: parseResolution(attrs['RESOLUTION'] ?? ''),
          frameRate:  parseFloat(attrs['FRAME-RATE'] ?? '0'),
          hdcpLevel:  attrs['HDCP-LEVEL'] ?? '',
          audio:      attrs['AUDIO']      ?? '',
          subtitles:  attrs['SUBTITLES']  ?? '',
          video:      attrs['VIDEO']      ?? '',
        });

      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const attrs = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
        const track = {
          type:       attrs['TYPE'],
          groupId:    attrs['GROUP-ID']  ?? '',
          language:   attrs['LANGUAGE'] ?? '',
          name:       attrs['NAME']     ?? '',
          default:    attrs['DEFAULT']  === 'YES',
          autoSelect: attrs['AUTOSELECT'] === 'YES',
          forced:     attrs['FORCED']   === 'YES',
          uri:        attrs['URI'] ? resolveUri(baseUrl, attrs['URI']) : null,
          channels:   attrs['CHANNELS'] ?? '',
        };
        if (attrs['TYPE'] === 'AUDIO')    playlist.audio.push(track);
        if (attrs['TYPE'] === 'SUBTITLES') playlist.subtitles.push(track);
      }
    }

    // Sort variants ascending by bandwidth (lowest quality first)
    playlist.variants.sort((a, b) => a.bandwidth - b.bandwidth);
    return playlist;
  }

  // ---------------------------------------------------------------------------
  // Media playlist
  // ---------------------------------------------------------------------------

  function parseMediaPlaylist(lines, baseUrl) {
    /** @type {MediaPlaylist} */
    const playlist = {
      type: 'media',
      version: 1,
      targetDuration: 0,
      mediaSequence: 0,
      discontinuitySequence: 0,
      endList: false,
      playlistType: null,   // VOD | EVENT
      segments: [],
      // Live: time the playlist was last fetched (for refresh scheduling)
      fetchedAt: Date.now(),
    };

    // Current encryption state (inherited across segments until changed)
    let currentKey = null;
    // Pending #EXTINF for the next URI line
    let pendingDuration = 0;
    let pendingTitle    = '';
    // Pending #EXT-X-BYTERANGE
    let pendingByteRange = null;
    // Discontinuity flag
    let discontinuity = false;
    // Program date-time
    let programDateTime = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-VERSION:')) {
        playlist.version = parseInt(line.split(':')[1], 10);

      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        playlist.targetDuration = parseInt(line.split(':')[1], 10);

      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        playlist.mediaSequence = parseInt(line.split(':')[1], 10);

      } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
        playlist.discontinuitySequence = parseInt(line.split(':')[1], 10);

      } else if (line === '#EXT-X-ENDLIST') {
        playlist.endList = true;

      } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        playlist.playlistType = line.split(':')[1].trim();

      } else if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = parseAttrs(line.slice('#EXT-X-KEY:'.length));
        if (attrs['METHOD'] === 'NONE') {
          currentKey = null;
        } else {
          currentKey = {
            method: attrs['METHOD'],
            uri:    attrs['URI'] ? resolveUri(baseUrl, attrs['URI']) : null,
            iv:     attrs['IV']  ? parseIV(attrs['IV']) : null,
            keyFormat: attrs['KEYFORMAT'] ?? 'identity',
          };
        }

      } else if (line.startsWith('#EXTINF:')) {
        const rest = line.slice('#EXTINF:'.length);
        const comma = rest.indexOf(',');
        pendingDuration = parseFloat(comma === -1 ? rest : rest.slice(0, comma));
        pendingTitle    = comma === -1 ? '' : rest.slice(comma + 1).trim();

      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingByteRange = parseByteRange(line.split(':')[1]);

      } else if (line === '#EXT-X-DISCONTINUITY') {
        discontinuity = true;

      } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        programDateTime = new Date(line.split(':').slice(1).join(':'));

      } else if (!line.startsWith('#') && pendingDuration > 0) {
        // URI line — create a segment
        const sn = playlist.mediaSequence + playlist.segments.length;
        playlist.segments.push({
          uri:           resolveUri(baseUrl, line),
          duration:      pendingDuration,
          title:         pendingTitle,
          sn,                   // sequence number
          key:           currentKey ? { ...currentKey } : null,
          byteRange:     pendingByteRange,
          discontinuity,
          programDateTime,
        });
        // Reset per-segment state
        pendingDuration  = 0;
        pendingTitle     = '';
        pendingByteRange = null;
        discontinuity    = false;
        programDateTime  = null;
      }
    }

    return playlist;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function resolveUri(base, uri) {
    if (!uri) return uri;
    if (/^https?:\/\//i.test(uri)) return uri;
    try { return new URL(uri, base).href; } catch { return uri; }
  }

  function parseResolution(str) {
    if (!str) return null;
    const [w, h] = str.split('x').map(Number);
    return { width: w, height: h };
  }

  function parseByteRange(str) {
    const [length, offset] = str.split('@');
    return {
      length: parseInt(length, 10),
      offset: offset !== undefined ? parseInt(offset, 10) : null,
    };
  }

  function parseIV(str) {
    // IV is a 16-byte hex value prefixed with 0x
    const hex = str.replace(/^0x/i, '');
    const arr = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2) || '00', 16);
    }
    return arr;
  }

  /**
   * segment-loader.js — Fetch HLS segments (and playlists) with:
   *   - Retry logic (up to maxRetries with exponential backoff)
   *   - Bandwidth estimation
   *   - AES-128 decryption support
   *   - Byte-range requests
   */


  const DEFAULT_MAX_RETRIES = 3;
  const BASE_RETRY_DELAY_MS = 1000;

  class SegmentLoader {
    constructor({ maxRetries = DEFAULT_MAX_RETRIES } = {}) {
      this.maxRetries    = maxRetries;
      /** Rolling average download bandwidth in bits/second. */
      this.bandwidth     = 1_000_000; // initial guess: 1 Mbps
      this._keyCache     = new Map(); // URI → CryptoKey
      this._abortCtrl    = null;
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /**
     * Fetch a text resource (playlist).
     * @returns {Promise<string>}
     */
    async loadText(url) {
      const resp = await this._fetchWithRetry(url);
      return resp.text();
    }

    /**
     * Fetch a binary segment.
     * @param {object} segment — from M3U8 parser (has .uri, .byteRange, .key)
     * @returns {Promise<ArrayBuffer>}
     */
    async loadSegment(segment) {
      const headers = {};
      if (segment.byteRange) {
        const { length, offset } = segment.byteRange;
        const start = offset ?? 0;
        headers['Range'] = `bytes=${start}-${start + length - 1}`;
      }

      const t0   = performance.now();
      const resp = await this._fetchWithRetry(segment.uri, { headers });
      const buf  = await resp.arrayBuffer();
      const dt   = (performance.now() - t0) / 1000; // seconds

      // Update bandwidth estimate (simple exponential moving average)
      const bps = (buf.byteLength * 8) / Math.max(dt, 0.001);
      this.bandwidth = this.bandwidth * 0.7 + bps * 0.3;

      if (segment.key) {
        return this._decrypt(buf, segment.key, segment.sn);
      }
      return buf;
    }

    /** Abort any in-flight request. */
    abort() {
      this._abortCtrl?.abort();
    }

    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------

    async _fetchWithRetry(url, options = {}) {
      let lastError;
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        this._abortCtrl = new AbortController();
        try {
          const resp = await fetch(url, {
            ...options,
            signal: this._abortCtrl.signal,
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
          return resp;
        } catch (err) {
          if (err.name === 'AbortError') throw err; // propagate abort immediately
          lastError = err;
          logger.warn(`Fetch failed (attempt ${attempt + 1}/${this.maxRetries + 1}): ${err.message}`);
          if (attempt < this.maxRetries) {
            await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt);
          }
        }
      }
      throw lastError;
    }

    // ---------------------------------------------------------------------------
    // AES-128 decryption (HLS #EXT-X-KEY METHOD=AES-128)
    // ---------------------------------------------------------------------------

    async _decrypt(buffer, keyInfo, segmentSN) {
      const cryptoKey = await this._getCryptoKey(keyInfo.uri);
      const iv        = keyInfo.iv ?? this._makeIV(segmentSN);

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv },
        cryptoKey,
        buffer,
      );
      return decrypted;
    }

    async _getCryptoKey(uri) {
      if (this._keyCache.has(uri)) return this._keyCache.get(uri);

      const resp     = await this._fetchWithRetry(uri);
      const keyBytes = await resp.arrayBuffer();

      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-CBC' },
        false,
        ['decrypt'],
      );
      this._keyCache.set(uri, cryptoKey);
      return cryptoKey;
    }

    /** Build the default IV from the segment sequence number (128-bit big-endian). */
    _makeIV(sn) {
      const iv = new Uint8Array(16);
      const view = new DataView(iv.buffer);
      view.setUint32(12, sn >>> 0, false);
      return iv;
    }
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

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


  /** How many seconds of data to keep BEHIND the current position. */
  const BACK_BUFFER_LENGTH = 30;

  class BufferManager {
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

  /**
   * abr-controller.js — Adaptive Bitrate (ABR) controller
   *
   * Selects the best quality level based on:
   *   1. Available download bandwidth (from SegmentLoader)
   *   2. Buffer health (seconds buffered ahead)
   *   3. A safety margin to avoid oscillation
   *
   * Quality switching rules:
   *   - Switch UP   when bandwidth ≥ level.bandwidth × UPGRADE_FACTOR and
   *                 buffer > MIN_BUFFER_FOR_UPGRADE
   *   - Switch DOWN immediately when bandwidth < current level.bandwidth
   *   - Minimum time between quality switches: SWITCH_COOLDOWN_MS
   */

  const UPGRADE_FACTOR       = 1.4;   // require 40% headroom before upgrading
  const MIN_BUFFER_FOR_UPGRADE = 10;  // seconds buffered before upgrading
  const SWITCH_COOLDOWN_MS    = 5000; // ms between any quality change
  const MAX_BUFFER_LENGTH     = 30;   // stop downloading when buffer > this

  class ABRController {
    /**
     * @param {object[]} levels — sorted array of variant objects (lowest → highest bitrate)
     */
    constructor(levels) {
      this._levels      = levels;
      this._currentIdx  = 0;    // index into levels[]
      this._lastSwitch  = 0;    // timestamp of last quality change
      this._forced      = null; // index if manually overridden by user
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /** Return the current quality level object. */
    get currentLevel() {
      return this._levels[this._currentIdx];
    }

    /** Return the current quality level index. */
    get currentIndex() {
      return this._currentIdx;
    }

    /** Number of available quality levels. */
    get levelCount() {
      return this._levels.length;
    }

    /**
     * Force a specific quality index (user override).
     * Pass null to re-enable automatic ABR.
     */
    forceLevel(index) {
      if (index === null) {
        this._forced = null;
        return;
      }
      if (index >= 0 && index < this._levels.length) {
        this._forced     = index;
        this._currentIdx = index;
      }
    }

    /**
     * Select the best initial quality for a cold start (before any bandwidth
     * estimate is available).  Picks the lowest level.
     */
    selectInitialLevel() {
      this._currentIdx = 0;
      return this._currentIdx;
    }

    /**
     * Decide whether to switch quality levels.
     *
     * @param {number} bandwidth    — estimated bandwidth in bps (from SegmentLoader)
     * @param {number} bufferAhead  — seconds of video buffered ahead of currentTime
     * @returns {{ changed: boolean, index: number }}
     */
    decide(bandwidth, bufferAhead) {
      if (this._forced !== null) {
        return { changed: false, index: this._currentIdx };
      }

      const now = Date.now();
      if (now - this._lastSwitch < SWITCH_COOLDOWN_MS) {
        return { changed: false, index: this._currentIdx };
      }

      // Don't buffer if we already have plenty — conserve bandwidth
      if (bufferAhead > MAX_BUFFER_LENGTH) {
        return { changed: false, index: this._currentIdx };
      }

      const current = this._levels[this._currentIdx];

      // Check if we should switch DOWN (bandwidth too low for current level)
      if (bandwidth < current.bandwidth) {
        const best = this._findBestDowngrade(bandwidth);
        if (best !== this._currentIdx) {
          return this._switch(best);
        }
      }

      // Check if we should switch UP (bandwidth comfortably above next level)
      if (this._currentIdx < this._levels.length - 1 &&
          bufferAhead >= MIN_BUFFER_FOR_UPGRADE) {
        const next = this._levels[this._currentIdx + 1];
        if (bandwidth >= next.bandwidth * UPGRADE_FACTOR) {
          return this._switch(this._currentIdx + 1);
        }
      }

      return { changed: false, index: this._currentIdx };
    }

    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------

    _findBestDowngrade(bandwidth) {
      // Walk from highest to lowest and pick the highest that fits
      for (let i = this._currentIdx - 1; i >= 0; i--) {
        if (this._levels[i].bandwidth <= bandwidth) return i;
      }
      return 0; // fall back to lowest
    }

    _switch(index) {
      this._currentIdx = index;
      this._lastSwitch = Date.now();
      return { changed: true, index };
    }

    /**
     * Return a description of all levels for debugging / UI.
     */
    getLevelSummaries() {
      return this._levels.map((l, i) => ({
        index:      i,
        bandwidth:  l.bandwidth,
        resolution: l.resolution,
        codecs:     l.codecs,
        current:    i === this._currentIdx,
      }));
    }
  }

  /**
   * ts-demuxer.js — MPEG-TS demuxer
   *
   * Reads 188-byte TS packets from an ArrayBuffer and emits:
   *   - H.264 / AVC NAL units  (videoTrack)
   *   - AAC ADTS audio frames  (audioTrack)
   *
   * The transmuxer feeds the output of this class into the fMP4 muxer.
   */

  const TS_SYNC_BYTE  = 0x47;
  const TS_PKT_SIZE   = 188;
  const PAT_PID       = 0x0000;

  // Stream-type constants in PMT
  const STREAM_TYPE_H264 = 0x1B;
  const STREAM_TYPE_AAC  = 0x0F;
  const STREAM_TYPE_AAC2 = 0x11; // ISO 14496-3 with SBR

  class TSDemuxer {
    constructor() {
      this.reset();
    }

    reset() {
      this._pmtPid       = null;
      this._videoPid     = null;
      this._audioPid     = null;
      this._videoBuffer  = null;  // Accumulated PES bytes for current video PES
      this._audioBuffer  = null;
      this._videoPts     = null;  // PTS of _videoBuffer's first PES
      this._videoDts     = null;
      this._audioPts     = null;
      this._audioDts     = null;
      this.videoTrack    = this._newVideoTrack();
      this.audioTrack    = this._newAudioTrack();
      this._videoCC      = -1;   // continuity counter
      this._audioCC      = -1;
    }

    // ---------------------------------------------------------------------------
    // Main entry point
    // ---------------------------------------------------------------------------

    /**
     * Demux a raw TS ArrayBuffer.
     * Returns { videoTrack, audioTrack } – the same objects as this.videoTrack /
     * this.audioTrack after being populated.
     */
    demux(buffer) {
      const data = new Uint8Array(buffer);

      // Find first sync byte (handles optional 4-byte timestamp prepended by some
      // CDNs / hardware encoders).
      let start = 0;
      for (let s = 0; s < 4; s++) {
        if (data[s] === TS_SYNC_BYTE && data[s + TS_PKT_SIZE] === TS_SYNC_BYTE) {
          start = s;
          break;
        }
      }

      for (let i = start; i + TS_PKT_SIZE <= data.length; i += TS_PKT_SIZE) {
        if (data[i] !== TS_SYNC_BYTE) continue; // lost sync — skip
        this._parsePacket(data, i);
      }

      // Flush any remaining PES data
      this._pushVideoNALUs(true);
      this._pushAudioFrames(true);

      return { videoTrack: this.videoTrack, audioTrack: this.audioTrack };
    }

    // ---------------------------------------------------------------------------
    // TS packet parsing
    // ---------------------------------------------------------------------------

    _parsePacket(data, offset) {
      // TS Header (4 bytes)
      const byte1   = data[offset + 1];
      const byte2   = data[offset + 2];
      const byte3   = data[offset + 3];

      const pusiFlag  = (byte1 & 0x40) !== 0;  // Payload Unit Start Indicator
      const pid       = ((byte1 & 0x1F) << 8) | byte2;
      const adaptCtrl = (byte3 & 0x30) >> 4;   // 01=payload only, 10=adapt only, 11=adapt+payload
      const cc        = byte3 & 0x0F;          // continuity counter

      // Skip transport error or null packets
      if (byte1 & 0x80) return;
      if (pid === 0x1FFF) return;

      let payloadOffset = offset + 4;
      if (adaptCtrl & 0x2) {
        // Adaptation field present
        const adaptLen = data[payloadOffset];
        payloadOffset += 1 + adaptLen;
      }
      if (!(adaptCtrl & 0x1)) return; // no payload

      const payload = data.subarray(payloadOffset, offset + TS_PKT_SIZE);

      if (pid === PAT_PID) {
        this._parsePAT(payload);
      } else if (pid === this._pmtPid) {
        this._parsePMT(payload);
      } else if (pid === this._videoPid) {
        this._handlePES(payload, pusiFlag, cc, 'video');
      } else if (pid === this._audioPid) {
        this._handlePES(payload, pusiFlag, cc, 'audio');
      }
    }

    // ---------------------------------------------------------------------------
    // PAT (Program Association Table)
    // ---------------------------------------------------------------------------

    _parsePAT(payload) {
      // Skip pointer field
      const tableOffset = payload[0] + 1;
      const tableId     = payload[tableOffset];
      if (tableId !== 0x00) return; // not PAT

      // section_length
      const sectionLen = ((payload[tableOffset + 1] & 0x0F) << 8) | payload[tableOffset + 2];
      // program entries start after 8-byte fixed header, end before 4-byte CRC
      const entriesEnd = tableOffset + 3 + sectionLen - 4;
      let i = tableOffset + 8;
      while (i < entriesEnd) {
        const programNum = (payload[i] << 8) | payload[i + 1];
        const pmtPid     = ((payload[i + 2] & 0x1F) << 8) | payload[i + 3];
        if (programNum !== 0) {
          this._pmtPid = pmtPid;
          break; // take the first non-NIT program
        }
        i += 4;
      }
    }

    // ---------------------------------------------------------------------------
    // PMT (Program Map Table)
    // ---------------------------------------------------------------------------

    _parsePMT(payload) {
      const tableOffset = payload[0] + 1;
      const tableId     = payload[tableOffset];
      if (tableId !== 0x02) return; // not PMT

      const sectionLen = ((payload[tableOffset + 1] & 0x0F) << 8) | payload[tableOffset + 2];
      const programInfoLen = ((payload[tableOffset + 10] & 0x0F) << 8) | payload[tableOffset + 11];

      let i = tableOffset + 12 + programInfoLen;
      const sectionEnd = tableOffset + 3 + sectionLen - 4;

      while (i < sectionEnd) {
        const streamType = payload[i];
        const elemPid    = ((payload[i + 1] & 0x1F) << 8) | payload[i + 2];
        const esInfoLen  = ((payload[i + 3] & 0x0F) << 8) | payload[i + 4];

        if (streamType === STREAM_TYPE_H264) {
          this._videoPid = elemPid;
          this.videoTrack.pid = elemPid;
        } else if (streamType === STREAM_TYPE_AAC || streamType === STREAM_TYPE_AAC2) {
          this._audioPid = elemPid;
          this.audioTrack.pid = elemPid;
        }

        i += 5 + esInfoLen;
      }
    }

    // ---------------------------------------------------------------------------
    // PES (Packetized Elementary Stream) accumulation
    // ---------------------------------------------------------------------------

    _handlePES(payload, pusi, cc, trackType) {
      if (trackType === 'video') {
        if (pusi) {
          // Start of new PES — flush previous
          this._pushVideoNALUs(false);
          const { pts, dts, headerLen } = this._parsePESHeader(payload);
          this._videoPts    = pts;
          this._videoDts    = dts;
          this._videoBuffer = payload.slice(headerLen);
          this._videoCC     = cc;
        } else if (this._videoBuffer) {
          this._videoBuffer = concatUint8(this._videoBuffer, payload);
        }
      } else {
        if (pusi) {
          this._pushAudioFrames(false);
          const { pts, dts, headerLen } = this._parsePESHeader(payload);
          this._audioPts    = pts;
          this._audioDts    = dts;
          this._audioBuffer = payload.slice(headerLen);
          this._audioCC     = cc;
        } else if (this._audioBuffer) {
          this._audioBuffer = concatUint8(this._audioBuffer, payload);
        }
      }
    }

    // ---------------------------------------------------------------------------
    // PES header parsing
    // ---------------------------------------------------------------------------

    _parsePESHeader(data) {
      // Bytes 0-2: start code prefix (0x000001)
      // Byte  3  : stream id
      // Bytes 4-5: PES packet length
      // Byte  6  : flags
      // Byte  7  : flags2 (PTS/DTS presence etc.)
      // Byte  8  : PES header data length
      if (data[0] !== 0x00 || data[1] !== 0x00 || data[2] !== 0x01) {
        return { pts: null, dts: null, headerLen: 6 };
      }

      const flags2      = data[7];
      const headerLen   = 9 + data[8]; // fixed 9 + variable optional fields
      const ptsDtsFlags = (flags2 & 0xC0) >> 6;

      let pts = null, dts = null;
      if (ptsDtsFlags >= 2) {
        pts = this._readTimestamp(data, 9);
      }
      if (ptsDtsFlags === 3) {
        dts = this._readTimestamp(data, 14);
      } else {
        dts = pts;
      }

      return { pts, dts, headerLen };
    }

    /** Read a 33-bit PTS/DTS value from 5 bytes starting at offset. */
    _readTimestamp(data, offset) {
      return ((data[offset] & 0x0E) * 536870912) +  // bits 32-30: *2^29
             ((data[offset + 1] & 0xFF) * 4194304) + // bits 29-22
             ((data[offset + 2] & 0xFE) * 16384)   + // bits 21-15
             ((data[offset + 3] & 0xFF) * 128)      + // bits 14-7
             ((data[offset + 4] & 0xFE) >> 1);        // bits 6-0
    }

    // ---------------------------------------------------------------------------
    // H.264 NAL unit extraction (Annex B → length-prefixed)
    // ---------------------------------------------------------------------------

    _pushVideoNALUs(flush) {
      if (!this._videoBuffer) return;

      const data  = this._videoBuffer;
      const pts   = this._videoPts;
      const dts   = this._videoDts;
      const nalus = [];

      // Parse Annex B start codes (0x000001 or 0x00000001)
      let start = -1;
      let i     = 0;

      const at3 = (pos) =>
        data[pos] === 0x00 && data[pos + 1] === 0x00 && data[pos + 2] === 0x01;

      while (i < data.length - 3) {
        const is4byte = data[i] === 0x00 && at3(i + 1);
        const is3byte = !is4byte && at3(i);
        if (is4byte || is3byte) {
          if (start !== -1) {
            nalus.push(data.subarray(start, i));
          }
          start = i + (is4byte ? 4 : 3);
          i     = start;
        } else {
          i++;
        }
      }
      if (start !== -1 && start < data.length) {
        nalus.push(data.subarray(start));
      }

      if (nalus.length === 0) {
        if (flush) {
          this._videoBuffer = null;
          this._videoPts = null;
          this._videoDts = null;
        }
        return;
      }

      // Extract SPS / PPS, detect keyframe
      let isKeyframe = false;
      for (const nalu of nalus) {
        const naluType = nalu[0] & 0x1F;
        if (naluType === 7) {                 // SPS
          this.videoTrack.sps = nalu.slice();
          this.videoTrack.codec = buildAVCCodecString(nalu);
        } else if (naluType === 8) {          // PPS
          this.videoTrack.pps = nalu.slice();
        } else if (naluType === 5) {          // IDR — keyframe
          isKeyframe = true;
        }
      }

      // Store as a sample
      this.videoTrack.samples.push({
        pts,
        dts: dts ?? pts,
        nalus,
        keyframe: isKeyframe,
      });

      { // always clear after pushing
        this._videoBuffer = null;
        this._videoPts    = null;
        this._videoDts    = null;
      }
    }

    // ---------------------------------------------------------------------------
    // AAC ADTS frame extraction
    // ---------------------------------------------------------------------------

    _pushAudioFrames(flush) {
      if (!this._audioBuffer) return;

      const data = this._audioBuffer;
      let i = 0;

      while (i < data.length - 7) {
        // ADTS sync word: 0xFFF (12 bits)
        if ((data[i] !== 0xFF) || ((data[i + 1] & 0xF0) !== 0xF0)) {
          i++;
          continue;
        }

        (data[i + 1] & 0x08) >> 3; // 0=MPEG-4, 1=MPEG-2
        const profile       = ((data[i + 2] & 0xC0) >> 6) + 1; // 1=AAC-LC, 2=SBR…
        const samplingIndex = (data[i + 2] & 0x3C) >> 2;
        const channelConf   = ((data[i + 2] & 0x01) << 2) | ((data[i + 3] & 0xC0) >> 6);
        const frameLength   = ((data[i + 3] & 0x03) << 11) |
                               (data[i + 4] << 3) |
                               ((data[i + 5] & 0xE0) >> 5);
        const headerLen     = (data[i + 1] & 0x01) ? 7 : 9; // no or with CRC

        if (frameLength < headerLen || i + frameLength > data.length) break;

        if (!this.audioTrack.config) {
          const config = buildAACConfig(profile, samplingIndex, channelConf);
          this.audioTrack.config        = config;
          this.audioTrack.sampleRate    = AAC_SAMPLE_RATES[samplingIndex] ?? 44100;
          this.audioTrack.channelCount  = channelConf;
          this.audioTrack.codec         = `mp4a.40.${profile}`;
        }

        const frame = data.subarray(i + headerLen, i + frameLength);
        this.audioTrack.samples.push({
          pts: this._audioPts,
          dts: this._audioDts ?? this._audioPts,
          data: frame.slice(),
        });

        i += frameLength;
      }

      if (flush) {
        this._audioBuffer = null;
        this._audioPts    = null;
        this._audioDts    = null;
      }
    }

    // ---------------------------------------------------------------------------
    // Track factories
    // ---------------------------------------------------------------------------

    _newVideoTrack() {
      return { pid: null, samples: [], sps: null, pps: null, codec: '' };
    }

    _newAudioTrack() {
      return { pid: null, samples: [], config: null, sampleRate: 0, channelCount: 0, codec: '' };
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function concatUint8(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  /**
   * Build an AVC codec string (avc1.PPCCLL) from a raw SPS NALU.
   * PP = profile_idc, CC = constraint flags byte, LL = level_idc
   */
  function buildAVCCodecString(sps) {
    const p = sps[1].toString(16).padStart(2, '0');
    const c = sps[2].toString(16).padStart(2, '0');
    const l = sps[3].toString(16).padStart(2, '0');
    return `avc1.${p}${c}${l}`;
  }

  /** Standard AAC sample-rate table (ISO 14496-3 Table 4.84) */
  const AAC_SAMPLE_RATES = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025,  8000,  7350,
  ];

  /**
   * Build a 2-byte ASC (AudioSpecificConfig) for mp4a.
   * profile   : 1=AAC-LC, 2=HE-AAC, 5=SBR
   * srIndex   : sampling frequency index
   * channels  : channel configuration
   */
  function buildAACConfig(profile, srIndex, channels) {
    const config = new Uint8Array(2);
    config[0] = (profile << 3) | (srIndex >> 1);
    config[1] = ((srIndex & 0x01) << 7) | (channels << 3);
    return config;
  }

  /**
   * mp4-muxer.js — fragmented MP4 (ISO BMFF) writer
   *
   * Produces:
   *   initSegment  — ftyp + moov (sent once per track configuration)
   *   fragment     — moof + mdat (sent for every group of samples)
   *
   * All values are big-endian as required by ISO BMFF.
   */

  const TIMESCALE = 90000; // 90 kHz — same as MPEG-TS PTS/DTS

  // ---------------------------------------------------------------------------
  // Binary writing primitives
  // ---------------------------------------------------------------------------

  /** Concatenate Uint8Arrays / ArrayBuffers into a single Uint8Array. */
  function concat(...parts) {
    let total = 0;
    for (const p of parts) total += p.byteLength ?? p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p instanceof ArrayBuffer ? new Uint8Array(p) : p, off);
      off += p.byteLength ?? p.length;
    }
    return out;
  }

  function u8(v)  { return new Uint8Array([v & 0xFF]); }
  function u16(v) { return new Uint8Array([(v >> 8) & 0xFF, v & 0xFF]); }
  function u32(v) {
    return new Uint8Array([
      (v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF,
    ]);
  }
  function i32(v) { return u32(v >>> 0); } // same bit pattern
  function ascii(s) { return new Uint8Array([...s].map(c => c.charCodeAt(0))); }
  function zeros(n) { return new Uint8Array(n); }

  /** Build an ISOBMFF box: [size(4)] [type(4)] [payload…] */
  function box(type, ...payloads) {
    const body    = concat(...payloads);
    const size    = u32(8 + body.length);
    return concat(size, ascii(type), body);
  }

  /** Build a FullBox: box + version(1) + flags(3) */
  function fullBox(type, version, flags, ...payloads) {
    return box(type, u8(version), u8((flags >> 16) & 0xFF), u8((flags >> 8) & 0xFF), u8(flags & 0xFF), ...payloads);
  }

  // ---------------------------------------------------------------------------
  // Initialization segment — ftyp + moov
  // ---------------------------------------------------------------------------

  /**
   * Create the initialization segment.
   * @param {object} videoTrack — from TSDemuxer (has sps, pps, codec)
   * @param {object} audioTrack — from TSDemuxer (has config, sampleRate, channelCount)
   */
  function createInitSegment(videoTrack, audioTrack) {
    const ftyp = makeFtyp();
    const moov = makeMoov(videoTrack, audioTrack);
    return concat(ftyp, moov).buffer;
  }

  function makeFtyp() {
    return box('ftyp',
      ascii('iso5'),  // major brand
      u32(1),         // minor version
      ascii('iso5'),
      ascii('iso6'),
      ascii('mp41'),
    );
  }

  function makeMoov(videoTrack, audioTrack) {
    const mvhd = makeMvhd();
    const vtrak = videoTrack.sps ? makeVideoTrak(videoTrack) : new Uint8Array(0);
    const atrak = audioTrack.config ? makeAudioTrak(audioTrack) : new Uint8Array(0);
    const mvex  = makeMvex(
      videoTrack.sps  ? 1 : null,
      audioTrack.config ? 2 : null,
    );
    return box('moov', mvhd, vtrak, atrak, mvex);
  }

  function makeMvhd() {
    return fullBox('mvhd', 0, 0,
      u32(0),       // creation time
      u32(0),       // modification time
      u32(TIMESCALE),
      u32(0),       // duration (unknown)
      u32(0x00010000), // rate 1.0
      u16(0x0100),  // volume 1.0
      zeros(10),    // reserved
      // identity matrix
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      zeros(24),    // pre-defined
      u32(0xFFFFFFFF), // next track ID
    );
  }

  // ---------------------------------------------------------------------------
  // Video trak
  // ---------------------------------------------------------------------------

  function makeVideoTrak(track) {
    return box('trak',
      makeVideoTkhd(),
      makeVideoMdia(track),
    );
  }

  function makeVideoTkhd() {
    return fullBox('tkhd', 0, 3, // version 0, flags=3 (enabled+in-movie)
      u32(0), u32(0),   // creation / modification time
      u32(1),           // track id
      u32(0),           // reserved
      u32(0),           // duration
      zeros(8),         // reserved
      u16(0), u16(0),   // layer, alternate group
      u16(0),           // volume (0 for video)
      u16(0),           // reserved
      // identity matrix
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(0), u32(0),   // width / height (0 = from SPS) — browsers parse SPS
    );
  }

  function makeVideoMdia(track) {
    return box('mdia',
      makeVideoMdhd(),
      makeHdlr('vide', 'VideoHandler'),
      makeVideoMinf(track),
    );
  }

  function makeVideoMdhd() {
    return fullBox('mdhd', 0, 0,
      u32(0), u32(0),      // creation / modification
      u32(TIMESCALE),      // timescale
      u32(0),              // duration
      u16(0x55C4),         // language: 'und'
      u16(0),              // pre-defined
    );
  }

  function makeHdlr(handlerType, name) {
    return fullBox('hdlr', 0, 0,
      u32(0),              // pre-defined
      ascii(handlerType),  // handler_type
      zeros(12),           // reserved
      new Uint8Array([...name].map(c => c.charCodeAt(0)), 0), // name (null-terminated)
      u8(0),
    );
  }

  function makeVideoMinf(track) {
    return box('minf',
      box('vmhd', zeros(8)), // fullBox version=0 flags=1 + graphicsMode + opcolor
      makeDinf(),
      makeVideoStbl(track),
    );
  }

  function makeDinf() {
    const dref = fullBox('dref', 0, 0,
      u32(1), // entry count
      fullBox('url ', 0, 1), // self-contained
    );
    return box('dinf', dref);
  }

  function makeVideoStbl(track) {
    // avcC (AVCDecoderConfigurationRecord)
    const sps = track.sps;
    const pps = track.pps ?? new Uint8Array(0);

    const avcc = concat(
      u8(1),            // configurationVersion
      u8(sps[1]),       // AVCProfileIndication
      u8(sps[2]),       // profile_compatibility
      u8(sps[3]),       // AVCLevelIndication
      u8(0xFF),         // lengthSizeMinusOne = 3 (4-byte NAL length prefix)
      u8(0xE1),         // numSequenceParameterSets = 1
      u16(sps.length), sps,
      u8(1),            // numPictureParameterSets = 1
      u16(pps.length), pps,
    );

    const avc1 = box('avc1',
      zeros(6),           // reserved
      u16(1),             // data-reference-index
      zeros(16),          // pre-defined + reserved
      u16(0), u16(0),     // width / height (0 = parse from SPS)
      u32(0x00480000),    // horizresolution 72 dpi
      u32(0x00480000),    // vertresolution  72 dpi
      u32(0),             // reserved
      u16(1),             // frame count
      zeros(32),          // compressorname
      u16(0x0018),        // depth
      i32(-1),            // pre-defined
      box('avcC', avcc),
    );

    return box('stbl',
      fullBox('stsd', 0, 0, u32(1), avc1),
      fullBox('stts', 0, 0, u32(0)), // empty — filled by trun in moof
      fullBox('stsc', 0, 0, u32(0)),
      fullBox('stsz', 0, 0, u32(0), u32(0)),
      fullBox('stco', 0, 0, u32(0)),
    );
  }

  // ---------------------------------------------------------------------------
  // Audio trak
  // ---------------------------------------------------------------------------

  function makeAudioTrak(track) {
    return box('trak',
      makeAudioTkhd(),
      makeAudioMdia(track),
    );
  }

  function makeAudioTkhd() {
    return fullBox('tkhd', 0, 3,
      u32(0), u32(0),
      u32(2),           // track id = 2
      u32(0),
      u32(0),
      zeros(8),
      u16(0), u16(1),   // layer 0, alternate group 1
      u16(0x0100),      // volume 1.0
      u16(0),
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(0), u32(0),   // width / height (0 for audio)
    );
  }

  function makeAudioMdia(track) {
    return box('mdia',
      makeAudioMdhd(track),
      makeHdlr('soun', 'SoundHandler'),
      makeAudioMinf(track),
    );
  }

  function makeAudioMdhd(track) {
    return fullBox('mdhd', 0, 0,
      u32(0), u32(0),
      u32(track.sampleRate),
      u32(0),
      u16(0x55C4), // 'und'
      u16(0),
    );
  }

  function makeAudioMinf(track) {
    return box('minf',
      fullBox('smhd', 0, 0, u16(0), u16(0)), // balance
      makeDinf(),
      makeAudioStbl(track),
    );
  }

  function makeAudioStbl(track) {
    const esds = makeEsds(track);
    const mp4a = box('mp4a',
      zeros(6),
      u16(1),           // data-reference-index
      zeros(8),         // reserved
      u16(track.channelCount),
      u16(16),          // sample size
      u16(0), u16(0),   // pre-defined + reserved
      u32(track.sampleRate << 16), // samplerate (16.16 fixed point)
      esds,
    );

    return box('stbl',
      fullBox('stsd', 0, 0, u32(1), mp4a),
      fullBox('stts', 0, 0, u32(0)),
      fullBox('stsc', 0, 0, u32(0)),
      fullBox('stsz', 0, 0, u32(0), u32(0)),
      fullBox('stco', 0, 0, u32(0)),
    );
  }

  function makeEsds(track) {
    const asc = track.config; // 2-byte AudioSpecificConfig
    // ES_Descriptor
    const esDesc = concat(
      u8(0x03),            // tag ES_DescrTag
      u8(0x19),            // length (25)
      u16(0x0001),         // ES_ID
      u8(0x00),            // flags
      u8(0x04),            // tag DecoderConfigDescrTag
      u8(0x11),            // length (17)
      u8(0x40),            // objectTypeIndication = Audio ISO/IEC 14496-3
      u8(0x15),            // streamType=audio(0x05)<<2 | upstream(0)<<1 | 1
      u8(0x00), u16(0),    // bufferSizeDB (3 bytes)
      u32(0),              // maxBitrate
      u32(0),              // avgBitrate
      u8(0x05),            // tag DecoderSpecificInfoTag
      u8(asc.length),
      ...asc,
      u8(0x06),            // tag SLConfigDescrTag
      u8(0x01),            // length
      u8(0x02),            // predefined
    );

    return fullBox('esds', 0, 0, esDesc);
  }

  // ---------------------------------------------------------------------------
  // mvex / trex
  // ---------------------------------------------------------------------------

  function makeMvex(videoTrackId, audioTrackId) {
    const trexes = [];
    if (videoTrackId != null) trexes.push(makeTrex(videoTrackId));
    if (audioTrackId != null) trexes.push(makeTrex(audioTrackId));
    return box('mvex', ...trexes);
  }

  function makeTrex(trackId) {
    return fullBox('trex', 0, 0,
      u32(trackId),
      u32(1),   // default sample description index
      u32(0),   // default sample duration
      u32(0),   // default sample size
      u32(0),   // default sample flags
    );
  }

  // ---------------------------------------------------------------------------
  // Media fragment — moof + mdat
  // ---------------------------------------------------------------------------

  /**
   * Create a media fragment from processed samples.
   *
   * @param {number} sequenceNumber  — monotonically increasing fragment counter
   * @param {Array}  videoSamples    — [{ dts, pts, nalus, keyframe }]
   * @param {Array}  audioSamples    — [{ dts, pts, data }]
   * @param {object} videoTrack
   * @param {object} audioTrack
   */
  function createMediaFragment(sequenceNumber, videoSamples, audioSamples, videoTrack, audioTrack) {
    const parts = [];

    // Build video traf
    if (videoSamples.length > 0) {
      const { traf, mdatData } = makeVideoTraf(1, videoSamples);
      parts.push({ traf, mdatData, trackId: 1 });
    }

    // Build audio traf
    if (audioSamples.length > 0) {
      const { traf, mdatData } = makeAudioTraf(2, audioSamples, audioTrack);
      parts.push({ traf, mdatData, trackId: 2 });
    }

    if (parts.length === 0) return null;

    // We need to know the total moof size before we can write the data_offset
    // in trun. Strategy: build moof twice — first pass to get size, second to fix offset.
    const mfhd  = makeMfhd(sequenceNumber);
    const trafs = parts.map(p => p.traf);

    // Calculate moof size
    let moofSize = 8 + mfhd.length; // box header + mfhd
    for (const t of trafs) moofSize += t.length;

    // Fix data_offset in each trun (offset from start of moof to first mdat byte)
    // moof size + 8 bytes (mdat header) = offset to first byte of mdat payload
    // But each traf's mdat follows sequentially. We need to walk them.
    let mdatOffset = moofSize + 8; // +8 for first mdat box header
    for (let i = 0; i < parts.length; i++) {
      patchTrunDataOffset(parts[i].traf, mdatOffset);
      mdatOffset += 8 + parts[i].mdatData.length; // advance past this mdat
    }

    // Re-assemble moof with patched trafs
    const moof = box('moof', mfhd, ...parts.map(p => p.traf));

    // Build mdat boxes
    const mdats = parts.map(p => box('mdat', p.mdatData));

    return concat(moof, ...mdats).buffer;
  }

  function makeMfhd(seqNum) {
    return fullBox('mfhd', 0, 0, u32(seqNum));
  }

  // ---------------------------------------------------------------------------
  // Video traf / trun
  // ---------------------------------------------------------------------------

  function makeVideoTraf(trackId, samples, seqNum) {
    const firstSample  = samples[0];
    const baseMediaDecodeTime = firstSample.dts ?? 0;

    // Build raw NAL data (4-byte length prefix per NALU)
    const rawParts = [];
    const sampleInfos = [];

    for (const sample of samples) {
      let sampleSize = 0;
      for (const nalu of sample.nalus) {
        rawParts.push(u32(nalu.length), nalu instanceof Uint8Array ? nalu : new Uint8Array(nalu));
        sampleSize += 4 + nalu.length;
      }

      const cts = Math.max(0, (sample.pts ?? sample.dts) - sample.dts); // composition time offset
      sampleInfos.push({
        duration:  0,              // filled by gap between dts values later
        size:      sampleSize,
        flags:     sample.keyframe ? 0x02000000 : 0x01010000, // keyframe vs non-keyframe
        cts,
      });
    }

    // Fill in durations (dts delta)
    for (let i = 0; i < sampleInfos.length - 1; i++) {
      sampleInfos[i].duration = Math.max(0, samples[i + 1].dts - samples[i].dts);
    }
    // Last sample: use same duration as second-to-last (common heuristic)
    if (sampleInfos.length > 1) {
      sampleInfos[sampleInfos.length - 1].duration = sampleInfos[sampleInfos.length - 2].duration;
    } else {
      sampleInfos[0].duration = 3000; // ~33ms at 90kHz for 30fps
    }

    const mdatData = concat(...rawParts);

    const tfhd = fullBox('tfhd', 0, 0x020000, // base-data-offset-present=0, default-base-is-moof=1
      u32(trackId),
    );
    const tfdt = fullBox('tfdt', 0, 0,
      u32(baseMediaDecodeTime),
    );
    const trun = makeTrun(sampleInfos, 0); // data_offset placeholder 0, patched later

    const traf = box('traf', tfhd, tfdt, trun);
    return { traf, mdatData };
  }

  // ---------------------------------------------------------------------------
  // Audio traf / trun
  // ---------------------------------------------------------------------------

  function makeAudioTraf(trackId, samples, audioTrack) {
    const baseMediaDecodeTime = samples[0].dts ?? 0;
    const samplesPerFrame     = 1024; // AAC LC frames are always 1024 samples

    const rawParts    = [];
    const sampleInfos = [];

    for (const sample of samples) {
      rawParts.push(sample.data instanceof Uint8Array ? sample.data : new Uint8Array(sample.data));
      sampleInfos.push({
        duration: Math.round(samplesPerFrame / audioTrack.sampleRate * TIMESCALE),
        size:     sample.data.length,
        flags:    0x02000000, // no sync flag needed for audio
        cts:      0,
      });
    }

    const mdatData = concat(...rawParts);

    const tfhd = fullBox('tfhd', 0, 0x020000,
      u32(trackId),
    );
    const tfdt = fullBox('tfdt', 0, 0,
      u32(baseMediaDecodeTime),
    );
    const trun = makeTrun(sampleInfos, 0);

    const traf = box('traf', tfhd, tfdt, trun);
    return { traf, mdatData };
  }

  // ---------------------------------------------------------------------------
  // trun
  // ---------------------------------------------------------------------------

  /**
   * Build a Track Fragment Run box.
   * flags 0xF01 = data-offset-present | sample-duration | sample-size |
   *               sample-flags | sample-composition-time-offset
   */
  function makeTrun(samples, dataOffset) {
    const flags = 0x000F01;
    const count = u32(samples.length);
    const doff  = i32(dataOffset);
    const entries = [];
    for (const s of samples) {
      entries.push(u32(s.duration), u32(s.size), u32(s.flags), i32(s.cts));
    }
    return fullBox('trun', 0, flags, count, doff, ...entries);
  }

  /**
   * Patch the data_offset field inside a trun box that's embedded in a traf.
   * We scan for the trun box by its 4-byte type tag, then update bytes 16-19
   * (after fullBox header = 4+4+4 = 12 bytes, then sample count = 4, then offset = 4).
   */
  function patchTrunDataOffset(traf, dataOffset) {
    const trunTag = [0x74, 0x72, 0x75, 0x6E]; // 'trun'
    for (let i = 0; i < traf.length - 4; i++) {
      if (traf[i + 4] === trunTag[0] && traf[i + 5] === trunTag[1] &&
          traf[i + 6] === trunTag[2] && traf[i + 7] === trunTag[3]) {
        // trun starts at i; data_offset is at byte 16 (skip: size(4)+type(4)+version(1)+flags(3)+sampleCount(4))
        const view = new DataView(traf.buffer, traf.byteOffset + i + 16, 4);
        view.setInt32(0, dataOffset, false);
        return;
      }
    }
  }

  /**
   * transmuxer.js — MPEG-TS → fragmented MP4 pipeline
   *
   * Wires TSDemuxer → MP4Muxer and exposes a clean API:
   *
   *   const tx = new Transmuxer();
   *   const { init, fragments } = tx.transmux(tsBuffer);
   *   // init      — ArrayBuffer (send once to MSE as initialization segment)
   *   // fragments — ArrayBuffer[] (one fMP4 fragment per call)
   */


  class Transmuxer {
    constructor() {
      this._demuxer     = new TSDemuxer();
      this._initialized = false;
      this._seqNum      = 0;
      this._videoTrack  = null;
      this._audioTrack  = null;
    }

    /**
     * Transmux a raw MPEG-TS ArrayBuffer.
     *
     * @returns {{ init: ArrayBuffer|null, fragment: ArrayBuffer|null }}
     *   init     — initialization segment (only on the first call, or after reset)
     *   fragment — media fragment (may be null if no samples decoded yet)
     */
    transmux(tsBuffer) {
      const { videoTrack, audioTrack } = this._demuxer.demux(tsBuffer);

      // Store track metadata discovered from the first segment
      if (!this._videoTrack && videoTrack.sps)   this._videoTrack = videoTrack;
      if (!this._audioTrack && audioTrack.config) this._audioTrack = audioTrack;

      let init = null;

      if (!this._initialized &&
          (videoTrack.sps || audioTrack.config)) {
        init = createInitSegment(
          videoTrack.sps   ? videoTrack  : { sps: null, pps: null },
          audioTrack.config ? audioTrack : { config: null },
        );
        this._initialized = true;
      }

      const vSamples = videoTrack.samples.slice();
      const aSamples = audioTrack.samples.slice();

      let fragment = null;
      if (vSamples.length > 0 || aSamples.length > 0) {
        fragment = createMediaFragment(
          ++this._seqNum,
          vSamples,
          aSamples,
          videoTrack,
          audioTrack,
        );
      }

      // Clear samples for next segment — demuxer resets its own buffers already
      videoTrack.samples = [];
      audioTrack.samples = [];

      return { init, fragment };
    }

    /**
     * Reset the transmuxer state (e.g. after a discontinuity or seek).
     */
    reset() {
      this._demuxer.reset();
      this._initialized = false;
      this._seqNum      = 0;
      this._videoTrack  = null;
      this._audioTrack  = null;
    }
  }

  /**
   * hls-player.js — Main HLS player orchestrator
   *
   * Lifecycle:
   *   new HLSPlayer(videoEl, options)
   *   player.load(url)        — attach a stream
   *   player.destroy()        — tear down
   *
   * Events (via EventEmitter):
   *   manifest_loaded   { masterPlaylist }
   *   level_loaded      { mediaPlaylist, levelIndex }
   *   frag_loading      { segment }
   *   frag_loaded       { segment, buffer }
   *   level_switched    { index, level }
   *   error             { type, details, fatal, error }
   *   buffer_created    { tracks }
   *   media_attached    { videoEl }
   */


  /** How many seconds to buffer ahead before pausing downloads. */
  const TARGET_BUFFER     = 20;
  /** Live playlist refresh: fraction of target duration to use as interval. */
  const LIVE_REFRESH_FRAC = 0.5;

  class HLSPlayer extends EventEmitter {
    /**
     * @param {HTMLVideoElement} videoEl
     * @param {object}           [options]
     * @param {boolean}          [options.debug=false]
     * @param {number}           [options.maxBufferLength=TARGET_BUFFER]
     * @param {number}           [options.maxRetries=3]
     */
    constructor(videoEl, options = {}) {
      super();
      this._video   = videoEl;
      this._opts    = {
        debug:           options.debug           ?? false,
        maxBufferLength: options.maxBufferLength ?? TARGET_BUFFER,
        maxRetries:      options.maxRetries      ?? 3,
      };

      if (this._opts.debug) logger.enabled = true;

      this._loader       = new SegmentLoader({ maxRetries: this._opts.maxRetries });
      this._bufMgr       = new BufferManager(videoEl);
      this._transmuxer   = new Transmuxer();
      this._abr          = null;

      this._masterPlaylist = null;
      this._mediaPlaylist  = null;
      this._currentLevelIdx = 0;

      this._segmentQueue   = [];  // segments waiting to be loaded
      this._loadedSNs      = new Set(); // sequence numbers already appended
      this._loading        = false;
      this._destroyed      = false;
      this._liveRefreshTimer = null;
      this._tickTimer        = null;

      // State: IDLE | LOADING | READY | ENDED | ERROR
      this._state = 'IDLE';

      this._bindVideoEvents();
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /**
     * Load an HLS stream.
     * @param {string} url — URL of the master or media M3U8 playlist
     */
    async load(url) {
      this._assertNotDestroyed();
      this._state = 'LOADING';
      this._streamUrl = url;

      try {
        // Check for native HLS support (Safari) — use it directly when available
        if (this._video.canPlayType('application/vnd.apple.mpegurl') &&
            !this._opts.forceJS) {
          logger.log('Using native HLS playback');
          this._video.src = url;
          this._state = 'READY';
          return;
        }

        if (!window.MediaSource) {
          throw new Error('MediaSource API not available in this browser');
        }

        await this._loadManifest(url);
      } catch (err) {
        this._emitError('network', 'manifestLoadError', true, err);
      }
    }

    /** Force a specific quality level index. Pass null to re-enable ABR. */
    setLevel(index) {
      this._abr?.forceLevel(index);
    }

    /** All available quality levels (from master playlist). */
    get levels() {
      return this._abr?.getLevelSummaries() ?? [];
    }

    /** Current quality level index. */
    get currentLevel() {
      return this._abr?.currentIndex ?? 0;
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      clearTimeout(this._liveRefreshTimer);
      clearTimeout(this._tickTimer);
      this._loader.abort();
      this._bufMgr.destroy();
      this._state = 'IDLE';
      this.removeAllListeners();
      logger.log('HLSPlayer destroyed');
    }

    // ---------------------------------------------------------------------------
    // Manifest loading
    // ---------------------------------------------------------------------------

    async _loadManifest(url) {
      logger.log('Loading manifest:', url);
      const text = await this._loader.loadText(url);
      const playlist = parseM3U8(text, url);

      if (playlist.type === 'master') {
        this._masterPlaylist = playlist;
        this.emit('manifest_loaded', { masterPlaylist: playlist });

        if (playlist.variants.length === 0) {
          throw new Error('Master playlist contains no variants');
        }

        this._abr = new ABRController(playlist.variants);
        const idx = this._abr.selectInitialLevel();
        await this._loadLevel(idx);

      } else {
        // Direct media playlist (no master)
        this._masterPlaylist = null;
        this._abr = new ABRController([{ bandwidth: 0, uri: url }]);
        this._mediaPlaylist = playlist;
        this.emit('level_loaded', { mediaPlaylist: playlist, levelIndex: 0 });
        await this._initMSE(playlist);
      }
    }

    async _loadLevel(index) {
      const variant = this._masterPlaylist.variants[index];
      logger.log(`Loading level ${index} (${Math.round(variant.bandwidth / 1000)} kbps)`);

      const text     = await this._loader.loadText(variant.uri);
      const playlist = parseM3U8(text, variant.uri);

      this._mediaPlaylist   = playlist;
      this._currentLevelIdx = index;
      this.emit('level_loaded', { mediaPlaylist: playlist, levelIndex: index });

      if (index === 0) {
        // First load — set up MSE pipeline
        await this._initMSE(playlist);
      } else {
        // Level switch — enqueue new segments
        this._enqueueNewSegments();
      }
    }

    // ---------------------------------------------------------------------------
    // MSE setup
    // ---------------------------------------------------------------------------

    async _initMSE(playlist) {
      logger.log('Initializing MSE');
      await this._bufMgr.open();

      // Set VOD duration
      if (playlist.endList) {
        const duration = playlist.segments.reduce((s, seg) => s + seg.duration, 0);
        this._bufMgr.setDuration(duration);
      }

      this._enqueueNewSegments();
      this._startTick();

      // For live streams schedule playlist refresh
      if (!playlist.endList) {
        this._scheduleLiveRefresh();
      }
    }

    // ---------------------------------------------------------------------------
    // Segment queue management
    // ---------------------------------------------------------------------------

    _enqueueNewSegments() {
      const segments = this._mediaPlaylist?.segments ?? [];
      for (const seg of segments) {
        if (!this._loadedSNs.has(seg.sn)) {
          this._segmentQueue.push(seg);
          this._loadedSNs.add(seg.sn);
        }
      }
    }

    // ---------------------------------------------------------------------------
    // Buffer tick — drives the download + append loop
    // ---------------------------------------------------------------------------

    _startTick() {
      const tick = async () => {
        if (this._destroyed) return;
        await this._tick();
        this._tickTimer = setTimeout(tick, 500);
      };
      tick();
    }

    async _tick() {
      if (this._loading) return;

      const buffered = this._bufMgr.bufferedAhead();
      const maxBuf   = this._opts.maxBufferLength;

      // Pause buffering when we have enough data
      if (buffered > maxBuf) return;

      // ABR decision
      if (this._abr && this._masterPlaylist) {
        const { changed, index } = this._abr.decide(this._loader.bandwidth, buffered);
        if (changed) {
          logger.log(`ABR: switching to level ${index}`);
          this.emit('level_switched', { index, level: this._abr.currentLevel });
          // Clear queue and load the new level's playlist
          this._segmentQueue = [];
          try {
            await this._loadLevel(index);
          } catch (err) {
            this._emitError('network', 'levelLoadError', false, err);
          }
          return;
        }
      }

      // Load next segment
      const seg = this._segmentQueue.shift();
      if (!seg) {
        // No more segments
        if (this._mediaPlaylist?.endList) {
          await this._bufMgr.endOfStream();
          this._state = 'ENDED';
        }
        return;
      }

      this._loading = true;
      try {
        await this._loadSegment(seg);
      } catch (err) {
        // Put segment back for retry on next tick
        this._segmentQueue.unshift(seg);
        this._emitError('network', 'fragLoadError', false, err);
      } finally {
        this._loading = false;
      }
    }

    // ---------------------------------------------------------------------------
    // Segment loading & appending
    // ---------------------------------------------------------------------------

    async _loadSegment(segment) {
      this.emit('frag_loading', { segment });
      logger.log(`Loading segment sn=${segment.sn}: ${segment.uri}`);

      const buffer = await this._loader.loadSegment(segment);
      this.emit('frag_loaded', { segment, buffer });

      await this._appendSegment(buffer, segment);
    }

    async _appendSegment(buffer, segment) {
      if (isMpegTS(buffer)) {
        await this._appendTS(buffer, segment);
      } else if (isMP4(buffer)) {
        await this._appendMP4(buffer);
      } else {
        logger.warn('Unknown segment format — trying as fMP4');
        await this._appendMP4(buffer);
      }
    }

    // MPEG-TS path: transmux to fMP4 then append
    async _appendTS(buffer, segment) {
      if (segment.discontinuity) {
        this._transmuxer.reset();
      }

      const { init, fragment } = this._transmuxer.transmux(buffer);

      if (init) {
        await this._ensureSourceBuffers(this._transmuxer);
        this._bufMgr.append('video', init);
        this._bufMgr.append('audio', init);
      }

      if (fragment) {
        this._bufMgr.append('video', fragment);
        this._bufMgr.append('audio', fragment);
      }
    }

    // Native fMP4 path: append directly (no transmuxing needed)
    async _appendMP4(buffer) {
      if (!this._mp4Initialized) {
        // We don't know the codecs until we get the first segment —
        // try a generic MIME type and hope for the best, or sniff the moov box.
        const mimeV = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
        const mimeA = 'audio/mp4; codecs="mp4a.40.2"';
        this._ensureSourceBufferDirect(mimeV, mimeA);
        this._mp4Initialized = true;
      }
      this._bufMgr.append('video', buffer);
    }

    // ---------------------------------------------------------------------------
    // SourceBuffer creation helpers
    // ---------------------------------------------------------------------------

    _sourceBuffersCreated = false;

    _ensureSourceBuffers(transmuxer) {
      if (this._sourceBuffersCreated) return;
      this._sourceBuffersCreated = true;

      const vTrack = transmuxer._demuxer.videoTrack;
      const aTrack = transmuxer._demuxer.audioTrack;

      const videoCodec = vTrack.codec || 'avc1.42E01E';
      const audioCodec = aTrack.codec || 'mp4a.40.2';

      logger.log(`Creating SourceBuffers — video: ${videoCodec}  audio: ${audioCodec}`);

      if (vTrack.sps) {
        this._bufMgr.addSourceBuffer('video', `video/mp4; codecs="${videoCodec}"`);
      }
      if (aTrack.config) {
        this._bufMgr.addSourceBuffer('audio', `audio/mp4; codecs="${audioCodec}"`);
      }

      this.emit('buffer_created', { tracks: { videoCodec, audioCodec } });
    }

    _ensureSourceBufferDirect(mimeV, mimeA) {
      if (this._sourceBuffersCreated) return;
      this._sourceBuffersCreated = true;

      try {
        this._bufMgr.addSourceBuffer('video', mimeV);
      } catch (err) {
        logger.warn('Could not create video SourceBuffer:', err.message);
        // Fall back to audio only
        this._bufMgr.addSourceBuffer('audio', mimeA);
      }
    }

    // ---------------------------------------------------------------------------
    // Live stream playlist refresh
    // ---------------------------------------------------------------------------

    _scheduleLiveRefresh() {
      const interval = Math.max(
        1000,
        (this._mediaPlaylist.targetDuration ?? 4) * LIVE_REFRESH_FRAC * 1000,
      );
      this._liveRefreshTimer = setTimeout(() => this._refreshLivePlaylist(), interval);
    }

    async _refreshLivePlaylist() {
      if (this._destroyed) return;
      try {
        const variant = this._masterPlaylist
          ? this._masterPlaylist.variants[this._currentLevelIdx]
          : { uri: this._streamUrl };

        const text    = await this._loader.loadText(variant.uri);
        const playlist = parseM3U8(text, variant.uri);
        this._mediaPlaylist = playlist;
        this._enqueueNewSegments();

        this.emit('level_loaded', { mediaPlaylist: playlist, levelIndex: this._currentLevelIdx });

        if (!playlist.endList) {
          this._scheduleLiveRefresh();
        }
      } catch (err) {
        logger.warn('Live playlist refresh failed:', err.message);
        if (!this._destroyed) {
          this._scheduleLiveRefresh(); // retry
        }
      }
    }

    // ---------------------------------------------------------------------------
    // Video element event bindings
    // ---------------------------------------------------------------------------

    _bindVideoEvents() {
      this._video.addEventListener('error', () => {
        this._emitError('media', 'videoError', true, this._video.error);
      });
      this._video.addEventListener('waiting', () => {
        logger.log('Video buffering…');
      });
    }

    // ---------------------------------------------------------------------------
    // Error helpers
    // ---------------------------------------------------------------------------

    _emitError(type, details, fatal, error) {
      logger.error(`[${type}] ${details}`, error);
      this.emit('error', { type, details, fatal, error });
      if (fatal) this._state = 'ERROR';
    }

    _assertNotDestroyed() {
      if (this._destroyed) throw new Error('HLSPlayer has been destroyed');
    }
  }

  exports.ABRController = ABRController;
  exports.BufferManager = BufferManager;
  exports.EventEmitter = EventEmitter;
  exports.HLSPlayer = HLSPlayer;
  exports.SegmentLoader = SegmentLoader;
  exports.TSDemuxer = TSDemuxer;
  exports.Transmuxer = Transmuxer;
  exports.isMP4 = isMP4;
  exports.isMpegTS = isMpegTS;
  exports.logger = logger;
  exports.parseM3U8 = parseM3U8;
  exports.resolveUrl = resolveUrl;

}));
//# sourceMappingURL=hls-player.js.map
