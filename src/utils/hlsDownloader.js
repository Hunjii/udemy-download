/**
 * HLS Downloader & Transmuxer (Engine 1)
 * Tải đa luồng song song các phân đoạn HLS, giải mã AES-128 bằng Web Crypto API và ghép thành file video MP4 hoàn chỉnh.
 */

import { parseMediaPlaylist } from './hlsParser.js';

/**
 * Chuyển đổi chuỗi Hex thành Uint8Array
 * @param {string} hexStr 
 * @returns {Uint8Array}
 */
function hexToUint8Array(hexStr) {
  let cleanHex = hexStr.startsWith('0x') ? hexStr.slice(2) : hexStr;
  if (cleanHex.length % 2 !== 0) cleanHex = '0' + cleanHex;
  const arr = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return arr;
}

/**
 * Tạo IV từ số thứ tự phân đoạn (theo chuẩn RFC 8216 của HLS)
 * @param {number} seqNumber 
 * @returns {Uint8Array}
 */
function getIvFromSeqNumber(seqNumber) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, seqNumber, false); // Big-endian
  return iv;
}

/**
 * Tải toàn bộ video HLS từ Media Playlist và ghép thành file Blob .mp4
 * @param {Object} options
 * @param {string} options.playlistUrl - URL của playlist độ phân giải được chọn (1080p, 720p...)
 * @param {number} [options.concurrency=6] - Số phân đoạn tải đồng thời
 * @param {Function} [options.onProgress] - Callback cập nhật tiến trình
 * @param {AbortSignal} [options.signal] - Tín hiệu hủy tải
 * @returns {Promise<{ blob: Blob, sizeBytes: number, duration: number }>}
 */
export async function downloadHlsVideo({
  playlistUrl,
  concurrency = 6,
  onProgress = () => {},
  signal = null
}) {
  onProgress({ stage: 'FETCH_PLAYLIST', percent: 0, message: 'Đang nạp danh sách phân đoạn...' });

  // 1. Tải nội dung Media Playlist
  const playlistRes = await fetch(playlistUrl, { credentials: 'include', signal });
  if (!playlistRes.ok) {
    throw new Error(`Không thể nạp playlist HLS (HTTP ${playlistRes.status})`);
  }
  const playlistText = await playlistRes.text();
  const parsed = parseMediaPlaylist(playlistText, playlistUrl);

  const { isFmp4, initSegmentUrl, segments, totalDuration } = parsed;

  if (parsed.keyInfo && (parsed.keyInfo.method === 'SAMPLE-AES' || parsed.keyInfo.method?.includes('SAMPLE'))) {
    throw new Error('Video này được mã hóa bảo vệ bản quyền (SAMPLE-AES / Widevine DRM). Vui lòng dùng Engine 2 (Ghi luồng phát Tab) trong tiện ích để tải.');
  }

  if (!segments || segments.length === 0) {
    throw new Error('Playlist không chứa phân đoạn video nào khả dụng');
  }

  const totalSegments = segments.length;
  onProgress({
    stage: 'STARTING',
    percent: 1,
    current: 0,
    total: totalSegments,
    message: `Tìm thấy ${totalSegments} phân đoạn. Đang chuẩn bị tải...`
  });

  // 2. Tải khóa giải mã AES-128 nếu có
  const keyCache = new Map();

  async function getCryptoKey(keyInfo) {
    if (!keyInfo || keyInfo.method !== 'AES-128' || !keyInfo.uri) {
      return null;
    }
    if (keyCache.has(keyInfo.uri)) {
      return keyCache.get(keyInfo.uri);
    }

    try {
      const keyRes = await fetch(keyInfo.uri, { credentials: 'include', signal });
      if (!keyRes.ok) throw new Error(`Lỗi tải AES-128 key (HTTP ${keyRes.status})`);
      const keyBuffer = await keyRes.arrayBuffer();

      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBuffer,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );

      keyCache.set(keyInfo.uri, cryptoKey);
      return cryptoKey;
    } catch (e) {
      console.warn('Lỗi giải mã khóa HLS:', e);
      throw new Error(`Không thể lấy khóa bản quyền AES-128: ${e.message}`);
    }
  }

  // 3. Tải phân đoạn khởi tạo fMP4 (init.mp4) nếu có
  let initSegmentBuffer = null;
  if (initSegmentUrl) {
    onProgress({ stage: 'INIT_SEGMENT', percent: 2, message: 'Đang tải phân đoạn khởi tạo fMP4...' });
    const initRes = await fetch(initSegmentUrl, { credentials: 'include', signal });
    if (!initRes.ok) throw new Error('Không thể tải init segment fMP4');
    initSegmentBuffer = await initRes.arrayBuffer();
  }

  // 4. Quản lý tải song song các phân đoạn (Worker Pool)
  const downloadedChunks = new Array(totalSegments);
  let completedCount = 0;
  let totalBytes = 0;
  const startTime = Date.now();

  let nextIndex = 0;

  async function downloadWorker() {
    while (nextIndex < totalSegments) {
      if (signal?.aborted) throw new Error('Tác vụ tải đã bị hủy');

      const currentIndex = nextIndex++;
      const segment = segments[currentIndex];

      let attempts = 0;
      let success = false;

      while (!success && attempts < 5) {
        try {
          attempts++;
          const segRes = await fetch(segment.url, { credentials: 'include', signal });
          if (!segRes.ok) {
            throw new Error(`HTTP ${segRes.status} (${segRes.statusText || 'Error'})`);
          }

          let rawData = await segRes.arrayBuffer();

          // Giải mã nếu có AES-128
          if (segment.keyInfo && segment.keyInfo.method === 'AES-128') {
            const cryptoKey = await getCryptoKey(segment.keyInfo);
            if (cryptoKey) {
              let iv = null;
              if (segment.keyInfo.iv) {
                iv = hexToUint8Array(segment.keyInfo.iv);
              } else {
                iv = getIvFromSeqNumber(segment.index);
              }
              try {
                rawData = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, rawData);
              } catch (decErr) {
                throw new Error(`Giải mã AES-128 thất bại: ${decErr.message}`);
              }
            }
          }

          downloadedChunks[currentIndex] = new Uint8Array(rawData);
          totalBytes += rawData.byteLength;
          completedCount++;
          success = true;

          // Tính toán phần trăm & tốc độ
          const percent = Math.round((completedCount / totalSegments) * 94) + 3; // Thang điểm từ 3% đến 97%
          const elapsedSec = (Date.now() - startTime) / 1000;
          const speedMbps = elapsedSec > 0 ? ((totalBytes * 8) / (elapsedSec * 1024 * 1024)).toFixed(1) : 0;
          const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);

          onProgress({
            stage: 'DOWNLOADING',
            percent,
            current: completedCount,
            total: totalSegments,
            totalMb,
            speedMbps,
            message: `Đang tải: ${completedCount}/${totalSegments} phân đoạn (${totalMb}MB - ${speedMbps} Mbps)`
          });
        } catch (err) {
          if (signal?.aborted) throw err;
          if (attempts >= 5) {
            let detail = err.message;
            if (detail.includes('403') || detail.includes('401')) {
              detail += ' - Token phân đoạn đã hết hạn. Vui lòng bấm Phát (Play) video bài giảng trên Udemy rồi tải lại.';
            }
            throw new Error(`Lỗi tải phân đoạn ${currentIndex + 1}/${totalSegments}: ${detail}`);
          }
          // Chờ theo lũy tiến (exponential backoff)
          const delay = Math.min(800 * Math.pow(1.5, attempts - 1), 4000);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
  }

  // Khởi động các worker chạy song song
  const actualConcurrency = Math.min(concurrency, totalSegments);
  const workers = Array.from({ length: actualConcurrency }, () => downloadWorker());
  await Promise.all(workers);

  // 5. Ghép nối các phân đoạn thành 1 file MP4 hoàn chỉnh
  onProgress({
    stage: 'ASSEMBLING',
    percent: 98,
    message: 'Đang đóng gói và hoàn thiện file MP4...'
  });

  const blobParts = [];
  if (initSegmentBuffer) {
    blobParts.push(initSegmentBuffer);
  }

  for (let i = 0; i < totalSegments; i++) {
    if (downloadedChunks[i]) {
      blobParts.push(downloadedChunks[i]);
    }
  }

  const finalBlob = new Blob(blobParts, { type: 'video/mp4' });

  onProgress({
    stage: 'DONE',
    percent: 100,
    message: 'Ghép video hoàn tất!'
  });

  return {
    blob: finalBlob,
    sizeBytes: finalBlob.size,
    duration: totalDuration
  };
}

/**
 * Tải trực tiếp video MP4 (dự phòng khi bài giảng chỉ có luồng MP4 tĩnh)
 * @param {Object} options
 * @param {string} options.videoUrl - Đường dẫn file MP4
 * @param {Function} [options.onProgress] - Callback cập nhật tiến trình
 * @param {AbortSignal} [options.signal] - Tín hiệu hủy tải
 * @returns {Promise<{ blob: Blob, sizeBytes: number, duration: number }>}
 */
export async function downloadDirectVideo({
  videoUrl,
  onProgress = () => {},
  signal = null
}) {
  onProgress({ stage: 'STARTING', percent: 0, message: 'Đang kết nối tải video MP4 trực tiếp...' });

  const res = await fetch(videoUrl, { credentials: 'include', signal });
  if (!res.ok) {
    throw new Error(`Không thể tải video MP4 (HTTP ${res.status})`);
  }

  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body ? res.body.getReader() : null;

  if (!reader) {
    const blob = await res.blob();
    return { blob, sizeBytes: blob.size, duration: 0 };
  }

  const chunks = [];
  let receivedBytes = 0;
  const startTime = Date.now();

  while (true) {
    if (signal?.aborted) throw new Error('Tác vụ tải đã bị hủy');
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.length;

    const percent = contentLength > 0 ? Math.round((receivedBytes / contentLength) * 100) : 0;
    const elapsedSec = (Date.now() - startTime) / 1000;
    const speedMbps = elapsedSec > 0 ? ((receivedBytes * 8) / (elapsedSec * 1024 * 1024)).toFixed(1) : '0';
    const totalMb = (receivedBytes / (1024 * 1024)).toFixed(1);

    onProgress({
      stage: 'DOWNLOADING',
      percent: percent || 50,
      speedMbps,
      totalMb,
      current: totalMb,
      total: contentLength > 0 ? (contentLength / (1024 * 1024)).toFixed(1) : '?',
      message: contentLength > 0 ? `Đang tải: ${percent}% (${totalMb} MB)` : `Đang tải: ${totalMb} MB...`
    });
  }

  const blob = new Blob(chunks, { type: 'video/mp4' });
  return { blob, sizeBytes: receivedBytes, duration: 0 };
}

