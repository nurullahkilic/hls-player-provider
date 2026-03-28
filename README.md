# hls-engine

> Full HLS playback engine built entirely from scratch — no runtime dependencies.

[![npm version](https://img.shields.io/npm/v/hls-engine?color=blue&style=flat-square)](https://www.npmjs.com/package/hls-engine)
[![license](https://img.shields.io/npm/l/hls-engine?style=flat-square)](./LICENSE)
[![minified size](https://img.shields.io/badge/minified-26%20kB-green?style=flat-square)](./dist/hls-player.min.js)
[![gzip size](https://img.shields.io/badge/gzip-9%20kB-green?style=flat-square)](./dist/hls-player.min.js)

`hls-engine` parses M3U8 playlists, demuxes MPEG-TS segments, transmuxes them into
fragmented MP4, feeds the data through the Media Source Extensions API, and
automatically adapts quality based on available bandwidth. Every layer is written
from first principles — no FFmpeg, no external codec library, no third-party
streaming helper.

---

## Table of Contents

- [Features](#features)
- [Browser Support](#browser-support)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage](#usage)
  - [CDN (UMD)](#cdn-umd)
  - [ES Module (bundler)](#es-module-bundler)
  - [CommonJS (Node / SSR)](#commonjs-node--ssr)
- [API Reference](#api-reference)
  - [Constructor](#constructor)
  - [Options](#options)
  - [Methods](#methods)
  - [Getters](#getters)
  - [Player States](#player-states)
- [Events](#events)
  - [Event Payloads](#event-payloads)
- [Playlist Object Shapes](#playlist-object-shapes)
  - [Master Playlist](#master-playlist)
  - [Media Playlist](#media-playlist)
  - [Segment](#segment)
- [Adaptive Bitrate (ABR)](#adaptive-bitrate-abr)
- [Live Streams](#live-streams)
- [AES-128 Encryption](#aes-128-encryption)
- [Error Handling](#error-handling)
- [Using Individual Modules](#using-individual-modules)
- [Architecture](#architecture)
- [Building from Source](#building-from-source)
- [License](#license)

---

## Features

| Capability | Detail |
|---|---|
| **M3U8 parsing** | Master playlists, media playlists, `#EXT-X-KEY`, `#EXT-X-BYTERANGE`, `#EXT-X-DISCONTINUITY`, `#EXT-X-PROGRAM-DATE-TIME` |
| **MPEG-TS demuxing** | PAT → PMT → PES → H.264 Annex B NAL units + AAC ADTS frames; SPS/PPS extraction |
| **fMP4 muxing** | Full ISO BMFF binary writer: `ftyp`, `moov`, `moof`, `mdat`, `avcC`, `esds` |
| **TS → fMP4 transmuxing** | Zero-copy pipeline: demux → mux → MSE in one pass |
| **Native fMP4 HLS** | Segments already in fMP4 are passed directly to MSE (no transmuxing overhead) |
| **AES-128 decryption** | `#EXT-X-KEY METHOD=AES-128` via the Web Crypto API; per-segment IV |
| **Adaptive bitrate** | Bandwidth EMA + buffer-health gating; configurable upgrade factor and cooldown |
| **Live streams** | Automatic playlist refresh on `targetDuration × 0.5` schedule |
| **Buffer management** | Append queue, back-buffer eviction, `QuotaExceededError` recovery |
| **Safari native HLS** | Detected automatically; player sets `<video src>` directly (no MSE overhead) |
| **Zero dependencies** | No runtime dependency — only rollup + terser for building |

---

## Browser Support

| Browser | Support | Notes |
|---|---|---|
| Chrome 34+ | Full | MSE + transmuxer path |
| Firefox 42+ | Full | MSE + transmuxer path |
| Edge 79+ | Full | Chromium-based |
| Safari 10+ | Full | Native HLS (`canPlayType`) |
| iOS Safari | Full | Native HLS |

The player requires `MediaSource` (MSE). All major browsers released since 2015
support it. On browsers with native HLS support (Safari, iOS) the player delegates
directly to the browser engine for zero overhead.

---

## Installation

```bash
# npm
npm install hls-engine

# yarn
yarn add hls-engine

# pnpm
pnpm add hls-engine
```

---

## Quick Start

```html
<video id="video" controls></video>

<script type="module">
  import { HLSPlayer } from 'hls-engine';

  const video  = document.getElementById('video');
  const player = new HLSPlayer(video);

  player.on('error', ({ fatal, error }) => {
    if (fatal) console.error('Fatal error:', error);
  });

  await player.load('https://example.com/stream/master.m3u8');
</script>
```

---

## Usage

### CDN (UMD)

Add one `<script>` tag — no build step required.

```html
<!-- Latest via unpkg -->
<script src="https://unpkg.com/hls-engine/dist/hls-player.min.js"></script>

<!-- Latest via jsDelivr -->
<script src="https://cdn.jsdelivr.net/npm/hls-engine/dist/hls-player.min.js"></script>
```

All exports are available on the global `HLS` object:

```html
<video id="video" controls></video>
<script>
  const player = new HLS.HLSPlayer(document.getElementById('video'));
  player.load('https://example.com/stream/master.m3u8');
</script>
```

---

### ES Module (bundler)

Works with Vite, Webpack, Rollup, esbuild, and any other ESM-aware bundler.

```js
import { HLSPlayer } from 'hls-engine';

const player = new HLSPlayer(videoElement, {
  maxBufferLength: 30,
  debug: false,
});

player.on('manifest_loaded', ({ masterPlaylist }) => {
  console.log(`${masterPlaylist.variants.length} quality levels available`);
});

player.on('level_switched', ({ index }) => {
  console.log(`Quality switched to level ${index}`);
});

player.on('error', ({ type, details, fatal, error }) => {
  console.error(`[${type}] ${details}`, error);
  if (fatal) player.destroy();
});

await player.load('https://example.com/stream/master.m3u8');
```

---

### CommonJS (Node / SSR)

```js
const { HLSPlayer } = require('hls-engine');
```

> **Note:** `HLSPlayer` requires browser APIs (`MediaSource`, `fetch`, `crypto.subtle`).
> In a server-side rendering context, import it only on the client.
> If you use Next.js or Nuxt, lazy-load the player with a dynamic import.

```js
// Next.js example
const { HLSPlayer } = await import('hls-engine');
```

---

## API Reference

### Constructor

```js
const player = new HLSPlayer(videoEl, options);
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `videoEl` | `HTMLVideoElement` | Yes | The `<video>` element to attach to |
| `options` | `object` | No | Configuration (see [Options](#options)) |

---

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `debug` | `boolean` | `false` | Print verbose logs to the browser console |
| `maxBufferLength` | `number` | `20` | Maximum seconds of video to buffer ahead of `currentTime` |
| `maxRetries` | `number` | `3` | Number of times to retry a failed segment or playlist fetch |
| `forceJS` | `boolean` | `false` | Disable native HLS detection and always use the MSE/JS path (useful for testing on Safari) |

---

### Methods

#### `player.load(url)`

Load and start an HLS stream. Accepts a master playlist URL or a direct media
playlist URL. Returns a `Promise` that resolves once the manifest is fetched and
the MSE pipeline is initialized.

```js
await player.load('https://example.com/stream/master.m3u8');
```

Calling `load()` on an already-active instance is not supported. Call
`destroy()` first, then create a new instance.

---

#### `player.setLevel(index)`

Force a specific quality level by its index in `player.levels`. The index is
zero-based, where `0` is the lowest bitrate and `levels.length - 1` is the
highest. Pass `null` to re-enable automatic ABR.

```js
// Force highest quality
player.setLevel(player.levels.length - 1);

// Re-enable ABR
player.setLevel(null);
```

---

#### `player.destroy()`

Tear down the player, cancel all in-flight requests, release the MediaSource,
and remove all event listeners. After calling `destroy()`, the instance must not
be reused.

```js
player.destroy();
```

---

#### `player.on(event, handler)`

Subscribe to a player event. Returns the player instance for chaining.

```js
player
  .on('manifest_loaded', ({ masterPlaylist }) => { /* … */ })
  .on('frag_loaded',     ({ segment })        => { /* … */ });
```

---

#### `player.off(event, handler)`

Remove a previously registered event handler.

```js
const handler = ({ segment }) => console.log(segment.sn);
player.on('frag_loaded', handler);
player.off('frag_loaded', handler);
```

---

#### `player.once(event, handler)`

Subscribe to an event for a single invocation. The handler is automatically
removed after it fires once.

```js
player.once('manifest_loaded', () => {
  console.log('Manifest is ready');
});
```

---

### Getters

#### `player.levels` → `LevelSummary[]`

Returns an array of all available quality levels. Populated after the
`manifest_loaded` event fires.

```js
player.on('manifest_loaded', () => {
  console.log(player.levels);
  // [
  //   { index: 0, bandwidth: 400000,  resolution: { width: 640,  height: 360  }, codecs: '…', current: false },
  //   { index: 1, bandwidth: 800000,  resolution: { width: 1280, height: 720  }, codecs: '…', current: true  },
  //   { index: 2, bandwidth: 2000000, resolution: { width: 1920, height: 1080 }, codecs: '…', current: false },
  // ]
});
```

Each `LevelSummary` object has:

| Field | Type | Description |
|---|---|---|
| `index` | `number` | Position in the sorted levels array |
| `bandwidth` | `number` | Peak bandwidth in bits/second |
| `resolution` | `{ width, height } \| null` | Video resolution, if declared |
| `codecs` | `string` | CODECS attribute from the master playlist |
| `current` | `boolean` | Whether this level is currently active |

---

#### `player.currentLevel` → `number`

Index of the currently active quality level.

```js
console.log(`Playing at level ${player.currentLevel}`);
```

---

### Player States

The internal `player._state` property tracks the playback lifecycle. These are
not emitted as events; use them only for debugging.

| State | Meaning |
|---|---|
| `IDLE` | Initial state, or after `destroy()` |
| `LOADING` | Fetching and parsing the manifest |
| `READY` | MSE pipeline initialized; segments are being downloaded |
| `ENDED` | VOD stream fully buffered and `endOfStream()` called |
| `ERROR` | A fatal error occurred |

---

## Events

Subscribe with `player.on(event, handler)`.

| Event | When it fires |
|---|---|
| [`manifest_loaded`](#manifest_loaded) | The master (or direct media) playlist is parsed |
| [`level_loaded`](#level_loaded) | A media playlist's segment list is ready |
| [`frag_loading`](#frag_loading) | A segment fetch begins |
| [`frag_loaded`](#frag_loaded) | A segment is fully downloaded |
| [`level_switched`](#level_switched) | ABR changed the active quality level |
| [`buffer_created`](#buffer_created) | MSE SourceBuffers are created and codec info is known |
| [`error`](#error) | A network or media error occurred |

---

### Event Payloads

#### `manifest_loaded`

```js
player.on('manifest_loaded', ({ masterPlaylist }) => {
  console.log(masterPlaylist.variants.length); // number of quality levels
});
```

`masterPlaylist` — see [Master Playlist](#master-playlist).

---

#### `level_loaded`

Fires once per quality level per playlist fetch (also fires on live playlist
refresh).

```js
player.on('level_loaded', ({ mediaPlaylist, levelIndex }) => {
  console.log(`Level ${levelIndex}: ${mediaPlaylist.segments.length} segments`);
  console.log('Is live:', !mediaPlaylist.endList);
});
```

`mediaPlaylist` — see [Media Playlist](#media-playlist).
`levelIndex` — index into `player.levels`.

---

#### `frag_loading`

```js
player.on('frag_loading', ({ segment }) => {
  console.log(`Fetching sn=${segment.sn}: ${segment.uri}`);
});
```

---

#### `frag_loaded`

```js
player.on('frag_loaded', ({ segment, buffer }) => {
  console.log(`sn=${segment.sn} loaded: ${buffer.byteLength} bytes`);
});
```

`buffer` is the raw `ArrayBuffer` of the downloaded segment (already decrypted
if the segment was AES-128 encrypted).

---

#### `level_switched`

```js
player.on('level_switched', ({ index, level }) => {
  const kbps = Math.round(level.bandwidth / 1000);
  console.log(`ABR: now at level ${index} (${kbps} kbps)`);
});
```

---

#### `buffer_created`

Fires once when the transmuxer has decoded enough of the first segment to
determine codec parameters and create the MSE SourceBuffers.

```js
player.on('buffer_created', ({ tracks }) => {
  console.log(`Video codec: ${tracks.videoCodec}`); // e.g. 'avc1.640028'
  console.log(`Audio codec: ${tracks.audioCodec}`); // e.g. 'mp4a.40.2'
});
```

---

#### `error`

```js
player.on('error', ({ type, details, fatal, error }) => {
  console.error(`[${type}/${details}] fatal=${fatal}`, error.message);
  if (fatal) {
    player.destroy();
  }
});
```

| Field | Type | Values |
|---|---|---|
| `type` | `string` | `'network'` or `'media'` |
| `details` | `string` | `'manifestLoadError'`, `'levelLoadError'`, `'fragLoadError'`, `'videoError'` |
| `fatal` | `boolean` | `true` = playback cannot continue |
| `error` | `Error` | The underlying error object |

Non-fatal errors (`fatal: false`) are automatically retried or skipped by the
player. Fatal errors require the application to call `destroy()`.

---

## Playlist Object Shapes

These objects are passed in event payloads. All fields reflect the parsed M3U8.

### Master Playlist

```js
{
  type: 'master',
  version: 3,
  variants: [
    {
      uri:          'https://…/360p.m3u8',
      bandwidth:    400000,          // #EXT-X-STREAM-INF BANDWIDTH
      avgBandwidth: 380000,          // AVERAGE-BANDWIDTH (0 if absent)
      codecs:       'avc1.4d401e,mp4a.40.2',
      resolution:   { width: 640, height: 360 }, // null if absent
      frameRate:    30,
      audio:        'audio-group',   // GROUP-ID reference, '' if absent
      subtitles:    '',
      video:        '',
    },
    // … more variants, sorted ascending by bandwidth
  ],
  audio: [
    {
      type:       'AUDIO',
      groupId:    'audio-group',
      language:   'en',
      name:       'English',
      default:    true,
      autoSelect: true,
      forced:     false,
      uri:        'https://…/audio-en.m3u8', // null if inline
      channels:   '2',
    },
  ],
  subtitles: [ /* same shape as audio entries */ ],
}
```

### Media Playlist

```js
{
  type:                  'media',
  version:               3,
  targetDuration:        4,
  mediaSequence:         0,
  discontinuitySequence: 0,
  endList:               true,   // false for live streams
  playlistType:          'VOD',  // 'EVENT', 'VOD', or null
  segments:              [ /* see Segment below */ ],
  fetchedAt:             1711584000000, // Date.now() when playlist was fetched
}
```

### Segment

```js
{
  uri:             'https://…/seg001.ts',
  duration:        4.008,       // #EXTINF duration in seconds
  title:           '',          // #EXTINF title (often empty)
  sn:              0,           // sequence number (mediaSequence + position)
  key: {                        // null if not encrypted
    method:    'AES-128',
    uri:       'https://…/key',
    iv:        Uint8Array(16),  // null = use default IV from sn
    keyFormat: 'identity',
  },
  byteRange: {                  // null if full file
    length: 50000,
    offset: 0,
  },
  discontinuity:   false,       // true after #EXT-X-DISCONTINUITY
  programDateTime: Date,        // null if #EXT-X-PROGRAM-DATE-TIME absent
}
```

---

## Adaptive Bitrate (ABR)

The ABR controller runs automatically after `load()` is called. On every tick
(every 500 ms) it computes a bandwidth estimate and decides whether to switch
quality.

**Algorithm:**

1. **Bandwidth** is estimated as an exponential moving average (EMA) of each
   segment's `byteLength / downloadTime`. New measurements carry 30% weight;
   historical carries 70%.

2. **Switch DOWN** immediately when the current level's `bandwidth > estimated bandwidth`.

3. **Switch UP** only when:
   - `estimated bandwidth ≥ next level's bandwidth × 1.4` (40% headroom), AND
   - `buffered ahead ≥ 10 seconds`

4. **Cooldown:** No quality change is allowed within 5 seconds of the previous change, preventing oscillation.

5. **Buffer cap:** Downloads are paused when the buffer exceeds `maxBufferLength` (default 20 s). This conserves bandwidth when the player is far ahead.

**Manual override:**

```js
// Quality selector UI example
player.on('manifest_loaded', () => {
  const select = document.getElementById('quality');
  player.levels.forEach(lvl => {
    const opt = document.createElement('option');
    opt.value = lvl.index;
    opt.text  = lvl.resolution
      ? `${lvl.resolution.height}p`
      : `${Math.round(lvl.bandwidth / 1000)} kbps`;
    select.appendChild(opt);
  });

  // Insert "Auto" at the top
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.text  = 'Auto';
  select.prepend(auto);

  select.addEventListener('change', () => {
    const v = select.value;
    player.setLevel(v === 'auto' ? null : Number(v));
  });
});
```

---

## Live Streams

Live streams are detected by the absence of `#EXT-X-ENDLIST` in the media
playlist. The player handles them automatically:

- The playlist is re-fetched every `targetDuration × 0.5` seconds.
- New segments discovered in each refresh are appended to the download queue.
- Already-loaded sequence numbers are deduplicated — segments are never fetched
  twice.
- Back-buffer eviction keeps memory usage stable during long-running live
  sessions (data older than 30 s behind `currentTime` is removed).

No extra configuration is needed; `load()` behaves identically for VOD and live.

```js
await player.load('https://example.com/live/stream.m3u8');
```

---

## AES-128 Encryption

Segments encrypted with `#EXT-X-KEY METHOD=AES-128` are decrypted automatically
before being appended to the MSE buffer. The player:

1. Downloads the key from the `URI` attribute (once per unique key URI; keys are
   cached for the lifetime of the player instance).
2. Derives the IV: uses the explicit `IV` attribute if present, otherwise builds
   the default IV from the segment sequence number (128-bit big-endian integer).
3. Decrypts the segment using `crypto.subtle.decrypt` with AES-CBC.

No configuration is required. Encrypted and unencrypted segments can be mixed
within the same playlist.

---

## Error Handling

```js
player.on('error', ({ type, details, fatal, error }) => {
  switch (details) {
    case 'manifestLoadError':
      // Failed to fetch the .m3u8 file (always fatal)
      showErrorScreen('Could not load stream');
      player.destroy();
      break;

    case 'fragLoadError':
      // A segment fetch failed after all retries (non-fatal — player retries)
      console.warn('Segment load error, retrying…');
      break;

    case 'levelLoadError':
      // A quality-level playlist refresh failed (non-fatal)
      console.warn('Level playlist error');
      break;

    case 'videoError':
      // HTMLVideoElement media error (always fatal)
      showErrorScreen('Media decode error');
      player.destroy();
      break;
  }
});
```

Network errors are automatically retried up to `maxRetries` times (default 3)
with exponential backoff (1 s, 2 s, 4 s). Only after all retries are exhausted
is an `error` event emitted.

---

## Using Individual Modules

All internal modules are exported and usable independently.

### Parse an M3U8 playlist

```js
import { parseM3U8 } from 'hls-engine';

const text     = await fetch('https://example.com/master.m3u8').then(r => r.text());
const playlist = parseM3U8(text, 'https://example.com/master.m3u8');

if (playlist.type === 'master') {
  playlist.variants.forEach(v => {
    console.log(v.bandwidth, v.resolution);
  });
}
```

---

### Demux an MPEG-TS segment

```js
import { TSDemuxer } from 'hls-engine';

const buffer  = await fetch('https://example.com/seg001.ts').then(r => r.arrayBuffer());
const demuxer = new TSDemuxer();
const { videoTrack, audioTrack } = demuxer.demux(buffer);

console.log(`Video samples: ${videoTrack.samples.length}`);
console.log(`Audio samples: ${audioTrack.samples.length}`);
console.log(`Video codec:   ${videoTrack.codec}`);  // e.g. 'avc1.640028'
console.log(`Audio codec:   ${audioTrack.codec}`);  // e.g. 'mp4a.40.2'
```

---

### Transmux TS → fMP4

```js
import { Transmuxer } from 'hls-engine';

const tx = new Transmuxer();

// First segment produces both an init segment and a media fragment
const buffer1 = await fetchSegment('seg001.ts');
const { init, fragment } = tx.transmux(buffer1);

// init     — ArrayBuffer; append to MSE SourceBuffer once as initialization data
// fragment — ArrayBuffer; append to MSE SourceBuffer as media data

// Subsequent segments produce only a fragment
const buffer2 = await fetchSegment('seg002.ts');
const { fragment: frag2 } = tx.transmux(buffer2);

// After a discontinuity (quality switch or gap in timeline):
tx.reset();
```

---

### Download segments with retry and bandwidth estimation

```js
import { SegmentLoader } from 'hls-engine';

const loader = new SegmentLoader({ maxRetries: 5 });

const text    = await loader.loadText('https://example.com/playlist.m3u8');
const buffer  = await loader.loadSegment({ uri: 'https://example.com/seg001.ts' });

console.log(`Estimated bandwidth: ${Math.round(loader.bandwidth / 1000)} kbps`);
```

---

### ABR Controller standalone

```js
import { ABRController } from 'hls-engine';

const levels = [
  { bandwidth: 400000 },
  { bandwidth: 800000 },
  { bandwidth: 2000000 },
];

const abr = new ABRController(levels);
abr.selectInitialLevel(); // returns 0 (lowest)

// On each tick:
const { changed, index } = abr.decide(
  estimatedBandwidth, // bps
  bufferedAhead,      // seconds
);
if (changed) switchToLevel(index);

// Force a level:
abr.forceLevel(2);    // always use level 2
abr.forceLevel(null); // re-enable automatic ABR
```

---

## Architecture

```
HLSPlayer
│
├── SegmentLoader          fetch() + retry + bandwidth EMA + AES-128 decrypt
│
├── M3U8 Parser            master playlist → variants[]
│                          media playlist  → segments[]
│
├── ABRController          bandwidth + buffer health → quality index
│
├── Transmuxer
│   ├── TSDemuxer          188-byte TS packets → H.264 NAL units + AAC frames
│   └── MP4Muxer           ISO BMFF binary writer → init segment + moof/mdat
│
└── BufferManager
    ├── MediaSource        opens the MSE pipeline
    ├── SourceBuffer[video] append queue + back-buffer eviction
    └── SourceBuffer[audio] append queue + back-buffer eviction
```

**Data flow for a single MPEG-TS segment:**

```
fetch(segment.uri)
  → ArrayBuffer (raw TS)
  → TSDemuxer.demux()       — parse TS packets; emit NALUs + AAC frames
  → MP4Muxer.createInit()   — ftyp + moov (once; contains SPS/PPS/AudioConfig)
  → MP4Muxer.createFrag()   — moof + mdat (per segment)
  → SourceBuffer.append()   — MSE decodes and renders
```

**For native fMP4 HLS** (segments already in ISO BMFF format):

```
fetch(segment.uri)
  → ArrayBuffer (fMP4)
  → SourceBuffer.append()   — no transmuxing needed
```

---

## Building from Source

```bash
# Clone
git clone https://github.com/nurullahkilic/hls-player-provider.git
cd hls-player-provider

# Install dev dependencies (rollup + terser only)
npm install

# Build all four targets (ESM, CJS, UMD, UMD min)
npm run build

# Watch mode during development
npm run dev

# Serve the demo locally
npm run demo
# → open http://localhost:3000/demo/index.html
```

**Output files after `npm run build`:**

| File | Format | Size | Use case |
|---|---|---|---|
| `dist/hls-player.esm.js` | ESM | ~71 kB | Bundlers (Vite, Webpack) |
| `dist/hls-player.cjs.js` | CJS | ~72 kB | Node.js / `require()` |
| `dist/hls-player.js` | UMD | ~76 kB | Browser `<script>` (debug) |
| `dist/hls-player.min.js` | UMD | **26 kB** | Browser `<script>` (production) |

All outputs include source maps (`.map` files).

---

## License

[MIT](./LICENSE) — Copyright © 2026 Nurullah Kılıç
