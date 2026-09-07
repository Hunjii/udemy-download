/**
 * Popup Script (Dual-Engine Mode)
 * Tự động kích hoạt content script qua chrome.scripting, làm sạch tên bài giảng, tối ưu 1-click tải phụ đề Tiếng Anh.
 */

import { convertVttToSrt } from '../utils/vtt2srt.js';
import { cleanLectureTitle, sanitizeName, padIndex, isEnglishCaption, findEnglishCaption, buildDownloadPath } from '../utils/sanitizer.js';
import { downloadHlsVideo, downloadDirectVideo } from '../utils/hlsDownloader.js';
import { TabRecorder } from '../utils/tabRecorder.js';
import {
  getSettings,
  saveSettings,
  getDirectoryHandle,
  saveDirectoryHandle,
  clearDirectoryHandle
} from '../utils/storage.js';

let currentLecture = null;
let currentSettings = null;
let activeFsHandle = null;
let tabRecorderInstance = null;
let targetUdemyTab = null;
let isSidePanel = false;

document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  await initWindowControls();
  await loadAndBindSettings();
  await detectCurrentLecture();
  initEngine2Controls();
  setupEventListeners();
  batchManager.init();

  // Lắng nghe cập nhật bài giảng thời gian thực từ Content Script / Background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'LECTURE_DATA_UPDATED' || message.type === 'UPDATE_LECTURE_DATA') {
      if (message.data) {
        currentLecture = message.data;
        renderLecture(message.data);
      }
    }
  });
});

// ============================================================================
// 1. Quản lý chuyển đổi Tab
// ============================================================================
function initTabs() {
  const tabBtnDownload = document.getElementById('tab-btn-download');
  const tabBtnSettings = document.getElementById('tab-btn-settings');
  const downloadTab = document.getElementById('download-tab');
  const settingsTab = document.getElementById('settings-tab');

  tabBtnDownload.addEventListener('click', () => {
    tabBtnDownload.classList.add('active');
    tabBtnSettings.classList.remove('active');
    downloadTab.classList.remove('hidden');
    settingsTab.classList.add('hidden');
  });

  tabBtnSettings.addEventListener('click', () => {
    tabBtnSettings.classList.add('active');
    tabBtnDownload.classList.remove('active');
    settingsTab.classList.remove('hidden');
    downloadTab.classList.add('hidden');
  });

  const accordionToggle = document.getElementById('accordion-toggle');
  const qualitiesList = document.getElementById('qualities-list');
  accordionToggle.addEventListener('click', () => {
    accordionToggle.classList.toggle('expanded');
    qualitiesList.classList.toggle('hidden');
  });
}

// ============================================================================
// 2. Quản lý Cài đặt
// ============================================================================
async function loadAndBindSettings() {
  currentSettings = await getSettings();

  const inputCustomFolder = document.getElementById('input-custom-folder');
  const togglePromptSave = document.getElementById('toggle-prompt-save');
  const modeBrowserRadio = document.getElementById('mode-browser');
  const modeFsRadio = document.getElementById('mode-fs');
  const modeDisplaySidebarRadio = document.getElementById('mode-display-sidebar');
  const modeDisplayWindowRadio = document.getElementById('mode-display-window');

  inputCustomFolder.value = currentSettings.customFolder || 'Udemy Courses';
  togglePromptSave.checked = Boolean(currentSettings.promptSaveAs);

  if (currentSettings.downloadMode === 'filesystem') {
    modeFsRadio.checked = true;
  } else {
    modeBrowserRadio.checked = true;
  }

  if (currentSettings.displayMode === 'window') {
    if (modeDisplayWindowRadio) modeDisplayWindowRadio.checked = true;
  } else {
    if (modeDisplaySidebarRadio) modeDisplaySidebarRadio.checked = true;
  }

  activeFsHandle = await getDirectoryHandle();
  updateFsFolderDisplay();

  const btnSelectFsFolder = document.getElementById('btn-select-fs-folder');
  const btnClearFsFolder = document.getElementById('btn-clear-fs-folder');

  modeBrowserRadio.addEventListener('change', async () => {
    if (modeBrowserRadio.checked) {
      currentSettings.downloadMode = 'browser';
      await saveSettings(currentSettings);
    }
  });

  modeFsRadio.addEventListener('change', async () => {
    if (modeFsRadio.checked) {
      if (!activeFsHandle) {
        alert('Bạn chưa chọn thư mục trên máy. Vui lòng bấm nút "Chọn thư mục trên máy tính...".');
        modeBrowserRadio.checked = true;
        return;
      }
      currentSettings.downloadMode = 'filesystem';
      await saveSettings(currentSettings);
    }
  });

  btnSelectFsFolder.addEventListener('click', async () => {
    try {
      if (typeof window.showDirectoryPicker !== 'function') {
        alert('Trình duyệt không hỗ trợ File System Access API. Vui lòng dùng chế độ Downloads.');
        return;
      }
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (dirHandle) {
        const perm = await dirHandle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          activeFsHandle = dirHandle;
          await saveDirectoryHandle(dirHandle);
          currentSettings.downloadMode = 'filesystem';
          await saveSettings(currentSettings);
          updateFsFolderDisplay();
          modeFsRadio.checked = true;
          showStatusBanner(`Đã chọn và cấp quyền lưu vào: ${dirHandle.name}`, 'success');
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') alert('Không thể chọn thư mục: ' + err.message);
    }
  });

  btnClearFsFolder.addEventListener('click', async () => {
    await clearDirectoryHandle();
    activeFsHandle = null;
    updateFsFolderDisplay();
    modeBrowserRadio.checked = true;
    currentSettings.downloadMode = 'browser';
    await saveSettings(currentSettings);
  });

  const btnSaveSettings = document.getElementById('btn-save-settings');
  const settingsSuccessMsg = document.getElementById('settings-success-msg');

  btnSaveSettings.addEventListener('click', async () => {
    const updated = {
      customFolder: inputCustomFolder.value.trim() || 'Udemy Courses',
      promptSaveAs: togglePromptSave.checked,
      downloadMode: modeFsRadio.checked ? 'filesystem' : 'browser',
      displayMode: (modeDisplayWindowRadio && modeDisplayWindowRadio.checked) ? 'window' : 'sidebar'
    };

    if (updated.downloadMode === 'filesystem' && !activeFsHandle) {
      alert('Bạn chưa chọn thư mục trên máy. Hệ thống chuyển về chế độ Downloads.');
      updated.downloadMode = 'browser';
      modeBrowserRadio.checked = true;
    }

    await saveSettings(updated);
    currentSettings = updated;

    // Cập nhật cấu hình click biểu tượng trên background service worker
    chrome.runtime.sendMessage({
      type: 'SET_DISPLAY_MODE',
      displayMode: updated.displayMode
    });

    settingsSuccessMsg.classList.remove('hidden');
    setTimeout(() => {
      settingsSuccessMsg.classList.add('hidden');
    }, 2500);
  });
}

function updateFsFolderDisplay() {
  const fsFolderName = document.getElementById('fs-folder-name');
  const btnClearFsFolder = document.getElementById('btn-clear-fs-folder');

  if (activeFsHandle && activeFsHandle.name) {
    fsFolderName.textContent = activeFsHandle.name;
    btnClearFsFolder.classList.remove('hidden');
  } else {
    fsFolderName.textContent = 'Chưa chọn thư mục';
    btnClearFsFolder.classList.add('hidden');
  }
}

// ============================================================================
// 3. Nhận diện bài giảng đang xem & Quản lý cửa sổ / Sidebar
// ============================================================================
async function initWindowControls() {
  try {
    const currentWin = await chrome.windows.getCurrent();
    // Popup window có win.type === 'popup', Sidebar nằm trong cửa sổ chính win.type === 'normal'
    isSidePanel = (currentWin.type !== 'popup');
  } catch (e) {
    isSidePanel = false;
  }

  const btnClose = document.getElementById('btn-close-window');
  const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  const iconToSidebar = document.getElementById('icon-to-sidebar');
  const iconToWindow = document.getElementById('icon-to-window');

  if (isSidePanel) {
    document.body.classList.add('mode-sidebar');
    if (btnClose) btnClose.classList.add('hidden'); // Sidebar có nút đóng native của Chrome
    if (iconToSidebar) iconToSidebar.classList.add('hidden');
    if (iconToWindow) iconToWindow.classList.remove('hidden');
    if (btnToggleSidebar) {
      btnToggleSidebar.title = 'Mở thành cửa sổ nổi độc lập';
      btnToggleSidebar.onclick = () => {
        chrome.runtime.sendMessage({ type: 'OPEN_POPUP_WINDOW' });
      };
    }
  } else {
    document.body.classList.remove('mode-sidebar');
    if (btnClose) {
      btnClose.classList.remove('hidden');
      btnClose.onclick = () => window.close();
    }
    if (iconToSidebar) iconToSidebar.classList.remove('hidden');
    if (iconToWindow) iconToWindow.classList.add('hidden');
    if (btnToggleSidebar) {
      btnToggleSidebar.title = 'Ghim vào thanh bên (Sidebar) cố định bên phải';
      btnToggleSidebar.onclick = async () => {
        try {
          const lastWin = await chrome.windows.getLastFocused();
          if (chrome.sidePanel && chrome.sidePanel.open && lastWin && lastWin.id) {
            await chrome.sidePanel.open({ windowId: lastWin.id });
            window.close();
          } else {
            chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', windowId: lastWin ? lastWin.id : undefined }, () => {
              window.close();
            });
          }
        } catch (e) {
          chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }, () => {
            window.close();
          });
        }
      };
    }
  }
}

function setupEventListeners() {
  // Tự động làm mới khi người dùng click trở lại cửa sổ tiện ích hoặc thanh bên
  window.addEventListener('focus', () => {
    detectCurrentLecture();
  });

  // Khi đang ở Sidebar mà người dùng chuyển tab trên trình duyệt
  if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(async () => {
      targetUdemyTab = null;
      await detectCurrentLecture();
    });
  }

  // Lắng nghe thông điệp từ background (đổi tab hoặc bài giảng mới được load)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TARGET_TAB_CHANGED' && message.tabId) {
      chrome.tabs.get(message.tabId).then((tab) => {
        if (tab && tab.url && tab.url.includes('udemy.com')) {
          targetUdemyTab = tab;
          detectCurrentLecture();
        }
      }).catch(() => {});
    } else if (message.type === 'LECTURE_DATA_UPDATED') {
      if (!targetUdemyTab || targetUdemyTab.id === message.tabId) {
        if (message.data) {
          renderLecture(message.data);
        } else {
          detectCurrentLecture();
        }
      }
    }
  });
}

async function getActiveUdemyTab() {
  // 1. Kiểm tra tabId truyền qua URL params (?tabId=...)
  const urlParams = new URLSearchParams(window.location.search);
  const tabIdParam = urlParams.get('tabId');
  if (tabIdParam) {
    try {
      const tab = await chrome.tabs.get(parseInt(tabIdParam, 10));
      if (tab && tab.url && tab.url.includes('udemy.com')) {
        return tab;
      }
    } catch (e) {}
  }

  // 2. Tab active ở cửa sổ hiện tại (Cực kỳ chính xác khi chạy trong Side Panel!)
  try {
    const [currTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currTab && currTab.url && currTab.url.includes('udemy.com')) {
      return currTab;
    }
  } catch (e) {}

  // 3. Tab đang hoạt động ở cửa sổ trình duyệt gần nhất (lastFocusedWindow)
  try {
    const [lastTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (lastTab && lastTab.url && lastTab.url.includes('udemy.com')) {
      return lastTab;
    }
  } catch (e) {}

  // 4. Tab đã lưu trước đó trong biến
  if (targetUdemyTab && targetUdemyTab.id) {
    try {
      const tab = await chrome.tabs.get(targetUdemyTab.id);
      if (tab && tab.url && tab.url.includes('udemy.com')) {
        return tab;
      }
    } catch (e) {}
  }

  // 5. Bất kỳ tab active nào trên udemy.com qua các cửa sổ
  try {
    const activeUdemyTabs = await chrome.tabs.query({ active: true, url: '*://*.udemy.com/*' });
    if (activeUdemyTabs && activeUdemyTabs.length > 0) {
      return activeUdemyTabs[0];
    }
  } catch (e) {}

  // 6. Bất kỳ tab nào trên udemy.com
  try {
    const allUdemyTabs = await chrome.tabs.query({ url: '*://*.udemy.com/*' });
    if (allUdemyTabs && allUdemyTabs.length > 0) {
      return allUdemyTabs[0];
    }
  } catch (e) {}

  return null;
}

async function detectCurrentLecture() {
  const loadingState = document.getElementById('loading-state');
  const notUdemyState = document.getElementById('not-udemy-state');
  const drmWarningState = document.getElementById('drm-warning-state');

  const activeTab = await getActiveUdemyTab();

  if (!activeTab || !activeTab.url || !activeTab.url.includes('udemy.com')) {
    loadingState.classList.add('hidden');
    notUdemyState.classList.remove('hidden');
    return;
  }
  targetUdemyTab = activeTab;

  // Tự động kiểm tra và inject content script nếu tab chưa có
  try {
    const ping = await new Promise((resolve) => {
      chrome.tabs.sendMessage(activeTab.id, { type: 'PING' }, (res) => {
        resolve(res);
      });
    });

    if (!ping || ping.status !== 'pong') {
      if (chrome.scripting) {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ['src/content/content.js']
        });
        await new Promise(r => setTimeout(r, 600));
      }
    }
  } catch (e) {
    if (chrome.scripting) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ['src/content/content.js']
        });
        await new Promise(r => setTimeout(r, 600));
      } catch (scriptErr) {}
    }
  }

  const urlMatch = activeTab.url?.match(/\/lecture\/(\d+)/);
  const expectedLectureId = urlMatch ? urlMatch[1] : null;

  // 1. Thử lấy từ Background cache (chỉ nhận nếu đúng bài giảng hiện tại)
  try {
    const bgResponse = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'GET_LECTURE_DATA',
        tabId: activeTab.id,
        expectedLectureId
      }, resolve);
    });

    if (bgResponse && bgResponse.success && bgResponse.data) {
      renderLecture(bgResponse.data);
      // Nếu dữ liệu cache chưa có phụ đề Tiếng Anh, kích hoạt quét ngầm từ Content Script
      if (!findEnglishCaption(bgResponse.data.captions)) {
        chrome.tabs.sendMessage(activeTab.id, { type: 'FETCH_CAPTIONS_FORCE' }, (res) => {
          if (res && Array.isArray(res.captions) && res.captions.length > 0) {
            bgResponse.data.captions = res.captions;
            if (currentLecture) currentLecture.captions = res.captions;
            renderEnglishCaption(res.captions);
          }
        });
      }
      return;
    }
  } catch (e) {}

  // 2. Yêu cầu Content Script trích xuất và phân tích
  try {
    const csResponse = await new Promise((resolve) => {
      chrome.tabs.sendMessage(activeTab.id, { type: 'GET_CURRENT_LECTURE_FROM_PAGE' }, (res) => {
        resolve(res || null);
      });
    });

    if (csResponse && csResponse.success && csResponse.data) {
      renderLecture(csResponse.data);
      if (!findEnglishCaption(csResponse.data.captions)) {
        chrome.tabs.sendMessage(activeTab.id, { type: 'FETCH_CAPTIONS_FORCE' }, (res) => {
          if (res && Array.isArray(res.captions) && res.captions.length > 0) {
            csResponse.data.captions = res.captions;
            if (currentLecture) currentLecture.captions = res.captions;
            renderEnglishCaption(res.captions);
          }
        });
      }
      return;
    }

    if (csResponse?.data?.isDrmProtected) {
      currentLecture = csResponse.data;
      loadingState.classList.add('hidden');
      drmWarningState.classList.remove('hidden');
      return;
    }

    if (csResponse?.pageInfo && csResponse.pageInfo.lectureId) {
      const cleanInfo = cleanLectureTitle(csResponse.pageInfo.lectureTitle);
      loadingState.classList.add('hidden');
      notUdemyState.classList.remove('hidden');
      notUdemyState.querySelector('h3').textContent = 'Đã nhận diện bài giảng';
      notUdemyState.querySelector('p').innerHTML = `Đang ở bài: <strong>${cleanInfo.title || csResponse.pageInfo.lectureId}</strong>.<br>Vui lòng bấm <strong>Phát (Play)</strong> video trên trình phát để tiện ích bắt luồng tải.`;
      return;
    }
  } catch (e) {
    console.warn('Lỗi kết nối content script:', e);
  }

  loadingState.classList.add('hidden');
  notUdemyState.classList.remove('hidden');
}

// ============================================================================
// 4. Hiển thị thông tin lên giao diện
// ============================================================================
function renderLecture(data) {
  currentLecture = data;

  const loadingState = document.getElementById('loading-state');
  const notUdemyState = document.getElementById('not-udemy-state');
  const drmWarningState = document.getElementById('drm-warning-state');
  const lectureContent = document.getElementById('lecture-content');

  loadingState.classList.add('hidden');
  notUdemyState.classList.add('hidden');

  if (data.isDrmProtected && (!data.streams || data.streams.length === 0)) {
    drmWarningState.classList.remove('hidden');
    return;
  }

  lectureContent.classList.remove('hidden');

  const cleanedMeta = cleanLectureTitle(data.lectureTitle);
  const finalIndex = data.lectureIndex || cleanedMeta.index || 1;
  const finalTitle = cleanedMeta.title;

  document.getElementById('course-title').textContent = data.courseTitle || 'Udemy Course';
  document.getElementById('lecture-title').textContent = finalTitle;
  document.getElementById('lecture-index-tag').textContent = `Bài ${padIndex(finalIndex)}`;

  const sectionRow = document.getElementById('section-row');
  const sectionTitleEl = document.getElementById('section-title');
  if (data.sectionTitle) {
    sectionTitleEl.textContent = data.sectionTitle;
    sectionRow.classList.remove('hidden');
  } else {
    sectionRow.classList.add('hidden');
  }

  const durationSec = data.duration || 0;
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;
  document.getElementById('duration-tag').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  const best = data.bestQuality;
  const btnDownloadBest = document.getElementById('btn-download-best');
  const bestResSubtext = document.getElementById('best-res-subtext');
  const highestQualityTag = document.getElementById('highest-quality-tag');

  if (best) {
    highestQualityTag.textContent = `${best.label}p HD`;
    bestResSubtext.textContent = `Độ phân giải: ${best.label}p MP4 (Engine 1)`;
    btnDownloadBest.disabled = false;
    btnDownloadBest.onclick = () => openDownloaderForStream(best);
  } else {
    highestQualityTag.textContent = 'Chưa bắt luồng';
    bestResSubtext.textContent = 'Bấm Play video để nhận diện chất lượng';
    btnDownloadBest.disabled = true;
  }

  renderQualityList(data.streams || [], best);
  renderEnglishCaption(data.captions || []);
  renderSupplementaryAssets(data.supplementaryAssets || []);
}

function renderQualityList(streams, bestStream) {
  const container = document.getElementById('qualities-list');
  container.innerHTML = '';

  if (!streams.length) {
    container.innerHTML = '<div class="text-muted" style="padding: 6px;">Không có độ phân giải nào khả dụng.</div>';
    return;
  }

  streams.forEach((stream) => {
    const item = document.createElement('div');
    item.className = 'quality-item';
    const isBest = bestStream && stream.label === bestStream.label;

    item.innerHTML = `
      <div class="quality-info">
        <span class="quality-badge ${isBest ? 'best' : ''}">${stream.label}p</span>
        <span style="color: var(--text-secondary); font-size: 11px;">MP4 Video</span>
      </div>
      <button class="btn btn-secondary">
        Tải ${stream.label}p
      </button>
    `;

    item.querySelector('button').addEventListener('click', () => openDownloaderForStream(stream));
    container.appendChild(item);
  });
}

async function rescanCaptions() {
  try {
    const tab = targetUdemyTab || await getActiveUdemyTab();
    if (!tab?.id) return;
    const res = await new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { type: 'FETCH_CAPTIONS_FORCE' }, resolve);
    });
    if (res && Array.isArray(res.captions)) {
      if (currentLecture) currentLecture.captions = res.captions;
      renderEnglishCaption(res.captions);
      if (findEnglishCaption(res.captions)) {
        showStatusBanner('Đã tìm thấy phụ đề Tiếng Anh!', 'success');
      } else {
        showStatusBanner('Không tìm thấy phụ đề Tiếng Anh cho bài này.', 'error');
      }
    }
  } catch (e) {
    console.warn('Lỗi khi tìm lại phụ đề:', e);
  }
}

function renderEnglishCaption(captions) {
  const statusText = document.getElementById('caption-status-text');
  const subText = document.getElementById('caption-sub-text');
  const btnDownloadCaption = document.getElementById('btn-download-caption');
  const btnRescan = document.getElementById('btn-rescan-caption');

  const enCap = findEnglishCaption(captions);

  if (!enCap) {
    statusText.textContent = 'Không có phụ đề Tiếng Anh';
    statusText.style.color = 'var(--text-muted)';
    subText.textContent = 'Bấm "Tìm lại" nếu video vừa tải xong';
    btnDownloadCaption.disabled = true;
    if (btnRescan) {
      btnRescan.classList.remove('hidden');
      btnRescan.onclick = async () => {
        btnRescan.disabled = true;
        btnRescan.textContent = '⏳ Đang quét...';
        await rescanCaptions();
        btnRescan.disabled = false;
        btnRescan.textContent = '🔄 Tìm lại';
      };
    }
    return;
  }

  if (btnRescan) btnRescan.classList.add('hidden');
  statusText.textContent = `Sẵn sàng: ${enCap.label || 'English'}`;
  statusText.style.color = '#6ee7b7';
  subText.textContent = 'Tự động khớp tên với video để xem offline';
  btnDownloadCaption.disabled = false;

  btnDownloadCaption.onclick = async () => {
    await downloadSubtitleAsSrt(enCap.url);
  };
}

function renderSupplementaryAssets(assets) {
  const section = document.getElementById('resources-section');
  const list = document.getElementById('resources-list');
  list.innerHTML = '';

  if (!assets || assets.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  assets.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'resource-item';
    el.innerHTML = `
      <span class="resource-name" title="${item.filename || item.title}">${item.filename || item.title}</span>
      <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 11px;">Tải file</button>
    `;

    el.querySelector('button').addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        payload: {
          url: item.downloadUrl,
          courseTitle: currentLecture.courseTitle,
          sectionTitle: currentLecture.sectionTitle || '',
          customFilename: item.filename || item.title,
          subDir: 'Tai_Lieu'
        }
      });
      showStatusBanner(`Đang tải tài liệu: ${item.filename || item.title}`, 'success');
    });

    list.appendChild(el);
  });
}

// ============================================================================
// 5. Mở Cửa sổ Downloader cho luồng được chọn (Engine 1)
// ============================================================================
async function openDownloaderForStream(stream) {
  if (!currentLecture || !stream) return;

  // Nếu người dùng cấu hình lưu vào ổ đĩa, yêu cầu cấp quyền ngay trong cú click này
  if (currentSettings.downloadMode === 'filesystem' && activeFsHandle) {
    try {
      let perm = await activeFsHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        perm = await activeFsHandle.requestPermission({ mode: 'readwrite' });
      }
    } catch (e) {
      console.warn('Lỗi xin quyền File System khi bấm tải:', e);
    }
  }

  const cleanedMeta = cleanLectureTitle(currentLecture.lectureTitle);
  const finalIndex = currentLecture.lectureIndex || cleanedMeta.index || 1;
  const finalTitle = cleanedMeta.title;

  chrome.runtime.sendMessage({
    type: 'OPEN_DOWNLOADER_WINDOW',
    payload: {
      playlistUrl: stream.file,
      courseTitle: currentLecture.courseTitle,
      sectionTitle: currentLecture.sectionTitle || '',
      lectureIndex: String(finalIndex),
      lectureTitle: finalTitle,
      quality: `${stream.label}p`
    }
  });

  showStatusBanner(`Đã mở cửa sổ tải tiến trình cho bản ${stream.label}p HD`, 'success');
}

// ============================================================================
// 6. Xử lý Engine 2: Tab Stream Recorder (Bypass Widevine DRM)
// ============================================================================
function initEngine2Controls() {
  const btnStart = document.getElementById('btn-start-record');
  const btnStop = document.getElementById('btn-stop-record');
  const recordBox = document.getElementById('record-status-box');
  const timerEl = document.getElementById('record-timer');
  const sizeEl = document.getElementById('record-size');

  if (!btnStart || !btnStop) return;

  btnStart.addEventListener('click', async () => {
    try {
      tabRecorderInstance = new TabRecorder();
      await tabRecorderInstance.startRecording({
        onUpdate: ({ elapsedSec, totalMb }) => {
          const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
          const s = String(elapsedSec % 60).padStart(2, '0');
          timerEl.textContent = `${m}:${s}`;
          sizeEl.textContent = `${totalMb} MB`;
        }
      });

      btnStart.classList.add('hidden');
      recordBox.classList.remove('hidden');
      showStatusBanner('Engine 2 đang ghi lại luồng phát video...', 'success');
    } catch (e) {
      alert('Không thể bắt đầu ghi luồng: ' + e.message);
    }
  });

  btnStop.addEventListener('click', async () => {
    if (!tabRecorderInstance) return;

    try {
      showStatusBanner('Đang hoàn thiện và lưu video...', 'success');
      const result = await tabRecorderInstance.stopRecording();

      const blobUrl = URL.createObjectURL(result.blob);
      const courseTitle = currentLecture?.courseTitle || 'Udemy Course';
      const cleanedMeta = cleanLectureTitle(currentLecture?.lectureTitle || 'DRM Lecture');
      const finalTitle = cleanedMeta.title;
      const finalIndex = cleanedMeta.index || currentLecture?.lectureIndex || 1;

      chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        payload: {
          url: blobUrl,
          courseTitle,
          sectionTitle: currentLecture?.sectionTitle || '',
          lectureIndex: finalIndex,
          lectureTitle: finalTitle,
          extension: result.extension
        }
      });

      recordBox.classList.add('hidden');
      btnStart.classList.remove('hidden');
      showStatusBanner('Ghi video thành công và đã gửi lệnh tải!', 'success');
    } catch (e) {
      alert('Lỗi khi dừng ghi: ' + e.message);
    }
  });
}

// ============================================================================
// 7. Tải Phụ đề Tiếng Anh (Khắc phục triệt để lỗi File System & Tự động Fallback)
// ============================================================================
async function downloadSubtitleAsSrt(subUrl) {
  if (!currentLecture || !subUrl) return;

  // 1. Kiểm tra và xin quyền File System TRƯỚC TIÊN ngay khi user click (đảm bảo user gesture còn hiệu lực)
  let hasFsPermission = false;
  if (currentSettings.downloadMode === 'filesystem' && activeFsHandle) {
    try {
      let perm = await activeFsHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        perm = await activeFsHandle.requestPermission({ mode: 'readwrite' });
      }
      hasFsPermission = (perm === 'granted');
    } catch (fsErr) {
      console.warn('Lỗi kiểm tra quyền File System:', fsErr);
      hasFsPermission = false;
    }
  }

  showStatusBanner('Đang tải và chuyển đổi phụ đề Tiếng Anh sang .SRT...', 'success');

  try {
    const res = await fetch(subUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`Không thể tải phụ đề từ máy chủ (HTTP ${res.status})`);
    let rawContent = await res.text();

    // Nếu đây là playlist m3u8 của phụ đề (HLS subtitles)
    if (rawContent.startsWith('#EXTM3U')) {
      const lines = rawContent.split('\n').map(l => l.trim()).filter(Boolean);
      const segmentUrls = lines
        .filter(l => !l.startsWith('#'))
        .map(rel => new URL(rel, subUrl).href);

      const segmentTexts = await Promise.all(
        segmentUrls.map(async (u) => {
          const sRes = await fetch(u, { credentials: 'include' });
          return sRes.ok ? await sRes.text() : '';
        })
      );
      rawContent = segmentTexts.join('\n');
    }

    const srtText = convertVttToSrt(rawContent);
    if (!srtText || srtText.trim().length === 0) {
      throw new Error('Nội dung phụ đề rỗng');
    }

    const cleanedMeta = cleanLectureTitle(currentLecture.lectureTitle);
    const finalIndex = currentLecture.lectureIndex || cleanedMeta.index || 1;
    const finalTitle = cleanedMeta.title;
    // Tên file phụ đề khớp 100% tên file video
    const fileName = `${padIndex(finalIndex)} - ${sanitizeName(finalTitle, 'Lesson')}.srt`;
    const cleanCourse = sanitizeName(currentLecture.courseTitle, 'Udemy Course');
    const cleanSection = sanitizeName(currentLecture.sectionTitle, '');
    const folderDisplay = cleanSection ? `${cleanCourse}/${cleanSection}` : cleanCourse;

    // 2. Thử lưu vào Thư mục Ổ đĩa nếu đã có quyền
    if (hasFsPermission && activeFsHandle) {
      try {
        const courseFolder = await activeFsHandle.getDirectoryHandle(cleanCourse, { create: true });
        let targetFolder = courseFolder;
        if (cleanSection) {
          targetFolder = await courseFolder.getDirectoryHandle(cleanSection, { create: true });
        }
        const fileHandle = await targetFolder.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(srtText);
        await writable.close();

        showStatusBanner(`Đã lưu phụ đề vào thư mục: ${activeFsHandle.name}/${folderDisplay}/${fileName}`, 'success');
        return;
      } catch (writeErr) {
        console.warn('File System Access bị lỗi khi ghi, chuyển sang Downloads:', writeErr);
      }
    }

    // 3. Fallback sang chrome.downloads (Lưu vào thư mục Downloads chuẩn)
    const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);

    chrome.runtime.sendMessage({
      type: 'START_DOWNLOAD',
      payload: {
        url: blobUrl,
        courseTitle: currentLecture.courseTitle,
        sectionTitle: currentLecture.sectionTitle || '',
        lectureIndex: finalIndex,
        lectureTitle: finalTitle, // Khớp 100% tên file video
        extension: 'srt'
      }
    });

    showStatusBanner(`Đã tải phụ đề: ${fileName}`, 'success');
  } catch (err) {
    console.error('Lỗi tải phụ đề:', err);
    showStatusBanner(`Lỗi tải phụ đề: ${err.message}`, 'error');
  }
}

function showStatusBanner(text, type = 'success') {
  const banner = document.getElementById('status-banner');
  banner.textContent = text;
  banner.className = `status-banner ${type}`;
  banner.classList.remove('hidden');

  setTimeout(() => {
    banner.classList.add('hidden');
  }, 4000);
}

// ============================================================================
// 8. Tự động Tải liên tục N Bài giảng (Auto Next & Batch Downloader)
// ============================================================================
async function saveVideoBlobDirectly(blob, lectureData, streamInfo, settings, fsHandle) {
  const cleanedMeta = cleanLectureTitle(lectureData.lectureTitle);
  const finalIndex = lectureData.lectureIndex || cleanedMeta.index || 1;
  const cleanTitle = sanitizeName(cleanedMeta.title, 'Lesson');
  const cleanCourse = sanitizeName(lectureData.courseTitle, 'Udemy Course');
  const cleanSection = sanitizeName(lectureData.sectionTitle, '');
  const fileName = `${padIndex(finalIndex)} - ${cleanTitle}.mp4`;
  const folderDisplay = cleanSection ? `${cleanCourse}/${cleanSection}` : cleanCourse;

  // 1. Chế độ File System Access API
  if (settings.downloadMode === 'filesystem' && fsHandle) {
    try {
      const perm = await fsHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        const courseFolder = await fsHandle.getDirectoryHandle(cleanCourse, { create: true });
        let targetFolder = courseFolder;
        if (cleanSection) {
          targetFolder = await courseFolder.getDirectoryHandle(cleanSection, { create: true });
        }
        const fileHandle = await targetFolder.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { success: true, path: `${fsHandle.name}/${folderDisplay}/${fileName}` };
      }
    } catch (e) {
      console.warn('Ghi video vào File System thất bại, chuyển sang chrome.downloads:', e);
    }
  }

  // 2. Chế độ chrome.downloads
  const blobUrl = URL.createObjectURL(blob);
  const relativePath = buildDownloadPath({
    baseFolder: settings.customFolder,
    courseTitle: lectureData.courseTitle,
    sectionTitle: lectureData.sectionTitle,
    lectureIndex: finalIndex,
    lectureTitle: cleanedMeta.title,
    extension: 'mp4'
  });

  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: blobUrl,
        filename: relativePath,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(downloadId);
      }
    );
  });

  return { success: true, path: `Downloads/${settings.customFolder}/${folderDisplay}/${fileName}` };
}

async function downloadSubtitleAsSrtForBatch(subUrl, lectureData, settings, fsHandle) {
  if (!lectureData || !subUrl) return false;

  const res = await fetch(subUrl, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let rawContent = await res.text();

  if (rawContent.startsWith('#EXTM3U')) {
    const lines = rawContent.split('\n').map(l => l.trim()).filter(Boolean);
    const segmentUrls = lines
      .filter(l => !l.startsWith('#'))
      .map(rel => new URL(rel, subUrl).href);

    const segmentTexts = await Promise.all(
      segmentUrls.map(async (u) => {
        const sRes = await fetch(u, { credentials: 'include' });
        return sRes.ok ? await sRes.text() : '';
      })
    );
    rawContent = segmentTexts.join('\n');
  }

  const srtText = convertVttToSrt(rawContent);
  if (!srtText || srtText.trim().length === 0) return false;

  const cleanedMeta = cleanLectureTitle(lectureData.lectureTitle);
  const finalIndex = lectureData.lectureIndex || cleanedMeta.index || 1;
  const cleanTitle = sanitizeName(cleanedMeta.title, 'Lesson');
  const cleanCourse = sanitizeName(lectureData.courseTitle, 'Udemy Course');
  const cleanSection = sanitizeName(lectureData.sectionTitle, '');
  const fileName = `${padIndex(finalIndex)} - ${cleanTitle}.srt`;

  if (settings.downloadMode === 'filesystem' && fsHandle) {
    try {
      const perm = await fsHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        const courseFolder = await fsHandle.getDirectoryHandle(cleanCourse, { create: true });
        let targetFolder = courseFolder;
        if (cleanSection) {
          targetFolder = await courseFolder.getDirectoryHandle(cleanSection, { create: true });
        }
        const fileHandle = await targetFolder.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(srtText);
        await writable.close();
        return true;
      }
    } catch (e) {}
  }

  // Fallback sang chrome.downloads
  const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const relativePath = buildDownloadPath({
    baseFolder: settings.customFolder,
    courseTitle: lectureData.courseTitle,
    sectionTitle: lectureData.sectionTitle,
    lectureIndex: finalIndex,
    lectureTitle: cleanedMeta.title,
    extension: 'srt'
  });

  await new Promise((resolve) => {
    chrome.downloads.download({
      url: blobUrl,
      filename: relativePath,
      saveAs: false,
      conflictAction: 'uniquify'
    }, () => resolve());
  });

  return true;
}

const batchManager = {
  isRunning: false,
  isPaused: false,
  targetCount: 5,
  completedCount: 0,
  processedLectureIds: new Set(),
  abortController: null,
  pauseResolver: null,
  userDecisionResolver: null,

  init() {
    const inputCount = document.getElementById('input-batch-count');
    const btnDecrease = document.getElementById('btn-batch-decrease');
    const btnIncrease = document.getElementById('btn-batch-increase');
    const btnStart = document.getElementById('btn-start-batch');
    const btnStartText = document.getElementById('btn-start-batch-text');
    const btnPause = document.getElementById('btn-batch-pause');
    const btnStop = document.getElementById('btn-batch-stop');
    const btnSkipSub = document.getElementById('btn-batch-skip-sub');
    const btnAbortSub = document.getElementById('btn-batch-abort-sub');

    const updateStartBtnText = () => {
      let val = parseInt(inputCount.value, 10) || 5;
      if (val < 1) val = 1;
      if (val > 100) val = 100;
      inputCount.value = val;
      if (btnStartText) btnStartText.textContent = `Bắt đầu tự động tải ${val} bài`;
    };

    btnDecrease?.addEventListener('click', () => {
      let val = (parseInt(inputCount.value, 10) || 5) - 1;
      if (val < 1) val = 1;
      inputCount.value = val;
      updateStartBtnText();
    });

    btnIncrease?.addEventListener('click', () => {
      let val = (parseInt(inputCount.value, 10) || 5) + 1;
      if (val > 100) val = 100;
      inputCount.value = val;
      updateStartBtnText();
    });

    inputCount?.addEventListener('input', updateStartBtnText);

    btnStart?.addEventListener('click', async () => {
      const count = parseInt(inputCount.value, 10) || 5;
      await this.start(count);
    });

    btnPause?.addEventListener('click', () => {
      if (!this.isRunning) return;
      if (this.isPaused) {
        this.resume();
      } else {
        this.pause();
      }
    });

    btnStop?.addEventListener('click', () => {
      this.stop(false);
    });

    btnSkipSub?.addEventListener('click', () => {
      if (this.userDecisionResolver) {
        this.userDecisionResolver('skip');
        this.userDecisionResolver = null;
      }
    });

    btnAbortSub?.addEventListener('click', () => {
      if (this.userDecisionResolver) {
        this.userDecisionResolver('abort');
        this.userDecisionResolver = null;
      }
    });
  },

  async start(count) {
    if (this.isRunning) return;

    // Yêu cầu quyền thư mục nếu dùng chế độ File System
    if (currentSettings.downloadMode === 'filesystem' && activeFsHandle) {
      try {
        let perm = await activeFsHandle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          perm = await activeFsHandle.requestPermission({ mode: 'readwrite' });
        }
      } catch (e) {
        console.warn('Lỗi kiểm tra quyền FS:', e);
      }
    }

    this.isRunning = true;
    this.isPaused = false;
    this.targetCount = count;
    this.completedCount = 0;
    this.processedLectureIds.clear();

    const configView = document.getElementById('batch-config-view');
    const liveView = document.getElementById('batch-live-view');
    const runningBadge = document.getElementById('batch-running-badge');
    const btnPause = document.getElementById('btn-batch-pause');

    configView?.classList.add('hidden');
    liveView?.classList.remove('hidden');
    runningBadge?.classList.remove('hidden');
    if (btnPause) btnPause.textContent = '⏸️ Tạm dừng';

    this.updateOverallProgress();
    this.runLoop();
  },

  updateOverallProgress() {
    const counterText = document.getElementById('batch-counter-text');
    const overallBar = document.getElementById('batch-overall-progress-bar');
    if (counterText) {
      counterText.textContent = `Bài ${this.completedCount + 1} / ${this.targetCount}`;
    }
    if (overallBar) {
      const pct = Math.min(100, Math.round((this.completedCount / this.targetCount) * 100));
      overallBar.style.width = `${pct}%`;
    }
  },

  async checkPause() {
    if (!this.isPaused) return;
    await new Promise(resolve => {
      this.pauseResolver = resolve;
    });
  },

  pause() {
    this.isPaused = true;
    const btnPause = document.getElementById('btn-batch-pause');
    if (btnPause) btnPause.textContent = '▶️ Tiếp tục';
    showStatusBanner('Đã tạm dừng chuỗi tự động tải.', 'info');
  },

  resume() {
    this.isPaused = false;
    const btnPause = document.getElementById('btn-batch-pause');
    if (btnPause) btnPause.textContent = '⏸️ Tạm dừng';
    if (this.pauseResolver) {
      this.pauseResolver();
      this.pauseResolver = null;
    }
    showStatusBanner('Tiếp tục chuỗi tự động tải...', 'success');
  },

  stop(isFinished = false) {
    this.isRunning = false;
    this.isPaused = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.pauseResolver) {
      this.pauseResolver();
      this.pauseResolver = null;
    }
    if (this.userDecisionResolver) {
      this.userDecisionResolver('abort');
      this.userDecisionResolver = null;
    }

    const configView = document.getElementById('batch-config-view');
    const liveView = document.getElementById('batch-live-view');
    const runningBadge = document.getElementById('batch-running-badge');
    const promptBox = document.getElementById('batch-no-sub-prompt');
    const cooldownBox = document.getElementById('batch-cooldown-box');

    configView?.classList.remove('hidden');
    liveView?.classList.add('hidden');
    runningBadge?.classList.add('hidden');
    promptBox?.classList.add('hidden');
    cooldownBox?.classList.add('hidden');

    if (isFinished) {
      showStatusBanner(`🎉 Đã hoàn thành tự động tải toàn bộ ${this.completedCount} bài giảng!`, 'success');
    } else {
      showStatusBanner(`Đã dừng chuỗi tự động (Đã tải ${this.completedCount}/${this.targetCount} bài).`, 'info');
    }
  },

  async runLoop() {
    while (this.isRunning && this.completedCount < this.targetCount) {
      await this.checkPause();
      if (!this.isRunning) break;

      const currentLectureNameEl = document.getElementById('batch-current-lecture-name');
      const videoStatusEl = document.getElementById('batch-video-status');
      const videoBarEl = document.getElementById('batch-video-progress-bar');
      const captionStatusEl = document.getElementById('batch-caption-status');
      const cooldownBox = document.getElementById('batch-cooldown-box');
      const promptBox = document.getElementById('batch-no-sub-prompt');

      if (cooldownBox) cooldownBox.classList.add('hidden');
      if (promptBox) promptBox.classList.add('hidden');
      if (videoBarEl) videoBarEl.style.width = '0%';
      if (captionStatusEl) captionStatusEl.textContent = 'Chờ tải...';
      if (videoStatusEl) videoStatusEl.textContent = 'Đang nhận diện bài giảng...';

      let lecture = currentLecture;
      let waitAttempts = 0;

      // Đợi nhận diện bài giảng mới (phải có lectureId và CHƯA nằm trong processedLectureIds)
      while (
        (!lecture ||
         !lecture.lectureId ||
         this.processedLectureIds.has(String(lecture.lectureId)) ||
         (!lecture.streams?.length && !lecture.isQuiz && !lecture.isArticle && !lecture.isDrmProtected)) &&
        waitAttempts < 25
      ) {
        if (!this.isRunning) return;
        waitAttempts++;
        if (videoStatusEl) {
          videoStatusEl.textContent = `Đang đợi chuyển sang bài mới (${waitAttempts}s)...`;
        }
        await new Promise(r => setTimeout(r, 800));
        await detectCurrentLecture();
        lecture = currentLecture;
      }

      // Đợi thêm chút nếu chưa giải mã xong 1080p
      let resWait = 0;
      while (lecture && lecture.streams?.length > 0 && !lecture.streams.some(s => s.resolution >= 1080 || s.type === 'hls') && resWait < 5) {
        await new Promise(r => setTimeout(r, 600));
        resWait++;
        lecture = currentLecture;
        if (!this.isRunning) return;
      }

      if (!lecture || this.processedLectureIds.has(String(lecture.lectureId))) {
        alert('Không thể nhận diện bài giảng mới trên trang Udemy. Chuỗi tự động đã dừng.');
        this.stop(false);
        return;
      }

      const cleaned = cleanLectureTitle(lecture.lectureTitle);
      const displayIndex = lecture.lectureIndex || cleaned.index || 1;
      const displayTitle = `${padIndex(displayIndex)} - ${cleaned.title}`;
      if (currentLectureNameEl) currentLectureNameEl.textContent = displayTitle;

      // 2. Tự động bỏ qua Quiz, Bài đọc (Article) hoặc DRM Widevine
      if (lecture.isQuiz || lecture.isArticle || lecture.isDrmProtected) {
        const typeLabel = lecture.isQuiz ? 'Quiz' : (lecture.isArticle ? 'Bài đọc' : 'DRM');
        if (videoStatusEl) videoStatusEl.textContent = `Bài này là ${typeLabel} (bỏ qua)...`;
        this.processedLectureIds.add(String(lecture.lectureId));
        await new Promise(r => setTimeout(r, 1500));
        await this.goToNext();
        continue;
      }

      // 3. Tải Video (Chất lượng cao nhất 1080p > 720p)
      const best = lecture.bestQuality || lecture.streams?.[0];
      if (!best) {
        if (videoStatusEl) videoStatusEl.textContent = 'Chưa bắt được luồng video, đang chờ...';
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      this.abortController = new AbortController();
      if (videoStatusEl) videoStatusEl.textContent = `Đang tải video ${best.label}p...`;

      try {
        const isDirectMp4 = best.file.includes('.mp4') || best.type === 'video/mp4';
        const videoResult = isDirectMp4
          ? await downloadDirectVideo({
              videoUrl: best.file,
              signal: this.abortController.signal,
              onProgress: (info) => {
                if (videoBarEl && info.percent !== undefined) videoBarEl.style.width = `${info.percent}%`;
                if (videoStatusEl && info.message) videoStatusEl.textContent = `${info.percent || 0}% (${info.speedMbps || 0} Mbps)`;
              }
            })
          : await downloadHlsVideo({
              playlistUrl: best.file,
              concurrency: 5,
              signal: this.abortController.signal,
              onProgress: (info) => {
                if (videoBarEl && info.percent !== undefined) videoBarEl.style.width = `${info.percent}%`;
                if (videoStatusEl && info.message) videoStatusEl.textContent = `${info.percent || 0}% (${info.speedMbps || 0} Mbps)`;
              }
            });

        if (videoBarEl) videoBarEl.style.width = '100%';
        if (videoStatusEl) videoStatusEl.textContent = `Đang lưu video ${best.label}p...`;

        await saveVideoBlobDirectly(videoResult.blob, lecture, best, currentSettings, activeFsHandle);
        if (videoStatusEl) videoStatusEl.textContent = `✅ Xong ${best.label}p (${(videoResult.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`;
      } catch (videoErr) {
        if (videoErr.name === 'AbortError' || !this.isRunning) return;
        console.error('Lỗi tải video trong batch:', videoErr);
        if (videoStatusEl) videoStatusEl.textContent = `❌ Lỗi video: ${videoErr.message}`;
        alert(`Lỗi khi tải video bài "${displayTitle}": ${videoErr.message}`);
        this.stop(false);
        return;
      }

      await this.checkPause();
      if (!this.isRunning) break;

      // 4. Tải Phụ đề Tiếng Anh
      const enCap = findEnglishCaption(lecture.captions);
      if (!enCap) {
        if (captionStatusEl) captionStatusEl.textContent = '⚠️ Không có phụ đề Tiếng Anh';
        if (promptBox) promptBox.classList.remove('hidden');

        const decision = await new Promise(resolve => {
          this.userDecisionResolver = resolve;
        });

        if (promptBox) promptBox.classList.add('hidden');

        if (decision === 'abort' || !this.isRunning) {
          this.stop(false);
          return;
        }
        if (captionStatusEl) captionStatusEl.textContent = '⏭️ Đã bỏ qua phụ đề';
      } else {
        if (captionStatusEl) captionStatusEl.textContent = 'Đang tải phụ đề .srt...';
        try {
          await downloadSubtitleAsSrtForBatch(enCap.url, lecture, currentSettings, activeFsHandle);
          if (captionStatusEl) captionStatusEl.textContent = '✅ Xong phụ đề (.srt)';
        } catch (subErr) {
          console.warn('Lỗi tải phụ đề trong batch:', subErr);
          if (captionStatusEl) captionStatusEl.textContent = `⚠️ Lỗi phụ đề: ${subErr.message}`;
        }
      }

      // Hoàn tất 1 bài hợp lệ
      this.processedLectureIds.add(String(lecture.lectureId));
      this.completedCount++;
      this.updateOverallProgress();

      if (this.completedCount >= this.targetCount) {
        this.stop(true);
        break;
      }

      await this.checkPause();
      if (!this.isRunning) break;

      // 5. Cooldown 3 giây trước khi Next bài tiếp theo
      if (cooldownBox) {
        cooldownBox.classList.remove('hidden');
        const cooldownText = document.getElementById('batch-cooldown-text');
        for (let s = 3; s > 0; s--) {
          if (!this.isRunning) break;
          await this.checkPause();
          if (cooldownText) cooldownText.textContent = `Nghỉ ${s}s... chuẩn bị chuyển bài tiếp`;
          await new Promise(r => setTimeout(r, 1000));
        }
        cooldownBox.classList.add('hidden');
      }

      if (!this.isRunning) break;

      // 6. Kích hoạt Next sang bài tiếp theo
      await this.goToNext();
    }
  },

  async goToNext() {
    const tab = targetUdemyTab || await getActiveUdemyTab();
    if (!tab?.id) {
      this.stop(false);
      return;
    }

    // Reset currentLecture để vòng lặp runLoop chắc chắn chờ đợi bài giảng mới
    currentLecture = null;

    const res = await new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { type: 'GO_TO_NEXT_LECTURE' }, (r) => {
        resolve(r || { success: false });
      });
    });

    if (res?.isLast) {
      showStatusBanner('🎉 Đã tải tới bài cuối cùng của khóa học!', 'success');
      this.stop(true);
      return;
    }

    if (res?.nextUrl && tab?.id) {
      const fullUrl = res.nextUrl.startsWith('http') ? res.nextUrl : `https://www.udemy.com${res.nextUrl}`;
      try {
        await chrome.tabs.update(tab.id, { url: fullUrl });
      } catch (e) {}
    } else if (!res?.success) {
      alert(res?.error || 'Không tìm thấy bài giảng tiếp theo hoặc đã tới bài cuối cùng của khóa học!');
      this.stop(true);
      return;
    }

    await new Promise(r => setTimeout(r, 1500));
  }
};

