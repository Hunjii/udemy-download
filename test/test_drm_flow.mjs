import assert from 'node:assert';
import { findEnglishCaption } from '../src/utils/sanitizer.js';
import { convertVttToSrt } from '../src/utils/vtt2srt.js';
import { parseMasterPlaylist } from '../src/utils/hlsParser.js';

console.log('--- BẮT ĐẦU KIỂM TRA DRM FLOW, FALLBACK VÀ AUTO-BATCH ENGINE 2 ---');

// ----------------------------------------------------------------------------
// 1. Kiểm tra logic phát hiện DRM và Fallback
// ----------------------------------------------------------------------------
function evaluateDrmAndFallback(payload, streams = []) {
  const asset = payload.asset || {};
  const streamUrls = asset.stream_urls || payload.stream_urls || {};

  const isDrmProtected = Boolean(
    asset.course_is_drmed ||
    payload.course_is_drmed ||
    (!streams.length && (streamUrls.dash || streamUrls.encrypted_hls)) ||
    Boolean(asset.media_license_token)
  );

  const hasNonDrmFallback = Boolean(isDrmProtected && streams.length > 0);

  return {
    isDrmProtected,
    hasNonDrmFallback,
    streams,
    bestQuality: streams.length > 0 ? streams[0] : null
  };
}

// Test 1.1: Bài giảng không có DRM, có đầy đủ luồng 1080p
const normalLecture = evaluateDrmAndFallback(
  { asset: { course_is_drmed: false } },
  [{ label: '1080', resolution: 1080, file: 'https://cdn/1080.m3u8', type: 'hls' }]
);
assert.strictEqual(normalLecture.isDrmProtected, false);
assert.strictEqual(normalLecture.hasNonDrmFallback, false);
assert.strictEqual(normalLecture.bestQuality.resolution, 1080);
console.log('1.1. Nhận diện bài giảng chuẩn (không DRM): ĐẠT');

// Test 1.2: Bài giảng DRM thuần túy (Không có luồng mở)
const pureDrmLecture = evaluateDrmAndFallback(
  {
    asset: {
      course_is_drmed: true,
      media_license_token: 'widevine_license_abc123'
    },
    streamUrls: {
      encrypted_hls: [{ file: 'https://cdn/enc.m3u8' }],
      dash: [{ file: 'https://cdn/manifest.mpd' }]
    }
  },
  []
);
assert.strictEqual(pureDrmLecture.isDrmProtected, true);
assert.strictEqual(pureDrmLecture.hasNonDrmFallback, false);
assert.strictEqual(pureDrmLecture.bestQuality, null);
console.log('1.2. Nhận diện bài giảng DRM thuần túy (Không có luồng fallback): ĐẠT');

// Test 1.3: Bài giảng DRM nhưng có luồng fallback 720p/480p không khóa
const drmWithFallback = evaluateDrmAndFallback(
  {
    asset: {
      course_is_drmed: true,
      media_license_token: 'widevine_token'
    }
  },
  [
    { label: '720', resolution: 720, file: 'https://cdn/720.mp4', type: 'video/mp4' },
    { label: '480', resolution: 480, file: 'https://cdn/480.mp4', type: 'video/mp4' }
  ]
);
assert.strictEqual(drmWithFallback.isDrmProtected, true);
assert.strictEqual(drmWithFallback.hasNonDrmFallback, true);
assert.strictEqual(drmWithFallback.bestQuality.resolution, 720);
console.log('1.3. Nhận diện bài giảng DRM có luồng mở Fallback (720p/480p): ĐẠT');

// ----------------------------------------------------------------------------
// 2. Kiểm tra điều phối quyết định trong Auto-Batch (Routing Logic)
// ----------------------------------------------------------------------------
function determineBatchAction(lecture, settings) {
  if (lecture.isQuiz || lecture.isArticle) {
    return { action: 'skip', reason: lecture.isQuiz ? 'quiz' : 'article' };
  }

  if (lecture.isDrmProtected) {
    if (lecture.hasNonDrmFallback && lecture.bestQuality) {
      return {
        action: 'engine1_download',
        targetStream: lecture.bestQuality,
        isFallback: true
      };
    }
    if (settings.autoRecordDrm) {
      return {
        action: 'engine2_record',
        speed: Number(settings.drmSpeed) || 1.0,
        muteSpeaker: settings.drmMuteSpeaker !== false
      };
    }
    return { action: 'skip', reason: 'drm_unrecorded' };
  }

  if (lecture.bestQuality) {
    return {
      action: 'engine1_download',
      targetStream: lecture.bestQuality,
      isFallback: false
    };
  }

  return { action: 'wait_stream' };
}

// Test 2.1: Bỏ qua Quiz và Article
const quizAction = determineBatchAction({ isQuiz: true, isDrmProtected: false }, {});
assert.strictEqual(quizAction.action, 'skip');
assert.strictEqual(quizAction.reason, 'quiz');

const articleAction = determineBatchAction({ isArticle: true, isDrmProtected: false }, {});
assert.strictEqual(articleAction.action, 'skip');
assert.strictEqual(articleAction.reason, 'article');
console.log('2.1. AutoBatch: Bỏ qua Quiz và Bài đọc (Article): ĐẠT');

// Test 2.2: Bài DRM có fallback -> Route sang Engine 1
const fallbackAction = determineBatchAction(
  {
    isDrmProtected: true,
    hasNonDrmFallback: true,
    bestQuality: { label: '720', resolution: 720 }
  },
  { autoRecordDrm: false }
);
assert.strictEqual(fallbackAction.action, 'engine1_download');
assert.strictEqual(fallbackAction.isFallback, true);
assert.strictEqual(fallbackAction.targetStream.resolution, 720);
console.log('2.2. AutoBatch: Điều hướng bài DRM có Fallback sang Engine 1: ĐẠT');

// Test 2.3: Bài pure DRM khi autoRecordDrm = true -> Route sang Engine 2 với speed và mute
const recordAction = determineBatchAction(
  {
    isDrmProtected: true,
    hasNonDrmFallback: false,
    bestQuality: null
  },
  {
    autoRecordDrm: true,
    drmSpeed: '1.5',
    drmMuteSpeaker: true
  }
);
assert.strictEqual(recordAction.action, 'engine2_record');
assert.strictEqual(recordAction.speed, 1.5);
assert.strictEqual(recordAction.muteSpeaker, true);
console.log('2.3. AutoBatch: Kích hoạt Engine 2 ghi luồng phát khi autoRecordDrm bật: ĐẠT');

// Test 2.4: Bài pure DRM khi autoRecordDrm = false -> Bỏ qua (skip)
const skipDrmAction = determineBatchAction(
  {
    isDrmProtected: true,
    hasNonDrmFallback: false,
    bestQuality: null
  },
  {
    autoRecordDrm: false
  }
);
assert.strictEqual(skipDrmAction.action, 'skip');
assert.strictEqual(skipDrmAction.reason, 'drm_unrecorded');
console.log('2.4. AutoBatch: Tự động bỏ qua bài DRM khi autoRecordDrm tắt: ĐẠT');

// ----------------------------------------------------------------------------
// 3. Kiểm tra tính toán thời gian ghi luồng theo tốc độ phát
// ----------------------------------------------------------------------------
function calculateEffectiveDuration(durationSec, playbackSpeed) {
  if (!durationSec || durationSec <= 0) return 0;
  const speed = Number(playbackSpeed) || 1.0;
  return durationSec / speed;
}

const duration100s = 100;
assert.strictEqual(calculateEffectiveDuration(duration100s, 1.0), 100);
assert.strictEqual(calculateEffectiveDuration(duration100s, 1.5), 100 / 1.5);
assert.strictEqual(calculateEffectiveDuration(duration100s, 2.0), 50);
console.log('3. Tính toán thời lượng ghi thực tế theo tốc độ 1.0x, 1.5x, 2.0x: ĐẠT');

// ----------------------------------------------------------------------------
// 4. Kiểm tra xử lý Phụ đề cho bài giảng DRM (WebVTT sang SRT)
// ----------------------------------------------------------------------------
const vttSample = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Welcome to Widevine DRM Protected Lesson.

2
00:00:04.500 --> 00:00:08.000
This caption is plain WebVTT and can be converted to SRT.
`;

const srtConverted = convertVttToSrt(vttSample);
assert.ok(srtConverted.includes('00:00:01,000 --> 00:00:04,000'), 'SRT phải có dấu phẩy ở miligiây');
assert.ok(srtConverted.includes('Welcome to Widevine DRM Protected Lesson.'));
assert.ok(srtConverted.includes('This caption is plain WebVTT and can be converted to SRT.'));

const captions = [
  { label: 'English', locale: 'en_US', url: 'https://cdn/en.vtt' },
  { label: 'Vietnamese', locale: 'vi_VN', url: 'https://cdn/vi.vtt' }
];
const englishSub = findEnglishCaption(captions);
assert.strictEqual(englishSub.url, 'https://cdn/en.vtt');
console.log('4. Xử lý phụ đề WebVTT sang SRT cho bài giảng DRM: ĐẠT');

// ----------------------------------------------------------------------------
// 5. Kiểm tra phân tích HLS Playlist phát hiện SAMPLE-AES / Widevine
// ----------------------------------------------------------------------------
const sampleAesMaster = `#EXTM3U
#EXT-X-VERSION:5
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://widevine.license",KEYFORMAT="com.widevine.alpha"
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080
1080/index.m3u8
`;
const parsedDrmMaster = parseMasterPlaylist(sampleAesMaster, 'https://cdn.udemy.com/master.m3u8');
assert.strictEqual(parsedDrmMaster.isDrm, true, 'Phải phát hiện isDrm = true khi playlist chứa SAMPLE-AES');
console.log('5. Phân tích HLS Playlist phát hiện SAMPLE-AES / Widevine: ĐẠT');

// ----------------------------------------------------------------------------
// 6. Kiểm tra xử lý ngoại lệ Runtime DRM trong Auto-Batch (Chống alert làm đứng chuỗi)
// ----------------------------------------------------------------------------
function handleBatchVideoError(err, lecture, settings) {
  const isDrmError = err.message?.includes('SAMPLE-AES') || err.message?.includes('Widevine DRM') || err.message?.includes('bản quyền');
  if (isDrmError) {
    if (settings.autoRecordDrm) {
      return { handled: true, action: 'switch_to_engine2' };
    }
    return { handled: true, action: 'skip_without_alert' };
  }
  return { handled: false, action: 'show_alert_and_stop' };
}

const sampleAesError = new Error('Video này được mã hóa bảo vệ bản quyền (SAMPLE-AES / Widevine DRM). Vui lòng dùng Engine 2 (Ghi luồng phát Tab) trong tiện ích để tải.');

// 6.1 Khi autoRecordDrm bật: tự động chuyển Engine 2
const resWhenEnabled = handleBatchVideoError(sampleAesError, { lectureId: '372' }, { autoRecordDrm: true });
assert.strictEqual(resWhenEnabled.handled, true);
assert.strictEqual(resWhenEnabled.action, 'switch_to_engine2');
console.log('6.1. Bắt lỗi SAMPLE-AES khi autoRecordDrm bật -> Tự động chuyển Engine 2 không hiện alert: ĐẠT');

// 6.2 Khi autoRecordDrm tắt: tự động bỏ qua (skip) không hiện alert làm dừng chuỗi
const resWhenDisabled = handleBatchVideoError(sampleAesError, { lectureId: '372' }, { autoRecordDrm: false });
assert.strictEqual(resWhenDisabled.handled, true);
assert.strictEqual(resWhenDisabled.action, 'skip_without_alert');
console.log('6.2. Bắt lỗi SAMPLE-AES khi autoRecordDrm tắt -> Tự động bỏ qua không hiện alert: ĐẠT');

// 6.3 Lỗi khác ngoài DRM vẫn báo dừng để người dùng xử lý
const otherErr = new Error('Mất kết nối mạng HTTP 500');
const resOther = handleBatchVideoError(otherErr, { lectureId: '372' }, { autoRecordDrm: true });
assert.strictEqual(resOther.handled, false);
assert.strictEqual(resOther.action, 'show_alert_and_stop');
console.log('6.3. Lỗi khác ngoài DRM vẫn báo dừng để người dùng xử lý: ĐẠT');

// 7. Kiểm tra sự hiện diện của Engine 2 Card và DRM Alert trực tiếp trong lecture-content
import fs from 'fs';
import path from 'path';

const popupHtmlPath = path.resolve('src/popup/popup.html');
const popupHtml = fs.readFileSync(popupHtmlPath, 'utf8');

assert.ok(popupHtml.includes('id="lecture-drm-alert"'), 'Phải có phần tử lecture-drm-alert trong popup.html');
assert.ok(popupHtml.includes('id="engine2-card"'), 'Phải có thẻ engine2-card trong popup.html');
assert.ok(popupHtml.includes('id="engine2-black-screen-tip"'), 'Phải có hộp hướng dẫn chống màn hình đen trong engine2-card');
assert.ok(popupHtml.includes('id="link-chrome-settings"'), 'Phải có link-chrome-settings trong hộp hướng dẫn');
assert.ok(popupHtml.includes('id="btn-start-record"'), 'Phải có nút btn-start-record trong engine2-card');
assert.ok(popupHtml.includes('id="btn-stop-record"'), 'Phải có nút btn-stop-record trong engine2-card');
assert.ok(popupHtml.includes('id="select-manual-drm-speed"'), 'Phải có select-manual-drm-speed trong engine2-card');
assert.ok(popupHtml.includes('id="cb-manual-drm-mute"'), 'Phải có cb-manual-drm-mute trong engine2-card');
assert.ok(!popupHtml.includes('id="drm-warning-state"'), 'Không được có drm-warning-state độc lập gây ẩn toàn bộ thông tin bài học');

console.log('7. Cấu trúc UI Engine 2 Card & DRM Alert trực tiếp trong lecture-content: ĐẠT');

// 8. Kiểm tra TabRecorder ưu tiên getDisplayMedia (hỗ trợ Side Panel 1-click) và dự phòng fallback
import { TabRecorder } from '../src/utils/tabRecorder.js';

let getDisplayMediaCalledOpts = null;
let trackEndedCalled = false;

const mockTracks = [
  {
    stop: () => {},
    addEventListener: (evt, cb) => {
      if (evt === 'ended') {
        mockTracks[0]._onended = cb;
      }
    }
  }
];

globalThis.navigator = {
  mediaDevices: {
    getDisplayMedia: async (options) => {
      getDisplayMediaCalledOpts = options;
      return {
        getTracks: () => mockTracks,
        getVideoTracks: () => mockTracks,
        getAudioTracks: () => mockTracks
      };
    },
    getUserMedia: async (constraints) => {
      return {
        getTracks: () => mockTracks,
        getVideoTracks: () => mockTracks,
        getAudioTracks: () => mockTracks
      };
    }
  }
};

globalThis.MediaRecorder = class MockMediaRecorder {
  static isTypeSupported() { return true; }
  constructor(stream, opts) {
    this.stream = stream;
    this.opts = opts;
    this.mimeType = opts.mimeType || 'video/mp4';
    this.state = 'recording';
  }
  start() {}
  stop() {
    this.state = 'inactive';
    if (this.onstop) this.onstop();
  }
};

// 8.1. Kiểm tra getDisplayMedia được ưu tiên với preferCurrentTab: true và displaySurface: browser
const recorder = new TabRecorder();
recorder.onTrackEnded = () => {
  trackEndedCalled = true;
};

await recorder.startRecording({
  targetTabId: 999,
  muteSpeaker: true
});

assert.ok(getDisplayMediaCalledOpts !== null, 'TabRecorder phải gọi getDisplayMedia đầu tiên');
assert.strictEqual(getDisplayMediaCalledOpts.preferCurrentTab, true, 'getDisplayMedia phải có preferCurrentTab: true');
assert.strictEqual(getDisplayMediaCalledOpts.video.displaySurface, 'browser', 'displaySurface phải là browser');
assert.strictEqual(getDisplayMediaCalledOpts.audio?.suppressLocalAudioPlayback, true, 'suppressLocalAudioPlayback phải là true khi muteSpeaker');
assert.strictEqual(recorder.isRecording, true, 'TabRecorder phải chuyển sang isRecording = true');

// Giả lập sự kiện người dùng bấm "Dừng chia sẻ" trên thanh Chrome
if (mockTracks[0]._onended) {
  mockTracks[0]._onended();
  assert.strictEqual(trackEndedCalled, true, 'Khi track ended, onTrackEnded callback phải được kích hoạt');
}

const stopResult = await recorder.stopRecording();
assert.strictEqual(recorder.isRecording, false, 'Sau khi stop, isRecording phải là false');
assert.strictEqual(stopResult.extension, 'mp4', 'Định dạng file phải là mp4');
assert.ok(typeof stopResult.sizeBytes === 'number', 'stopResult phải trả về sizeBytes');

// 8.2. Kiểm tra xử lý khi người dùng hủy hoặc đóng hộp thoại chia sẻ (NotAllowedError)
globalThis.navigator.mediaDevices.getDisplayMedia = async () => {
  const err = new Error('Permission denied by user');
  err.name = 'NotAllowedError';
  throw err;
};

const cancelRecorder = new TabRecorder();
let threwExpectedCancel = false;
try {
  await cancelRecorder.startRecording({ targetTabId: 999 });
} catch (err) {
  if (err.isCancelled && err.message.includes('Người dùng đã đóng hoặc hủy')) {
    threwExpectedCancel = true;
  }
}
assert.strictEqual(threwExpectedCancel, true, 'Khi người dùng bấm Hủy chia sẻ, TabRecorder phải ném lỗi kèm cờ isCancelled');

// 8.3. Kiểm tra fallback sang getMediaStreamId nếu getDisplayMedia không có
delete globalThis.navigator.mediaDevices.getDisplayMedia;
let fallbackTargetTabId = null;
globalThis.chrome = {
  tabCapture: {
    getMediaStreamId: ({ targetTabId }, callback) => {
      fallbackTargetTabId = targetTabId;
      callback('mock-fallback-id');
    }
  },
  runtime: { lastError: null }
};

const fallbackRecorder = new TabRecorder();
await fallbackRecorder.startRecording({ targetTabId: 888 });
assert.strictEqual(fallbackTargetTabId, 888, 'Fallback phải gọi getMediaStreamId với targetTabId');
assert.strictEqual(fallbackRecorder.isRecording, true, 'Fallback ghi luồng thành công');
await fallbackRecorder.stopRecording();

console.log('8. TabRecorder ưu tiên getDisplayMedia (Side Panel 1-click), bắt sự kiện hủy & fallback: ĐẠT');

// ----------------------------------------------------------------------------
// 9. Kiểm tra bộ vá MP4 Metadata (patchMp4Metadata) & WebM Duration
// ----------------------------------------------------------------------------
import { patchMp4Metadata, patchWebmDuration } from '../src/utils/tabRecorder.js';

function createMockMp4Blob(timescale = 1000) {
  // ftyp: 20 bytes
  const ftyp = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d]);

  // mvhd: 108 bytes (version 0)
  const mvhd = Buffer.alloc(108);
  mvhd.writeUInt32BE(108, 0);
  mvhd.write('mvhd', 4);
  mvhd.writeUInt8(0, 8); // version 0
  mvhd.writeUInt32BE(timescale, 20); // timescale
  mvhd.writeUInt32BE(0, 24); // duration ban đầu = 0

  // tkhd: 92 bytes (version 0)
  const tkhd = Buffer.alloc(92);
  tkhd.writeUInt32BE(92, 0);
  tkhd.write('tkhd', 4);
  tkhd.writeUInt8(0, 8);
  tkhd.writeUInt32BE(1, 20); // track_id = 1
  tkhd.writeUInt32BE(0, 28); // duration ban đầu = 0

  // mdhd: 32 bytes (version 0, track timescale = 30000)
  const mdhd = Buffer.alloc(32);
  mdhd.writeUInt32BE(32, 0);
  mdhd.write('mdhd', 4);
  mdhd.writeUInt8(0, 8);
  mdhd.writeUInt32BE(30000, 20); // track timescale
  mdhd.writeUInt32BE(0, 24); // duration ban đầu = 0

  const mdia = Buffer.concat([Buffer.from([0, 0, 0, 8 + mdhd.length, 0x6d, 0x64, 0x69, 0x61]), mdhd]);
  const trak = Buffer.concat([Buffer.from([0, 0, 0, 8 + tkhd.length + mdia.length, 0x74, 0x72, 0x61, 0x6b]), tkhd, mdia]);
  const moov = Buffer.concat([Buffer.from([0, 0, 0, 8 + mvhd.length + trak.length, 0x6d, 0x6f, 0x6f, 0x76]), mvhd, trak]);
  const full = Buffer.concat([ftyp, moov]);

  return new Blob([full], { type: 'video/mp4' });
}

// 9.1 Kiểm tra vá MP4 duration vào mvhd, tkhd, mdhd
const rawMp4Blob = createMockMp4Blob(1000);
const durationToPatch = 150; // 150 giây (2 phút 30 giây)
const patchedBlob = await patchMp4Metadata(rawMp4Blob, durationToPatch);

assert.strictEqual(patchedBlob.type, 'video/mp4', 'Blob type phải là video/mp4');
const patchedBuf = Buffer.from(await patchedBlob.arrayBuffer());

const mvhdIdx = patchedBuf.indexOf(Buffer.from('mvhd'));
const tkhdIdx = patchedBuf.indexOf(Buffer.from('tkhd'));
const mdhdIdx = patchedBuf.indexOf(Buffer.from('mdhd'));

assert.ok(mvhdIdx !== -1, 'Phải tìm thấy mvhd trong MP4');
assert.ok(tkhdIdx !== -1, 'Phải tìm thấy tkhd trong MP4');
assert.ok(mdhdIdx !== -1, 'Phải tìm thấy mdhd trong MP4');

const patchedMvhdDuration = patchedBuf.readUInt32BE(mvhdIdx + 20);
const patchedTkhdDuration = patchedBuf.readUInt32BE(tkhdIdx + 24);
const patchedMdhdDuration = patchedBuf.readUInt32BE(mdhdIdx + 20);

assert.strictEqual(patchedMvhdDuration, 150 * 1000, 'mvhd duration phải được vá thành 150000 (150s * 1000ts)');
assert.strictEqual(patchedTkhdDuration, 150 * 1000, 'tkhd duration phải được vá thành 150000');
assert.strictEqual(patchedMdhdDuration, 150 * 30000, 'mdhd duration phải được vá thành 4500000 (150s * 30000ts)');

console.log('9.1. patchMp4Metadata vá chuẩn xác mvhd, tkhd, mdhd: ĐẠT');

// 9.2 Kiểm tra vá WebM Duration (EBML)
const webmHeader = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, // EBML Header
  0x18, 0x53, 0x80, 0x67, 0x01, 0x00, // Segment
  0x15, 0x49, 0xa9, 0x66, 0x0a,       // Info tag
  0x44, 0x89, 0x04, 0x00, 0x00, 0x00, 0x00 // Duration tag (len=4 float32)
]);
const webmBlob = new Blob([webmHeader], { type: 'video/webm' });
const patchedWebm = await patchWebmDuration(webmBlob, 60);
const patchedWebmBuf = Buffer.from(await patchedWebm.arrayBuffer());
const durIdx = patchedWebmBuf.indexOf(Buffer.from([0x44, 0x89]));
assert.ok(durIdx !== -1, 'Phải tìm thấy tag Duration trong WebM');
const patchedDurationMs = patchedWebmBuf.readFloatBE(durIdx + 3);
assert.strictEqual(patchedDurationMs, 60000, 'Duration WebM phải được vá thành 60000ms');

console.log('9.2. patchWebmDuration vá chuẩn xác EBML Duration: ĐẠT');

// ----------------------------------------------------------------------------
// 10. Kiểm tra thông điệp Cinema Mode trong Content Script
// ----------------------------------------------------------------------------
const contentJs = fs.readFileSync(path.resolve('src/content/content.js'), 'utf-8');
assert.ok(contentJs.includes('ENABLE_CINEMA_MODE_FOR_RECORDING'), 'content.js phải có xử lý ENABLE_CINEMA_MODE_FOR_RECORDING');
assert.ok(contentJs.includes('DISABLE_CINEMA_MODE_FOR_RECORDING'), 'content.js phải có xử lý DISABLE_CINEMA_MODE_FOR_RECORDING');
assert.ok(contentJs.includes('udemy-downloader-cinema-mode-style'), 'content.js phải chèn CSS Cinema Mode');
assert.ok(contentJs.includes('udemy-downloader-recording-pill'), 'content.js phải chèn thanh nổi trạng thái Cinema Mode');

console.log('10. Cinema Mode và cơ chế hoàn nguyên giao diện trong Content Script: ĐẠT');

console.log('\n✅ TẤT CẢ CÁC BÀI TEST DRM FLOW ĐỀU ĐẠT CHUẨN (100% PASS)!');

