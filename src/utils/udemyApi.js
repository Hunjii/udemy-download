/**
 * Udemy API Service
 * Xử lý giao tiếp trực tiếp với Udemy REST API v2 để nạp chương mục, metadata video 1080p và phụ đề.
 */

import { parseMasterPlaylist, resolveUrl, isChildPlaylistUrl, deriveMasterPlaylistUrl } from './hlsParser.js';
import { cleanLectureTitle, cleanSectionTitle, findEnglishCaption, isEnglishCaption } from './sanitizer.js';
import { convertVttToSrt } from './vtt2srt.js';

/**
 * Chuẩn hóa đối tượng Caption nhận từ API
 */
export function normalizeCaptionItem(c) {
  if (!c) return null;
  const url = c.url || c.file_url || c.file || c.download_url || c.src || '';
  if (!url) return null;

  let label = c.label || c.title || c.video_label || c.name || '';
  let locale = c.locale_id || c.locale || c.srclang || c.language || '';

  if (!locale) {
    const m = url.match(/([a-z]{2}(?:[_-][a-z]{2})?)\.vtt/i) || url.match(/locale(?:_id)?=([a-z]{2}(?:[_-][a-z]{2})?)/i);
    if (m) locale = m[1];
  }

  if (!label) {
    label = locale ? `Subtitles (${locale})` : 'English';
  }

  return {
    id: c.id ? String(c.id) : `cap-${Math.random().toString(36).substr(2, 9)}`,
    label,
    locale,
    url
  };
}

const UDEMY_BASE = 'https://www.udemy.com';

/**
 * Hàm fetch an toàn hỗ trợ URL đầy đủ, backoff 429 và fallback qua tab Udemy
 */
async function safeFetch(url, options = {}, tabId = null) {
  const fullUrl = url.startsWith('http') ? url : `${UDEMY_BASE}${url}`;

  try {
    const res = await fetch(fullUrl, {
      credentials: 'include',
      headers: { 'Accept': 'application/json, text/plain, */*', ...(options.headers || {}) },
      ...options
    });

    if (res.status === 429) {
      console.warn('[Udemy API] HTTP 429 Rate Limit. Tự động chờ 10s...');
      await new Promise(r => setTimeout(r, 10000));
      return await safeFetch(url, options, tabId);
    }

    if (res.ok || (res.status !== 401 && res.status !== 403)) {
      return res;
    }
  } catch (err) {
    if (!tabId || typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) {
      throw err;
    }
  }

  // Fallback qua content script của tab Udemy nếu extension context bị hạn chế cookie/CORS
  if (tabId && typeof chrome !== 'undefined' && chrome.tabs?.sendMessage) {
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(Number(tabId), { type: 'API_FETCH', url: fullUrl }, (r) => {
        resolve(r || { ok: false, error: chrome.runtime?.lastError?.message });
      });
    });

    if (response?.ok) {
      return {
        ok: true,
        status: response.status || 200,
        json: async () => response.data,
        text: async () => (typeof response.data === 'string' ? response.data : JSON.stringify(response.data))
      };
    }
  }

  throw new Error(`Không thể kết nối API (${fullUrl})`);
}

/**
 * Lấy toàn bộ danh mục bài học và chương mục của khóa học
 * @param {string|number} courseId 
 * @param {number|null} tabId
 * @returns {Promise<Array<{ id: string, index: number, title: string, type: string, chapter: { index: number, title: string } }>>}
 */
export async function fetchCourseCurriculum(courseId, tabId = null) {
  if (!courseId) throw new Error('Thiếu courseId để lấy danh mục khóa học');

  const endpoint = `/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=1400&fields[lecture]=title,object_index&fields[chapter]=title,object_index&fields[quiz]=title,object_index&fields[practice]=title,object_index`;
  const res = await safeFetch(endpoint, {}, tabId);

  if (!res.ok) {
    throw new Error(`Không thể lấy danh mục khóa học (HTTP ${res.status})`);
  }

  const data = await res.json();
  const rawItems = Array.isArray(data.results) ? data.results : [];

  let currentChapter = null;
  const orderedList = [];

  rawItems.forEach(item => {
    if (item._class === 'chapter') {
      currentChapter = {
        index: item.object_index,
        title: item.title
      };
    } else if (item._class === 'lecture' || item._class === 'quiz' || item._class === 'practice') {
      orderedList.push({
        id: String(item.id),
        index: item.object_index,
        title: item.title,
        type: item._class,
        chapter: currentChapter ? { ...currentChapter } : null
      });
    }
  });

  return orderedList;
}

/**
 * Xác định danh sách N bài giảng video cần tải tiếp theo tính từ startLectureId
 * @param {Array} curriculumItems 
 * @param {string|number} startLectureId 
 * @param {number} count 
 * @returns {Array}
 */
export function getBatchLectureList(curriculumItems, startLectureId, count = 5) {
  if (!Array.isArray(curriculumItems) || curriculumItems.length === 0) return [];

  let startIdx = 0;
  if (startLectureId) {
    const foundIdx = curriculumItems.findIndex(item => String(item.id) === String(startLectureId));
    if (foundIdx !== -1) {
      startIdx = foundIdx;
    }
  }

  const selectedLectures = [];
  for (let i = startIdx; i < curriculumItems.length; i++) {
    const item = curriculumItems[i];
    // Chỉ chọn các bài giảng video thông thường (bỏ qua Quiz, Practice)
    if (item.type === 'lecture') {
      selectedLectures.push(item);
      if (selectedLectures.length >= count) break;
    }
  }

  return selectedLectures;
}

/**
 * Phân tích Master M3U8 để bóc tách các biến thể phân giải (1080p, 720p...) và Subtitle
 */
async function resolveHlsMedia(m3u8Url, tabId = null) {
  if (!m3u8Url) return { streams: [], subtitles: [] };

  let targetUrl = m3u8Url;
  if (isChildPlaylistUrl(m3u8Url)) {
    const derived = deriveMasterPlaylistUrl(m3u8Url);
    if (derived) {
      try {
        const res = await safeFetch(derived, {}, tabId);
        if (res.ok) {
          const text = await res.text();
          const parsed = parseMasterPlaylist(text, derived);
          if (parsed.variants && parsed.variants.length > 0) {
            return {
              streams: parsed.variants.map(v => ({
                label: v.label,
                resolution: v.resolution,
                file: v.url || derived,
                type: 'hls'
              })).sort((a, b) => b.resolution - a.resolution),
              subtitles: parsed.subtitles || []
            };
          }
        }
      } catch (e) {}
    }
  }

  try {
    const res = await safeFetch(targetUrl, {}, tabId);
    if (!res.ok) return { streams: [], subtitles: [] };
    const text = await res.text();
    const parsed = parseMasterPlaylist(text, targetUrl);
    return {
      streams: (parsed.variants || []).map(v => ({
        label: v.label,
        resolution: v.resolution,
        file: v.url || targetUrl,
        type: 'hls'
      })).sort((a, b) => b.resolution - a.resolution),
      subtitles: parsed.subtitles || []
    };
  } catch (err) {
    return { streams: [], subtitles: [] };
  }
}

/**
 * Gọi API lấy chi tiết luồng phát và phụ đề của 1 bài giảng
 * @param {string|number} courseId 
 * @param {string|number} lectureId 
 * @param {number|null} tabId
 * @returns {Promise<Object>}
 */
export async function fetchLectureMediaData(courseId, lectureId, tabId = null) {
  if (!courseId || !lectureId) {
    throw new Error('Cần có courseId và lectureId');
  }

  const captionField = '&fields[caption]=@default,url,locale_id,title,video_label,source';
  const url = `/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[lecture]=title,object_index,asset,download_urls,captions&fields[asset]=stream_urls,captions,media_sources,media_license_token,course_is_drmed${captionField}`;

  const res = await safeFetch(url, {}, tabId);

  if (!res.ok) {
    throw new Error(`Lỗi nạp thông tin bài giảng (HTTP ${res.status})`);
  }

  const payload = await res.json();
  const asset = payload.asset || {};
  const streamUrls = asset.stream_urls || payload.stream_urls || {};

  // 1. Kiểm tra DRM
  const isDrmProtected = Boolean(
    asset.course_is_drmed ||
    payload.course_is_drmed ||
    (!streamUrls.hls && !streamUrls.Video && (streamUrls.dash || streamUrls.encrypted_hls)) ||
    Boolean(asset.media_license_token)
  );

  // 2. Thu thập luồng MP4
  const rawVideo = streamUrls.Video || [];
  let mp4Streams = [];
  if (Array.isArray(rawVideo)) {
    mp4Streams = rawVideo
      .filter(s => s.type === 'video/mp4' && s.file)
      .map(s => ({
        label: s.label || 'Unknown',
        resolution: parseInt(s.label, 10) || 0,
        file: s.file,
        type: 'video/mp4'
      }));
  }

  // 3. Thu thập luồng HLS
  let hlsMasterUrl = null;
  if (Array.isArray(streamUrls.hls) && streamUrls.hls.length > 0 && streamUrls.hls[0].file) {
    hlsMasterUrl = streamUrls.hls[0].file;
  } else if (Array.isArray(asset.media_sources)) {
    const hlsSource = asset.media_sources.find(s => s.type === 'application/x-mpegURL' || s.src?.includes('.m3u8'));
    if (hlsSource && hlsSource.src) hlsMasterUrl = hlsSource.src;
  }

  let hlsStreams = [];
  let hlsSubtitles = [];
  if (hlsMasterUrl) {
    const hlsData = await resolveHlsMedia(hlsMasterUrl, tabId);
    hlsStreams = hlsData.streams || [];
    hlsSubtitles = hlsData.subtitles || [];
  }

  // Hợp nhất luồng: ưu tiên HLS cao nhất
  let streams = [];
  if (hlsStreams.length > 0) {
    streams = [...hlsStreams];
    const existingRes = new Set(streams.map(s => s.resolution));
    mp4Streams.forEach(m => {
      if (!existingRes.has(m.resolution)) {
        streams.push(m);
        existingRes.add(m.resolution);
      }
    });
  } else {
    streams = [...mp4Streams];
  }
  streams.sort((a, b) => b.resolution - a.resolution);

  // 4. Hợp nhất Phụ đề
  const captionsMap = new Map();
  const rawApiCaps = [
    ...(Array.isArray(asset.captions) ? asset.captions : []),
    ...(Array.isArray(payload.captions) ? payload.captions : [])
  ];

  rawApiCaps.forEach(c => {
    const norm = normalizeCaptionItem(c);
    if (norm && !captionsMap.has(norm.url)) captionsMap.set(norm.url, norm);
  });

  hlsSubtitles.forEach(s => {
    if (s.url && !captionsMap.has(s.url)) captionsMap.set(s.url, s);
  });

  // Nếu chưa có phụ đề và có ID, thử gọi endpoint chuyên biệt
  if (captionsMap.size === 0) {
    try {
      const capEndpoint = `/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/captions/?${captionField}`;
      const capRes = await safeFetch(capEndpoint, {}, tabId);
      if (capRes.ok) {
        const capJson = await capRes.json();
        const list = Array.isArray(capJson) ? capJson : (Array.isArray(capJson.results) ? capJson.results : []);
        list.forEach(c => {
          const norm = normalizeCaptionItem(c);
          if (norm && !captionsMap.has(norm.url)) captionsMap.set(norm.url, norm);
        });
      }
    } catch (e) {}
  }

  const allCaptions = Array.from(captionsMap.values());
  const englishCaption = findEnglishCaption(allCaptions);

  return {
    lectureId: String(lectureId),
    title: payload.title || `Lecture ${lectureId}`,
    index: payload.object_index || 1,
    duration: asset.time_estimation || 0,
    isDrmProtected,
    streams,
    bestQuality: streams.length > 0 ? streams[0] : null,
    captions: allCaptions,
    englishCaption
  };
}

/**
 * Tải file phụ đề từ URL (hỗ trợ cả HLS subtitle playlist và WebVTT thuần) và chuyển thành SRT
 * @param {string} subUrl 
 * @param {number|null} tabId
 * @returns {Promise<string>} Nội dung file .srt
 */
export async function downloadCaptionAsSrt(subUrl, tabId = null) {
  if (!subUrl) throw new Error('Thiếu subUrl');

  const res = await safeFetch(subUrl, {}, tabId);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let rawContent = await res.text();

  // Nếu là m3u8 subtitle playlist
  if (rawContent.startsWith('#EXTM3U')) {
    const lines = rawContent.split('\n').map(l => l.trim()).filter(Boolean);
    const segmentUrls = lines
      .filter(l => !l.startsWith('#'))
      .map(rel => new URL(rel, subUrl).href);

    const segmentTexts = await Promise.all(
      segmentUrls.map(async (u) => {
        const sRes = await safeFetch(u, {}, tabId);
        return sRes.ok ? await sRes.text() : '';
      })
    );
    rawContent = segmentTexts.join('\n');
  }

  const srtText = convertVttToSrt(rawContent);
  if (!srtText || srtText.trim().length === 0) {
    throw new Error('Nội dung phụ đề rỗng sau khi chuyển đổi');
  }

  return srtText;
}
