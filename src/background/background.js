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
function isMasterM3u8(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.includes('master.m3u8') || url.includes('playlist.m3u8')) return true;
  if (/\/(?:1080|720|480|360|240|144)\/(?:index|playlist)\.m3u8/i.test(url)) return false;
  if (/index_(?:1080|720|480|360|240|144)\.m3u8/i.test(url)) return false;
  return true;
}

if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const url = details.url;
      const tabId = details.tabId;

      if (tabId > 0 && (url.includes('.m3u8') || url.includes('/hls/'))) {
        const prevM3u8 = tabM3u8Urls.get(tabId);
        // Không để child variant playlist (720p/480p...) ghi đè master playlist
        if (prevM3u8 && isMasterM3u8(prevM3u8) && !isMasterM3u8(url)) {
          return;
        }

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
          if (message.data.masterM3u8Url) {
            tabM3u8Urls.set(tabId, message.data.masterM3u8Url);
          }
        } else {
          tabLectures.delete(tabId);
          tabM3u8Urls.delete(tabId);
        }

        // Báo cho popup window (nếu đang mở) để cập nhật thông tin bài giảng mới
        chrome.runtime.sendMessage({
          type: 'LECTURE_DATA_UPDATED',
          tabId,
          data: message.data || null,
          loadingLectureId: message.loadingLectureId || null
        }).catch(() => {});
      }
      sendResponse({ status: 'ok' });
      break;

    case 'GET_LECTURE_DATA':
      {
        const targetTabId = message.tabId;
        const data = tabLectures.get(targetTabId);
        const m3u8 = tabM3u8Urls.get(targetTabId);

        // Kiểm tra xem dữ liệu trong cache có bị cũ so với bài giảng hiện tại không
        if (message.expectedLectureId) {
          if (!data || String(data.lectureId) !== String(message.expectedLectureId)) {
            sendResponse({ success: false, data: null, isStale: true });
            break;
          }
        }

        sendResponse({ success: Boolean(data), data: data || null, latestM3u8: m3u8 || null });
      }
      break;

    case 'OPEN_DOWNLOADER_WINDOW':
      {
        const params = new URLSearchParams(message.payload);
        const url = chrome.runtime.getURL(`src/downloader/downloader.html?${params.toString()}`);
        const isBatch = message.payload?.mode === 'batch';
        chrome.windows.create({
          url,
          type: 'popup',
          width: isBatch ? 580 : 520,
          height: isBatch ? 680 : 480
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

    case 'OPEN_SIDE_PANEL':
      if (chrome.sidePanel && chrome.sidePanel.open) {
        const targetWindowId = message.windowId;
        if (targetWindowId) {
          chrome.sidePanel.open({ windowId: targetWindowId })
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: err.message }));
        } else {
          chrome.windows.getLastFocused().then((win) => {
            if (win?.id) {
              chrome.sidePanel.open({ windowId: win.id })
                .then(() => sendResponse({ success: true }))
                .catch((err) => sendResponse({ success: false, error: err.message }));
            } else {
              sendResponse({ success: false, error: 'Không tìm thấy cửa sổ' });
            }
          });
        }
        return true;
      }
      sendResponse({ success: false, error: 'SidePanel API không khả dụng' });
      break;

    case 'OPEN_POPUP_WINDOW':
      openPopupWindow(null)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'SET_DISPLAY_MODE':
      if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        chrome.sidePanel.setPanelBehavior({
          openPanelOnActionClick: message.displayMode !== 'window'
        }).then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      }
      sendResponse({ success: true });
      break;

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

// ----------------------------------------------------------------------------
// 5. Quản lý Chế độ hiển thị: Sidebar cố định & Cửa sổ Popup nổi
// ----------------------------------------------------------------------------
let popupWindowId = null;

export async function openPopupWindow(tab = null) {
  // 1. Nếu cửa sổ popup đang mở, đưa lên trên cùng (focus)
  if (popupWindowId !== null) {
    try {
      const win = await chrome.windows.get(popupWindowId);
      if (win) {
        if (tab?.id) {
          chrome.runtime.sendMessage({
            type: 'TARGET_TAB_CHANGED',
            tabId: tab.id
          }).catch(() => {});
        }
        await chrome.windows.update(popupWindowId, { focused: true });
        return;
      }
    } catch (e) {
      popupWindowId = null;
    }
  }

  // 2. Tính toán vị trí góc trên bên phải màn hình
  const width = 450;
  const height = 660;
  let left = 100;
  let top = 80;

  try {
    const currentWin = await chrome.windows.getCurrent();
    if (currentWin.left !== undefined && currentWin.width !== undefined) {
      left = Math.max(0, currentWin.left + currentWin.width - width - 20);
      top = Math.max(0, currentWin.top + 70);
    }
  } catch (e) {}

  let targetTabId = tab?.id;
  if (!targetTabId) {
    try {
      const [actTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (actTab?.id) targetTabId = actTab.id;
    } catch (e) {}
  }

  const url = chrome.runtime.getURL(`src/popup/popup.html${targetTabId ? `?tabId=${targetTabId}` : ''}`);

  try {
    const newWin = await chrome.windows.create({
      url,
      type: 'popup',
      width,
      height,
      left,
      top
    });
    popupWindowId = newWin.id;
  } catch (err) {
    console.error('Lỗi khi mở cửa sổ popup:', err);
  }
}

// Xử lý khi người dùng bấm biểu tượng tiện ích trên Chrome Toolbar
chrome.action.onClicked.addListener((tab) => {
  openPopupWindow(tab);
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

// Cấu hình hành vi SidePanel theo cài đặt của người dùng
async function applySidePanelBehavior() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    try {
      const settings = await getSettings();
      const openInSidebar = (settings.displayMode !== 'window');
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: openInSidebar });
    } catch (e) {
      console.warn('Lỗi cấu hình sidePanel:', e);
    }
  }
}

applySidePanelBehavior();

chrome.runtime.onInstalled.addListener(() => {
  applySidePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  applySidePanelBehavior();
});

