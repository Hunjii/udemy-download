/**
 * Popup Script (Dual-Engine Mode)
 * Tự động kích hoạt content script qua chrome.scripting, làm sạch tên bài giảng, tối ưu 1-click tải phụ đề Tiếng Anh.
 */

import { convertVttToSrt } from '../utils/vtt2srt.js';
import { cleanLectureTitle, sanitizeName, padIndex } from '../utils/sanitizer.js';
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

document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  await loadAndBindSettings();
  await detectCurrentLecture();
  initEngine2Controls();
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

  inputCustomFolder.value = currentSettings.customFolder || 'Udemy Courses';
  togglePromptSave.checked = Boolean(currentSettings.promptSaveAs);

  if (currentSettings.downloadMode === 'filesystem') {
    modeFsRadio.checked = true;
  } else {
    modeBrowserRadio.checked = true;
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
      downloadMode: modeFsRadio.checked ? 'filesystem' : 'browser'
    };

    if (updated.downloadMode === 'filesystem' && !activeFsHandle) {
      alert('Bạn chưa chọn thư mục trên máy. Hệ thống chuyển về chế độ Downloads.');
      updated.downloadMode = 'browser';
      modeBrowserRadio.checked = true;
    }

    await saveSettings(updated);
    currentSettings = updated;

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
// 3. Nhận diện bài giảng đang xem
// ============================================================================
async function detectCurrentLecture() {
  const loadingState = document.getElementById('loading-state');
  const notUdemyState = document.getElementById('not-udemy-state');
  const drmWarningState = document.getElementById('drm-warning-state');

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab || !activeTab.url || !activeTab.url.includes('udemy.com')) {
    loadingState.classList.add('hidden');
    notUdemyState.classList.remove('hidden');
    return;
  }

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

  // 1. Thử lấy từ Background cache
  try {
    const bgResponse = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_LECTURE_DATA', tabId: activeTab.id }, resolve);
    });

    if (bgResponse && bgResponse.success && bgResponse.data) {
      renderLecture(bgResponse.data);
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
  const finalIndex = cleanedMeta.index || data.lectureIndex || 1;
  const finalTitle = cleanedMeta.title;

  document.getElementById('course-title').textContent = data.courseTitle || 'Udemy Course';
  document.getElementById('lecture-title').textContent = finalTitle;
  document.getElementById('lecture-index-tag').textContent = `Bài ${padIndex(finalIndex)}`;

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

/**
 * Tự động tìm và chỉ hiển thị tùy chọn tải phụ đề Tiếng Anh (loại bỏ danh sách rối mắt)
 */
function findEnglishCaption(captions) {
  if (!captions || !captions.length) return null;

  // 1. Ưu tiên bản English chuẩn do người tạo (manual, không có nhãn auto / tự động)
  const manualEn = captions.find(c => {
    const loc = (c.locale || '').toLowerCase();
    const lbl = (c.label || '').toLowerCase();
    const isEn = loc === 'en' || loc === 'en_us' || loc === 'en-us' || loc === 'en_gb' || loc === 'en-gb' || lbl.includes('english') || lbl === 'en';
    const isAuto = lbl.includes('auto') || lbl.includes('tự động');
    return isEn && !isAuto;
  });
  if (manualEn) return manualEn;

  // 2. Ưu tiên bản English [Auto]
  const autoEn = captions.find(c => {
    const loc = (c.locale || '').toLowerCase();
    const lbl = (c.label || '').toLowerCase();
    return loc === 'en' || loc === 'en_us' || loc === 'en-us' || loc === 'en_gb' || loc === 'en-gb' || lbl.includes('english') || lbl.includes('tiếng anh') || lbl === 'en';
  });
  if (autoEn) return autoEn;

  // 3. Không fallback sang thứ tiếng khác nếu không có Tiếng Anh
  return null;
}

function renderEnglishCaption(captions) {
  const statusText = document.getElementById('caption-status-text');
  const subText = document.getElementById('caption-sub-text');
  const btnDownloadCaption = document.getElementById('btn-download-caption');

  const enCap = findEnglishCaption(captions);

  if (!enCap) {
    statusText.textContent = 'Không có phụ đề Tiếng Anh';
    statusText.style.color = 'var(--text-muted)';
    subText.textContent = 'Bài giảng này không có phụ đề Tiếng Anh';
    btnDownloadCaption.disabled = true;
    return;
  }

  statusText.textContent = `Sẵn sàng: ${enCap.label}`;
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
  const finalIndex = cleanedMeta.index || currentLecture.lectureIndex || 1;
  const finalTitle = cleanedMeta.title;

  chrome.runtime.sendMessage({
    type: 'OPEN_DOWNLOADER_WINDOW',
    payload: {
      playlistUrl: stream.file,
      courseTitle: currentLecture.courseTitle,
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
    const finalIndex = cleanedMeta.index || currentLecture.lectureIndex || 1;
    const finalTitle = cleanedMeta.title;
    // Tên file phụ đề khớp 100% tên file video
    const fileName = `${padIndex(finalIndex)} - ${sanitizeName(finalTitle, 'Lesson')}.srt`;

    // 2. Thử lưu vào Thư mục Ổ đĩa nếu đã có quyền
    if (hasFsPermission && activeFsHandle) {
      try {
        const cleanCourse = sanitizeName(currentLecture.courseTitle, 'Udemy Course');
        const courseFolder = await activeFsHandle.getDirectoryHandle(cleanCourse, { create: true });
        const fileHandle = await courseFolder.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(srtText);
        await writable.close();

        showStatusBanner(`Đã lưu phụ đề vào thư mục: ${activeFsHandle.name}/${cleanCourse}/${fileName}`, 'success');
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
