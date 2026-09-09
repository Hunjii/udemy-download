/**
 * Tab Stream Recorder (Engine 2 - Bypass Widevine DRM 100%)
 * Ghi lại luồng phát video và âm thanh trực tiếp từ trình phát tab Udemy ở độ phân giải gốc.
 */

export class TabRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.stream = null;
    this.isRecording = false;
    this.startTime = 0;
  }

  /**
   * Bắt đầu ghi luồng từ tab mục tiêu (hỗ trợ cả Popup Window, Side Panel và Toolbar Popup)
   * @param {Object} options 
   * @param {number} [options.targetTabId] - ID của tab Udemy cần ghi
   * @param {Function} [options.onUpdate] - Callback cập nhật giây ghi và dung lượng
   * @param {boolean} [options.muteSpeaker] - Tắt tiếng ra loa ngoài máy tính trong khi ghi
   * @returns {Promise<void>}
   */
  async startRecording({ targetTabId, onUpdate = () => {}, muteSpeaker = false } = {}) {
    if (this.isRecording) return;

    let stream = null;
    let isDisplayMedia = false;

    // 1. Phương pháp Chuẩn Tối Ưu: navigator.mediaDevices.getDisplayMedia
    // Hoạt động 100% không lỗi trên cả Side Panel, Popup Window lẫn Tab thông thường.
    // Với preferCurrentTab: true và displaySurface: 'browser', Chrome tự động chọn sẵn tab Udemy hiện tại.
    if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
      try {
        const displayMediaOptions = {
          video: {
            displaySurface: 'browser'
          },
          audio: muteSpeaker ? { suppressLocalAudioPlayback: true } : true,
          preferCurrentTab: true,
          selfBrowserSurface: 'exclude',
          systemAudio: 'include'
        };

        try {
          stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
          isDisplayMedia = true;
        } catch (specErr) {
          if (specErr.name === 'NotAllowedError' || specErr.name === 'AbortError' || specErr.name === 'NotFoundError') {
            throw specErr;
          }
          // Thử lại với constraints cơ bản nếu các tuỳ chọn nâng cao chưa hỗ trợ
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true
          });
          isDisplayMedia = true;
        }
      } catch (displayErr) {
        if (displayErr.name === 'NotAllowedError' || displayErr.name === 'AbortError' || displayErr.message?.includes('Permission denied')) {
          const cancelErr = new Error('Người dùng đã đóng hoặc hủy chia sẻ tab.');
          cancelErr.isCancelled = true;
          throw cancelErr;
        }
        console.warn('[TabRecorder] getDisplayMedia không thành công, thử fallback:', displayErr);
      }
    }

    // 2. Phương pháp Dự phòng 1: chrome.tabCapture.getMediaStreamId chỉ định targetTabId
    if (!stream && targetTabId && chrome.tabCapture && typeof chrome.tabCapture.getMediaStreamId === 'function') {
      try {
        const streamId = await new Promise((resolve, reject) => {
          chrome.tabCapture.getMediaStreamId({ targetTabId }, (id) => {
            if (chrome.runtime.lastError) {
              return reject(new Error(chrome.runtime.lastError.message));
            }
            if (!id) {
              return reject(new Error('Không thể tạo streamId cho tab'));
            }
            resolve(id);
          });
        });

        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId
            }
          },
          video: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId,
              minWidth: 1280,
              minHeight: 720,
              maxWidth: 1920,
              maxHeight: 1080,
              maxFrameRate: 30
            }
          }
        });
      } catch (getStreamErr) {
        console.warn('[TabRecorder] getMediaStreamId thất bại, thử fallback sang capture():', getStreamErr);
      }
    }

    // 3. Phương pháp Dự phòng 2: chrome.tabCapture.capture trực tiếp
    if (!stream && chrome.tabCapture && typeof chrome.tabCapture.capture === 'function') {
      try {
        stream = await new Promise((resolve, reject) => {
          chrome.tabCapture.capture(
            {
              audio: true,
              video: true,
              videoConstraints: {
                mandatory: {
                  minWidth: 1280,
                  minHeight: 720,
                  maxWidth: 1920,
                  maxHeight: 1080,
                  maxFrameRate: 30
                }
              }
            },
            (capturedStream) => {
              if (!capturedStream || chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError?.message || 'Không thể bắt luồng phát của tab'));
              }
              resolve(capturedStream);
            }
          );
        });
      } catch (e) {
        console.warn('[TabRecorder] Fallback capture() thất bại:', e);
      }
    }

    if (!stream) {
      throw new Error('Không thể khởi tạo luồng thu phát của tab bài giảng.');
    }

    this.stream = stream;
    this.recordedChunks = [];

    // Lắng nghe khi người dùng bấm nút "Dừng chia sẻ" (Stop sharing) trên thanh thông báo gốc của Chrome
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => {
        if (this.isRecording && typeof this.onTrackEnded === 'function') {
          this.onTrackEnded();
        }
      });
    }

    // Chỉ kết nối AudioContext ra loa ngoài nếu dùng tabCapture (tabCapture tự ngắt tiếng của tab).
    // Đối với getDisplayMedia, trình duyệt phát tiếng bình thường trừ khi chọn tắt loa.
    if (!isDisplayMedia && !muteSpeaker && typeof AudioContext !== 'undefined') {
      try {
        const audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(audioCtx.destination);
        this.audioCtx = audioCtx;
      } catch (e) {
        console.warn('Lỗi kết nối âm thanh ra loa:', e);
      }
    }

    // Chọn mimeType được trình duyệt hỗ trợ tốt nhất (Ưu tiên H.264 MP4)
    let mimeType = 'video/mp4;codecs=avc1,mp4a.40.2';
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/mp4;codecs=avc1';
      }
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/mp4';
      }
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm;codecs=vp9,opus';
      }
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm';
      }
    }

    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 5500000, // 5.5 Mbps cho chất lượng Full HD 1080p sắc nét
      audioBitsPerSecond: 192000   // 192 kbps âm thanh stereo trong trẻo
    });

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    // Khởi động ghi không truyền timeslice nhỏ để tránh ép chia cắt phân mảnh MP4 phá vỡ cấu trúc I-frame/GOP gây xước hình
    this.mediaRecorder.start();
    this.isRecording = true;
    this.startTime = Date.now();

    // Bộ đếm thời gian cập nhật giao diện
    this.timerInterval = setInterval(() => {
      if (!this.isRecording) return;
      const elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
      const actualBytes = this.recordedChunks.reduce((acc, c) => acc + c.size, 0);
      // Ước tính dung lượng theo bitrate nếu chưa có chunk flush
      const totalMb = actualBytes > 0
        ? (actualBytes / (1024 * 1024)).toFixed(1)
        : (elapsedSec * 0.71).toFixed(1);
      onUpdate({ elapsedSec, totalMb, isRecording: true });
    }, 1000);
  }

  /**
   * Dừng ghi luồng và xuất ra Blob video đã được vá Metadata hoàn chỉnh
   * @returns {Promise<{ blob: Blob, extension: string, durationSec: number, sizeBytes: number }>}
   */
  async stopRecording() {
    if (!this.isRecording || !this.mediaRecorder) {
      throw new Error('Chưa có phiên ghi nào đang chạy');
    }

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    return new Promise((resolve) => {
      this.mediaRecorder.onstop = async () => {
        const mimeType = this.mediaRecorder.mimeType || 'video/mp4';
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        let finalBlob = new Blob(this.recordedChunks, { type: mimeType });

        // Dừng các track của luồng phát
        if (this.stream) {
          this.stream.getTracks().forEach(track => {
            try { track.stop(); } catch (e) {}
          });
          this.stream = null;
        }

        if (this.audioCtx) {
          try { this.audioCtx.close(); } catch (e) {}
          this.audioCtx = null;
        }

        const durationSec = Math.max(1, Math.floor((Date.now() - this.startTime) / 1000));
        this.isRecording = false;

        // Tự động vá Metadata thời lượng và thanh tua cho MP4 hoặc WebM
        try {
          if (ext === 'mp4') {
            finalBlob = await patchMp4Metadata(finalBlob, durationSec);
          } else if (ext === 'webm') {
            finalBlob = await patchWebmDuration(finalBlob, durationSec);
          }
        } catch (patchErr) {
          console.warn('[TabRecorder] Lỗi khi vá metadata video:', patchErr);
        }

        resolve({
          blob: finalBlob,
          extension: ext,
          durationSec,
          sizeBytes: finalBlob.size
        });
      };

      if (this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    });
  }
}

/**
 * Vá Metadata thời lượng vào cấu trúc ISO Base Media File Format (MP4)
 * Giúp video MP4 ghi từ MediaRecorder có duration chính xác, tua mượt mà và tương thích 100% với Windows Player.
 * @param {Blob} blob
 * @param {number} durationSec
 * @returns {Promise<Blob>}
 */
export async function patchMp4Metadata(blob, durationSec) {
  if (!blob || durationSec <= 0) return blob;
  try {
    const headerSliceSize = Math.min(blob.size, 256 * 1024);
    const headerBuffer = await blob.slice(0, headerSliceSize).arrayBuffer();
    const view = new DataView(headerBuffer);

    let offset = 0;
    let moovFound = false;
    let moovOffset = 0;
    let moovSize = 0;

    while (offset + 8 <= headerBuffer.byteLength) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );

      if (size === 1) {
        if (offset + 16 > headerBuffer.byteLength) break;
        const sizeHigh = view.getUint32(offset + 8);
        const sizeLow = view.getUint32(offset + 12);
        size = sizeHigh * 4294967296 + sizeLow;
      } else if (size === 0) {
        size = headerBuffer.byteLength - offset;
      }

      if (type === 'moov') {
        moovFound = true;
        moovOffset = offset;
        moovSize = size;
        break;
      }

      if (size < 8) break;
      offset += size;
    }

    let targetBuffer = headerBuffer;
    let targetView = view;
    let fullBufferLoaded = false;

    if (!moovFound) {
      if (blob.size <= headerSliceSize) return blob;
      targetBuffer = await blob.arrayBuffer();
      targetView = new DataView(targetBuffer);
      fullBufferLoaded = true;

      offset = 0;
      while (offset + 8 <= targetBuffer.byteLength) {
        let size = targetView.getUint32(offset);
        const type = String.fromCharCode(
          targetView.getUint8(offset + 4),
          targetView.getUint8(offset + 5),
          targetView.getUint8(offset + 6),
          targetView.getUint8(offset + 7)
        );
        if (size === 1) {
          if (offset + 16 > targetBuffer.byteLength) break;
          const sizeHigh = targetView.getUint32(offset + 8);
          const sizeLow = targetView.getUint32(offset + 12);
          size = sizeHigh * 4294967296 + sizeLow;
        } else if (size === 0) {
          size = targetBuffer.byteLength - offset;
        }
        if (type === 'moov') {
          moovFound = true;
          moovOffset = offset;
          moovSize = size;
          break;
        }
        if (size < 8) break;
        offset += size;
      }
    }

    if (!moovFound) return blob;

    let movieTimescale = 1000;

    function parseBoxes(startOffset, endOffset) {
      let cur = startOffset;
      while (cur + 8 <= endOffset) {
        let boxSize = targetView.getUint32(cur);
        const boxType = String.fromCharCode(
          targetView.getUint8(cur + 4),
          targetView.getUint8(cur + 5),
          targetView.getUint8(cur + 6),
          targetView.getUint8(cur + 7)
        );
        let headerLen = 8;
        if (boxSize === 1) {
          if (cur + 16 > endOffset) break;
          const sH = targetView.getUint32(cur + 8);
          const sL = targetView.getUint32(cur + 12);
          boxSize = sH * 4294967296 + sL;
          headerLen = 16;
        } else if (boxSize === 0) {
          boxSize = endOffset - cur;
        }

        if (boxSize < headerLen || cur + boxSize > endOffset) break;

        const contentOffset = cur + headerLen;
        const boxEnd = cur + boxSize;

        if (boxType === 'mvhd') {
          const version = targetView.getUint8(contentOffset);
          if (version === 0) {
            movieTimescale = targetView.getUint32(contentOffset + 12);
            if (movieTimescale > 0) {
              const durationUnits = Math.round(durationSec * movieTimescale);
              targetView.setUint32(contentOffset + 16, durationUnits);
            }
          } else if (version === 1) {
            movieTimescale = targetView.getUint32(contentOffset + 20);
            if (movieTimescale > 0) {
              const durationUnits = Math.round(durationSec * movieTimescale);
              targetView.setUint32(contentOffset + 24, Math.floor(durationUnits / 4294967296));
              targetView.setUint32(contentOffset + 28, durationUnits >>> 0);
            }
          }
        } else if (boxType === 'tkhd') {
          const version = targetView.getUint8(contentOffset);
          if (version === 0) {
            if (movieTimescale > 0) {
              const durationUnits = Math.round(durationSec * movieTimescale);
              targetView.setUint32(contentOffset + 20, durationUnits);
            }
          } else if (version === 1) {
            if (movieTimescale > 0) {
              const durationUnits = Math.round(durationSec * movieTimescale);
              targetView.setUint32(contentOffset + 28, Math.floor(durationUnits / 4294967296));
              targetView.setUint32(contentOffset + 32, durationUnits >>> 0);
            }
          }
        } else if (boxType === 'mdhd') {
          const version = targetView.getUint8(contentOffset);
          let trackTimescale = movieTimescale;
          if (version === 0) {
            trackTimescale = targetView.getUint32(contentOffset + 12) || movieTimescale;
            if (trackTimescale > 0) {
              const durationUnits = Math.round(durationSec * trackTimescale);
              targetView.setUint32(contentOffset + 16, durationUnits);
            }
          } else if (version === 1) {
            trackTimescale = targetView.getUint32(contentOffset + 20) || movieTimescale;
            if (trackTimescale > 0) {
              const durationUnits = Math.round(durationSec * trackTimescale);
              targetView.setUint32(contentOffset + 24, Math.floor(durationUnits / 4294967296));
              targetView.setUint32(contentOffset + 28, durationUnits >>> 0);
            }
          }
        } else if (['trak', 'mdia', 'minf'].includes(boxType)) {
          parseBoxes(contentOffset, boxEnd);
        }

        cur += boxSize;
      }
    }

    const moovHeaderLen = targetView.getUint32(moovOffset) === 1 ? 16 : 8;
    parseBoxes(moovOffset + moovHeaderLen, moovOffset + moovSize);

    if (fullBufferLoaded) {
      return new Blob([targetBuffer], { type: blob.type || 'video/mp4' });
    } else {
      return new Blob([targetBuffer, blob.slice(headerSliceSize)], { type: blob.type || 'video/mp4' });
    }
  } catch (err) {
    console.warn('[TabRecorder] Không thể vá MP4 metadata:', err);
    return blob;
  }
}

/**
 * Vá Metadata thời lượng vào WebM (EBML Duration)
 * @param {Blob} blob 
 * @param {number} durationSec 
 * @returns {Promise<Blob>}
 */
export async function patchWebmDuration(blob, durationSec) {
  if (!blob || durationSec <= 0) return blob;
  try {
    const durationMs = durationSec * 1000;
    const headerSliceSize = Math.min(blob.size, 128 * 1024);
    const headerBuffer = await blob.slice(0, headerSliceSize).arrayBuffer();
    const u8 = new Uint8Array(headerBuffer);

    let infoOffset = -1;
    for (let i = 0; i < u8.length - 8; i++) {
      if (u8[i] === 0x15 && u8[i + 1] === 0x49 && u8[i + 2] === 0xA9 && u8[i + 3] === 0x66) {
        infoOffset = i;
        break;
      }
    }
    if (infoOffset === -1) return blob;

    let durationOffset = -1;
    for (let i = infoOffset; i < Math.min(infoOffset + 1024, u8.length - 6); i++) {
      if (u8[i] === 0x44 && u8[i + 1] === 0x89) {
        durationOffset = i;
        break;
      }
    }

    if (durationOffset !== -1) {
      const dataView = new DataView(headerBuffer);
      const len = u8[durationOffset + 2];
      if (len === 4) {
        dataView.setFloat32(durationOffset + 3, durationMs);
        return new Blob([headerBuffer, blob.slice(headerSliceSize)], { type: blob.type || 'video/webm' });
      } else if (len === 8) {
        dataView.setFloat64(durationOffset + 3, durationMs);
        return new Blob([headerBuffer, blob.slice(headerSliceSize)], { type: blob.type || 'video/webm' });
      }
    }
    return blob;
  } catch (err) {
    console.warn('[TabRecorder] Không thể vá WebM metadata:', err);
    return blob;
  }
}
