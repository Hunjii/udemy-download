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

  // DRM Settings in Auto-Batch
  const cbAutoRecordDrm = document.getElementById('cb-auto-record-drm');
  const drmSubSettings = document.getElementById('drm-sub-settings');
  const selectDrmSpeed = document.getElementById('select-drm-speed');
  const cbDrmMute = document.getElementById('cb-drm-mute-speaker');

  if (cbAutoRecordDrm) {
    cbAutoRecordDrm.checked = Boolean(currentSettings.autoRecordDrm);
    if (cbAutoRecordDrm.checked) {
      drmSubSettings?.classList.remove('hidden');
    } else {
      drmSubSettings?.classList.add('hidden');
    }
    cbAutoRecordDrm.addEventListener('change', async () => {
      currentSettings.autoRecordDrm = cbAutoRecordDrm.checked;
      if (cbAutoRecordDrm.checked) {
        drmSubSettings?.classList.remove('hidden');
      } else {
        drmSubSettings?.classList.add('hidden');
      }
      await saveSettings(currentSettings);
    });
  }

  if (selectDrmSpeed) {
    selectDrmSpeed.value = currentSettings.drmSpeed || '1.0';
    selectDrmSpeed.addEventListener('change', async () => {
      currentSettings.drmSpeed = selectDrmSpeed.value;
      await saveSettings(currentSettings);
    });
  }

  if (cbDrmMute) {
    cbDrmMute.checked = currentSettings.drmMuteSpeaker !== false;
    cbDrmMute.addEventListener('change', async () => {
      currentSettings.drmMuteSpeaker = cbDrmMute.checked;
      await saveSettings(currentSettings);
    });
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
      return;
    }

    if (message.type === 'LECTURE_DATA_UPDATED' || message.type === 'UPDATE_LECTURE_DATA') {
      if (message.tabId && targetUdemyTab && targetUdemyTab.id !== message.tabId) {
        return;
      }

      if (message.data) {
        // Kiểm tra xem ID bài giảng nhận được có khớp với URL của target tab không (tránh bài cũ)
        if (targetUdemyTab?.url) {
          const urlMatch = targetUdemyTab.url.match(/\/(?:lecture|quiz|practice)\/(\d+)/);
          const activeUrlId = urlMatch ? urlMatch[1] : null;
          if (activeUrlId && message.data.lectureId && String(message.data.lectureId) !== activeUrlId) {
            console.log(`[Udemy Downloader Popup] Bỏ qua gói tin bài giảng ID=${message.data.lectureId} vì tab đang ở ID=${activeUrlId}`);
            return;
          }
        }
        currentLecture = message.data;
        renderLecture(message.data);
      } else {
        // Đang chuyển bài: cập nhật targetUdemyTab URL và hiển thị trạng thái chờ nếu chưa có bài
        if (targetUdemyTab?.id) {
          chrome.tabs.get(targetUdemyTab.id).then(tab => {
            if (tab?.url) targetUdemyTab = tab;
          }).catch(() => {});
        }
        const loadingState = document.getElementById('loading-state');
        const lectureContent = document.getElementById('lecture-content');
        if (!currentLecture) {
          loadingState?.classList.remove('hidden');
          lectureContent?.classList.add('hidden');
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

function sendMessageWithTimeout(message, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(res || null);
        }
      });
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

function sendTabMessageWithTimeout(tabId, message, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeoutMs);

    try {
      chrome.tabs.sendMessage(tabId, message, (res) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(res || null);
        }
      });
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

// ============================================================================
// 3. Nhận diện bài giảng đang xem
// ============================================================================
async function detectCurrentLecture() {
  const loadingState = document.getElementById('loading-state');
  const notUdemyState = document.getElementById('not-udemy-state');
  const lectureContent = document.getElementById('lecture-content');

  // Đảm bảo loading state hiển thị
  loadingState?.classList.remove('hidden');
  notUdemyState?.classList.add('hidden');
  lectureContent?.classList.add('hidden');

  const activeTab = await getActiveUdemyTab();

  if (!activeTab || !activeTab.url || !activeTab.url.includes('udemy.com')) {
    loadingState?.classList.add('hidden');
    notUdemyState?.classList.remove('hidden');
    return;
  }
  targetUdemyTab = activeTab;

  // Kiểm tra ping nhanh (timeout 500ms)
  try {
    const ping = await sendTabMessageWithTimeout(activeTab.id, { type: 'PING' }, 500);

    if (!ping || ping.status !== 'pong') {
      if (chrome.scripting) {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ['src/content/content.js']
        });
        await new Promise(r => setTimeout(r, 300));
      }
    }
  } catch (e) {}

  const urlMatch = activeTab.url?.match(/\/(?:lecture|quiz|practice)\/(\d+)/);
  const expectedLectureId = urlMatch ? urlMatch[1] : null;

  // 1. Thử lấy từ Background cache (timeout nhanh 1.2s)
  try {
    const bgResponse = await sendMessageWithTimeout({
      type: 'GET_LECTURE_DATA',
      tabId: activeTab.id,
      expectedLectureId
    }, 1200);

    if (bgResponse && bgResponse.success && bgResponse.data) {
      if (!expectedLectureId || String(bgResponse.data.lectureId) === String(expectedLectureId)) {
        renderLecture(bgResponse.data);
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
    }
  } catch (e) {}

  // 2. Yêu cầu Content Script trích xuất và phân tích (timeout 2.5s)
  try {
    const csResponse = await sendTabMessageWithTimeout(activeTab.id, { type: 'GET_CURRENT_LECTURE_FROM_PAGE' }, 2500);

    if (csResponse && csResponse.data && (!expectedLectureId || String(csResponse.data.lectureId) === String(expectedLectureId))) {
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
      renderLecture(csResponse.data);
      return;
    }

    // 3. Nếu Content Script đã nhận diện được thông tin bài giảng (dù video chưa bấm Play)
    if (csResponse?.pageInfo && csResponse.pageInfo.lectureId) {
      const pInfo = csResponse.pageInfo;
      renderLecture({
        lectureId: pInfo.lectureId,
        courseId: pInfo.courseId,
        courseTitle: pInfo.courseTitle || 'Udemy Course',
        sectionTitle: pInfo.sectionTitle || '',
        lectureTitle: pInfo.lectureTitle || `Bài ${pInfo.lectureId}`,
        lectureIndex: pInfo.lectureIndex || 1,
        streams: [],
        bestQuality: null,
        captions: [],
        supplementaryAssets: [],
        isDrmProtected: false
      });
      return;
    }
  } catch (e) {
    console.warn('Lỗi kết nối content script:', e);
  }

  // 4. Fallback cuối cùng: Phân tích trực tiếp từ Tab URL & Title nếu content script chưa kịp phản hồi
  if (expectedLectureId) {
    const rawTitle = activeTab.title ? activeTab.title.split('|')[0].trim() : `Bài ${expectedLectureId}`;
    const courseTitle = activeTab.title?.split('|')?.[1]?.trim() || 'Udemy Course';
    renderLecture({
      lectureId: expectedLectureId,
      courseId: null,
      courseTitle,
      sectionTitle: '',
      lectureTitle: rawTitle,
      lectureIndex: 1,
      streams: [],
      bestQuality: null,
      captions: [],
      supplementaryAssets: [],
      isDrmProtected: false
    });
    return;
  }

  loadingState?.classList.add('hidden');
  notUdemyState?.classList.remove('hidden');
}

// ============================================================================
// 4. Hiển thị thông tin lên giao diện
// ============================================================================
function renderLecture(data) {
  currentLecture = data;

  const loadingState = document.getElementById('loading-state');
  const notUdemyState = document.getElementById('not-udemy-state');
  const lectureContent = document.getElementById('lecture-content');
  const drmAlert = document.getElementById('lecture-drm-alert');
  const engine2Card = document.getElementById('engine2-card');

  loadingState?.classList.add('hidden');
  notUdemyState?.classList.add('hidden');
  lectureContent?.classList.remove('hidden');

  const isDrm = Boolean(data.isDrmProtected);
  if (isDrm) {
    drmAlert?.classList.remove('hidden');
    engine2Card?.classList.add('highlighted');
  } else {
    drmAlert?.classList.add('hidden');
    engine2Card?.classList.remove('highlighted');
  }

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

  if (isDrm && (!data.streams || data.streams.length === 0)) {
    highestQualityTag.textContent = 'Khóa DRM';
    highestQualityTag.style.color = '#f87171';
    bestResSubtext.textContent = 'Bị khóa DRM (SAMPLE-AES) - Hãy dùng Engine 2 bên dưới';
    btnDownloadBest.disabled = false;
    btnDownloadBest.onclick = () => {
      const btnStartRecord = document.getElementById('btn-start-record');
      if (btnStartRecord) {
        btnStartRecord.scrollIntoView({ behavior: 'smooth', block: 'center' });
        showStatusBanner('Bài này bị khóa DRM Widevine. Vui lòng bấm BẮT ĐẦU GHI ENGINE 2 bên dưới!', 'error');
      }
    };
  } else if (best) {
    highestQualityTag.textContent = `${best.label}p HD`;
    highestQualityTag.style.color = '';
    bestResSubtext.textContent = `Độ phân giải: ${best.label}p MP4 (Engine 1)`;
    btnDownloadBest.disabled = false;
    btnDownloadBest.onclick = () => openDownloaderForStream(best);
  } else {
    highestQualityTag.textContent = 'Chưa bắt luồng';
    highestQualityTag.style.color = '';
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

  const linkChromeSettings = document.getElementById('link-chrome-settings');
  if (linkChromeSettings) {
    linkChromeSettings.addEventListener('click', () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText('chrome://settings/system').then(() => {
          showStatusBanner('📋 Đã copy "chrome://settings/system"! Hãy dán vào tab mới để tắt Tăng tốc phần cứng.', 'info');
        }).catch(() => {
          showStatusBanner('Vui lòng mở tab mới và truy cập: chrome://settings/system', 'info');
        });
      } else {
        showStatusBanner('Vui lòng mở tab mới và truy cập: chrome://settings/system', 'info');
      }
    });
  }

  let autoStopTimer = null;

  btnStart.addEventListener('click', async () => {
    try {
      const muteSpeaker = Boolean(document.getElementById('cb-manual-drm-mute')?.checked);
      const speed = Number(document.getElementById('select-manual-drm-speed')?.value) || 1.0;

      const tab = targetUdemyTab || await getActiveUdemyTab();
      if (!tab?.id) {
        throw new Error('Không tìm thấy tab Udemy đang phát bài giảng. Vui lòng mở lại trang bài giảng trên Udemy.');
      }

      // Kích hoạt tab Udemy để đảm bảo tab không bị trình duyệt đóng băng (thường xảy ra khi mở popup dạng window)
      try {
        await chrome.tabs.update(tab.id, { active: true });
      } catch (e) {}

      // Kích hoạt Cinema Mode trên tab Udemy để video tràn toàn màn hình
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'ENABLE_CINEMA_MODE_FOR_RECORDING' }).catch(() => {});
      }

      tabRecorderInstance = new TabRecorder();
      tabRecorderInstance.onTrackEnded = () => {
        // Khi người dùng bấm "Dừng chia sẻ" trên thanh thông báo gốc của Chrome
        if (btnStop && !btnStop.classList.contains('hidden')) {
          btnStop.click();
        }
      };

      await tabRecorderInstance.startRecording({
        targetTabId: tab.id,
        muteSpeaker,
        onUpdate: ({ elapsedSec, totalMb }) => {
          const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
          const s = String(elapsedSec % 60).padStart(2, '0');
          if (timerEl) timerEl.textContent = `${m}:${s}`;
          if (sizeEl) sizeEl.textContent = `${totalMb} MB`;
        }
      });

      // Điều khiển tab phát video với tốc độ đã chọn từ đầu bài (00:00)
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'PLAY_VIDEO_FOR_RECORDING',
          playbackSpeed: speed,
          startFromBeginning: true
        }).catch(() => {});
      }

      btnStart.classList.add('hidden');
      recordBox?.classList.remove('hidden');
      showStatusBanner(`Engine 2.0 đang ghi Cinema Mode (${speed}x, ${muteSpeaker ? 'Tắt loa ngoài' : 'Có tiếng'})...`, 'success');

      // Tự động kiểm tra và dừng ghi khi video kết thúc
      if (autoStopTimer) clearInterval(autoStopTimer);
      autoStopTimer = setInterval(async () => {
        if (!tabRecorderInstance) {
          clearInterval(autoStopTimer);
          return;
        }
        try {
          const checkTab = targetUdemyTab || await getActiveUdemyTab();
          if (checkTab?.id) {
            const state = await sendTabMessageWithTimeout(checkTab.id, { type: 'GET_VIDEO_PLAYBACK_STATE' }, 800);
            if (state && state.ended) {
              clearInterval(autoStopTimer);
              btnStop.click();
            }
          }
        } catch (e) {}
      }, 1000);
    } catch (e) {
      const tab = targetUdemyTab || await getActiveUdemyTab();
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'DISABLE_CINEMA_MODE_FOR_RECORDING' }).catch(() => {});
      }
      if (e.isCancelled || e.name === 'NotAllowedError' || e.name === 'AbortError') {
        showStatusBanner('Đã hủy kích hoạt Engine 2.0 (bạn chưa bấm Chia sẻ tab).', 'info');
      } else {
        alert('Không thể bắt đầu ghi luồng: ' + e.message);
      }
      tabRecorderInstance = null;
    }
  });

  btnStop.addEventListener('click', async () => {
    if (autoStopTimer) {
      clearInterval(autoStopTimer);
      autoStopTimer = null;
    }

    if (!tabRecorderInstance) return;

    try {
      showStatusBanner('Đang hoàn thiện và lưu video...', 'success');
      const tab = targetUdemyTab || await getActiveUdemyTab();
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_VIDEO_FOR_RECORDING' }).catch(() => {});
        chrome.tabs.sendMessage(tab.id, { type: 'DISABLE_CINEMA_MODE_FOR_RECORDING' }).catch(() => {});
      }

      const result = await tabRecorderInstance.stopRecording();
      tabRecorderInstance = null;

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

      // Tự động tải kèm phụ đề .SRT nếu bài có phụ đề
      const engCap = currentLecture?.captions ? findEnglishCaption(currentLecture.captions) : null;
      const targetCap = engCap || currentLecture?.captions?.[0];
      if (targetCap && targetCap.url) {
        try {
          await downloadSubtitleAsSrt(targetCap.url);
          showStatusBanner('Ghi video thành công và đã lưu kèm phụ đề .SRT!', 'success');
        } catch (e) {
          showStatusBanner('Ghi video thành công và đã gửi lệnh tải!', 'success');
        }
      } else {
        showStatusBanner('Ghi video thành công và đã gửi lệnh tải!', 'success');
      }

      recordBox?.classList.add('hidden');
      btnStart.classList.remove('hidden');
      if (timerEl) timerEl.textContent = '00:00';
      if (sizeEl) sizeEl.textContent = '0.0 MB';
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

    const btnBatchStartDrm = document.getElementById('btn-batch-start-drm');
    const btnBatchSkipDrm = document.getElementById('btn-batch-skip-drm');

    btnBatchStartDrm?.addEventListener('click', () => {
      if (this.drmPromptResolver) {
        this.drmPromptResolver(true);
        this.drmPromptResolver = null;
      }
    });

    btnBatchSkipDrm?.addEventListener('click', () => {
      if (this.drmPromptResolver) {
        this.drmPromptResolver(false);
        this.drmPromptResolver = null;
      }
    });
  },

  async start(count) {
    // 1. Yêu cầu quyền thư mục nếu dùng chế độ File System
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

    const tab = targetUdemyTab || await getActiveUdemyTab();
    if (!tab?.id) {
      alert('Không tìm thấy tab Udemy đang hoạt động.');
      return;
    }

    // Nếu người dùng cấu hình tự động ghi DRM (Engine 2) -> chạy AutoBatch trực tiếp trên tab/popup
    if (currentSettings.autoRecordDrm) {
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
      return;
    }

    // 2. Lấy thông tin bài giảng và ID khóa học
    let courseId = currentLecture?.courseId;
    let startLectureId = currentLecture?.lectureId;
    let courseTitle = currentLecture?.courseTitle;

    if (!courseId || !startLectureId) {
      try {
        const infoRes = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, { type: 'GET_COURSE_AND_LECTURE_INFO' }, (r) => {
            resolve(r || null);
          });
        });
        if (infoRes?.pageInfo) {
          if (!courseId) courseId = infoRes.pageInfo.courseId;
          if (!startLectureId) startLectureId = infoRes.pageInfo.lectureId;
          if (!courseTitle) courseTitle = infoRes.pageInfo.courseTitle;
        }
      } catch (e) {}
    }

    // Fallback qua URL nếu thiếu
    if (!startLectureId && tab.url) {
      const m = tab.url.match(/\/(?:lecture|quiz|practice)\/(\d+)/);
      if (m) startLectureId = m[1];
    }

    if (!courseId) {
      alert('Chưa nhận diện được ID khóa học. Vui lòng làm mới trang Udemy hoặc bấm mở 1 bài giảng.');
      return;
    }

    // 3. Khởi chạy cửa sổ Downloader độc lập ở chế độ Batch API Queue
    chrome.runtime.sendMessage({
      type: 'OPEN_DOWNLOADER_WINDOW',
      payload: {
        mode: 'batch',
        courseId,
        startLectureId: startLectureId || '',
        count,
        courseTitle: courseTitle || 'Udemy Course',
        tabId: tab.id
      }
    }, (res) => {
      if (res?.success) {
        showStatusBanner(`🚀 Đã mở cửa sổ hàng đợi tải ${count} bài giảng!`, 'success');
      } else {
        showStatusBanner('Không thể mở cửa sổ tải.', 'error');
      }
    });
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
    if (this.drmPromptResolver) {
      this.drmPromptResolver(false);
      this.drmPromptResolver = null;
    }
    if (this.tabRecorder && this.tabRecorder.isRecording) {
      try { this.tabRecorder.stopRecording(); } catch (e) {}
      this.tabRecorder = null;
      getActiveUdemyTab().then(tab => {
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_VIDEO_FOR_RECORDING' }).catch(() => {});
          chrome.tabs.sendMessage(tab.id, { type: 'DISABLE_CINEMA_MODE_FOR_RECORDING' }).catch(() => {});
        }
      }).catch(() => {});
    }

    const configView = document.getElementById('batch-config-view');
    const liveView = document.getElementById('batch-live-view');
    const runningBadge = document.getElementById('batch-running-badge');
    const promptBox = document.getElementById('batch-no-sub-prompt');
    const drmPromptBox = document.getElementById('batch-drm-prompt');
    const cooldownBox = document.getElementById('batch-cooldown-box');

    configView?.classList.remove('hidden');
    liveView?.classList.add('hidden');
    runningBadge?.classList.add('hidden');
    promptBox?.classList.add('hidden');
    drmPromptBox?.classList.add('hidden');
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

      // 2. Tự động bỏ qua Quiz hoặc Bài đọc (Article)
      if (lecture.isQuiz || lecture.isArticle) {
        const typeLabel = lecture.isQuiz ? 'Quiz' : 'Bài đọc';
        if (videoStatusEl) videoStatusEl.textContent = `Bài này là ${typeLabel} (bỏ qua)...`;
        this.processedLectureIds.add(String(lecture.lectureId));
        await new Promise(r => setTimeout(r, 1500));
        await this.goToNext();
        continue;
      }

      // 2.1 Xử lý bài giảng bị mã hóa DRM (Widevine)
      if (lecture.isDrmProtected) {
        if (lecture.hasNonDrmFallback && (lecture.bestQuality || lecture.streams?.length > 0)) {
          if (videoStatusEl) {
            videoStatusEl.textContent = `Bài khóa DRM nhưng có luồng mở (${lecture.bestQuality?.label || '720'}p), đang tải...`;
          }
          // Tiếp tục bước 3 để Engine 1 tải luồng non-DRM fallback
        } else if (currentSettings.autoRecordDrm) {
          // Bật chế độ tự động ghi Engine 2
          const speed = Number(currentSettings.drmSpeed) || 1.0;
          const mute = currentSettings.drmMuteSpeaker !== false;
          try {
            const recorded = await this.recordDrmLecture(lecture, {
              speed,
              muteSpeaker: mute,
              videoStatusEl,
              videoBarEl,
              captionStatusEl,
              promptBox
            });
            if (recorded === false) {
              this.processedLectureIds.add(String(lecture.lectureId));
              await new Promise(r => setTimeout(r, 1000));
              await this.goToNext();
              continue;
            }
          } catch (recErr) {
            if (!this.isRunning) return;
            console.error('Lỗi ghi luồng DRM trong batch:', recErr);
            if (videoStatusEl) videoStatusEl.textContent = `⚠️ Lỗi ghi DRM: ${recErr.message} (Bỏ qua)`;
            this.processedLectureIds.add(String(lecture.lectureId));
            await new Promise(r => setTimeout(r, 1500));
            await this.goToNext();
            continue;
          }

          // Hoàn tất 1 bài DRM thành công
          this.processedLectureIds.add(String(lecture.lectureId));
          this.completedCount++;
          this.updateOverallProgress();

          if (this.completedCount >= this.targetCount) {
            this.stop(true);
            break;
          }

          await this.checkPause();
          if (!this.isRunning) break;

          // Cooldown 3 giây trước khi Next bài tiếp theo
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
          await this.goToNext();
          continue;
        } else {
          // autoRecordDrm tắt -> Bỏ qua bài DRM
          if (videoStatusEl) videoStatusEl.textContent = 'Bài này bị khóa DRM (Đã bỏ qua)...';
          this.processedLectureIds.add(String(lecture.lectureId));
          await new Promise(r => setTimeout(r, 1500));
          await this.goToNext();
          continue;
        }
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

        const isDrmError = videoErr.message?.includes('SAMPLE-AES') || videoErr.message?.includes('Widevine DRM') || videoErr.message?.includes('bản quyền');
        if (isDrmError) {
          lecture.isDrmProtected = true;
          lecture.hasNonDrmFallback = false;

          if (currentSettings.autoRecordDrm) {
            console.log('[AutoBatch] Phát hiện luồng DRM ở tầng HLS, tự động chuyển sang Engine 2 ghi luồng phát...');
            const speed = Number(currentSettings.drmSpeed) || 1.0;
            const mute = currentSettings.drmMuteSpeaker !== false;
            try {
              const recorded = await this.recordDrmLecture(lecture, {
                speed,
                muteSpeaker: mute,
                videoStatusEl,
                videoBarEl,
                captionStatusEl,
                promptBox
              });
              if (recorded === false) {
                this.processedLectureIds.add(String(lecture.lectureId));
                await new Promise(r => setTimeout(r, 1000));
                await this.goToNext();
                continue;
              }

              this.processedLectureIds.add(String(lecture.lectureId));
              this.completedCount++;
              this.updateOverallProgress();

              if (this.completedCount >= this.targetCount) {
                this.stop(true);
                break;
              }

              await this.checkPause();
              if (!this.isRunning) break;

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
              await this.goToNext();
              continue;
            } catch (recErr) {
              console.error('Lỗi ghi DRM fallback:', recErr);
              if (videoStatusEl) videoStatusEl.textContent = `⚠️ Lỗi ghi DRM: ${recErr.message} (Bỏ qua)`;
              this.processedLectureIds.add(String(lecture.lectureId));
              await new Promise(r => setTimeout(r, 1500));
              await this.goToNext();
              continue;
            }
          } else {
            // Tự động bỏ qua bài DRM khi autoRecordDrm tắt, KHÔNG làm kẹt chuỗi tải bằng alert!
            if (videoStatusEl) videoStatusEl.textContent = 'Bài này khóa DRM SAMPLE-AES (Đã tự động bỏ qua)...';
            this.processedLectureIds.add(String(lecture.lectureId));
            await new Promise(r => setTimeout(r, 1500));
            await this.goToNext();
            continue;
          }
        }

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

  async recordDrmLecture(lecture, { speed = 1.0, muteSpeaker = true, videoStatusEl, videoBarEl, captionStatusEl, promptBox }) {
    const tab = targetUdemyTab || await getActiveUdemyTab();
    if (!tab?.id) {
      throw new Error('Không tìm thấy tab Udemy để ghi luồng phát.');
    }

    const cleaned = cleanLectureTitle(lecture.lectureTitle);
    const displayIndex = lecture.lectureIndex || cleaned.index || 1;
    const displayTitle = `${padIndex(displayIndex)} - ${cleaned.title}`;

    if (videoStatusEl) videoStatusEl.textContent = `🎬 Đang khởi động ghi Engine 2.0 (${speed}x, ${muteSpeaker ? 'Tắt loa' : 'Có tiếng'})...`;
    if (videoBarEl) videoBarEl.style.width = '0%';

    // Kích hoạt Cinema Mode trên tab Udemy để video tràn toàn màn hình
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'ENABLE_CINEMA_MODE_FOR_RECORDING' }).catch(() => {});
    }

    this.tabRecorder = new TabRecorder();

    const onUpdateCallback = ({ elapsedSec, totalMb }) => {
      const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const s = String(elapsedSec % 60).padStart(2, '0');
      if (videoStatusEl) {
        videoStatusEl.textContent = `🔴 Đang ghi (${speed}x): ${m}:${s} (${totalMb.toFixed(1)} MB)`;
      }
      if (lecture.duration > 0 && videoBarEl) {
        const effectiveDuration = lecture.duration / speed;
        const pct = Math.min(99, Math.round((elapsedSec / effectiveDuration) * 100));
        videoBarEl.style.width = `${pct}%`;
      }
    };

    // 1. Khởi động TabRecorder
    let recordingStarted = false;
    this.tabRecorder.onTrackEnded = () => {
      // Tự động hoàn tất khi người dùng bấm "Dừng chia sẻ" trên thanh thông báo gốc của Chrome
      isFinished = true;
    };

    try {
      await this.tabRecorder.startRecording({
        targetTabId: tab.id,
        muteSpeaker,
        onUpdate: onUpdateCallback
      });
      recordingStarted = true;
    } catch (captureErr) {
      console.warn('[AutoBatch] Yêu cầu tương tác người dùng để chia sẻ tab:', captureErr);
      const drmPromptBox = document.getElementById('batch-drm-prompt');
      if (drmPromptBox) {
        drmPromptBox.classList.remove('hidden');
        if (videoStatusEl) videoStatusEl.textContent = '🔒 Bài này khóa DRM. Vui lòng bấm "Bắt đầu ghi" bên dưới...';

        const userAccepted = await new Promise(resolve => {
          this.drmPromptResolver = resolve;
        });
        drmPromptBox.classList.add('hidden');

        if (!userAccepted || !this.isRunning) {
          if (videoStatusEl) videoStatusEl.textContent = '⏭️ Đã bỏ qua bài DRM';
          if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { type: 'DISABLE_CINEMA_MODE_FOR_RECORDING' }).catch(() => {});
          }
          return false;
        }

        try {
          await this.tabRecorder.startRecording({
            targetTabId: tab.id,
            muteSpeaker,
            onUpdate: onUpdateCallback
          });
          recordingStarted = true;
        } catch (retryErr) {
          console.warn('[AutoBatch] Không thể kích hoạt chia sẻ tab sau khi người dùng xác nhận:', retryErr);
          if (videoStatusEl) videoStatusEl.textContent = '⏭️ Đã bỏ qua bài DRM (chưa cấp quyền chia sẻ tab)';
          if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { type: 'DISABLE_CINEMA_MODE_FOR_RECORDING' }).catch(() => {});
          }
          return false;
        }
      } else {
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'DISABLE_CINEMA_MODE_FOR_RECORDING' }).catch(() => {});
        }
        throw captureErr;
      }
    }

    if (!recordingStarted) {
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'DISABLE_CINEMA_MODE_FOR_RECORDING' }).catch(() => {});
      }
      return false;
    }

    // 2. Gửi thông điệp điều khiển phát video từ đầu trên tab
    await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'PLAY_VIDEO_FOR_RECORDING',
        playbackSpeed: speed,
        startFromBeginning: true
      }, (res) => {
        resolve(res);
      });
    });

    // 3. Giám sát phát video
    const pollInterval = 1000;
    let isFinished = false;
    let lastTime = 0;
    let stalledCount = 0;

    while (this.isRunning && !isFinished) {
      await this.checkPause();
      if (!this.isRunning) break;

      await new Promise(r => setTimeout(r, pollInterval));
      if (!this.isRunning) break;

      const state = await new Promise(resolve => {
        chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_PLAYBACK_STATE' }, (r) => {
          resolve(r || null);
        });
      });

      if (state) {
        if (state.ended) {
          isFinished = true;
          break;
        }
        if (state.duration > 0 && state.currentTime >= (state.duration - 1)) {
          isFinished = true;
          break;
        }
        if (state.currentTime === lastTime && !state.paused) {
          stalledCount++;
          if (stalledCount > 15) {
            console.warn('[AutoBatch DRM] Video dừng tiến triển sau 15s, hoàn tất ghi.');
            isFinished = true;
            break;
          }
        } else {
          stalledCount = 0;
          lastTime = state.currentTime;
        }
      }
    }

    // 4. Tạm dừng video, tắt Cinema Mode và dừng ghi
    chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_VIDEO_FOR_RECORDING' }).catch(() => {});
    chrome.tabs.sendMessage(tab.id, { type: 'DISABLE_CINEMA_MODE_FOR_RECORDING' }).catch(() => {});
    if (videoStatusEl) videoStatusEl.textContent = 'Đang hoàn tất và đóng gói video...';

    const recordResult = await this.tabRecorder.stopRecording();
    this.tabRecorder = null;

    if (!this.isRunning) return;

    if (videoBarEl) videoBarEl.style.width = '100%';

    // 5. Lưu video đã ghi
    const streamInfo = {
      label: '1080',
      resolution: 1080,
      type: recordResult.blob.type || 'video/mp4'
    };
    await saveVideoBlobDirectly(recordResult.blob, lecture, streamInfo, currentSettings, activeFsHandle);
    if (videoStatusEl) videoStatusEl.textContent = `✅ Xong DRM (${(recordResult.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`;

    // 6. Tải phụ đề Tiếng Anh (nếu có)
    const enCap = findEnglishCaption(lecture.captions);
    if (!enCap) {
      if (captionStatusEl) captionStatusEl.textContent = '⚠️ Không có phụ đề Tiếng Anh';
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
      // Chờ 1.2s xem router SPA của Udemy đã tự chuyển URL chưa; chỉ cập nhật tabs nếu router chưa kích hoạt
      await new Promise(r => setTimeout(r, 1200));
      const updatedTab = await chrome.tabs.get(tab.id).catch(() => null);
      if (updatedTab?.url && res.nextId && !updatedTab.url.includes(res.nextId)) {
        const fullUrl = res.nextUrl.startsWith('http') ? res.nextUrl : `https://www.udemy.com${res.nextUrl}`;
        try {
          await chrome.tabs.update(tab.id, { url: fullUrl });
        } catch (e) {}
      }
    } else if (!res?.success) {
      alert(res?.error || 'Không tìm thấy bài giảng tiếp theo hoặc đã tới bài cuối cùng của khóa học!');
      this.stop(true);
      return;
    }

    await new Promise(r => setTimeout(r, 1000));
  }
};

