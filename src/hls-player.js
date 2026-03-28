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

import { EventEmitter, isMpegTS, isMP4, resolveUrl, logger } from './utils.js';
import { parseM3U8 }       from './m3u8-parser.js';
import { SegmentLoader }   from './segment-loader.js';
import { BufferManager }   from './buffer-manager.js';
import { ABRController }   from './abr-controller.js';
import { Transmuxer }      from './transmuxer.js';

/** How many seconds to buffer ahead before pausing downloads. */
const TARGET_BUFFER     = 20;
/** How close to the end of buffered data before resuming. */
const RESUME_BUFFER     = 5;
/** Live playlist refresh: fraction of target duration to use as interval. */
const LIVE_REFRESH_FRAC = 0.5;

export class HLSPlayer extends EventEmitter {
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
