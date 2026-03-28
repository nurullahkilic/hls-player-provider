/**
 * utils.js — Shared helpers used across the player
 */

/**
 * Minimal EventEmitter so the player can emit/listen to events
 * without any external library.
 */
export class EventEmitter {
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
export function resolveUrl(base, url) {
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url, base).href;
}

/**
 * Concatenate multiple ArrayBuffers into one.
 */
export function concatBuffers(...buffers) {
  const total = buffers.reduce((s, b) => s + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const buf of buffers) {
    out.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return out.buffer;
}

/**
 * Read a 32-bit big-endian unsigned integer from a Uint8Array at offset.
 */
export function readUint32BE(arr, offset) {
  return ((arr[offset] << 24) | (arr[offset + 1] << 16) |
          (arr[offset + 2] << 8)  |  arr[offset + 3]) >>> 0;
}

/**
 * Write a 32-bit big-endian unsigned integer into a DataView at byteOffset.
 */
export function writeUint32BE(view, offset, value) {
  view.setUint32(offset, value >>> 0, false);
}

/**
 * Check if an ArrayBuffer contains an MPEG-TS stream (sync byte 0x47 at
 * position 0, 188, 376, …).
 */
export function isMpegTS(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 564));
  return bytes[0] === 0x47 && bytes[188] === 0x47;
}

/**
 * Check if an ArrayBuffer starts with an fMP4 / ISOBMFF box
 * (first four bytes are a size, next four are an ASCII box type).
 */
export function isMP4(buffer) {
  if (buffer.byteLength < 8) return false;
  const bytes = new Uint8Array(buffer, 4, 4);
  const type = String.fromCharCode(...bytes);
  return ['ftyp', 'moof', 'mdat', 'moov', 'styp'].includes(type);
}

/**
 * Simple logger that can be silenced.
 */
export const logger = {
  enabled: true,
  log:   (...a) => logger.enabled && console.log('[HLS]', ...a),
  warn:  (...a) => logger.enabled && console.warn('[HLS]', ...a),
  error: (...a) =>                   console.error('[HLS]', ...a),
};
