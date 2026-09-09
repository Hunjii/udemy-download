/**
 * Injected Script (Chạy trong MAIN world của trang Udemy)
 * Can thiệp (hook) vào fetch và XMLHttpRequest để bắt gói tin API, luồng phát HLS m3u8 và phụ đề .vtt.
 */

(function () {
  if (window.__UDEMY_DOWNLOADER_INJECTED__) return;
  window.__UDEMY_DOWNLOADER_INJECTED__ = true;

  console.log('[Udemy Downloader] Injected script đã kích hoạt trong MAIN world');

  window.__UDEMY_LATEST_LECTURE_DATA__ = null;
  window.__UDEMY_LATEST_M3U8_URL__ = null;
  window.__UDEMY_INTERCEPTED_CAPTIONS__ = [];
  window.__UDEMY_INTERCEPTED_CAPTIONS_LIST__ = [];
  let lastUrlChangeTime = 0;

  function getCurrentPageLectureId() {
    try {
      const m = window.location.pathname.match(/\/(?:lecture|quiz|practice)\/(\d+)/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  function extractLectureIdFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const m = url.match(/\/(?:lectures|quiz|practice)\/(\d+)/);
    return m ? m[1] : null;
  }

  function notifyLectureData(data, sourceUrl = '') {
    try {
      if (!data || typeof data !== 'object') return;

      const hasAsset = data.asset || data.stream_urls || data.media_sources;
      if (!hasAsset && !data.supplementary_assets && !data.captions) return;

      const dataId = data.id ? String(data.id) : extractLectureIdFromUrl(sourceUrl);
      const curPageId = getCurrentPageLectureId();

      // Nếu bài giảng này rõ ràng khác với bài giảng trên URL hiện tại (ví dụ prefetch hoặc request cũ), bỏ qua lưu cache chính
      if (dataId && curPageId && dataId !== curPageId) {
        console.log(`[Udemy Downloader Injected] Bỏ qua gói tin ID=${dataId} do trang đang ở ID=${curPageId}`);
        return;
      }

      window.__UDEMY_LATEST_LECTURE_DATA__ = {
        data,
        lectureId: dataId,
        sourceUrl,
        timestamp: Date.now()
      };

      window.postMessage({
        type: 'UDEMY_LECTURE_INTERCEPTED',
        payload: data,
        lectureId: dataId,
        sourceUrl
      }, '*');
    } catch (e) {
      console.warn('[Udemy Downloader] Lỗi phân tích gói tin bài giảng:', e);
    }
  }

  function notifyCaptionsList(captions, sourceUrl = '') {
    try {
      if (!Array.isArray(captions) || captions.length === 0) return;
      window.__UDEMY_INTERCEPTED_CAPTIONS_LIST__ = captions;

      window.postMessage({
        type: 'UDEMY_CAPTIONS_LIST_INTERCEPTED',
        captions,
        sourceUrl,
        timestamp: Date.now()
      }, '*');
    } catch (e) {
      console.warn('[Udemy Downloader] Lỗi phân tích danh sách phụ đề:', e);
    }
  }

  function isM3u8Playlist(url) {
    if (!url || typeof url !== 'string') return false;
    if (!url.includes('.m3u8')) return false;
    if (/\.(?:ts|m4s|mp4|m4a|aac|vtt|srt|key|jpe?g|png|gif|svg|css|js)(?:$|\?)/i.test(url)) return false;
    return true;
  }

  function isMasterPlaylistUrl(url) {
    if (!isM3u8Playlist(url)) return false;
    if (url.includes('master.m3u8') || url.includes('playlist.m3u8')) return true;
    if (/\/(?:1080|720|480|360|240|144)\/(?:index|playlist)\.m3u8/i.test(url)) return false;
    if (/index_(?:1080|720|480|360|240|144)\.m3u8/i.test(url)) return false;
    return true;
  }

  function notifyM3u8Stream(m3u8Url) {
    if (!m3u8Url || !isM3u8Playlist(m3u8Url)) return;
    // Nếu URL hiện tại đã là master playlist, không để child variant playlist (720p/480p...) ghi đè
    if (window.__UDEMY_LATEST_M3U8_URL__ && isMasterPlaylistUrl(window.__UDEMY_LATEST_M3U8_URL__) && !isMasterPlaylistUrl(m3u8Url)) {
      return;
    }
    if (window.__UDEMY_LATEST_M3U8_URL__ === m3u8Url) return;
    window.__UDEMY_LATEST_M3U8_URL__ = m3u8Url;

    window.postMessage({
      type: 'UDEMY_M3U8_INTERCEPTED',
      m3u8Url,
      timestamp: Date.now()
    }, '*');
  }

  function notifyCaption(vttUrl) {
    if (!vttUrl) return;
    if (window.__UDEMY_INTERCEPTED_CAPTIONS__.includes(vttUrl)) return;
    window.__UDEMY_INTERCEPTED_CAPTIONS__.push(vttUrl);

    window.postMessage({
      type: 'UDEMY_CAPTION_INTERCEPTED',
      vttUrl,
      timestamp: Date.now()
    }, '*');
  }

  function notifyCurriculumData(data, sourceUrl = '') {
    try {
      if (!data || !Array.isArray(data.results)) return;
      window.postMessage({
        type: 'UDEMY_CURRICULUM_INTERCEPTED',
        results: data.results,
        sourceUrl
      }, '*');
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // 1. Hook window.fetch
  // --------------------------------------------------------------------------
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

      // 1.1 Bắt gói tin API bài giảng hoặc API phụ đề chuyên biệt
      if (url.includes('/api-2.0/') && (url.includes('/lectures/') || url.includes('/subscribed-courses/'))) {
        const clone = response.clone();
        clone.json().then(data => {
          if (url.includes('/captions')) {
            const list = Array.isArray(data) ? data : (Array.isArray(data?.results) ? data.results : (data?.captions || []));
            notifyCaptionsList(list, url);
          } else {
            notifyLectureData(data, url);
          }
        }).catch(() => {});
      }

      // 1.2 Bắt gói tin API chương mục toàn khóa học (Curriculum)
      if (url.includes('/subscriber-curriculum-items/') || url.includes('/curriculum-items/')) {
        const clone = response.clone();
        clone.json().then(data => {
          notifyCurriculumData(data, url);
        }).catch(() => {});
      }

      // 1.3 Bắt luồng HLS .m3u8 (chỉ nạp file playlist, bỏ qua toàn bộ phân đoạn video)
      if (isM3u8Playlist(url)) {
        notifyM3u8Stream(url);
      }

      // 1.4 Bắt file phụ đề .vtt trực tiếp
      if (url.includes('.vtt') || (!url.includes('/api-2.0/') && (url.includes('/captions/') || url.includes('/subtitles/')))) {
        notifyCaption(url);
      }
    } catch (err) {}
    return response;
  };

  // --------------------------------------------------------------------------
  // 2. Hook XMLHttpRequest
  // --------------------------------------------------------------------------
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._requestUrl = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const url = this._requestUrl || '';
        if (typeof url === 'string') {
          if (url.includes('/api-2.0/') && (url.includes('/lectures/') || url.includes('/subscribed-courses/'))) {
            if (this.responseText) {
              const data = JSON.parse(this.responseText);
              if (url.includes('/captions')) {
                const list = Array.isArray(data) ? data : (Array.isArray(data?.results) ? data.results : (data?.captions || []));
                notifyCaptionsList(list, url);
              } else {
                notifyLectureData(data, url);
              }
            }
          } else if (url.includes('/subscriber-curriculum-items/') || url.includes('/curriculum-items/')) {
            if (this.responseText) {
              const data = JSON.parse(this.responseText);
              notifyCurriculumData(data, url);
            }
          } else if (isM3u8Playlist(url)) {
            notifyM3u8Stream(url);
          } else if (url.includes('.vtt') || (!url.includes('/api-2.0/') && (url.includes('/captions/') || url.includes('/subtitles/')))) {
            notifyCaption(url);
          }
        }
      } catch (e) {}
    });
    return originalSend.apply(this, args);
  };

  // --------------------------------------------------------------------------
  // 3. Lắng nghe yêu cầu từ Content Script
  // --------------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'UDEMY_REQUEST_LATEST_DATA') {
      const curId = getCurrentPageLectureId();
      const expectedId = event.data.expectedLectureId || curId;
      if (window.__UDEMY_LATEST_LECTURE_DATA__) {
        const dataId = window.__UDEMY_LATEST_LECTURE_DATA__.lectureId ||
          (window.__UDEMY_LATEST_LECTURE_DATA__.data?.id ? String(window.__UDEMY_LATEST_LECTURE_DATA__.data.id) : null);
        // Chỉ gửi lại dữ liệu nếu khớp với bài giảng đang xem
        if (!expectedId || !dataId || dataId === expectedId) {
          window.postMessage({
            type: 'UDEMY_LECTURE_INTERCEPTED',
            payload: window.__UDEMY_LATEST_LECTURE_DATA__.data,
            lectureId: dataId,
            sourceUrl: window.__UDEMY_LATEST_LECTURE_DATA__.sourceUrl
          }, '*');
        }
      }
      if (window.__UDEMY_LATEST_M3U8_URL__) {
        window.postMessage({
          type: 'UDEMY_M3U8_INTERCEPTED',
          m3u8Url: window.__UDEMY_LATEST_M3U8_URL__
        }, '*');
      }
      if (window.__UDEMY_INTERCEPTED_CAPTIONS_LIST__ && window.__UDEMY_INTERCEPTED_CAPTIONS_LIST__.length > 0) {
        window.postMessage({
          type: 'UDEMY_CAPTIONS_LIST_INTERCEPTED',
          captions: window.__UDEMY_INTERCEPTED_CAPTIONS_LIST__
        }, '*');
      }
      window.__UDEMY_INTERCEPTED_CAPTIONS__.forEach(vttUrl => {
        window.postMessage({
          type: 'UDEMY_CAPTION_INTERCEPTED',
          vttUrl
        }, '*');
      });
    }
  });

  // --------------------------------------------------------------------------
  // 4. Định kỳ kiểm tra thẻ <video> và <track>
  // --------------------------------------------------------------------------
  setInterval(() => {
    // Nếu trang vừa chuyển bài trong vòng 2.5 giây, DOM có thể chưa cập nhật xong video mới -> Không quét tránh nhận nhầm video bài cũ!
    if (Date.now() - lastUrlChangeTime < 2500) return;

    const video = document.querySelector('video');
    if (video) {
      if (video.src && isM3u8Playlist(video.src)) {
        notifyM3u8Stream(video.src);
      }
    }
    // Quét tất cả thẻ <track> trên toàn trang
    const tracks = document.querySelectorAll('track');
    tracks.forEach(track => {
      if (track.src) {
        notifyCaption(track.src);
      }
    });
  }, 2000);

  // --------------------------------------------------------------------------
  // 5. Theo dõi chuyển bài giảng trong SPA (pushState, replaceState, popstate)
  // --------------------------------------------------------------------------
  function handleUrlChange() {
    lastUrlChangeTime = Date.now();
    window.__UDEMY_LATEST_LECTURE_DATA__ = null;
    window.__UDEMY_LATEST_M3U8_URL__ = null;
    window.__UDEMY_INTERCEPTED_CAPTIONS__ = [];
    window.__UDEMY_INTERCEPTED_CAPTIONS_LIST__ = [];

    const currentLectureId = getCurrentPageLectureId();
    window.postMessage({
      type: 'UDEMY_URL_CHANGED',
      url: window.location.href,
      lectureId: currentLectureId,
      timestamp: Date.now()
    }, '*');
  }

  const origPushState = history.pushState;
  history.pushState = function (...args) {
    const res = origPushState.apply(this, args);
    handleUrlChange();
    return res;
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    const res = origReplaceState.apply(this, args);
    handleUrlChange();
    return res;
  };

  window.addEventListener('popstate', handleUrlChange);

  let prevUrl = window.location.href;
  setInterval(() => {
    if (window.location.href !== prevUrl) {
      prevUrl = window.location.href;
      handleUrlChange();
    }
  }, 600);
})();
