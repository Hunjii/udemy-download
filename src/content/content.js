/**
 * Content Script (Chạy trong ISOLATED world của trang Udemy)
 * KHÔNG dùng import/export để đảm bảo tương thích 100% với trình tải content scripts của Chromium.
 */

(function () {
  if (window.__udemyDownloaderContentInjected) return;
  window.__udemyDownloaderContentInjected = true;

  console.log('[Udemy Downloader] Content script đã khởi tạo thành công!');

  let currentLectureInfo = null;
  let interceptedMasterM3u8 = null;
  let cachedCourseId = null;
  const interceptedCaptionsList = [];
  const curriculumChapterMap = new Map();
  const curriculumLectureMap = new Map();
  const curriculumOrderList = [];

  let currentEpoch = 0;
  let scheduledFetchTimeout = null;
  let lastMonitoredLectureId = null;

  function storeCurriculumResults(results) {
    if (!Array.isArray(results)) return;
    let currentChapter = null;
    curriculumOrderList.length = 0;
    results.forEach(item => {
      if (item._class === 'chapter') {
        currentChapter = { index: item.object_index, title: item.title };
      } else if (item._class === 'lecture' || item._class === 'quiz' || item._class === 'practice') {
        const entry = {
          id: String(item.id),
          index: item.object_index,
          title: item.title,
          type: item._class,
          chapter: currentChapter
        };
        curriculumLectureMap.set(String(item.id), entry);
        curriculumOrderList.push(entry);
        if (currentChapter) {
          curriculumChapterMap.set(String(item.id), currentChapter);
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // 1. Nhúng injected.js vào MAIN world
  // --------------------------------------------------------------------------
  function injectMainWorldScript() {
    try {
      if (document.getElementById('udemy-downloader-injected-script')) return;
      const script = document.createElement('script');
      script.id = 'udemy-downloader-injected-script';
      script.src = chrome.runtime.getURL('src/content/injected.js');
      script.onload = function () {
        this.remove();
      };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.warn('[Udemy Downloader] Không thể inject script:', e);
    }
  }

  injectMainWorldScript();

  // --------------------------------------------------------------------------
  // 2. Tiện ích làm sạch tiêu đề bài giảng & phần cha
  // --------------------------------------------------------------------------
  function cleanLectureTitleInline(rawTitle) {
    if (!rawTitle || typeof rawTitle !== 'string') {
      return { title: 'Lesson', index: null };
    }

    let cleaned = rawTitle
      .replace(/(?:Chưa\s+hoàn\s+thành|Hoàn\s+thành|Incomplete|Completed|Uncompleted)/gi, ' ')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
      .replace(/\b\d+\s*(?:phút|min|giây|sec)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let index = null;
    const indexMatch = cleaned.match(/^(?:bài|lecture|section)?\s*(\d+)[\.\s\-:]+/i);
    if (indexMatch) {
      index = parseInt(indexMatch[1], 10);
      cleaned = cleaned.substring(indexMatch[0].length).trim();
    }

    cleaned = cleaned.replace(/^[\.\s\-:]+/, '').trim();

    return {
      title: cleaned || 'Lesson',
      index
    };
  }

  function cleanSectionTitleInline(rawSectionTitle, sectionIndex = null) {
    if (!rawSectionTitle || typeof rawSectionTitle !== 'string') {
      if (sectionIndex) {
        return `Section ${String(sectionIndex).padStart(2, '0')}`;
      }
      return '';
    }

    let cleaned = rawSectionTitle
      .replace(/(?:Chưa\s+hoàn\s+thành|Hoàn\s+thành|Incomplete|Completed|Uncompleted)/gi, ' ')
      .replace(/\b\d+\s*\/\s*\d+\b/g, ' ')
      .replace(/\|\s*.*$/g, '')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
      .replace(/\b\d+\s*(?:phút|min|hr|h|giây|sec)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const prefixMatch = cleaned.match(/^(section|phần|chapter|chương)?\s*(\d+)[\.\s\-:]+/i);
    let finalIndex = sectionIndex ? parseInt(sectionIndex, 10) : null;
    let prefixWord = 'Section';

    if (prefixMatch) {
      if (prefixMatch[1]) {
        prefixWord = prefixMatch[1].charAt(0).toUpperCase() + prefixMatch[1].slice(1).toLowerCase();
      }
      finalIndex = parseInt(prefixMatch[2], 10);
      cleaned = cleaned.substring(prefixMatch[0].length).trim();
    }

    cleaned = cleaned.replace(/^[\.\s\-:]+/, '').trim();

    if (finalIndex) {
      const idxStr = String(finalIndex).padStart(2, '0');
      if (cleaned) {
        return `${prefixWord} ${idxStr} - ${cleaned.replace(/[\/\?<>\\:\*\|":]/g, '-')}`;
      }
      return `${prefixWord} ${idxStr}`;
    }

    return cleaned.replace(/[\/\?<>\\:\*\|":]/g, '-');
  }

  // --------------------------------------------------------------------------
  // 3. Tiện ích phân tích cú pháp Master Playlist M3U8 (Bao gồm Subtitles)
  // --------------------------------------------------------------------------
  function resolveUrl(relativeOrAbsolute, baseUrl) {
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

  function isM3u8PlaylistUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (!url.includes('.m3u8')) return false;
    if (/\.(?:ts|m4s|mp4|m4a|aac|vtt|srt|key|jpe?g|png|gif|svg|css|js)(?:$|\?)/i.test(url)) return false;
    return true;
  }

  function isChildPlaylistUrl(url) {
    if (!isM3u8PlaylistUrl(url)) return false;
    return /\/(?:1080|720|480|360|240|144)\/(?:index|playlist)\.m3u8/i.test(url) ||
           /index_(?:1080|720|480|360|240|144)\.m3u8/i.test(url);
  }

  function deriveMasterPlaylistUrl(url) {
    if (!url || typeof url !== 'string') return null;
    if (/\/(?:1080|720|480|360|240|144)\/(?:index|playlist)\.m3u8/i.test(url)) {
      return url.replace(/\/(?:1080|720|480|360|240|144)\/(?:index|playlist)\.m3u8/i, '/master.m3u8');
    }
    if (/index_(?:1080|720|480|360|240|144)\.m3u8/i.test(url)) {
      return url.replace(/index_(?:1080|720|480|360|240|144)\.m3u8/i, 'master.m3u8');
    }
    return null;
  }

  function parseMasterPlaylistInline(m3u8Content, masterUrl) {
    if (!m3u8Content || typeof m3u8Content !== 'string') return { variants: [], subtitles: [] };

    const lines = m3u8Content.split('\n').map(l => l.trim()).filter(Boolean);
    const variants = [];
    const subtitles = [];

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
          file: masterUrl,
          type: 'hls',
          masterUrl
        }],
        subtitles: []
      };
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Phân tích phụ đề trong master m3u8 (hỗ trợ cả có ngoặc kép hoặc không)
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

      // Phân tích biến thể video
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attributes = line.substring('#EXT-X-STREAM-INF:'.length);

        let height = 0;
        const resMatch = attributes.match(/RESOLUTION=(\d+)x(\d+)/i);
        if (resMatch) {
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
            file: fullUrl,
            type: 'hls',
            masterUrl
          });
        }
      }
    }

    variants.sort((a, b) => b.resolution - a.resolution);
    return { variants, subtitles };
  }

  // --------------------------------------------------------------------------
  // 4. Trích xuất Phụ đề từ thẻ <track> trên toàn DOM
  // --------------------------------------------------------------------------
  function getCaptionsFromDom() {
    const domCaptions = [];
    const tracks = document.querySelectorAll('track');
    tracks.forEach((track, idx) => {
      const src = track.src;
      if (src && (track.kind === 'captions' || track.kind === 'subtitles' || src.includes('.vtt') || track.srclang)) {
        const label = track.label || track.srclang || `Subtitle ${idx + 1}`;
        domCaptions.push({
          id: `dom-track-${idx}`,
          label,
          locale: track.srclang || '',
          url: src
        });
      }
    });
    return domCaptions;
  }

  // --------------------------------------------------------------------------
  // 5. Chuẩn hóa đối tượng phụ đề đa dạng từ API
  // --------------------------------------------------------------------------
  function normalizeCaption(c) {
    if (!c) return null;
    const url = c.url || c.file_url || c.file || c.download_url || c.src || '';
    if (!url) return null;

    let label = c.label || c.title || c.video_label || c.name || '';
    let locale = c.locale_id || c.locale || c.srclang || c.language || '';

    // Dự đoán ngôn ngữ nếu locale còn thiếu
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

  // --------------------------------------------------------------------------
  // 6. Trích xuất thông tin Khóa học & Bài giảng từ URL và DOM
  // --------------------------------------------------------------------------
  function getCourseAndLectureInfoFromPage() {
    const pathname = window.location.pathname;

    const lectureMatch = pathname.match(/\/(?:lecture|quiz|practice)\/(\d+)/);
    const lectureId = lectureMatch ? lectureMatch[1] : null;

    const courseSlugMatch = pathname.match(/\/course\/([^\/]+)/);
    const courseSlug = courseSlugMatch ? courseSlugMatch[1] : null;

    let courseTitle = '';
    const titleEl = document.querySelector('header [data-purpose="course-header-title"]') ||
      document.querySelector('[class*="course-title"]') ||
      document.querySelector('a[href*="/course/"] h1') ||
      document.querySelector('h1');

    if (titleEl && titleEl.textContent.trim()) {
      courseTitle = titleEl.textContent.trim();
    } else {
      const titleParts = document.title.split('|');
      if (titleParts.length >= 2) {
        courseTitle = titleParts[1].trim();
      } else {
        courseTitle = courseSlug ? courseSlug.replace(/-/g, ' ') : 'Udemy Course';
      }
    }

    let rawLectureTitle = '';
    let lectureIndex = 1;
    let rawSectionTitle = '';
    let sectionIndex = null;

    // 1. Ưu tiên cao nhất: Dữ liệu chuẩn xác từ curriculumLectureMap (100% miễn nhiễm với lỗi DOM trễ)
    if (lectureId && curriculumLectureMap.has(String(lectureId))) {
      const curEntry = curriculumLectureMap.get(String(lectureId));
      rawLectureTitle = curEntry.title || '';
      lectureIndex = curEntry.index || 1;
      if (curEntry.chapter) {
        rawSectionTitle = curEntry.chapter.title || '';
        sectionIndex = curEntry.chapter.index || null;
      }
    }

    // 2. Nếu chưa có trong Map, tìm phần tử DOM liên kết ĐÚNG với lectureId hiện tại
    if (!rawLectureTitle && lectureId) {
      const targetLink = document.querySelector(`a[href*="/lecture/${lectureId}"], a[href*="/quiz/${lectureId}"]`);
      if (targetLink) {
        const titleSpan = targetLink.querySelector('[data-purpose="item-title"], [class*="item-title"]');
        if (titleSpan && titleSpan.textContent.trim()) {
          rawLectureTitle = titleSpan.textContent.trim();
        } else {
          const clone = targetLink.cloneNode(true);
          clone.querySelectorAll('.sr-only, [class*="sr-only"], [class*="metadata"], [class*="duration"], svg, span[aria-hidden="true"]').forEach(el => el.remove());
          rawLectureTitle = clone.textContent.trim();
        }
      }
    }

    // 3. Fallback Header chỉ khi Header không chứa bài cũ
    if (!rawLectureTitle) {
      const headerTitleEl = document.querySelector('[data-purpose="lecture-title"]') ||
        document.querySelector('h2[data-purpose="title"]');
      if (headerTitleEl && headerTitleEl.textContent.trim()) {
        rawLectureTitle = headerTitleEl.textContent.trim();
      }
    }

    // 4. Fallback mục active trong danh mục bài giảng
    if (!rawLectureTitle) {
      const currentItemEl = document.querySelector('[class*="curriculum-item-link--is-current"]') ||
        document.querySelector('[aria-current="true"]') ||
        document.querySelector('[data-purpose="curriculum-item-title"]');

      if (currentItemEl) {
        // Kiểm tra xem currentItemEl có trỏ sang một ID khác không
        const href = currentItemEl.getAttribute('href') || '';
        const m = href.match(/\/(?:lecture|quiz)\/(\d+)/);
        if (!m || !lectureId || m[1] === String(lectureId)) {
          const titleSpan = currentItemEl.querySelector('[data-purpose="item-title"]') ||
            currentItemEl.querySelector('[class*="item-title"]');
          if (titleSpan) {
            rawLectureTitle = titleSpan.textContent.trim();
          } else {
            const clone = currentItemEl.cloneNode(true);
            clone.querySelectorAll('.sr-only, [class*="sr-only"], [class*="metadata"], [class*="duration"], svg, span[aria-hidden="true"]').forEach(el => el.remove());
            rawLectureTitle = clone.textContent.trim();
          }
        }
      }
    }

    if (!rawLectureTitle && document.title.includes('|')) {
      rawLectureTitle = document.title.split('|')[0].trim();
    }

    const titleMeta = cleanLectureTitleInline(rawLectureTitle);
    const lectureTitle = titleMeta.title;

    if (titleMeta.index && (!lectureIndex || lectureIndex === 1)) {
      lectureIndex = titleMeta.index;
    }

    // Trích xuất tiêu đề phần cha (Section / Chapter) nếu chưa có từ curriculumChapterMap
    if (lectureId && curriculumChapterMap.has(String(lectureId)) && !rawSectionTitle) {
      const ch = curriculumChapterMap.get(String(lectureId));
      rawSectionTitle = ch.title;
      sectionIndex = ch.index;
    }

    if (!rawSectionTitle) {
      const currentItemEl = document.querySelector('[class*="curriculum-item-link--is-current"]') ||
        document.querySelector('[aria-current="true"]') ||
        document.querySelector('[data-purpose="curriculum-item-title"]');

      if (currentItemEl) {
        const sectionPanel = currentItemEl.closest(
          '[data-purpose*="section"], [class*="section--panel"], [class*="section--section"], [class*="accordion-panel"], .ud-accordion-panel, [class*="curriculum-section"]'
        );
        if (sectionPanel) {
          const secTitleEl = sectionPanel.querySelector(
            '[data-purpose="section-title"], [class*="section-title"], [class*="section--section-title"], [class*="panel-title"], button [class*="title"], h3, h4, [class*="header-title"]'
          );
          if (secTitleEl) {
            const clone = secTitleEl.cloneNode(true);
            clone.querySelectorAll('.sr-only, [class*="sr-only"], [class*="metadata"], [class*="duration"], svg, span[aria-hidden="true"]').forEach(el => el.remove());
            rawSectionTitle = clone.textContent.trim();
          }
        }
      }

      if (!rawSectionTitle) {
        const allSections = document.querySelectorAll(
          '[data-purpose*="section"], [class*="section--panel"], [class*="accordion-panel"], .ud-accordion-panel'
        );
        for (const sec of allSections) {
          if (sec.querySelector('[class*="curriculum-item-link--is-current"], [aria-current="true"]')) {
            const secTitleEl = sec.querySelector(
              '[data-purpose="section-title"], [class*="section-title"], [class*="section--section-title"], button [class*="title"], h3, h4'
            );
            if (secTitleEl) {
              const clone = secTitleEl.cloneNode(true);
              clone.querySelectorAll('.sr-only, [class*="sr-only"], [class*="metadata"], [class*="duration"], svg, span[aria-hidden="true"]').forEach(el => el.remove());
              rawSectionTitle = clone.textContent.trim();
              break;
            }
          }
        }
      }
    }

    const sectionTitle = cleanSectionTitleInline(rawSectionTitle, sectionIndex);

    let courseId = cachedCourseId;
    if (!courseId) {
      const courseIdEl = document.querySelector('[data-course-id]') ||
        document.querySelector('[data-clp-course-id]') ||
        document.querySelector('[data-module-args*="courseId"]');

      if (courseIdEl) {
        courseId = courseIdEl.getAttribute('data-course-id') ||
          courseIdEl.getAttribute('data-clp-course-id');
        if (!courseId) {
          const args = courseIdEl.getAttribute('data-module-args');
          const m = args?.match(/"courseId":\s*(\d+)/);
          if (m) courseId = m[1];
        }
      }
    }

    return {
      lectureId,
      courseSlug,
      courseId,
      courseTitle,
      sectionTitle,
      lectureTitle,
      lectureIndex
    };
  }

  // --------------------------------------------------------------------------
  // 7. Lấy Course ID qua API nếu không có trong DOM
  // --------------------------------------------------------------------------
  async function resolveCourseId(courseSlug) {
    if (cachedCourseId) return cachedCourseId;
    if (!courseSlug) return null;

    try {
      const res = await fetch(`/api-2.0/courses/${courseSlug}/?fields[course]=id,title`, {
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        if (data.id) {
          cachedCourseId = String(data.id);
          return cachedCourseId;
        }
      }
    } catch (e) {
      console.warn('[Udemy Downloader] Lỗi lấy courseId từ slug:', e);
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // 8. Phân tích Master M3U8 từ URL (Cả Video và Phụ đề) - Có Cache & Fallback an toàn
  // --------------------------------------------------------------------------
  const resolvedHlsCache = new Map();
  const inFlightHlsPromises = new Map();
  const failedHlsUrls = new Set();

  async function fetchM3u8Text(url) {
    if (!url || !isM3u8PlaylistUrl(url)) return null;

    // 1. Thử fetch trực tiếp ở Content Script (KHÔNG kèm credentials để không bị CORS block khi CDN trả Access-Control-Allow-Origin: *)
    try {
      const res = await fetch(url);
      if (res.ok) {
        return await res.text();
      }
    } catch (e) {
      // Bị chặn CORS hoặc lỗi mạng -> fallback qua background
    }

    // 2. Fallback qua Background Service Worker (có host_permissions, hoàn toàn không bị hạn chế CORS)
    try {
      const bgRes = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_M3U8_TEXT', url }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(resp);
          }
        });
      });
      if (bgRes && bgRes.success && typeof bgRes.text === 'string') {
        return bgRes.text;
      }
    } catch (e) {}

    return null;
  }

  async function resolveHlsData(m3u8Url) {
    if (!m3u8Url || !isM3u8PlaylistUrl(m3u8Url)) {
      return { streams: [], subtitles: [] };
    }

    if (resolvedHlsCache.has(m3u8Url)) {
      return resolvedHlsCache.get(m3u8Url);
    }

    if (failedHlsUrls.has(m3u8Url)) {
      return { streams: [], subtitles: [] };
    }

    if (inFlightHlsPromises.has(m3u8Url)) {
      return await inFlightHlsPromises.get(m3u8Url);
    }

    const taskPromise = (async () => {
      // Nếu m3u8Url là child variant playlist, thử nạp candidate master trước
      if (isChildPlaylistUrl(m3u8Url)) {
        const candidateMaster = deriveMasterPlaylistUrl(m3u8Url);
        if (candidateMaster) {
          const masterText = await fetchM3u8Text(candidateMaster);
          if (masterText) {
            const parsed = parseMasterPlaylistInline(masterText, candidateMaster);
            if (parsed.variants && parsed.variants.length > 0 && parsed.variants.some(v => v.resolution >= 720)) {
              const result = {
                streams: parsed.variants,
                subtitles: parsed.subtitles
              };
              resolvedHlsCache.set(m3u8Url, result);
              resolvedHlsCache.set(candidateMaster, result);
              return result;
            }
          }
        }
      }

      const m3u8Text = await fetchM3u8Text(m3u8Url);
      if (m3u8Text) {
        const parsed = parseMasterPlaylistInline(m3u8Text, m3u8Url);
        const result = {
          streams: parsed.variants,
          subtitles: parsed.subtitles
        };
        resolvedHlsCache.set(m3u8Url, result);
        return result;
      }

      // Đánh dấu URL lỗi vào set để không tải lặp lại vô ích
      failedHlsUrls.add(m3u8Url);
      if (failedHlsUrls.size > 50) failedHlsUrls.clear();

      let fallbackRes = 720;
      const m = m3u8Url.match(/[\/_](\d{3,4})(?:p|\/|\.m3u8)/i);
      if (m && [1080, 720, 480, 360, 240, 144].includes(parseInt(m[1], 10))) {
        fallbackRes = parseInt(m[1], 10);
      }
      const fallbackResult = {
        streams: [{
          label: `${fallbackRes}`,
          resolution: fallbackRes,
          file: m3u8Url,
          type: 'hls',
          masterUrl: m3u8Url
        }],
        subtitles: []
      };
      resolvedHlsCache.set(m3u8Url, fallbackResult);
      return fallbackResult;
    })();

    inFlightHlsPromises.set(m3u8Url, taskPromise);
    try {
      const res = await taskPromise;
      if (resolvedHlsCache.size > 50) {
        const oldestKey = resolvedHlsCache.keys().next().value;
        resolvedHlsCache.delete(oldestKey);
      }
      return res;
    } finally {
      inFlightHlsPromises.delete(m3u8Url);
    }
  }

  // --------------------------------------------------------------------------
  // 9. Xử lý Payload bài giảng (Hợp nhất 5 nguồn phụ đề & Ưu tiên 1080p HLS)
  // --------------------------------------------------------------------------
  async function processLecturePayload(payload, forcedM3u8Url = null, requestEpoch = null) {
    if (!payload || typeof payload !== 'object') return null;

    if (requestEpoch !== null && requestEpoch !== currentEpoch) {
      console.log(`[Udemy Downloader] Bỏ qua gói tin vì epoch đã cũ (${requestEpoch} vs ${currentEpoch})`);
      return null;
    }

    const pageInfo = getCourseAndLectureInfoFromPage();
    const payloadId = payload.id ? String(payload.id) : null;
    if (pageInfo.lectureId && payloadId && String(pageInfo.lectureId) !== payloadId) {
      console.log(`[Udemy Downloader] Bỏ qua gói tin bài giảng khác ID=${payloadId} (trang hiện tại: ${pageInfo.lectureId})`);
      return null;
    }

    const asset = payload.asset || {};
    const streamUrls = asset.stream_urls || payload.stream_urls || {};

    let mp4Streams = [];
    let hlsSubtitles = [];

    // 1. Thu thập luồng MP4 trực tiếp (dự phòng)
    const rawVideoStreams = streamUrls.Video || [];
    if (Array.isArray(rawVideoStreams) && rawVideoStreams.length > 0) {
      mp4Streams = rawVideoStreams
        .filter(s => s.type === 'video/mp4' && s.file)
        .map(s => ({
          label: s.label || 'Unknown',
          resolution: parseInt(s.label, 10) || 0,
          file: s.file,
          type: 'video/mp4'
        }));
    }

    // 2. Xác định Master M3U8 URL chuẩn cho bài giảng này:
    // Ưu tiên cao nhất: forcedM3u8Url -> streamUrls.hls[0].file (API chính thức) -> asset.media_sources -> interceptedMasterM3u8
    let hlsMasterUrl = forcedM3u8Url;
    if (!hlsMasterUrl) {
      if (Array.isArray(streamUrls.hls) && streamUrls.hls.length > 0 && streamUrls.hls[0].file) {
        hlsMasterUrl = streamUrls.hls[0].file;
      } else if (Array.isArray(asset.media_sources)) {
        const hlsSource = asset.media_sources.find(s => s.type === 'application/x-mpegURL' || s.src?.includes('.m3u8'));
        if (hlsSource && hlsSource.src) hlsMasterUrl = hlsSource.src;
      }
    }
    if (!hlsMasterUrl && interceptedMasterM3u8) {
      hlsMasterUrl = interceptedMasterM3u8;
    }

    let hlsStreams = [];
    if (hlsMasterUrl && isM3u8PlaylistUrl(hlsMasterUrl)) {
      interceptedMasterM3u8 = hlsMasterUrl;
      const hlsData = await resolveHlsData(hlsMasterUrl);
      if (hlsData.streams && hlsData.streams.length > 0) {
        hlsStreams = hlsData.streams;
      }
      if (hlsData.subtitles && hlsData.subtitles.length > 0) {
        hlsSubtitles = hlsData.subtitles;
      }
    }

    // HỢP NHẤT LUỒNG: ƯU TIÊN TUYỆT ĐỐI HLS (CHỨA ĐỘ PHÂN GIẢI 1080P CAO NHẤT)
    let streams = [];
    if (hlsStreams.length > 0) {
      streams = [...hlsStreams];
      const existingRes = new Set(streams.map(s => s.resolution));
      mp4Streams.forEach(mp4 => {
        if (!existingRes.has(mp4.resolution)) {
          streams.push(mp4);
          existingRes.add(mp4.resolution);
        }
      });
    } else {
      streams = [...mp4Streams];
    }

    streams.sort((a, b) => b.resolution - a.resolution);

    // 3. Kiểm tra DRM
    const isDrmProtected = Boolean(
      asset.course_is_drmed ||
      payload.course_is_drmed ||
      (!streams.length && (streamUrls.dash || streamUrls.encrypted_hls)) ||
      Boolean(asset.media_license_token)
    );

    // 4. HỢP NHẤT PHỤ ĐỀ (TỪ 5 NGUỒN ĐỘC LẬP)
    const captionsMap = new Map();

    // Nguồn 4.1: API asset.captions hoặc payload.captions
    const rawApiCaptions = [
      ...(Array.isArray(asset.captions) ? asset.captions : []),
      ...(Array.isArray(payload.captions) ? payload.captions : [])
    ];
    let hasShallowCaptions = false;
    rawApiCaptions.forEach(item => {
      const norm = normalizeCaption(item);
      if (norm && !captionsMap.has(norm.url)) {
        captionsMap.set(norm.url, norm);
      } else if (item && (item.id || item.locale_id) && !item.url) {
        hasShallowCaptions = true;
      }
    });

    // Nếu API chỉ trả về stub ID nông mà không có url, chủ động gọi endpoint captions chi tiết
    if (hasShallowCaptions && captionsMap.size === 0 && (payload.id || pageInfo.lectureId)) {
      const targetLecId = payload.id || pageInfo.lectureId;
      const targetCourseId = pageInfo.courseId || cachedCourseId;
      const directCaps = await fetchCaptionsDirectly(targetCourseId, targetLecId);
      directCaps.forEach(item => {
        if (item.url && !captionsMap.has(item.url)) {
          captionsMap.set(item.url, item);
        }
      });
    }

    // Nguồn 4.2: Phụ đề trích xuất từ Master HLS Playlist
    hlsSubtitles.forEach(item => {
      if (item.url && !captionsMap.has(item.url)) {
        captionsMap.set(item.url, item);
      }
    });

    // Nguồn 4.3: Phụ đề từ thẻ <track> trên trang DOM
    const domCaptions = getCaptionsFromDom();
    domCaptions.forEach(item => {
      if (item.url && !captionsMap.has(item.url)) {
        captionsMap.set(item.url, item);
      }
    });

    // Nguồn 4.4: Phụ đề bắt được qua mạng (injected.js)
    interceptedCaptionsList.forEach(vttUrl => {
      if (!captionsMap.has(vttUrl)) {
        // Dự đoán ngôn ngữ từ URL (ví dụ en_US.vtt hoặc vi_VN.vtt)
        let label = 'Subtitles';
        const m = vttUrl.match(/([a-z]{2}(?:_[A-Z]{2})?)\.vtt/i);
        if (m) label = `Phụ đề (${m[1]})`;
        captionsMap.set(vttUrl, {
          id: `net-sub-${captionsMap.size + 1}`,
          label,
          locale: m ? m[1] : '',
          url: vttUrl
        });
      }
    });

    const captions = Array.from(captionsMap.values());

    // 5. Tài liệu đính kèm
    let supplementaryAssets = [];
    const rawSupp = payload.supplementary_assets || [];
    if (Array.isArray(rawSupp)) {
      supplementaryAssets = rawSupp.map(item => {
        const downloadUrls = item.download_urls?.File || [];
        const fileUrl = downloadUrls.length > 0 ? downloadUrls[0].file : (item.file_url || '');
        return {
          id: item.id,
          title: item.title || item.filename || 'Resource',
          filename: item.filename || item.title || 'file',
          downloadUrl: fileUrl
        };
      }).filter(item => Boolean(item.downloadUrl));
    }

    const rawTitle = payload.title || pageInfo.lectureTitle || `Lecture ${pageInfo.lectureId || ''}`;
    const cleanedMeta = cleanLectureTitleInline(rawTitle);
    const finalLectureTitle = cleanedMeta.title;
    const finalLectureIndex = payload.object_index || (payload.id && curriculumLectureMap.get(String(payload.id))?.index) || cleanedMeta.index || pageInfo.lectureIndex || 1;
    const finalCourseTitle = pageInfo.courseTitle || 'Udemy Course';
    const rawSection = payload.chapter?.title || payload.section?.title || pageInfo.sectionTitle || '';
    const sectionIdx = payload.chapter?.object_index || payload.section?.object_index;
    const finalSectionTitle = cleanSectionTitleInline(rawSection, sectionIdx);

    const processedData = {
      lectureId: payload.id || pageInfo.lectureId,
      courseId: pageInfo.courseId || cachedCourseId,
      courseTitle: finalCourseTitle,
      sectionTitle: finalSectionTitle,
      lectureTitle: finalLectureTitle,
      lectureIndex: finalLectureIndex,
      assetType: asset.asset_type || (window.location.pathname.includes('/quiz/') ? 'Quiz' : 'Video'),
      isQuiz: payload._class === 'quiz' || window.location.pathname.includes('/quiz/'),
      isArticle: asset.asset_type === 'Article' || payload._class === 'article',
      isDrmProtected,
      streams,
      bestQuality: streams.length > 0 ? streams[0] : null,
      masterM3u8Url: hlsMasterUrl || null,
      captions,
      supplementaryAssets,
      duration: asset.time_estimation || 0,
      timestamp: Date.now()
    };

    // Kiểm tra lần cuối trước khi cập nhật state: đảm bảo trong lúc xử lý async URL không bị chuyển sang bài khác
    const latestPage = getCourseAndLectureInfoFromPage();
    if (latestPage.lectureId && processedData.lectureId && String(latestPage.lectureId) !== String(processedData.lectureId)) {
      console.log(`[Udemy Downloader] Hủy gán bài giảng: trang đã chuyển sang ID=${latestPage.lectureId} trong khi đang xử lý ID=${processedData.lectureId}`);
      return null;
    }
    if (requestEpoch !== null && requestEpoch !== currentEpoch) {
      console.log(`[Udemy Downloader] Hủy gán bài giảng: epoch đã lỗi thời (${requestEpoch} vs ${currentEpoch})`);
      return null;
    }

    currentLectureInfo = processedData;

    chrome.runtime.sendMessage({
      type: 'UPDATE_LECTURE_DATA',
      data: processedData
    }).catch(() => {});

    return processedData;
  }

  // --------------------------------------------------------------------------
  // 9.1 Cập nhật & Nâng cấp Luồng phát khi bắt được M3U8 mới từ Mạng
  // --------------------------------------------------------------------------
  async function updateStreamsWithM3u8(m3u8Url) {
    if (!m3u8Url || !isM3u8PlaylistUrl(m3u8Url)) return;

    const pageInfo = getCourseAndLectureInfoFromPage();
    if (!pageInfo.lectureId) return;

    let targetUrl = m3u8Url;
    if (isChildPlaylistUrl(m3u8Url)) {
      const derived = deriveMasterPlaylistUrl(m3u8Url);
      if (derived) targetUrl = derived;
    }

    // Nếu bài giảng hiện tại đã có masterM3u8Url giống hệt và đã chứa các luồng phân giải HLS cao
    if (currentLectureInfo && currentLectureInfo.masterM3u8Url === targetUrl &&
        currentLectureInfo.streams && currentLectureInfo.streams.some(s => s.type === 'hls' && s.resolution >= 720)) {
      return;
    }

    const hlsData = await resolveHlsData(targetUrl);
    if (!hlsData || !hlsData.streams || hlsData.streams.length === 0) return;

    const thisEpoch = currentEpoch;
    if (!currentLectureInfo || String(currentLectureInfo.lectureId) !== String(pageInfo.lectureId)) {
      await fetchLectureApiDirectly(thisEpoch);
    }

    if (currentEpoch !== thisEpoch) return;

    const latestPage = getCourseAndLectureInfoFromPage();
    if (currentLectureInfo && String(currentLectureInfo.lectureId) === String(latestPage.lectureId)) {
      const currentBestRes = currentLectureInfo.bestQuality?.resolution || 0;
      const newBestRes = hlsData.streams[0]?.resolution || 0;

      let hasNewStream = false;
      // Nếu luồng HLS mới có độ phân giải cao hơn (ví dụ 1080p > 720p) hoặc hiện tại chưa có HLS
      if (newBestRes > currentBestRes || !currentLectureInfo.streams?.some(s => s.type === 'hls')) {
        const mergedStreams = [...hlsData.streams];
        const existingRes = new Set(mergedStreams.map(s => s.resolution));
        (currentLectureInfo.streams || []).forEach(s => {
          if (s.type !== 'hls' && !existingRes.has(s.resolution)) {
            mergedStreams.push(s);
            existingRes.add(s.resolution);
          }
        });
        mergedStreams.sort((a, b) => b.resolution - a.resolution);
        currentLectureInfo.streams = mergedStreams;
        currentLectureInfo.bestQuality = mergedStreams[0];
        currentLectureInfo.masterM3u8Url = targetUrl;
        hasNewStream = true;
      }

      if (hlsData.subtitles && hlsData.subtitles.length > 0) {
        const existingCapUrls = new Set((currentLectureInfo.captions || []).map(c => c.url));
        hlsData.subtitles.forEach(sub => {
          if (!existingCapUrls.has(sub.url)) {
            currentLectureInfo.captions.push(sub);
            existingCapUrls.add(sub.url);
            hasNewStream = true;
          }
        });
      }

      if (hasNewStream) {
        console.log(`[Udemy Downloader] Đã nâng cấp luồng bài giảng lên ${currentLectureInfo.bestQuality?.label}p HD!`);
        chrome.runtime.sendMessage({
          type: 'UPDATE_LECTURE_DATA',
          data: currentLectureInfo
        }).catch(() => {});
      }
    }
  }

  // --------------------------------------------------------------------------
  // 9.2 Hàm điều phối chuyển đổi bài giảng tập trung (Chống giật / Loạn trạng thái)
  // --------------------------------------------------------------------------
  function handleLectureTransition(newLectureId) {
    if (!newLectureId) return;

    // Nếu ĐÃ LÀ bài đang theo dõi (cùng ID), tuyệt đối không reset hay tăng epoch
    if (lastMonitoredLectureId === String(newLectureId)) {
      return;
    }

    currentEpoch++;
    const thisEpoch = currentEpoch;
    lastMonitoredLectureId = String(newLectureId);

    console.log(`[Udemy Downloader] Kích hoạt chuyển bài mới ID=${newLectureId} (Epoch ${thisEpoch})`);

    // Reset sạch dữ liệu bài cũ ngay lập tức
    currentLectureInfo = null;
    interceptedMasterM3u8 = null;
    interceptedCaptionsList.length = 0;

    if (scheduledFetchTimeout) {
      clearTimeout(scheduledFetchTimeout);
      scheduledFetchTimeout = null;
    }

    // Báo Popup và Background xóa sạch cache bài cũ, đánh dấu đang tải bài mới
    chrome.runtime.sendMessage({
      type: 'UPDATE_LECTURE_DATA',
      data: null,
      loadingLectureId: newLectureId
    }).catch(() => {});

    // Kích hoạt nạp API chính thức cho bài mới sau 300ms
    scheduledFetchTimeout = setTimeout(() => {
      scheduledFetchTimeout = null;
      if (currentEpoch === thisEpoch) {
        fetchLectureApiDirectly(thisEpoch);
      }
    }, 300);
  }

  // --------------------------------------------------------------------------
  // 10. Lắng nghe gói tin từ Injected Script
  // --------------------------------------------------------------------------
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'UDEMY_LECTURE_INTERCEPTED') {
      const targetLecId = event.data.lectureId || (event.data.payload?.id ? String(event.data.payload.id) : null);
      const pageInfo = getCourseAndLectureInfoFromPage();
      if (pageInfo.lectureId && targetLecId && String(pageInfo.lectureId) !== targetLecId) {
        console.log(`[Udemy Downloader] Bỏ qua gói tin UDEMY_LECTURE_INTERCEPTED vì ID=${targetLecId} khác trang hiện tại ${pageInfo.lectureId}`);
        return;
      }
      await processLecturePayload(event.data.payload, null, currentEpoch);
    } else if (event.data?.type === 'UDEMY_CURRICULUM_INTERCEPTED') {
      const results = event.data.results || [];
      storeCurriculumResults(results);
      if (currentLectureInfo) {
        let changed = false;
        if (!currentLectureInfo.sectionTitle) {
          const pageInfo = getCourseAndLectureInfoFromPage();
          if (pageInfo.sectionTitle) {
            currentLectureInfo.sectionTitle = pageInfo.sectionTitle;
            changed = true;
          }
        }
        if (!currentLectureInfo.lectureIndex && currentLectureInfo.lectureId && curriculumLectureMap.has(String(currentLectureInfo.lectureId))) {
          currentLectureInfo.lectureIndex = curriculumLectureMap.get(String(currentLectureInfo.lectureId)).index;
          changed = true;
        }
        if (changed) {
          chrome.runtime.sendMessage({
            type: 'UPDATE_LECTURE_DATA',
            data: currentLectureInfo
          }).catch(() => {});
        }
      }
    } else if (event.data?.type === 'UDEMY_M3U8_INTERCEPTED') {
      const newM3u8 = event.data.m3u8Url;
      if (newM3u8 && isM3u8PlaylistUrl(newM3u8)) {
        if (!isChildPlaylistUrl(newM3u8) || !interceptedMasterM3u8) {
          interceptedMasterM3u8 = newM3u8;
        }
        await updateStreamsWithM3u8(newM3u8);
      }
    } else if (event.data?.type === 'UDEMY_CAPTION_INTERCEPTED') {
      const vttUrl = event.data.vttUrl;
      if (vttUrl && !interceptedCaptionsList.includes(vttUrl)) {
        interceptedCaptionsList.push(vttUrl);
        if (currentLectureInfo) {
          const norm = normalizeCaption({ url: vttUrl });
          if (norm && !currentLectureInfo.captions.some(c => c.url === vttUrl)) {
            currentLectureInfo.captions.push(norm);
            chrome.runtime.sendMessage({
              type: 'UPDATE_LECTURE_DATA',
              data: currentLectureInfo
            }).catch(() => {});
          }
        }
      }
    } else if (event.data?.type === 'UDEMY_CAPTIONS_LIST_INTERCEPTED') {
      const list = event.data.captions || [];
      if (list.length > 0) {
        let changed = false;
        if (!currentLectureInfo) {
          const pageInfo = getCourseAndLectureInfoFromPage();
          currentLectureInfo = {
            lectureId: pageInfo.lectureId,
            courseId: pageInfo.courseId || cachedCourseId,
            courseTitle: pageInfo.courseTitle,
            sectionTitle: pageInfo.sectionTitle,
            lectureTitle: pageInfo.lectureTitle,
            lectureIndex: pageInfo.lectureIndex,
            streams: [],
            captions: [],
            supplementaryAssets: [],
            timestamp: Date.now()
          };
        }
        const existingUrls = new Set(currentLectureInfo.captions.map(c => c.url));
        list.forEach(item => {
          const norm = normalizeCaption(item);
          if (norm && !existingUrls.has(norm.url)) {
            currentLectureInfo.captions.push(norm);
            existingUrls.add(norm.url);
            changed = true;
          }
        });
        if (changed) {
          chrome.runtime.sendMessage({
            type: 'UPDATE_LECTURE_DATA',
            data: currentLectureInfo
          }).catch(() => {});
        }
      }
    } else if (event.data?.type === 'UDEMY_URL_CHANGED') {
      const pageInfo = getCourseAndLectureInfoFromPage();
      const newLecId = event.data.lectureId || pageInfo.lectureId;
      if (newLecId) {
        handleLectureTransition(newLecId);
      }
    }
  });

  // Tải ngầm danh sách chương mục khóa học nếu có courseId
  async function fetchCurriculumIfNeeded(courseId) {
    if (!courseId || curriculumLectureMap.size > 0) return;
    try {
      const res = await fetch(`/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=1400&fields[lecture]=title,object_index&fields[chapter]=title,object_index&fields[quiz]=title,object_index&fields[practice]=title,object_index`, {
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.results)) {
          storeCurriculumResults(data.results);
          if (currentLectureInfo) {
            let changed = false;
            if (!currentLectureInfo.sectionTitle) {
              const pageInfo = getCourseAndLectureInfoFromPage();
              if (pageInfo.sectionTitle) {
                currentLectureInfo.sectionTitle = pageInfo.sectionTitle;
                changed = true;
              }
            }
            if (!currentLectureInfo.lectureIndex && currentLectureInfo.lectureId && curriculumLectureMap.has(String(currentLectureInfo.lectureId))) {
              currentLectureInfo.lectureIndex = curriculumLectureMap.get(String(currentLectureInfo.lectureId)).index;
              changed = true;
            }
            if (changed) {
              chrome.runtime.sendMessage({
                type: 'UPDATE_LECTURE_DATA',
                data: currentLectureInfo
              }).catch(() => {});
            }
          }
        }
      }
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // 11. Gọi trực tiếp endpoint Phụ đề của Udemy để lấy đầy đủ URL .vtt
  // --------------------------------------------------------------------------
  async function fetchCaptionsDirectly(courseId, lectureId) {
    if (!lectureId) return [];
    const endpoints = [];
    const fields = 'fields[caption]=@default,url,locale_id,title,video_label,source';
    if (courseId) {
      endpoints.push(`/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/captions/?${fields}`);
    }
    endpoints.push(`/api-2.0/lectures/${lectureId}/captions/?${fields}`);

    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          credentials: 'include',
          headers: { 'Accept': 'application/json, text/plain, */*' }
        });
        if (res.ok) {
          const json = await res.json();
          const rawList = Array.isArray(json) ? json : (Array.isArray(json.results) ? json.results : (json.captions || []));
          if (rawList.length > 0) {
            const normList = rawList.map(normalizeCaption).filter(Boolean);
            if (normList.length > 0) {
              return normList;
            }
          }
        }
      } catch (e) {
        console.warn('[Udemy Downloader] Thử endpoint captions lỗi:', e);
      }
    }
    return [];
  }

  // --------------------------------------------------------------------------
  // 12. Fallback chủ động gọi API khi người dùng mở Popup
  // --------------------------------------------------------------------------
  async function fetchLectureApiDirectly(requestEpoch = null) {
    if (requestEpoch !== null && requestEpoch !== currentEpoch) return null;
    const pageInfo = getCourseAndLectureInfoFromPage();
    if (!pageInfo.lectureId) return null;

    let courseId = pageInfo.courseId;
    if (!courseId && pageInfo.courseSlug) {
      courseId = await resolveCourseId(pageInfo.courseSlug);
    }

    if (courseId) {
      fetchCurriculumIfNeeded(courseId);
    }

    try {
      const captionField = '&fields[caption]=@default,url,locale_id,title,video_label,source';
      const url = courseId
        ? `/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${pageInfo.lectureId}/?fields[lecture]=title,object_index,asset,supplementary_assets,description,download_urls,captions&fields[asset]=@default,stream_urls,download_urls,captions,media_sources,media_license_token,course_is_drmed${captionField}`
        : `/api-2.0/lectures/${pageInfo.lectureId}/?fields[lecture]=title,object_index,asset,supplementary_assets,description,download_urls,captions&fields[asset]=@default,stream_urls,download_urls,captions,media_sources,media_license_token,course_is_drmed${captionField}`;

      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json, text/plain, */*' }
      });

      if (res.ok) {
        if (requestEpoch !== null && requestEpoch !== currentEpoch) return null;
        const data = await res.json();
        const processed = await processLecturePayload(data, null, requestEpoch);
        if (processed && (!processed.captions || processed.captions.length === 0)) {
          const directCaps = await fetchCaptionsDirectly(courseId, pageInfo.lectureId);
          if (directCaps.length > 0 && (requestEpoch === null || requestEpoch === currentEpoch)) {
            processed.captions = directCaps;
            if (currentLectureInfo && String(currentLectureInfo.lectureId) === String(pageInfo.lectureId)) {
              currentLectureInfo.captions = directCaps;
            }
          }
        }
        return processed;
      }
    } catch (err) {
      console.warn('[Udemy Downloader] Lỗi gọi fallback API:', err);
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // 13. Lắng nghe tin nhắn từ Popup và Background
  // --------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ status: 'pong' });
      return true;
    }

    if (message.type === 'BACKGROUND_DETECTED_M3U8') {
      const newM3u8 = message.m3u8Url;
      if (newM3u8 && isM3u8PlaylistUrl(newM3u8)) {
        if (!isChildPlaylistUrl(newM3u8) || !interceptedMasterM3u8) {
          interceptedMasterM3u8 = newM3u8;
        }
        updateStreamsWithM3u8(newM3u8);
      }
      return true;
    }

    if (message.type === 'GET_COURSE_AND_LECTURE_INFO') {
      const pageInfo = getCourseAndLectureInfoFromPage();
      if (!pageInfo.courseId && pageInfo.courseSlug) {
        resolveCourseId(pageInfo.courseSlug).then((cid) => {
          pageInfo.courseId = cid;
          sendResponse({ success: true, pageInfo });
        }).catch(() => {
          sendResponse({ success: true, pageInfo });
        });
        return true;
      }
      sendResponse({ success: true, pageInfo });
      return true;
    }

    if (message.type === 'API_FETCH') {
      fetch(message.url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json, text/plain, */*' }
      })
        .then(async (r) => {
          const text = await r.text();
          let data = text;
          try { data = JSON.parse(text); } catch (e) {}
          sendResponse({ ok: r.ok, status: r.status, data });
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err.message });
        });
      return true;
    }

    if (message.type === 'GET_CURRENT_LECTURE_FROM_PAGE') {
      const pageInfo = getCourseAndLectureInfoFromPage();

      // Chỉ kích hoạt transition nếu bài giảng thực sự khác với bài đang theo dõi
      if (pageInfo.lectureId && lastMonitoredLectureId !== String(pageInfo.lectureId)) {
        handleLectureTransition(pageInfo.lectureId);
      }

      // 1. Trả lời ngay nếu đã có thông tin bài giảng hiện tại (có streams)
      const isExactLecture = currentLectureInfo && pageInfo.lectureId && String(currentLectureInfo.lectureId) === String(pageInfo.lectureId);
      if (isExactLecture && currentLectureInfo.streams && currentLectureInfo.streams.length > 0) {
        sendResponse({ success: true, data: currentLectureInfo, pageInfo });
        return true;
      }

      // 2. Yêu cầu Injected script phát lại cache
      window.postMessage({ type: 'UDEMY_REQUEST_LATEST_DATA', expectedLectureId: pageInfo.lectureId }, '*');

      // 3. Gọi nạp API trực tiếp và LUÔN LUÔN gọi sendResponse (không bao giờ drop làm popup treo loading)
      const thisEpoch = currentEpoch;
      fetchLectureApiDirectly(thisEpoch)
        .then(async (data) => {
          const targetData = (data && String(data.lectureId) === String(pageInfo.lectureId)) ? data :
            (currentLectureInfo && String(currentLectureInfo.lectureId) === String(pageInfo.lectureId) ? currentLectureInfo : null);

          if (targetData && (!targetData.captions || targetData.captions.length === 0)) {
            try {
              const caps = await fetchCaptionsDirectly(pageInfo.courseId || cachedCourseId, pageInfo.lectureId);
              if (caps && caps.length > 0) {
                targetData.captions = caps;
                if (currentLectureInfo && String(currentLectureInfo.lectureId) === String(pageInfo.lectureId)) {
                  currentLectureInfo.captions = caps;
                }
              }
            } catch (e) {}
          }

          if (targetData) {
            sendResponse({ success: true, data: targetData, pageInfo });
          } else {
            sendResponse({
              success: Boolean(currentLectureInfo && String(currentLectureInfo.lectureId) === String(pageInfo.lectureId)),
              data: (currentLectureInfo && String(currentLectureInfo.lectureId) === String(pageInfo.lectureId)) ? currentLectureInfo : null,
              pageInfo,
              error: 'Chưa bắt được luồng phát video. Vui lòng bấm Phát (Play) video bài giảng.'
            });
          }
        })
        .catch((err) => {
          console.warn('[Udemy Downloader] Lỗi GET_CURRENT_LECTURE_FROM_PAGE:', err);
          sendResponse({
            success: false,
            data: (currentLectureInfo && String(currentLectureInfo.lectureId) === String(pageInfo.lectureId)) ? currentLectureInfo : null,
            pageInfo,
            error: err.message
          });
        });

      return true;
    }

    if (message.type === 'FETCH_CAPTIONS_FORCE') {
      (async () => {
        const pageInfo = getCourseAndLectureInfoFromPage();
        const courseId = pageInfo.courseId || cachedCourseId;
        const lectureId = pageInfo.lectureId;
        const directCaps = await fetchCaptionsDirectly(courseId, lectureId);
        const domCaps = getCaptionsFromDom();

        const map = new Map();
        (currentLectureInfo?.captions || []).forEach(c => map.set(c.url, c));
        directCaps.forEach(c => map.set(c.url, c));
        domCaps.forEach(c => map.set(c.url, c));

        const merged = Array.from(map.values());
        if (currentLectureInfo) {
          currentLectureInfo.captions = merged;
          chrome.runtime.sendMessage({
            type: 'UPDATE_LECTURE_DATA',
            data: currentLectureInfo
          }).catch(() => {});
        }
        sendResponse({ success: true, captions: merged });
      })();
      return true;
    }

    if (message.type === 'GO_TO_NEXT_LECTURE') {
      triggerNextLecture().then(res => {
        sendResponse(res);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }
  });

  // --------------------------------------------------------------------------
  // 14. Tiện ích Mở rộng các phần giáo trình và Tìm mục tiêu bài tiếp theo
  // --------------------------------------------------------------------------
  function expandAllCurriculumSections() {
    const collapsedHeaders = document.querySelectorAll(
      'button[aria-expanded="false"][data-purpose*="section"], ' +
      'button[aria-expanded="false"][class*="section"], ' +
      'button[aria-expanded="false"][class*="accordion"], ' +
      '[data-purpose*="curriculum-section"] button[aria-expanded="false"], ' +
      '.ud-accordion-panel-toggler[aria-expanded="false"]'
    );
    collapsedHeaders.forEach(btn => {
      try { btn.click(); } catch (e) {}
    });
  }

  async function getNextLectureTarget() {
    const pageInfo = getCourseAndLectureInfoFromPage();
    const currentId = String(pageInfo.lectureId || currentLectureInfo?.lectureId || '');
    const courseSlug = pageInfo.courseSlug || '';

    // Chiến lược 1: Sử dụng curriculumOrderList đã có sẵn trong bộ nhớ
    if (curriculumOrderList.length > 0 && currentId) {
      const idx = curriculumOrderList.findIndex(item => String(item.id) === currentId);
      if (idx !== -1) {
        if (idx + 1 < curriculumOrderList.length) {
          const nextItem = curriculumOrderList[idx + 1];
          const nextType = nextItem.type === 'quiz' ? 'quiz' : 'lecture';
          return {
            id: String(nextItem.id),
            type: nextType,
            title: nextItem.title,
            index: nextItem.index,
            url: `/course/${courseSlug}/learn/${nextType}/${nextItem.id}`
          };
        } else {
          return { isLast: true };
        }
      }
    }

    // Chiến lược 2: Trích xuất trực tiếp từ __NEXT_DATA__ trong HTML
    const nextDataEl = document.getElementById('__NEXT_DATA__');
    if (nextDataEl && nextDataEl.textContent) {
      try {
        const nextJson = JSON.parse(nextDataEl.textContent);
        const curriculum = nextJson.props?.pageProps?.curriculum ||
                           nextJson.props?.pageProps?.course?.curriculum;
        if (Array.isArray(curriculum) && curriculum.length > 0) {
          storeCurriculumResults(curriculum);
          if (curriculumOrderList.length > 0 && currentId) {
            const idx = curriculumOrderList.findIndex(item => String(item.id) === currentId);
            if (idx !== -1) {
              if (idx + 1 < curriculumOrderList.length) {
                const nextItem = curriculumOrderList[idx + 1];
                const nextType = nextItem.type === 'quiz' ? 'quiz' : 'lecture';
                return {
                  id: String(nextItem.id),
                  type: nextType,
                  title: nextItem.title,
                  index: nextItem.index,
                  url: `/course/${courseSlug}/learn/${nextType}/${nextItem.id}`
                };
              } else {
                return { isLast: true };
              }
            }
          }
        }
      } catch (e) {}
    }

    // Chiến lược 3: Quét các liên kết bài học trong Curriculum Drawer (Mở các section bị thu gọn)
    expandAllCurriculumSections();

    const domLinks = Array.from(document.querySelectorAll('a[href*="/lecture/"], a[href*="/quiz/"]'));
    const linkItems = [];
    const seenHrefs = new Set();
    domLinks.forEach(a => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/(lecture|quiz)\/(\d+)/);
      if (m && !seenHrefs.has(m[0])) {
        seenHrefs.add(m[0]);
        linkItems.push({ el: a, href, type: m[1], id: m[2] });
      }
    });

    if (linkItems.length > 0 && currentId) {
      const curIdx = linkItems.findIndex(item => item.id === currentId);
      if (curIdx !== -1) {
        if (curIdx + 1 < linkItems.length) {
          const nextLink = linkItems[curIdx + 1];
          return {
            id: nextLink.id,
            type: nextLink.type,
            url: nextLink.href,
            el: nextLink.el
          };
        } else {
          return { isLast: true };
        }
      }
    }

    // Chiến lược 4: Tìm courseId từ HTML nguồn và fetch curriculum qua các endpoint API
    let courseId = pageInfo.courseId || cachedCourseId;
    if (!courseId) {
      const m = document.documentElement.innerHTML.match(/"courseId":\s*(\d+)|"course_id":\s*(\d+)|data-course-id="(\d+)"/);
      if (m) courseId = m[1] || m[2] || m[3];
    }

    const endpoints = [];
    if (courseId) {
      endpoints.push(`/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=1400`);
      endpoints.push(`/api-2.0/courses/${courseId}/curriculum-items/?page_size=1400`);
    }
    if (courseSlug) {
      endpoints.push(`/api-2.0/courses/${courseSlug}/subscriber-curriculum-items/?page_size=1400`);
      endpoints.push(`/api-2.0/courses/${courseSlug}/curriculum-items/?page_size=1400`);
    }

    for (const ep of endpoints) {
      try {
        const res = await fetch(ep, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.results) && data.results.length > 0) {
            storeCurriculumResults(data.results);
            if (currentId) {
              const idx = curriculumOrderList.findIndex(item => String(item.id) === currentId);
              if (idx !== -1) {
                if (idx + 1 < curriculumOrderList.length) {
                  const nextItem = curriculumOrderList[idx + 1];
                  const nextType = nextItem.type === 'quiz' ? 'quiz' : 'lecture';
                  return {
                    id: String(nextItem.id),
                    type: nextType,
                    title: nextItem.title,
                    index: nextItem.index,
                    url: `/course/${courseSlug}/learn/${nextType}/${nextItem.id}`
                  };
                } else {
                  return { isLast: true };
                }
              }
            }
            break;
          }
        }
      } catch (e) {}
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // 15. Kích hoạt chuyển sang bài giảng tiếp theo (Auto Next Đa Lớp)
  // --------------------------------------------------------------------------
  async function triggerNextLecture() {
    console.log('[Udemy Downloader] Bắt đầu kích hoạt chuyển bài tiếp theo...');

    // 1. Đánh dấu hoàn tất video trên trang (Seek video về cuối và phát sự kiện ended)
    try {
      const video = document.querySelector('video');
      if (video && !isNaN(video.duration) && video.duration > 0) {
        video.currentTime = Math.max(0, video.duration - 0.2);
        video.dispatchEvent(new Event('timeupdate'));
        video.dispatchEvent(new Event('ended'));
      }
    } catch (e) {}

    // 2. Thử kích hoạt phím tắt chính thức của Udemy Player: Shift + N
    try {
      const keyOpts = { key: 'N', code: 'KeyN', keyCode: 78, which: 78, shiftKey: true, bubbles: true, cancelable: true };
      const targetEl = document.querySelector('video') || document.activeElement || document.body;
      targetEl.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
      targetEl.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    } catch (e) {}

    // 3. Thử tìm và click các nút Next trên giao diện (bỏ qua thuộc tính disabled)
    const nextSelectors = [
      '[data-purpose="go-to-next-lecture"]',
      '[data-purpose="go-to-next-button"]',
      '[data-purpose="go-to-next-lecture-button"]',
      '[data-purpose="next-lecture-button"]',
      '[data-purpose="next-lecture"]',
      '[data-purpose="go-to-next"]',
      '[data-purpose="next-button"]',
      '[data-purpose="next-item"]',
      'button[data-purpose*="next"]',
      'a[data-purpose*="next"]',
      'button[data-purpose*="go-to-next"]',
      'a[data-purpose*="go-to-next"]',
      'button[aria-label*="next" i]',
      'a[aria-label*="next" i]',
      'button[aria-label*="tiếp" i]',
      'a[aria-label*="tiếp" i]',
      'button[class*="next-lecture"]',
      'a[class*="next-lecture"]',
      '[class*="go-to-next"]',
      'button[class*="next-button"]',
      'a[class*="next-button"]'
    ];

    for (const sel of nextSelectors) {
      const elements = Array.from(document.querySelectorAll(sel));
      for (const btn of elements) {
        if (btn) {
          try {
            if (btn.disabled) btn.disabled = false;
            btn.removeAttribute('disabled');
            btn.removeAttribute('aria-disabled');
            btn.click();
            console.log('[Udemy Downloader] Đã click nút Next:', sel);
          } catch (e) {}
        }
      }
    }

    // 4. Lấy mục tiêu bài tiếp theo một cách chuẩn xác 100%
    const nextTarget = await getNextLectureTarget();
    if (nextTarget) {
      if (nextTarget.isLast) {
        return { success: false, isLast: true, error: 'Đã tới bài cuối cùng của khóa học!' };
      }

      if (nextTarget.el && typeof nextTarget.el.click === 'function') {
        try {
          nextTarget.el.click();
        } catch (e) {}
      }

      return {
        success: true,
        method: 'target-resolved',
        nextUrl: nextTarget.url,
        nextId: nextTarget.id
      };
    }

    // 5. Fallback cuối cùng: Thử click bất kỳ link bài học nào khác bài hiện tại
    const pageInfo = getCourseAndLectureInfoFromPage();
    const currentId = String(pageInfo.lectureId || '');
    const allLinks = Array.from(document.querySelectorAll('a[href*="/lecture/"], a[href*="/quiz/"]'));
    for (const a of allLinks) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/(lecture|quiz)\/(\d+)/);
      if (m && m[2] !== currentId) {
        try { a.click(); } catch (e) {}
        return { success: true, method: 'dom-fallback-link', nextUrl: href, nextId: m[2] };
      }
    }

    return { success: false, error: 'Không tìm thấy bài giảng tiếp theo hoặc đã tới bài cuối cùng của khóa học.' };
  }



  setTimeout(() => {
    const pInfo = getCourseAndLectureInfoFromPage();
    if (pInfo.lectureId && !currentLectureInfo) {
      handleLectureTransition(pInfo.lectureId);
    }
  }, 1000);

  // Định kỳ giám sát URL để phát hiện chuyển bài trong SPA (dùng chung handleLectureTransition tập trung)
  setInterval(() => {
    const pInfo = getCourseAndLectureInfoFromPage();
    if (pInfo.lectureId && pInfo.lectureId !== lastMonitoredLectureId) {
      handleLectureTransition(pInfo.lectureId);
    }
  }, 800);
})();
