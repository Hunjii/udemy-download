/**
 * HLS (.m3u8) Parser Utility
 * Phân tích Master Playlist, Media Playlist và Subtitles Playlist của chuẩn HLS.
 */

/**
 * Chuyển đổi URL tương đối thành URL tuyệt đối dựa trên URL gốc
 * @param {string} relativeOrAbsolute 
 * @param {string} baseUrl 
 * @returns {string}
 */
export function resolveUrl(relativeOrAbsolute, baseUrl) {
  try {
    return new URL(relativeOrAbsolute, baseUrl).href;
  } catch (e) {
    return relativeOrAbsolute;
  }
}

/**
 * Phân tích Master Playlist để lấy danh sách video variants và phụ đề subtitles
 * @param {string} m3u8Content 
 * @param {string} masterUrl 
 * @returns {{ variants: Array<any>, subtitles: Array<any> }}
 */
export function parseMasterPlaylist(m3u8Content, masterUrl) {
  if (!m3u8Content || typeof m3u8Content !== 'string') {
    return { variants: [], subtitles: [] };
  }

  const lines = m3u8Content.split('\n').map(l => l.trim()).filter(Boolean);
  const variants = [];
  const subtitles = [];

  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF') || l.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'));

  if (!isMaster) {
    return {
      variants: [{
        label: 'Original',
        resolution: 720,
        width: 1280,
        height: 720,
        bandwidth: 0,
        url: masterUrl
      }],
      subtitles: []
    };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1. Phân tích phụ đề: #EXT-X-MEDIA:TYPE=SUBTITLES,...
    if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=SUBTITLES')) {
      const nameMatch = line.match(/NAME="([^"]+)"/i);
      const langMatch = line.match(/LANGUAGE="([^"]+)"/i);
      const uriMatch = line.match(/URI="([^"]+)"/i);

      if (uriMatch) {
        const fullSubUrl = resolveUrl(uriMatch[1], masterUrl);
        const label = nameMatch ? nameMatch[1] : (langMatch ? langMatch[1] : 'Subtitles');
        subtitles.push({
          id: `hls-sub-${subtitles.length + 1}`,
          label,
          locale: langMatch ? langMatch[1] : '',
          url: fullSubUrl
        });
      }
    }

    // 2. Phân tích biến thể độ phân giải: #EXT-X-STREAM-INF:...
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = line.substring('#EXT-X-STREAM-INF:'.length);

      let width = 0;
      let height = 0;
      const resMatch = attributes.match(/RESOLUTION=(\d+)x(\d+)/i);
      if (resMatch) {
        width = parseInt(resMatch[1], 10);
        height = parseInt(resMatch[2], 10);
      }

      let bandwidth = 0;
      const bwMatch = attributes.match(/BANDWIDTH=(\d+)/i);
      if (bwMatch) {
        bandwidth = parseInt(bwMatch[1], 10);
      }

      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) {
          uri = lines[j];
          i = j;
          break;
        }
      }

      if (uri) {
        const fullUrl = resolveUrl(uri, masterUrl);
        const label = height ? `${height}` : (bandwidth ? `${Math.round(bandwidth / 1000)}k` : 'Auto');

        variants.push({
          label,
          resolution: height || (bandwidth ? Math.round(bandwidth / 1000) : 0),
          width,
          height,
          bandwidth,
          url: fullUrl
        });
      }
    }
  }

  variants.sort((a, b) => b.resolution - a.resolution);

  return { variants, subtitles };
}

/**
 * Phân tích Media Playlist để lấy danh sách các phân đoạn video (.ts / .m4s) và thông tin giải mã
 * @param {string} m3u8Content 
 * @param {string} playlistUrl 
 * @returns {{ isFmp4: boolean, initSegmentUrl: string|null, segments: Array<{ index: number, duration: number, url: string, keyInfo: any }>, totalDuration: number, keyInfo: any }}
 */
export function parseMediaPlaylist(m3u8Content, playlistUrl) {
  const lines = m3u8Content.split('\n').map(l => l.trim()).filter(Boolean);

  let currentKeyInfo = null;
  let initSegmentUrl = null;
  let totalDuration = 0;
  const segments = [];
  let nextDuration = 0;
  let segmentIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = line.match(/URI="([^"]+)"/i);
      if (uriMatch) {
        initSegmentUrl = resolveUrl(uriMatch[1], playlistUrl);
      }
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const methodMatch = line.match(/METHOD=([^,\s]+)/i);
      const uriMatch = line.match(/URI="([^"]+)"/i);
      const ivMatch = line.match(/IV=([0-9a-fA-Fx]+)/i);

      const method = methodMatch ? methodMatch[1] : 'NONE';

      if (method === 'NONE') {
        currentKeyInfo = null;
      } else {
        currentKeyInfo = {
          method,
          uri: uriMatch ? resolveUrl(uriMatch[1], playlistUrl) : null,
          iv: ivMatch ? ivMatch[1] : null
        };
      }
    }

    if (line.startsWith('#EXTINF:')) {
      const durMatch = line.match(/#EXTINF:([0-9\.]+)/i);
      if (durMatch) {
        nextDuration = parseFloat(durMatch[1]);
        totalDuration += nextDuration;
      }
    }

    if (!line.startsWith('#')) {
      const segUrl = resolveUrl(line, playlistUrl);
      segments.push({
        index: segmentIndex++,
        duration: nextDuration,
        url: segUrl,
        keyInfo: currentKeyInfo ? { ...currentKeyInfo } : null
      });
      nextDuration = 0;
    }
  }

  return {
    isFmp4: Boolean(initSegmentUrl),
    initSegmentUrl,
    segments,
    totalDuration,
    keyInfo: currentKeyInfo
  };
}
