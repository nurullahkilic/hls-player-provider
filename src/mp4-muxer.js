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
function u64(hi, lo) { return concat(u32(hi), u32(lo)); }
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
export function createInitSegment(videoTrack, audioTrack) {
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
export function createMediaFragment(sequenceNumber, videoSamples, audioSamples, videoTrack, audioTrack) {
  const parts = [];

  // Build video traf
  if (videoSamples.length > 0) {
    const { traf, mdatData } = makeVideoTraf(1, videoSamples, sequenceNumber);
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
