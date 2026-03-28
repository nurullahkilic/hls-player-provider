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

import { TSDemuxer }          from './ts-demuxer.js';
import { createInitSegment, createMediaFragment } from './mp4-muxer.js';

export class Transmuxer {
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
