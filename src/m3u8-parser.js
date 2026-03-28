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
export function parseM3U8(text, baseUrl = '') {
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
