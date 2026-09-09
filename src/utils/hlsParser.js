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
    const base = new URL(baseUrl);
    const resolved = new URL(relativeOrAbsolute, baseUrl);
    if (!resolved.search && base.search) {
      resolved.search = base.search;
    } else if (resolved.search && base.search) {
      const baseParams = new URLSearchParams(base.search);
      const resParams = new URLSearchParams(resolved.search);
      for (const [k, v] of baseParams.entries()) {
        if (!resParams.has(k)) {
          resParams.set(k, v);
        }
      }
      resolved.search = resParams.toString();
    }
    return resolved.href;
  } catch (e) {
    return relativeOrAbsolute;
  }
}

/**
 * Kiểm tra xem URL có phải là playlist định dạng .m3u8 thực sự hay không
 * (Bỏ qua triệt để các phân đoạn .ts, .m4s, video tĩnh hoặc asset)
 * @param {string} url 
 * @returns {boolean}
 */
export function isM3u8PlaylistUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.includes('.m3u8')) return false;
  if (/\.(?:ts|m4s|mp4|m4a|aac|vtt|srt|key|jpe?g|png|gif|svg|css|js)(?:$|\?)/i.test(url)) return false;
  return true;
}

/**
 * Kiểm tra xem URL có phải là child/media playlist (chứa chỉ 1 độ phân giải) hay không
 * @param {string} url 
 * @returns {boolean}
 */
export function isChildPlaylistUrl(url) {
  if (!isM3u8PlaylistUrl(url)) return false;
  return /\/(?:1080|720|480|360|240|144)\/(?:index|playlist)\.m3u8/i.test(url) ||
         /index_(?:1080|720|480|360|240|144)\.m3u8/i.test(url);
}

/**
 * Kiểm tra xem URL có phải là Master Playlist hay không
 * @param {string} url 
 * @returns {boolean}
 */
export function isMasterPlaylistUrl(url) {
  if (!isM3u8PlaylistUrl(url)) return false;
  if (url.includes('master.m3u8') || url.includes('playlist.m3u8')) return true;
  if (isChildPlaylistUrl(url)) return false;
  return true;
}

/**
 * Suy đoán URL Master Playlist từ URL của Child Playlist
 * @param {string} url 
 * @returns {string|null}
 */
export function deriveMasterPlaylistUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (/\/(?:1080|720|480|360|240|144)\/(?:index|playlist)\.m3u8/i.test(url)) {
    return url.replace(/\/(?:1080|720|480|360|240|144)\/(?:index|playlist)\.m3u8/i, '/master.m3u8');
  }
  if (/index_(?:1080|720|480|360|240|144)\.m3u8/i.test(url)) {
    return url.replace(/index_(?:1080|720|480|360|240|144)\.m3u8/i, 'master.m3u8');
  }
  return null;
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

  const isDrm = lines.some(l => 
    l.includes('METHOD=SAMPLE-AES') || 
    l.includes('com.widevine.alpha') || 
    l.includes('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed') || 
    l.includes('KEYFORMAT="urn:uuid:') ||
    l.includes('com.apple.streamingkeydelivery')
  );

  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF') || l.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'));

  if (!isMaster) {
    let detectedRes = 720;
    const resMatch = masterUrl ? masterUrl.match(/[\/_](\d{3,4})(?:p|\/|\.m3u8)/i) : null;
    if (resMatch) {
      const parsedRes = parseInt(resMatch[1], 10);
      if ([1080, 720, 480, 360, 240, 144].includes(parsedRes)) {
        detectedRes = parsedRes;
      }
    }
    return {
      variants: [{
        label: `${detectedRes}`,
        resolution: detectedRes,
        width: detectedRes === 1080 ? 1920 : (detectedRes === 720 ? 1280 : 854),
        height: detectedRes,
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
      const nameMatch = line.match(/NAME=(?:"([^"]+)"|([^,]+))/i);
      const langMatch = line.match(/LANGUAGE=(?:"([^"]+)"|([^,]+))/i);
      const uriMatch = line.match(/URI=(?:"([^"]+)"|([^,]+))/i);

      if (uriMatch) {
        const rawUri = (uriMatch[1] || uriMatch[2] || '').trim();
        const fullSubUrl = resolveUrl(rawUri, masterUrl);
        const nameVal = nameMatch ? (nameMatch[1] || nameMatch[2] || '').trim() : '';
        const langVal = langMatch ? (langMatch[1] || langMatch[2] || '').trim() : '';
        const label = nameVal || langVal || 'Subtitles';
        subtitles.push({
          id: `hls-sub-${subtitles.length + 1}`,
          label,
          locale: langVal,
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

  return { variants, subtitles, isDrm };
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
