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

export class TSDemuxer {
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

    if (flush || true) { // always clear after pushing
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

      const id            = (data[i + 1] & 0x08) >> 3; // 0=MPEG-4, 1=MPEG-2
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
