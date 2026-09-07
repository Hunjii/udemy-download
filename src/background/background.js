/**
 * Background Service Worker (Manifest V3)
 * Quản lý bộ nhớ tạm, giám sát luồng m3u8 qua webRequest và điều phối cửa sổ tải độc lập.
 */

import { buildDownloadPath } from '../utils/sanitizer.js';
import { getSettings } from '../utils/storage.js';

const tabLectures = new Map();
const tabM3u8Urls = new Map();

// ----------------------------------------------------------------------------
// 1. Giám sát các gói tin .m3u8 qua webRequest
// ----------------------------------------------------------------------------
if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const url = details.url;
      const tabId = details.tabId;

      if (tabId > 0 && (url.includes('.m3u8') || url.includes('/hls/'))) {
        tabM3u8Urls.set(tabId, url);

        // Báo cho content script của tab biết URL m3u8 mới nhất
        chrome.tabs.sendMessage(tabId, {
          type: 'BACKGROUND_DETECTED_M3U8',
          m3u8Url: url
        }).catch(() => {});
      }
    },
    { urls: ['*://*.udemy.com/*', '*://*.udemycdn.com/*', '*://*.cloudfront.net/*'] }
  );
}

// Dọn dẹp khi đóng tab
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLectures.delete(tabId);
  tabM3u8Urls.delete(tabId);
});

// ----------------------------------------------------------------------------
// 2. Xử lý thông điệp từ Content Script, Popup và Downloader
// ----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  switch (message.type) {
    case 'UPDATE_LECTURE_DATA':
      if (tabId) {
        if (message.data) {
          tabLectures.set(tabId, message.data);
        } else {
          tabLectures.delete(tabId);
          tabM3u8Urls.delete(tabId);
        }
      }
      sendResponse({ status: 'ok' });
      break;

    case 'GET_LECTURE_DATA':
      {
        const targetTabId = message.tabId;
        const data = tabLectures.get(targetTabId);
        const m3u8 = tabM3u8Urls.get(targetTabId);

        // Kiểm tra xem dữ liệu trong cache có bị cũ so với bài giảng hiện tại không
        if (data && message.expectedLectureId && String(data.lectureId) !== String(message.expectedLectureId)) {
          sendResponse({ success: false, data: null, isStale: true });
          break;
        }

        sendResponse({ success: Boolean(data), data: data || null, latestM3u8: m3u8 || null });
      }
      break;

    case 'OPEN_DOWNLOADER_WINDOW':
      {
        const params = new URLSearchParams(message.payload);
        const url = chrome.runtime.getURL(`src/downloader/downloader.html?${params.toString()}`);
        chrome.windows.create({
          url,
          type: 'popup',
          width: 520,
          height: 480
        }, (win) => {
          sendResponse({ success: true, windowId: win.id });
        });
      }
      return true;

    case 'START_DOWNLOAD':
      handleDownload(message.payload)
        .then((result) => sendResponse({ success: true, ...result }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'CHECK_DOWNLOAD_STATUS':
      checkDownloadStatus(message.downloadId)
        .then((status) => sendResponse({ success: true, status }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    default:
      break;
  }
});

// ----------------------------------------------------------------------------
// 3. Xử lý tải file qua chrome.downloads
// ----------------------------------------------------------------------------
async function handleDownload(options) {
  const {
    url,
    courseTitle = 'Udemy Course',
    sectionTitle = '',
    lectureIndex = 1,
    lectureTitle = 'Lecture',
    quality = '',
    extension = 'mp4',
    subDir = '',
    customFilename = null
  } = options;

  if (!url) {
    throw new Error('Đường dẫn URL tải không hợp lệ');
  }

  const settings = await getSettings();

  let filename = '';
  if (customFilename) {
    filename = buildDownloadPath({
      baseFolder: settings.customFolder,
      courseTitle,
      sectionTitle,
      lectureIndex,
      lectureTitle: customFilename.replace(/\.[^/.]+$/, ''),
      extension: customFilename.split('.').pop() || extension,
      subDir: subDir || 'Tai_Lieu'
    });
  } else {
    filename = buildDownloadPath({
      baseFolder: settings.customFolder,
      courseTitle,
      sectionTitle,
      lectureIndex,
      lectureTitle,
      quality,
      extension,
      subDir
    });
  }

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: url,
        filename: filename,
        saveAs: Boolean(settings.promptSaveAs),
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve({ downloadId, targetFilename: filename });
      }
    );
  });
}

// ----------------------------------------------------------------------------
// 4. Kiểm tra tiến trình
// ----------------------------------------------------------------------------
async function checkDownloadStatus(downloadId) {
  return new Promise((resolve, reject) => {
    chrome.downloads.search({ id: downloadId }, (items) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!items || items.length === 0) {
        return resolve({ state: 'interrupted', error: 'Không tìm thấy tác vụ tải' });
      }

      const item = items[0];
      resolve({
        id: item.id,
        bytesReceived: item.bytesReceived,
        totalBytes: item.totalBytes,
        state: item.state,
        filename: item.filename,
        error: item.error
      });
    });
  });
}
