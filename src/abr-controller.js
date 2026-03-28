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

export class ABRController {
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
