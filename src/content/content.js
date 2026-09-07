/**
 * Content Script (Chạy trong ISOLATED world của trang Udemy)
 * KHÔNG dùng import/export để đảm bảo tương thích 100% với trình tải content scripts của Chromium.
 */

(function () {
  console.log('[Udemy Downloader] Content script đã khởi tạo thành công!');

  let currentLectureInfo = null;
  let interceptedMasterM3u8 = null;
  let cachedCourseId = null;
  const interceptedCaptionsList = [];
  const curriculumChapterMap = new Map();
  const curriculumLectureMap = new Map();
  const curriculumOrderList = [];

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

  function isChildPlaylistUrl(url) {
    if (!url || typeof url !== 'string') return false;
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

    const lectureMatch = pathname.match(/\/lecture\/(\d+)/);
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

    const headerTitleEl = document.querySelector('[data-purpose="lecture-title"]') ||
      document.querySelector('h2[data-purpose="title"]');
    if (headerTitleEl && headerTitleEl.textContent.trim()) {
      rawLectureTitle = headerTitleEl.textContent.trim();
    }

    if (!rawLectureTitle) {
      const currentItemEl = document.querySelector('[class*="curriculum-item-link--is-current"]') ||
        document.querySelector('[aria-current="true"]') ||
        document.querySelector('[data-purpose="curriculum-item-title"]');

      if (currentItemEl) {
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

    if (!rawLectureTitle && document.title.includes('|')) {
      rawLectureTitle = document.title.split('|')[0].trim();
    }

    const titleMeta = cleanLectureTitleInline(rawLectureTitle);
    const lectureTitle = titleMeta.title;
    if (lectureId && curriculumLectureMap.has(String(lectureId))) {
      lectureIndex = curriculumLectureMap.get(String(lectureId)).index;
    } else if (titleMeta.index) {
      lectureIndex = titleMeta.index;
    } else {
      const curItem = document.querySelector('[class*="curriculum-item-link--is-current"]') ||
        document.querySelector('[aria-current="true"]') ||
        (lectureId ? document.querySelector(`a[href*="/lecture/${lectureId}"]`) : null);
      if (curItem) {
        const itemMeta = cleanLectureTitleInline(curItem.textContent || '');
        if (itemMeta.index) {
          lectureIndex = itemMeta.index;
        } else {
          const idxEl = curItem.querySelector('[class*="section-item-index"], [class*="item-index"], [data-purpose*="item-index"]');
          if (idxEl) {
            const parsed = parseInt(idxEl.textContent.trim(), 10);
            if (!isNaN(parsed) && parsed > 0) lectureIndex = parsed;
          }
        }
      }
    }

    // Trích xuất tiêu đề phần cha (Section / Chapter)
    let rawSectionTitle = '';
    let sectionIndex = null;

    if (lectureId && curriculumChapterMap.has(String(lectureId))) {
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
  // 8. Phân tích Master M3U8 từ URL (Cả Video và Phụ đề)
  // --------------------------------------------------------------------------
  async function resolveHlsData(m3u8Url) {
    if (!m3u8Url) return { streams: [], subtitles: [] };

    // Nếu m3u8Url là child variant playlist, thử nạp candidate master trước
    if (isChildPlaylistUrl(m3u8Url)) {
      const candidateMaster = deriveMasterPlaylistUrl(m3u8Url);
      if (candidateMaster) {
        try {
          const res = await fetch(candidateMaster, { credentials: 'include' });
          if (res.ok) {
            const text = await res.text();
            const parsed = parseMasterPlaylistInline(text, candidateMaster);
            if (parsed.variants && parsed.variants.length > 0 && parsed.variants.some(v => v.resolution >= 720)) {
              return {
                streams: parsed.variants,
                subtitles: parsed.subtitles
              };
            }
          }
        } catch (e) {}
      }
    }

    try {
      const res = await fetch(m3u8Url, { credentials: 'include' });
      if (!res.ok) return { streams: [], subtitles: [] };

      const m3u8Text = await res.text();
      const parsed = parseMasterPlaylistInline(m3u8Text, m3u8Url);
      return {
        streams: parsed.variants,
        subtitles: parsed.subtitles
      };
    } catch (err) {
      console.warn('[Udemy Downloader] Lỗi nạp master m3u8:', err);
      let fallbackRes = 720;
      const m = m3u8Url.match(/[\/_](\d{3,4})(?:p|\/|\.m3u8)/i);
      if (m && [1080, 720, 480, 360, 240, 144].includes(parseInt(m[1], 10))) {
        fallbackRes = parseInt(m[1], 10);
      }
      return {
        streams: [{
          label: `${fallbackRes}`,
          resolution: fallbackRes,
          file: m3u8Url,
          type: 'hls',
          masterUrl: m3u8Url
        }],
        subtitles: []
      };
    }
  }

  // --------------------------------------------------------------------------
  // 9. Xử lý Payload bài giảng (Hợp nhất 5 nguồn phụ đề & Ưu tiên 1080p HLS)
  // --------------------------------------------------------------------------
  async function processLecturePayload(payload, forcedM3u8Url = null) {
    const pageInfo = getCourseAndLectureInfoFromPage();
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
    if (hlsMasterUrl) {
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
    if (!m3u8Url) return;

    let targetUrl = m3u8Url;
    if (isChildPlaylistUrl(m3u8Url)) {
      const derived = deriveMasterPlaylistUrl(m3u8Url);
      if (derived) targetUrl = derived;
    }

    const hlsData = await resolveHlsData(targetUrl);
    if (!hlsData || !hlsData.streams || hlsData.streams.length === 0) return;

    if (!currentLectureInfo) {
      await fetchLectureApiDirectly();
    }

    if (currentLectureInfo) {
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
  // 10. Lắng nghe gói tin từ Injected Script
  // --------------------------------------------------------------------------
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'UDEMY_LECTURE_INTERCEPTED') {
      await processLecturePayload(event.data.payload);
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
      if (newM3u8) {
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
      if (pageInfo.lectureId && String(pageInfo.lectureId) !== String(currentLectureInfo?.lectureId)) {
        console.log('[Udemy Downloader] Phát hiện chuyển bài giảng sang ID:', pageInfo.lectureId);
        currentLectureInfo = null;
        interceptedMasterM3u8 = null;
        interceptedCaptionsList.length = 0;
        chrome.runtime.sendMessage({
          type: 'UPDATE_LECTURE_DATA',
          data: null
        }).catch(() => {});
        setTimeout(fetchLectureApiDirectly, 200);
        setTimeout(fetchLectureApiDirectly, 800);
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
  async function fetchLectureApiDirectly() {
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
        const data = await res.json();
        const processed = await processLecturePayload(data);
        if (processed && (!processed.captions || processed.captions.length === 0)) {
          const directCaps = await fetchCaptionsDirectly(courseId, pageInfo.lectureId);
          if (directCaps.length > 0) {
            processed.captions = directCaps;
            if (currentLectureInfo) currentLectureInfo.captions = directCaps;
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
      if (newM3u8) {
        if (!isChildPlaylistUrl(newM3u8) || !interceptedMasterM3u8) {
          interceptedMasterM3u8 = newM3u8;
        }
        updateStreamsWithM3u8(newM3u8);
      }
      return true;
    }

    if (message.type === 'GET_CURRENT_LECTURE_FROM_PAGE') {
      const pageInfo = getCourseAndLectureInfoFromPage();

      // Nếu bài giảng hiện tại trong URL khác với bài giảng trong cache, xóa cache cũ ngay lập tức!
      if (currentLectureInfo && pageInfo.lectureId && String(currentLectureInfo.lectureId) !== String(pageInfo.lectureId)) {
        currentLectureInfo = null;
        interceptedMasterM3u8 = null;
        interceptedCaptionsList.length = 0;
      }

      // Chỉ trả lời ngay nếu ĐÃ CÓ cả luồng phát VÀ phụ đề cho ĐÚNG bài giảng hiện tại, và đã có luồng HLS/1080p
      const hasHighRes = currentLectureInfo?.streams?.some(s => s.resolution >= 1080 || s.type === 'hls');
      if (currentLectureInfo && currentLectureInfo.streams?.length > 0 && currentLectureInfo.captions?.length > 0 && hasHighRes) {
        sendResponse({ success: true, data: currentLectureInfo });
        return true;
      }

      window.postMessage({ type: 'UDEMY_REQUEST_LATEST_DATA' }, '*');

      fetchLectureApiDirectly().then(async (data) => {
        const targetData = data || currentLectureInfo;
        if (targetData && (!targetData.captions || targetData.captions.length === 0)) {
          const pageInfo = getCourseAndLectureInfoFromPage();
          const caps = await fetchCaptionsDirectly(pageInfo.courseId || cachedCourseId, pageInfo.lectureId);
          if (caps.length > 0) {
            targetData.captions = caps;
            if (currentLectureInfo) currentLectureInfo.captions = caps;
          }
        }

        if (targetData) {
          sendResponse({ success: true, data: targetData });
        } else {
          const pageInfo = getCourseAndLectureInfoFromPage();
          sendResponse({
            success: Boolean(currentLectureInfo),
            data: currentLectureInfo,
            pageInfo,
            error: 'Chưa bắt được luồng phát video. Vui lòng bấm Phát (Play) video bài giảng.'
          });
        }
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
      const res = triggerNextLecture();
      sendResponse(res);
      return true;
    }
  });

  // --------------------------------------------------------------------------
  // 14. Kích hoạt chuyển sang bài giảng tiếp theo (Auto Next)
  // --------------------------------------------------------------------------
  function triggerNextLecture() {
    const pageInfo = getCourseAndLectureInfoFromPage();
    const currentLecId = String(pageInfo.lectureId || currentLectureInfo?.lectureId || '');
    const courseSlug = pageInfo.courseSlug || '';

    // 1. Thử click nút Next trên thanh điều khiển video / giao diện bài học của Udemy
    const nextSelectors = [
      '[data-purpose="go-to-next-button"]',
      '[data-purpose="go-to-next-lecture-button"]',
      '[data-purpose="next-lecture-button"]',
      '[data-purpose="next-item"]',
      '[data-purpose="next-button"]',
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

    // Đánh thức controls nếu đang bị ẩn tự động
    const playerContainer = document.querySelector('.video-player--container, [data-purpose="video-controls"], [class*="video-viewer"]');
    if (playerContainer) {
      playerContainer.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    }

    for (const selector of nextSelectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      for (const btn of elements) {
        if (btn && typeof btn.click === 'function' && !btn.disabled) {
          console.log('[Udemy Downloader] Kích hoạt Next qua nút điều khiển:', selector);
          btn.click();
          return { success: true, method: 'video-control-button', selector };
        }
      }
    }

    // 2. Thử kích hoạt phím tắt chính thức của Udemy Player: Shift + N
    try {
      const keyOpts = { key: 'N', code: 'KeyN', keyCode: 78, which: 78, shiftKey: true, bubbles: true, cancelable: true };
      const targetEl = document.querySelector('video') || document.activeElement || document.body;
      targetEl.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
      targetEl.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
      console.log('[Udemy Downloader] Kích hoạt phím tắt Shift+N');
    } catch (e) {}

    // 3. Sử dụng danh sách giáo trình từ API (curriculumOrderList)
    if (curriculumOrderList.length > 0 && currentLecId) {
      const currentIdx = curriculumOrderList.findIndex(item => String(item.id) === currentLecId);
      if (currentIdx !== -1) {
        if (currentIdx + 1 < curriculumOrderList.length) {
          const nextItem = curriculumOrderList[currentIdx + 1];
          const nextType = nextItem.type === 'quiz' ? 'quiz' : 'lecture';
          const nextUrl = `/course/${courseSlug}/learn/${nextType}/${nextItem.id}`;

          // Tìm xem thẻ link bài tiếp theo có trong DOM không
          const nextDomLink = document.querySelector(`a[href*="/${nextItem.id}"], a[href*="/lecture/${nextItem.id}"], a[href*="/quiz/${nextItem.id}"]`);
          if (nextDomLink) {
            // Nếu nằm trong accordion đang đóng, mở ra
            const parentPanel = nextDomLink.closest('[class*="accordion-panel"], [data-purpose*="section"]');
            if (parentPanel) {
              const toggleBtn = parentPanel.querySelector('button[aria-expanded="false"], [data-purpose*="panel-header"]');
              if (toggleBtn) toggleBtn.click();
            }
            console.log('[Udemy Downloader] Click link bài tiếp theo từ danh sách curriculumOrderList:', nextItem);
            nextDomLink.click();
            return { success: true, method: 'curriculum-order-link', nextUrl, nextId: nextItem.id };
          }

          // Nếu không có trong DOM (ví dụ danh sách thu gọn), trả về nextUrl để chuyển hướng
          console.log('[Udemy Downloader] Trả về nextUrl để chuyển hướng trực tiếp:', nextUrl);
          return { success: true, method: 'navigate-url', nextUrl, nextId: nextItem.id };
        } else {
          return { success: false, error: 'Đã tới bài cuối cùng của khóa học!' };
        }
      }
    }

    // 4. Tìm kiếm bài tiếp theo qua các thẻ link curriculum trong DOM
    const allItemLinks = Array.from(document.querySelectorAll('a[href*="/learn/lecture/"], a[href*="/learn/quiz/"], a[href*="/lecture/"], a[href*="/quiz/"]'));
    if (allItemLinks.length > 0) {
      let curIdx = -1;
      if (currentLecId) {
        curIdx = allItemLinks.findIndex(a => a.href.includes(`/${currentLecId}`));
      }
      if (curIdx === -1) {
        const curActive = document.querySelector('[class*="curriculum-item-link--is-current"]') || document.querySelector('[aria-current="true"]');
        if (curActive) {
          curIdx = allItemLinks.indexOf(curActive) !== -1 ? allItemLinks.indexOf(curActive) : allItemLinks.indexOf(curActive.closest('a'));
        }
      }

      if (curIdx !== -1 && curIdx + 1 < allItemLinks.length) {
        const nextLink = allItemLinks[curIdx + 1];
        console.log('[Udemy Downloader] Kích hoạt Next qua thẻ link kế tiếp trong DOM');
        nextLink.click();
        return { success: true, method: 'dom-link-sequential', nextUrl: nextLink.getAttribute('href') };
      }
    }

    // 5. Fallback quét tất cả nút hoặc link chứa chữ Next / Tiếp
    const allButtons = Array.from(document.querySelectorAll('button, a'));
    for (const el of allButtons) {
      const txt = (el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const purpose = (el.getAttribute('data-purpose') || '').toLowerCase();
      if (
        (purpose.includes('next') || aria.includes('next') || aria.includes('tiếp') || txt === 'next' || txt === 'tiếp theo' || txt === 'bài tiếp theo' || txt === 'next lecture') &&
        !el.disabled
      ) {
        console.log('[Udemy Downloader] Kích hoạt Next qua fallback element:', el);
        el.click();
        return { success: true, method: 'fallback-element' };
      }
    }

    return { success: false, error: 'Không tìm thấy nút chuyển bài tiếp theo hoặc đây là bài cuối cùng của khóa học.' };
  }


  setTimeout(fetchLectureApiDirectly, 1500);

  // Định kỳ giám sát URL để phát hiện chuyển bài trong SPA
  let lastMonitoredLectureId = null;
  setInterval(() => {
    const pInfo = getCourseAndLectureInfoFromPage();
    if (pInfo.lectureId && pInfo.lectureId !== lastMonitoredLectureId) {
      lastMonitoredLectureId = pInfo.lectureId;
      if (currentLectureInfo && String(currentLectureInfo.lectureId) !== String(pInfo.lectureId)) {
        console.log('[Udemy Downloader] Định kỳ phát hiện bài mới:', pInfo.lectureId);
        currentLectureInfo = null;
        interceptedMasterM3u8 = null;
        interceptedCaptionsList.length = 0;
        chrome.runtime.sendMessage({
          type: 'UPDATE_LECTURE_DATA',
          data: null
        }).catch(() => {});
        setTimeout(fetchLectureApiDirectly, 200);
        setTimeout(fetchLectureApiDirectly, 800);
      }
    }
  }, 1000);
})();
