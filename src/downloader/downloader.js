/**
 * Downloader Window Logic
 * Nhận lệnh tải luồng HLS, điều phối downloadHlsVideo và lưu file vào thư mục cấu hình.
 */

import { downloadHlsVideo } from '../utils/hlsDownloader.js';
import { cleanLectureTitle, sanitizeName, padIndex, buildDownloadPath } from '../utils/sanitizer.js';
import { getSettings, getDirectoryHandle } from '../utils/storage.js';

let abortController = new AbortController();

document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const playlistUrl = urlParams.get('playlistUrl');
  const courseTitle = urlParams.get('courseTitle') || 'Udemy Course';
  const rawLectureTitle = urlParams.get('lectureTitle') || 'Lecture';
  const lectureIndexParam = parseInt(urlParams.get('lectureIndex') || '1', 10);
  const quality = urlParams.get('quality') || '1080p';

  // Làm sạch tiêu đề và trích xuất số bài chuẩn
  const cleanedMeta = cleanLectureTitle(rawLectureTitle);
  const finalIndex = cleanedMeta.index || lectureIndexParam;
  const cleanTitle = cleanedMeta.title;

  // Cập nhật thông tin UI
  document.getElementById('course-name').textContent = courseTitle;
  document.getElementById('lecture-name').textContent = `${padIndex(finalIndex)} - ${cleanTitle}`;
  document.getElementById('quality-badge').textContent = `${quality} HD`;

  const btnCancel = document.getElementById('btn-cancel');
  const btnClose = document.getElementById('btn-close');

  btnCancel.addEventListener('click', () => {
    if (confirm('Bạn có chắc chắn muốn dừng tải video này?')) {
      abortController.abort();
      window.close();
    }
  });

  btnClose.addEventListener('click', () => {
    window.close();
  });

  if (!playlistUrl) {
    updateStatus('Lỗi: Không tìm thấy đường dẫn phát HLS.', 'error');
    return;
  }

  try {
    await startHlsDownloadProcess({
      playlistUrl,
      courseTitle,
      lectureTitle: cleanTitle,
      lectureIndex: finalIndex,
      quality
    });
  } catch (err) {
    if (err.name === 'AbortError' || err.message?.includes('hủy')) {
      updateStatus('Đã hủy tiến trình tải.', 'error');
    } else {
      console.error('Lỗi khi tải video HLS:', err);
      updateStatus(`Lỗi tải: ${err.message}`, 'error');
    }
  }
});

/**
 * Điều phối toàn bộ quá trình tải, ghép và lưu file
 */
async function startHlsDownloadProcess(meta) {
  const settings = await getSettings();
  const fsHandle = await getDirectoryHandle();

  // Gọi bộ tải đa luồng
  const result = await downloadHlsVideo({
    playlistUrl: meta.playlistUrl,
    concurrency: 6,
    signal: abortController.signal,
    onProgress: (info) => {
      handleProgressUpdate(info);
    }
  });

  updateStatus('Đang hoàn thiện lưu file vào thư mục...', 'info');

  const cleanCourse = sanitizeName(meta.courseTitle, 'Udemy Course');
  const cleanTitle = sanitizeName(meta.lectureTitle, 'Lesson');
  const indexStr = padIndex(meta.lectureIndex);
  // Tên file chuẩn: "[Index] - [Tên bài].mp4" (không gắn tag [1080p])
  const fileName = `${indexStr} - ${cleanTitle}.mp4`;

  // 1. Chế độ lưu vào Thư mục Ổ đĩa tùy chọn (File System Access API)
  if (settings.downloadMode === 'filesystem' && fsHandle) {
    try {
      const perm = await fsHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await saveBlobToFileSystem(fsHandle, cleanCourse, fileName, result.blob);
        showCompletion(fileName, `Đã ghi thành công vào thư mục: ${fsHandle.name}/${cleanCourse}`);
        return;
      }
    } catch (fsErr) {
      console.warn('Kiểm tra quyền ghi File System:', fsErr);
    }

    // Nếu chưa có quyền 'granted' (do Chromium yêu cầu transient user activation):
    // Hiển thị nút bấm để người dùng click 1 chạm cấp quyền lưu trực tiếp vào thư mục đã chọn
    promptFsSave({
      fsHandle,
      cleanCourse,
      fileName,
      blob: result.blob,
      settings,
      meta
    });
    return;
  }

  // 2. Chế độ lưu vào Thư mục Downloads chuẩn (chrome.downloads)
  await saveViaDownloadsApi(result.blob, meta, settings, fileName, cleanCourse);
}

function promptFsSave({ fsHandle, cleanCourse, fileName, blob, settings, meta }) {
  const permBox = document.getElementById('fs-permission-box');
  const targetNameEl = document.getElementById('fs-target-name');
  const btnGrant = document.getElementById('btn-grant-save');
  const btnFallback = document.getElementById('btn-fallback-download');

  targetNameEl.textContent = `${fsHandle.name}/${cleanCourse}`;
  permBox.classList.remove('hidden');

  updateStatus('Đã ghép xong video! Bấm nút bên dưới để hoàn tất lưu vào ổ đĩa.', 'info');

  btnGrant.onclick = async () => {
    btnGrant.disabled = true;
    btnGrant.textContent = 'Đang lưu file vào ổ đĩa...';
    try {
      let perm = await fsHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        perm = await fsHandle.requestPermission({ mode: 'readwrite' });
      }
      if (perm === 'granted') {
        await saveBlobToFileSystem(fsHandle, cleanCourse, fileName, blob);
        permBox.classList.add('hidden');
        showCompletion(fileName, `Đã ghi thành công vào thư mục: ${fsHandle.name}/${cleanCourse}`);
        return;
      } else {
        alert('Trình duyệt chưa được cấp quyền ghi vào thư mục này.');
      }
    } catch (e) {
      console.error('Lỗi khi ghi file vào ổ đĩa:', e);
      alert('Không thể ghi file vào thư mục: ' + e.message);
    }
    btnGrant.disabled = false;
    btnGrant.textContent = `💾 Thử lại lưu vào thư mục ${fsHandle.name}`;
  };

  btnFallback.onclick = async () => {
    permBox.classList.add('hidden');
    await saveViaDownloadsApi(blob, meta, settings, fileName, cleanCourse);
  };
}

async function saveBlobToFileSystem(fsHandle, courseDirName, fileName, blob) {
  const courseFolder = await fsHandle.getDirectoryHandle(courseDirName, { create: true });
  const fileHandle = await courseFolder.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function saveViaDownloadsApi(blob, meta, settings, fileName, cleanCourse) {
  updateStatus('Đang lưu qua trình quản lý tải xuống...', 'info');
  const blobUrl = URL.createObjectURL(blob);
  const relativePath = buildDownloadPath({
    baseFolder: settings.customFolder,
    courseTitle: meta.courseTitle,
    lectureIndex: meta.lectureIndex,
    lectureTitle: meta.lectureTitle,
    extension: 'mp4'
  });

  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: blobUrl,
        filename: relativePath,
        saveAs: Boolean(settings.promptSaveAs),
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(downloadId);
      }
    );
  });

  showCompletion(fileName, `Đã lưu vào Downloads/${settings.customFolder}/${cleanCourse}`);
}

function handleProgressUpdate(info) {
  const percentEl = document.getElementById('percent-number');
  const barEl = document.getElementById('progress-bar-fill');
  const statusEl = document.getElementById('status-message');

  const metricSegments = document.getElementById('metric-segments');
  const metricSpeed = document.getElementById('metric-speed');
  const metricSize = document.getElementById('metric-size');
  const speedBadge = document.getElementById('speed-badge');
  const sizeBadge = document.getElementById('size-badge');

  if (info.percent !== undefined) {
    percentEl.textContent = `${info.percent}%`;
    barEl.style.width = `${info.percent}%`;
  }

  if (info.message) {
    statusEl.textContent = info.message;
  }

  if (info.current !== undefined && info.total) {
    metricSegments.textContent = `${info.current} / ${info.total}`;
  }

  if (info.speedMbps) {
    metricSpeed.textContent = `${info.speedMbps} Mbps`;
    speedBadge.textContent = `${info.speedMbps} Mbps`;
  }

  if (info.totalMb) {
    metricSize.textContent = `${info.totalMb} MB`;
    sizeBadge.textContent = `${info.totalMb} MB`;
  }
}

function updateStatus(text, type = 'info') {
  const statusEl = document.getElementById('status-message');
  statusEl.textContent = text;
  if (type === 'error') {
    statusEl.style.color = '#fca5a5';
  }
}

function showCompletion(fileName, desc) {
  document.getElementById('finish-box').classList.remove('hidden');
  document.getElementById('finish-desc').textContent = `${desc} (${fileName})`;

  document.getElementById('btn-cancel').classList.add('hidden');
  document.getElementById('btn-close').classList.remove('hidden');

  document.getElementById('percent-number').textContent = '100%';
  document.getElementById('progress-bar-fill').style.width = '100%';
  document.getElementById('status-message').textContent = 'Tải hoàn tất!';
}
