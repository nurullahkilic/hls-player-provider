/**
 * segment-loader.js — Fetch HLS segments (and playlists) with:
 *   - Retry logic (up to maxRetries with exponential backoff)
 *   - Bandwidth estimation
 *   - AES-128 decryption support
 *   - Byte-range requests
 */

import { logger } from './utils.js';

const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

export class SegmentLoader {
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
