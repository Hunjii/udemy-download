/**
 * Downloader Window Logic
 * Hỗ trợ 2 chế độ:
 * 1. Single Mode: Tải 1 bài giảng trực tiếp.
 * 2. Batch Mode: Điều phối tải tự động hàng loạt N bài qua Headless API Queue.
 */

import { downloadHlsVideo, downloadDirectVideo } from '../utils/hlsDownloader.js';
import { cleanLectureTitle, sanitizeName, padIndex, buildDownloadPath, findEnglishCaption } from '../utils/sanitizer.js';
import { getSettings, getDirectoryHandle } from '../utils/storage.js';
import { fetchCourseCurriculum, getBatchLectureList, fetchLectureMediaData, downloadCaptionAsSrt } from '../utils/udemyApi.js';

let abortController = new AbortController();

document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const mode = urlParams.get('mode');

  const btnCancel = document.getElementById('btn-cancel');
  const btnClose = document.getElementById('btn-close');

  btnClose.addEventListener('click', () => {
    window.close();
  });

  // --------------------------------------------------------------------------
  // Chế độ 1: BATCH QUEUE MODE (Hàng đợi API tải tự động)
  // --------------------------------------------------------------------------
  if (mode === 'batch') {
    const courseId = urlParams.get('courseId');
    const startLectureId = urlParams.get('startLectureId');
    const count = parseInt(urlParams.get('count') || '5', 10);
    const courseTitle = urlParams.get('courseTitle') || 'Udemy Course';
    const tabId = urlParams.get('tabId') ? parseInt(urlParams.get('tabId'), 10) : null;

    btnCancel.addEventListener('click', () => {
      if (confirm('Bạn có chắc chắn muốn hủy chuỗi tự động tải?')) {
        abortController.abort();
        updateStatus('Đã hủy chuỗi tải theo yêu cầu.', 'error');
        btnCancel.classList.add('hidden');
        btnClose.classList.remove('hidden');
      }
    });

    try {
      await startBatchQueueProcess({ courseId, startLectureId, count, courseTitle, tabId });
    } catch (err) {
      if (err.name === 'AbortError' || err.message?.includes('hủy')) {
        updateStatus('Đã hủy chuỗi tự động tải.', 'error');
      } else {
        console.error('Lỗi hàng đợi batch:', err);
        updateStatus(`Lỗi chuỗi tải: ${err.message}`, 'error');
      }
      btnCancel.classList.add('hidden');
      btnClose.classList.remove('hidden');
    }
    return;
  }

  // --------------------------------------------------------------------------
  // Chế độ 2: SINGLE DOWNLOAD MODE (Tải 1 bài đơn lẻ)
  // --------------------------------------------------------------------------
  const playlistUrl = urlParams.get('playlistUrl');
  const courseTitle = urlParams.get('courseTitle') || 'Udemy Course';
  const sectionTitle = urlParams.get('sectionTitle') || '';
  const rawLectureTitle = urlParams.get('lectureTitle') || 'Lecture';
  const lectureIndexParam = parseInt(urlParams.get('lectureIndex') || '1', 10);
  const quality = urlParams.get('quality') || '1080p';
  const streamType = urlParams.get('streamType') || 'hls';

  const cleanedMeta = cleanLectureTitle(rawLectureTitle);
  const finalIndex = cleanedMeta.index || lectureIndexParam;
  const cleanTitle = cleanedMeta.title;

  document.getElementById('course-name').textContent = sectionTitle ? `${courseTitle} • ${sectionTitle}` : courseTitle;
  document.getElementById('lecture-name').textContent = `${padIndex(finalIndex)} - ${cleanTitle}`;
  document.getElementById('quality-badge').textContent = `${quality} HD`;

  btnCancel.addEventListener('click', () => {
    if (confirm('Bạn có chắc chắn muốn dừng tải video này?')) {
      abortController.abort();
      window.close();
    }
  });

  if (!playlistUrl) {
    updateStatus('Lỗi: Không tìm thấy đường dẫn phát video.', 'error');
    return;
  }

  try {
    await startHlsDownloadProcess({
      playlistUrl,
      courseTitle,
      sectionTitle,
      lectureTitle: cleanTitle,
      lectureIndex: finalIndex,
      quality,
      streamType
    });
  } catch (err) {
    if (err.name === 'AbortError' || err.message?.includes('hủy')) {
      updateStatus('Đã hủy tiến trình tải.', 'error');
    } else {
      console.error('Lỗi khi tải video:', err);
      updateStatus(`Lỗi tải: ${err.message}`, 'error');
    }
  }
});

// ============================================================================
// BATCH QUEUE PROCESSOR
// ============================================================================
async function startBatchQueueProcess({ courseId, startLectureId, count, courseTitle, tabId }) {
  const batchOverallSection = document.getElementById('batch-overall-section');
  const batchQueueSection = document.getElementById('batch-queue-section');
  const btnPause = document.getElementById('btn-pause-batch');
  const btnCancel = document.getElementById('btn-cancel');
  const btnClose = document.getElementById('btn-close');

  const batchCounterBadge = document.getElementById('batch-counter-badge');
  const batchOverallFill = document.getElementById('batch-overall-fill');
  const batchCompletedCountEl = document.getElementById('batch-completed-count');
  const batchSubCountEl = document.getElementById('batch-sub-count');
  const batchQueueTotalEl = document.getElementById('batch-queue-total');
  const batchQueueListEl = document.getElementById('batch-queue-list');

  // Modals & prompts
  const subPromptModal = document.getElementById('batch-sub-prompt-modal');
  const btnPromptSkipSub = document.getElementById('btn-prompt-skip-sub');
  const btnPromptAbortSub = document.getElementById('btn-prompt-abort-sub');

  const errPromptModal = document.getElementById('batch-error-prompt-modal');
  const promptErrDesc = document.getElementById('prompt-err-desc');
  const btnPromptRetry = document.getElementById('btn-prompt-retry');
  const btnPromptSkipErr = document.getElementById('btn-prompt-skip-err');
  const btnPromptAbortErr = document.getElementById('btn-prompt-abort-err');

  batchOverallSection?.classList.remove('hidden');
  batchQueueSection?.classList.remove('hidden');
  btnPause?.classList.remove('hidden');

  let isPaused = false;
  let pauseResolver = null;
  let userDecisionResolver = null;
  let completedCount = 0;
  let subCount = 0;

  btnPause?.addEventListener('click', () => {
    if (isPaused) {
      isPaused = false;
      btnPause.textContent = '⏸️ Tạm dừng';
      if (pauseResolver) {
        pauseResolver();
        pauseResolver = null;
      }
      updateStatus('Tiếp tục tải...', 'info');
    } else {
      isPaused = true;
      btnPause.textContent = '▶️ Tiếp tục';
      updateStatus('Hàng đợi đã tạm dừng.', 'info');
    }
  });

  const checkPause = async () => {
    if (!isPaused) return;
    await new Promise((resolve) => {
      pauseResolver = resolve;
    });
  };

  btnPromptSkipSub?.addEventListener('click', () => {
    subPromptModal.classList.add('hidden');
    if (userDecisionResolver) {
      userDecisionResolver('skip');
      userDecisionResolver = null;
    }
  });

  btnPromptAbortSub?.addEventListener('click', () => {
    subPromptModal.classList.add('hidden');
    if (userDecisionResolver) {
      userDecisionResolver('abort');
      userDecisionResolver = null;
    }
  });

  btnPromptRetry?.addEventListener('click', () => {
    errPromptModal.classList.add('hidden');
    if (userDecisionResolver) {
      userDecisionResolver('retry');
      userDecisionResolver = null;
    }
  });

  btnPromptSkipErr?.addEventListener('click', () => {
    errPromptModal.classList.add('hidden');
    if (userDecisionResolver) {
      userDecisionResolver('skip');
      userDecisionResolver = null;
    }
  });

  btnPromptAbortErr?.addEventListener('click', () => {
    errPromptModal.classList.add('hidden');
    if (userDecisionResolver) {
      userDecisionResolver('abort');
      userDecisionResolver = null;
    }
  });

  // Kiểm tra quyền lưu File System ngay từ đầu
  const settings = await getSettings();
  const fsHandle = await getDirectoryHandle();

  if (settings.downloadMode === 'filesystem' && fsHandle) {
    try {
      let perm = await fsHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        const permBox = document.getElementById('fs-permission-box');
        const targetNameEl = document.getElementById('fs-target-name');
        const btnGrant = document.getElementById('btn-grant-save');
        const btnFallback = document.getElementById('btn-fallback-download');

        targetNameEl.textContent = fsHandle.name;
        permBox.classList.remove('hidden');
        updateStatus('Vui lòng cấp quyền ghi thư mục để chuỗi tải tự động không bị gián đoạn.', 'info');

        await new Promise((resolve) => {
          btnGrant.onclick = async () => {
            try {
              perm = await fsHandle.requestPermission({ mode: 'readwrite' });
            } catch (e) {}
            permBox.classList.add('hidden');
            resolve();
          };
          btnFallback.onclick = () => {
            settings.downloadMode = 'browser';
            permBox.classList.add('hidden');
            resolve();
          };
        });
      }
    } catch (e) {
      console.warn('Lỗi kiểm tra quyền thư mục ban đầu:', e);
    }
  }

  updateStatus('Đang nạp danh mục bài học từ Udemy API...', 'info');

  // Lấy danh mục qua Udemy API
  let curriculum = [];
  try {
    curriculum = await fetchCourseCurriculum(courseId, tabId);
  } catch (apiErr) {
    console.error('Lỗi fetchCourseCurriculum:', apiErr);
    updateStatus(`Không thể nạp danh mục: ${apiErr.message}`, 'error');
    return;
  }

  const batchLectures = getBatchLectureList(curriculum, startLectureId, count);
  if (!batchLectures || batchLectures.length === 0) {
    updateStatus('Không tìm thấy bài giảng nào trong đợt tải này.', 'error');
    return;
  }

  const totalCount = batchLectures.length;
  if (batchQueueTotalEl) batchQueueTotalEl.textContent = `${totalCount} bài`;

  // Render danh sách queue
  batchQueueListEl.innerHTML = '';
  const itemElements = new Map();

  batchLectures.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.id = `queue-item-${item.id}`;

    const cleaned = cleanLectureTitle(item.title);
    const displayIndex = padIndex(item.index || idx + 1);

    row.innerHTML = `
      <div class="queue-item-left">
        <span class="queue-index">#${displayIndex}</span>
        <div class="queue-item-info">
          <span class="queue-title">${cleaned.title}</span>
          <span class="queue-chapter">${item.chapter ? item.chapter.title : (courseTitle || 'Khóa học')}</span>
        </div>
      </div>
      <span class="queue-badge waiting">Chờ tải</span>
    `;

    batchQueueListEl.appendChild(row);
    itemElements.set(item.id, row);
  });

  const updateOverall = (currentIdx) => {
    if (batchCounterBadge) {
      batchCounterBadge.textContent = `Bài ${Math.min(currentIdx + 1, totalCount)} / ${totalCount}`;
    }
    const pct = Math.min(100, Math.round((completedCount / totalCount) * 100));
    if (batchOverallFill) {
      batchOverallFill.style.width = `${pct}%`;
    }
    if (batchCompletedCountEl) {
      batchCompletedCountEl.textContent = `Đã hoàn tất: ${completedCount} / ${totalCount} bài`;
    }
    if (batchSubCountEl) {
      batchSubCountEl.textContent = `Phụ đề EN: ${subCount}`;
    }
  };

  updateOverall(0);

  // Vòng lặp tải từng bài trong Queue
  for (let i = 0; i < batchLectures.length; i++) {
    if (abortController.signal.aborted) break;
    await checkPause();
    if (abortController.signal.aborted) break;

    const item = batchLectures[i];
    const rowEl = itemElements.get(item.id);
    const badgeEl = rowEl?.querySelector('.queue-badge');

    // Cập nhật UI Active
    if (rowEl) {
      rowEl.classList.add('active');
      rowEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (badgeEl) {
      badgeEl.className = 'queue-badge active';
      badgeEl.textContent = 'Đang tải';
    }

    const cleaned = cleanLectureTitle(item.title);
    const displayIndex = item.index || (i + 1);
    const finalTitle = cleaned.title;
    const sectionName = item.chapter ? item.chapter.title : '';

    document.getElementById('course-name').textContent = sectionName ? `${courseTitle} • ${sectionName}` : courseTitle;
    document.getElementById('lecture-name').textContent = `${padIndex(displayIndex)} - ${finalTitle}`;
    updateOverall(i);
    updateStatus(`Đang lấy dữ liệu bài ${i + 1}/${totalCount}...`, 'info');

    // 1. Lấy Media Data
    let mediaData = null;
    let fetchMediaAttempts = 0;
    while (!mediaData && fetchMediaAttempts < 3 && !abortController.signal.aborted) {
      try {
        fetchMediaAttempts++;
        mediaData = await fetchLectureMediaData(courseId, item.id, tabId);
      } catch (err) {
        if (fetchMediaAttempts < 3) {
          await new Promise((r) => setTimeout(r, 1500 * fetchMediaAttempts));
        } else {
          console.warn(`Không thể lấy media bài ${item.id}:`, err);
        }
      }
    }

    if (!mediaData) {
      if (rowEl) {
        rowEl.classList.remove('active');
        rowEl.classList.add('error');
      }
      if (badgeEl) {
        badgeEl.className = 'queue-badge error';
        badgeEl.textContent = 'Lỗi nạp API';
      }
      continue;
    }

    // Bỏ qua nếu DRM
    if (mediaData.isDrmProtected) {
      if (rowEl) {
        rowEl.classList.remove('active');
        rowEl.classList.add('skipped');
      }
      if (badgeEl) {
        badgeEl.className = 'queue-badge skipped';
        badgeEl.textContent = 'Khóa DRM';
      }
      updateStatus('Bài này bị khóa bản quyền DRM (Bỏ qua).', 'info');
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }

    await checkPause();
    if (abortController.signal.aborted) break;

    // 2. Tải Phụ đề Tiếng Anh
    const enCap = findEnglishCaption(mediaData.captions);

    if (!enCap) {
      updateStatus('Bài này không có phụ đề Tiếng Anh. Đang chờ lựa chọn...', 'warn');
      const promptTitle = document.getElementById('prompt-sub-title');
      if (promptTitle) promptTitle.textContent = `Không có phụ đề EN: ${padIndex(displayIndex)} - ${finalTitle}`;
      subPromptModal.classList.remove('hidden');

      const decision = await new Promise((resolve) => {
        userDecisionResolver = resolve;
      });

      if (decision === 'abort') {
        updateStatus('Đã hủy chuỗi tải theo yêu cầu người dùng.', 'error');
        abortController.abort();
        break;
      }
      updateStatus('Đã bỏ qua phụ đề, tiếp tục tải video...', 'info');
    } else {
      updateStatus('Đang tải phụ đề Tiếng Anh (.srt)...', 'info');
      try {
        const srtText = await downloadCaptionAsSrt(enCap.url, tabId);
        await saveSubtitleContent({
          srtText,
          courseTitle,
          sectionTitle: sectionName,
          lectureIndex: displayIndex,
          lectureTitle: finalTitle,
          settings,
          fsHandle
        });
        subCount++;
        updateOverall(i);
      } catch (subErr) {
        console.warn(`Lỗi tải phụ đề bài ${item.id}:`, subErr);
      }
    }

    await checkPause();
    if (abortController.signal.aborted) break;

    // 3. Tải Video với Retry 3 lần
    const bestStream = mediaData.bestQuality || mediaData.streams[0];
    if (!bestStream) {
      if (rowEl) {
        rowEl.classList.remove('active');
        rowEl.classList.add('error');
      }
      if (badgeEl) {
        badgeEl.className = 'queue-badge error';
        badgeEl.textContent = 'Không có stream';
      }
      continue;
    }

    document.getElementById('quality-badge').textContent = `${bestStream.label || '1080p'} HD`;
    const isDirectMp4 = bestStream.file.includes('.mp4') || bestStream.type === 'video/mp4';

    let videoResult = null;
    let videoAttempts = 0;

    while (!videoResult && videoAttempts < 3 && !abortController.signal.aborted) {
      videoAttempts++;
      try {
        updateStatus(`Đang tải video ${bestStream.label}p (Lần ${videoAttempts}/3)...`, 'info');
        videoResult = isDirectMp4
          ? await downloadDirectVideo({
              videoUrl: bestStream.file,
              signal: abortController.signal,
              onProgress: handleProgressUpdate
            })
          : await downloadHlsVideo({
              playlistUrl: bestStream.file,
              concurrency: 4,
              signal: abortController.signal,
              onProgress: handleProgressUpdate
            });
      } catch (vErr) {
        if (abortController.signal.aborted) break;
        console.warn(`Lỗi tải video bài ${item.id} lần ${videoAttempts}:`, vErr);

        if (videoAttempts < 3) {
          updateStatus(`Lỗi phân đoạn. Thử lại lần ${videoAttempts + 1}/3 sau 2s...`, 'warn');
          await new Promise((r) => setTimeout(r, 2000 * videoAttempts));
        } else {
          updateStatus('Lỗi sau 3 lần thử. Đang chờ lựa chọn...', 'error');
          if (promptErrDesc) {
            promptErrDesc.textContent = `Bài "${finalTitle}" gặp lỗi: ${vErr.message}`;
          }
          errPromptModal.classList.remove('hidden');

          const decision = await new Promise((resolve) => {
            userDecisionResolver = resolve;
          });

          if (decision === 'retry') {
            videoAttempts = 0;
          } else if (decision === 'skip') {
            break;
          } else {
            abortController.abort();
            break;
          }
        }
      }
    }

    if (abortController.signal.aborted) break;

    if (videoResult) {
      updateStatus('Đang lưu video vào thư mục...', 'info');
      await saveVideoResult({
        blob: videoResult.blob,
        courseTitle,
        sectionTitle: sectionName,
        lectureIndex: displayIndex,
        lectureTitle: finalTitle,
        settings,
        fsHandle
      });

      completedCount++;
      updateOverall(i);

      if (rowEl) {
        rowEl.classList.remove('active');
        rowEl.classList.add('done');
      }
      if (badgeEl) {
        badgeEl.className = 'queue-badge done';
        badgeEl.textContent = '✅ Đã tải';
      }
    } else {
      if (rowEl) {
        rowEl.classList.remove('active');
        rowEl.classList.add('error');
      }
      if (badgeEl) {
        badgeEl.className = 'queue-badge error';
        badgeEl.textContent = 'Lỗi video';
      }
    }

    // Cooldown nhỏ 1.5s giữa các bài
    if (i < batchLectures.length - 1 && !abortController.signal.aborted) {
      for (let s = 2; s > 0; s--) {
        await checkPause();
        if (abortController.signal.aborted) break;
        updateStatus(`Nghỉ ${s}s trước khi sang bài tiếp theo...`, 'info');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  // Kết thúc
  btnPause?.classList.add('hidden');
  btnCancel?.classList.add('hidden');
  btnClose?.classList.remove('hidden');

  const finishBox = document.getElementById('finish-box');
  const finishTitle = document.getElementById('finish-title');
  const finishDesc = document.getElementById('finish-desc');

  if (completedCount > 0) {
    finishBox?.classList.remove('hidden');
    if (finishTitle) finishTitle.textContent = `🎉 Hoàn tất đợt tải (${completedCount}/${totalCount} bài)!`;
    if (finishDesc) finishDesc.textContent = `Đã lưu thành công ${completedCount} video và ${subCount} phụ đề Tiếng Anh vào thư mục.`;
    updateStatus(`Hoàn thành đợt tải: ${completedCount}/${totalCount} bài.`, 'info');
  } else {
    updateStatus('Chuỗi tải đã kết thúc hoặc bị hủy.', 'info');
  }
}

// ============================================================================
// SINGLE HLS DOWNLOAD PROCESSOR
// ============================================================================
async function startHlsDownloadProcess(meta) {
  const settings = await getSettings();
  const fsHandle = await getDirectoryHandle();

  const isDirectMp4 = meta.playlistUrl.includes('.mp4') || meta.streamType === 'video/mp4';

  const result = isDirectMp4
    ? await downloadDirectVideo({
        videoUrl: meta.playlistUrl,
        signal: abortController.signal,
        onProgress: (info) => {
          handleProgressUpdate(info);
        }
      })
    : await downloadHlsVideo({
        playlistUrl: meta.playlistUrl,
        concurrency: 5,
        signal: abortController.signal,
        onProgress: (info) => {
          handleProgressUpdate(info);
        }
      });

  updateStatus('Đang hoàn thiện lưu file vào thư mục...', 'info');

  const cleanCourse = sanitizeName(meta.courseTitle, 'Udemy Course');
  const cleanSection = sanitizeName(meta.sectionTitle, '');
  const cleanTitle = sanitizeName(meta.lectureTitle, 'Lesson');
  const indexStr = padIndex(meta.lectureIndex);
  const fileName = `${indexStr} - ${cleanTitle}.mp4`;
  const folderDisplay = cleanSection ? `${cleanCourse}/${cleanSection}` : cleanCourse;

  // 1. Chế độ lưu vào Thư mục Ổ đĩa tùy chọn (File System Access API)
  if (settings.downloadMode === 'filesystem' && fsHandle) {
    try {
      const perm = await fsHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await saveBlobToFileSystem(fsHandle, cleanCourse, cleanSection, fileName, result.blob);
        showCompletion(fileName, `Đã ghi thành công vào thư mục: ${fsHandle.name}/${folderDisplay}`);
        return;
      }
    } catch (fsErr) {
      console.warn('Kiểm tra quyền ghi File System:', fsErr);
    }

    promptFsSave({
      fsHandle,
      cleanCourse,
      cleanSection,
      folderDisplay,
      fileName,
      blob: result.blob,
      settings,
      meta
    });
    return;
  }

  // 2. Chế độ lưu vào Thư mục Downloads chuẩn (chrome.downloads)
  await saveViaDownloadsApi(result.blob, meta, settings, fileName, folderDisplay);
}

// ============================================================================
// FILE SAVING HELPERS
// ============================================================================
async function saveSubtitleContent({ srtText, courseTitle, sectionTitle, lectureIndex, lectureTitle, settings, fsHandle }) {
  const cleanCourse = sanitizeName(courseTitle, 'Udemy Course');
  const cleanSection = sanitizeName(sectionTitle, '');
  const cleanTitle = sanitizeName(lectureTitle, 'Lesson');
  const indexStr = padIndex(lectureIndex);
  const fileName = `${indexStr} - ${cleanTitle}.srt`;
  const srtBlob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });

  if (settings.downloadMode === 'filesystem' && fsHandle) {
    try {
      await saveBlobToFileSystem(fsHandle, cleanCourse, cleanSection, fileName, srtBlob);
      return;
    } catch (e) {
      console.warn('Lỗi ghi sub vào FS, fallback Downloads:', e);
    }
  }

  const blobUrl = URL.createObjectURL(srtBlob);
  const relativePath = buildDownloadPath({
    baseFolder: settings.customFolder,
    courseTitle,
    sectionTitle,
    lectureIndex,
    lectureTitle,
    extension: 'srt'
  });

  await new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: blobUrl,
        filename: relativePath,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      () => resolve()
    );
  });
}

async function saveVideoResult({ blob, courseTitle, sectionTitle, lectureIndex, lectureTitle, settings, fsHandle }) {
  const cleanCourse = sanitizeName(courseTitle, 'Udemy Course');
  const cleanSection = sanitizeName(sectionTitle, '');
  const cleanTitle = sanitizeName(lectureTitle, 'Lesson');
  const indexStr = padIndex(lectureIndex);
  const fileName = `${indexStr} - ${cleanTitle}.mp4`;

  if (settings.downloadMode === 'filesystem' && fsHandle) {
    try {
      await saveBlobToFileSystem(fsHandle, cleanCourse, cleanSection, fileName, blob);
      return;
    } catch (e) {
      console.warn('Lỗi ghi video vào FS, fallback Downloads:', e);
    }
  }

  const blobUrl = URL.createObjectURL(blob);
  const relativePath = buildDownloadPath({
    baseFolder: settings.customFolder,
    courseTitle,
    sectionTitle,
    lectureIndex,
    lectureTitle,
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
}

async function saveBlobToFileSystem(fsHandle, courseDirName, sectionDirName, fileName, blob) {
  const courseFolder = await fsHandle.getDirectoryHandle(courseDirName, { create: true });
  let targetFolder = courseFolder;
  if (sectionDirName) {
    targetFolder = await courseFolder.getDirectoryHandle(sectionDirName, { create: true });
  }
  const fileHandle = await targetFolder.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function saveViaDownloadsApi(blob, meta, settings, fileName, folderDisplay) {
  updateStatus('Đang lưu qua trình quản lý tải xuống...', 'info');
  const blobUrl = URL.createObjectURL(blob);
  const relativePath = buildDownloadPath({
    baseFolder: settings.customFolder,
    courseTitle: meta.courseTitle,
    sectionTitle: meta.sectionTitle,
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

  showCompletion(fileName, `Đã lưu vào Downloads/${settings.customFolder}/${folderDisplay}`);
}

function promptFsSave({ fsHandle, cleanCourse, cleanSection, folderDisplay, fileName, blob, settings, meta }) {
  const permBox = document.getElementById('fs-permission-box');
  const targetNameEl = document.getElementById('fs-target-name');
  const btnGrant = document.getElementById('btn-grant-save');
  const btnFallback = document.getElementById('btn-fallback-download');

  targetNameEl.textContent = `${fsHandle.name}/${folderDisplay}`;
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
        await saveBlobToFileSystem(fsHandle, cleanCourse, cleanSection, fileName, blob);
        permBox.classList.add('hidden');
        showCompletion(fileName, `Đã ghi thành công vào thư mục: ${fsHandle.name}/${folderDisplay}`);
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
    await saveViaDownloadsApi(blob, meta, settings, fileName, folderDisplay);
  };
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
  if (!statusEl) return;
  statusEl.textContent = text;
  if (type === 'error') {
    statusEl.style.color = '#fca5a5';
  } else if (type === 'warn') {
    statusEl.style.color = '#fbbf24';
  } else {
    statusEl.style.color = 'var(--text-muted)';
  }
}

function showCompletion(fileName, desc) {
  document.getElementById('finish-box')?.classList.remove('hidden');
  const finishDesc = document.getElementById('finish-desc');
  if (finishDesc) finishDesc.textContent = `${desc} (${fileName})`;

  document.getElementById('btn-cancel')?.classList.add('hidden');
  document.getElementById('btn-close')?.classList.remove('hidden');

  const percentEl = document.getElementById('percent-number');
  const barEl = document.getElementById('progress-bar-fill');
  const statusEl = document.getElementById('status-message');

  if (percentEl) percentEl.textContent = '100%';
  if (barEl) barEl.style.width = '100%';
  if (statusEl) statusEl.textContent = 'Tải hoàn tất!';
}
