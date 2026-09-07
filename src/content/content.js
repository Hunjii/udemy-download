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
  // 2. Tiện ích làm sạch tiêu đề bài giảng
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

  // --------------------------------------------------------------------------
  // 3. Tiện ích phân tích cú pháp Master Playlist M3U8 (Bao gồm Subtitles)
  // --------------------------------------------------------------------------
  function resolveUrl(relativeOrAbsolute, baseUrl) {
    try {
      return new URL(relativeOrAbsolute, baseUrl).href;
    } catch (e) {
      return relativeOrAbsolute;
    }
  }

  function parseMasterPlaylistInline(m3u8Content, masterUrl) {
    if (!m3u8Content || typeof m3u8Content !== 'string') return { variants: [], subtitles: [] };

    const lines = m3u8Content.split('\n').map(l => l.trim()).filter(Boolean);
    const variants = [];
    const subtitles = [];

    const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF') || l.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'));

    if (!isMaster) {
      return {
        variants: [{
          label: 'Original',
          resolution: 720,
          file: masterUrl,
          type: 'hls',
          masterUrl
        }],
        subtitles: []
      };
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Phân tích phụ đề trong master m3u8
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
  // 4. Trích xuất Phụ đề từ thẻ <track> và <video> trong DOM
  // --------------------------------------------------------------------------
  function getCaptionsFromDom() {
    const domCaptions = [];
    const tracks = document.querySelectorAll('video track');
    tracks.forEach((track, idx) => {
      const src = track.src;
      if (src && (track.kind === 'captions' || track.kind === 'subtitles' || src.includes('.vtt'))) {
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

    const label = c.label || c.title || c.locale_id || c.language || c.name || 'Subtitles';
    const locale = c.locale_id || c.srclang || c.language || '';

    return {
      id: c.id || Math.random().toString(),
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
    if (titleMeta.index) {
      lectureIndex = titleMeta.index;
    }

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
      return {
        streams: [{
          label: 'Auto',
          resolution: 720,
          file: m3u8Url,
          type: 'hls',
          masterUrl: m3u8Url
        }],
        subtitles: []
      };
    }
  }

  // --------------------------------------------------------------------------
  // 9. Xử lý Payload bài giảng (Hợp nhất 5 nguồn phụ đề)
  // --------------------------------------------------------------------------
  async function processLecturePayload(payload, forcedM3u8Url = null) {
    const pageInfo = getCourseAndLectureInfoFromPage();
    const asset = payload.asset || {};
    const streamUrls = asset.stream_urls || payload.stream_urls || {};

    let streams = [];
    let hlsSubtitles = [];

    // 1. Kiểm tra luồng MP4 trực tiếp
    const rawVideoStreams = streamUrls.Video || [];
    if (Array.isArray(rawVideoStreams) && rawVideoStreams.length > 0) {
      streams = rawVideoStreams
        .filter(s => s.type === 'video/mp4' && s.file)
        .map(s => ({
          label: s.label || 'Unknown',
          resolution: parseInt(s.label, 10) || 0,
          file: s.file,
          type: 'video/mp4'
        }));
    }

    // 2. Kiểm tra luồng HLS m3u8
    let hlsMasterUrl = forcedM3u8Url || interceptedMasterM3u8;
    if (!hlsMasterUrl) {
      if (Array.isArray(streamUrls.hls) && streamUrls.hls.length > 0) {
        hlsMasterUrl = streamUrls.hls[0].file;
      } else if (Array.isArray(asset.media_sources)) {
        const hlsSource = asset.media_sources.find(s => s.type === 'application/x-mpegURL' || s.src?.includes('.m3u8'));
        if (hlsSource) hlsMasterUrl = hlsSource.src;
      }
    }

    if (hlsMasterUrl) {
      const hlsData = await resolveHlsData(hlsMasterUrl);
      if (hlsData.streams.length > 0 && (!streams.length || streams.length === 0)) {
        streams = hlsData.streams;
      }
      if (hlsData.subtitles.length > 0) {
        hlsSubtitles = hlsData.subtitles;
      }
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
    rawApiCaptions.forEach(item => {
      const norm = normalizeCaption(item);
      if (norm && !captionsMap.has(norm.url)) {
        captionsMap.set(norm.url, norm);
      }
    });

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
    const finalLectureIndex = cleanedMeta.index || pageInfo.lectureIndex || 1;
    const finalCourseTitle = pageInfo.courseTitle || 'Udemy Course';

    const processedData = {
      lectureId: payload.id || pageInfo.lectureId,
      courseId: pageInfo.courseId || cachedCourseId,
      courseTitle: finalCourseTitle,
      lectureTitle: finalLectureTitle,
      lectureIndex: finalLectureIndex,
      assetType: asset.asset_type || 'Video',
      isDrmProtected,
      streams,
      bestQuality: streams.length > 0 ? streams[0] : null,
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
  // 10. Lắng nghe gói tin từ Injected Script
  // --------------------------------------------------------------------------
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'UDEMY_LECTURE_INTERCEPTED') {
      await processLecturePayload(event.data.payload);
    } else if (event.data?.type === 'UDEMY_M3U8_INTERCEPTED') {
      interceptedMasterM3u8 = event.data.m3u8Url;
      if (currentLectureInfo && (!currentLectureInfo.streams || currentLectureInfo.streams.length === 0)) {
        await processLecturePayload(currentLectureInfo, interceptedMasterM3u8);
      }
    } else if (event.data?.type === 'UDEMY_CAPTION_INTERCEPTED') {
      const vttUrl = event.data.vttUrl;
      if (vttUrl && !interceptedCaptionsList.includes(vttUrl)) {
        interceptedCaptionsList.push(vttUrl);
        if (currentLectureInfo) {
          await processLecturePayload(currentLectureInfo, interceptedMasterM3u8);
        }
      }
    }
  });

  // --------------------------------------------------------------------------
  // 11. Fallback chủ động gọi API khi người dùng mở Popup
  // --------------------------------------------------------------------------
  async function fetchLectureApiDirectly() {
    const pageInfo = getCourseAndLectureInfoFromPage();
    if (!pageInfo.lectureId) return null;

    let courseId = pageInfo.courseId;
    if (!courseId && pageInfo.courseSlug) {
      courseId = await resolveCourseId(pageInfo.courseSlug);
    }

    try {
      const url = courseId
        ? `/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${pageInfo.lectureId}/?fields[lecture]=title,asset,supplementary_assets,description,download_urls,captions&fields[asset]=@default,stream_urls,download_urls,captions,media_sources,media_license_token,course_is_drmed`
        : `/api-2.0/lectures/${pageInfo.lectureId}/?fields[lecture]=title,asset,supplementary_assets,description,download_urls,captions&fields[asset]=@default,stream_urls,download_urls,captions,media_sources,media_license_token,course_is_drmed`;

      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json, text/plain, */*' }
      });

      if (res.ok) {
        const data = await res.json();
        return await processLecturePayload(data);
      }
    } catch (err) {
      console.warn('[Udemy Downloader] Lỗi gọi fallback API:', err);
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // 12. Lắng nghe tin nhắn từ Popup và Background
  // --------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ status: 'pong' });
      return true;
    }

    if (message.type === 'BACKGROUND_DETECTED_M3U8') {
      interceptedMasterM3u8 = message.m3u8Url;
      return true;
    }

    if (message.type === 'GET_CURRENT_LECTURE_FROM_PAGE') {
      if (currentLectureInfo && currentLectureInfo.streams?.length > 0) {
        sendResponse({ success: true, data: currentLectureInfo });
        return true;
      }

      window.postMessage({ type: 'UDEMY_REQUEST_LATEST_DATA' }, '*');

      fetchLectureApiDirectly().then(data => {
        if (data) {
          sendResponse({ success: true, data });
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
  });

  setTimeout(fetchLectureApiDirectly, 1500);
})();
