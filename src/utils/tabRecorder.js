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
   * Bắt đầu ghi luồng từ tab hiện tại
   * @param {Object} options 
   * @param {Function} [options.onUpdate] - Callback cập nhật giây ghi và dung lượng
   * @returns {Promise<void>}
   */
  async startRecording({ onUpdate = () => {} } = {}) {
    if (this.isRecording) return;

    return new Promise((resolve, reject) => {
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
        (stream) => {
          if (!stream || chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError?.message || 'Không thể bắt luồng phát của tab'));
          }

          this.stream = stream;
          this.recordedChunks = [];

          // Tiếp tục phát âm thanh ra loa để người dùng nghe được
          try {
            const audioCtx = new AudioContext();
            const source = audioCtx.createMediaStreamSource(stream);
            source.connect(audioCtx.destination);
          } catch (e) {
            console.warn('Lỗi kết nối âm thanh ra loa:', e);
          }

          // Chọn mimeType được trình duyệt hỗ trợ tốt nhất
          let mimeType = 'video/webm;codecs=vp9,opus';
          if (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')) {
            mimeType = 'video/mp4;codecs=avc1,mp4a.40.2';
          } else if (MediaRecorder.isTypeSupported('video/mp4')) {
            mimeType = 'video/mp4';
          }

          this.mediaRecorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 4500000 // 4.5 Mbps cho chất lượng HD sắc nét
          });

          this.mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
              this.recordedChunks.push(event.data);
            }
          };

          this.mediaRecorder.start(1000); // Thu thập dữ liệu mỗi 1 giây
          this.isRecording = true;
          this.startTime = Date.now();

          // Bộ đếm thời gian cập nhật giao diện
          this.timerInterval = setInterval(() => {
            if (!this.isRecording) return;
            const elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
            const totalBytes = this.recordedChunks.reduce((acc, c) => acc + c.size, 0);
            const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
            onUpdate({ elapsedSec, totalMb, isRecording: true });
          }, 1000);

          resolve();
        }
      );
    });
  }

  /**
   * Dừng ghi luồng và xuất ra Blob video
   * @returns {Promise<{ blob: Blob, extension: string, durationSec: number }>}
   */
  async stopRecording() {
    if (!this.isRecording || !this.mediaRecorder) {
      throw new Error('Chưa có phiên ghi nào đang chạy');
    }

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    return new Promise((resolve) => {
      this.mediaRecorder.onstop = () => {
        const mimeType = this.mediaRecorder.mimeType || 'video/mp4';
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const finalBlob = new Blob(this.recordedChunks, { type: mimeType });

        // Dừng các track của luồng phát
        if (this.stream) {
          this.stream.getTracks().forEach(track => track.stop());
          this.stream = null;
        }

        const durationSec = Math.floor((Date.now() - this.startTime) / 1000);
        this.isRecording = false;

        resolve({
          blob: finalBlob,
          extension: ext,
          durationSec
        });
      };

      this.mediaRecorder.stop();
    });
  }
}
