import assert from 'node:assert';
import { convertVttToSrt } from '../src/utils/vtt2srt.js';
import { sanitizeName, padIndex, buildDownloadPath, cleanLectureTitle, cleanSectionTitle } from '../src/utils/sanitizer.js';

console.log('--- BẮT ĐẦU KIỂM TRA UTILS ---');

// 1. Kiểm tra WebVTT to SRT Converter
console.log('1. Kiểm tra WebVTT to SRT Converter...');
const sampleVtt = `WEBVTT
Kind: captions
Language: en

STYLE
::cue { color: yellow; }

1
00:00:01.500 --> 00:00:04.200
Hello <v Speaker>World</v> &amp; welcome!

2
01:23.050 --> 01:25.800
This is a test <i>caption</i>.
`;

const expectedSrt = `1
00:00:01,500 --> 00:00:04,200
Hello World & welcome!

2
00:01:23,050 --> 00:01:25,800
This is a test caption.
`;

const resultSrt = convertVttToSrt(sampleVtt);
assert.strictEqual(resultSrt.trim(), expectedSrt.trim(), 'Nội dung SRT không khớp!');
console.log('-> convertVttToSrt: ĐẠT');

// 2. Kiểm tra cleanLectureTitle (Loại bỏ nhãn 'Chưa hoàn thành', thời lượng...)
console.log('2. Kiểm tra cleanLectureTitle...');
const t1 = cleanLectureTitle('Chưa hoàn thành 15. Cài đặt môi trường 08:35');
assert.strictEqual(t1.title, 'Cài đặt môi trường', 'Phải bỏ được Chưa hoàn thành và thời lượng');
assert.strictEqual(t1.index, 15, 'Số thứ tự bài phải là 15');

const t2 = cleanLectureTitle('Hoàn thành Bài 2: Biến và Kiểu dữ liệu');
assert.strictEqual(t2.title, 'Biến và Kiểu dữ liệu', 'Phải bỏ được Hoàn thành và tiền tố');
assert.strictEqual(t2.index, 2, 'Số thứ tự bài phải là 2');
console.log('-> cleanLectureTitle: ĐẠT');

// 3. Kiểm tra Tên Video và Tên Phụ đề trùng khớp 100% (không có tag [1080p])
console.log('3. Kiểm tra Tên Video và Phụ đề đồng bộ...');
const videoPath = buildDownloadPath({
  baseFolder: 'Udemy Courses',
  courseTitle: 'Python 101',
  lectureIndex: 1,
  lectureTitle: 'Chưa hoàn thành 15. Cài đặt môi trường 08:35',
  extension: 'mp4'
});

const subPath = buildDownloadPath({
  baseFolder: 'Udemy Courses',
  courseTitle: 'Python 101',
  lectureIndex: 1,
  lectureTitle: 'Chưa hoàn thành 15. Cài đặt môi trường 08:35',
  extension: 'srt'
});

assert.strictEqual(
  videoPath,
  'Udemy Courses/Python 101/015 - Cài đặt môi trường.mp4',
  'Tên video không được chứa tag [1080p]'
);

assert.strictEqual(
  subPath,
  'Udemy Courses/Python 101/015 - Cài đặt môi trường.srt',
  'Tên phụ đề phải khớp 100% với tên video (chỉ khác đuôi .srt)'
);
console.log('-> Đồng bộ Video & Subtitles: ĐẠT');

// 4. Kiểm tra Lọc Phụ đề Tiếng Anh chuyên dụng (Chỉ lấy English, ưu tiên Manual, không lấy thứ tiếng khác)
console.log('4. Kiểm tra Lọc Phụ đề Tiếng Anh...');
const sampleCaptions = [
  { id: '1', label: 'Español', locale: 'es', url: 'http://example.com/es.vtt' },
  { id: '2', label: 'English [Auto]', locale: 'en', url: 'http://example.com/en_auto.vtt' },
  { id: '3', label: 'English', locale: 'en_US', url: 'http://example.com/en_manual.vtt' },
  { id: '4', label: 'Français', locale: 'fr', url: 'http://example.com/fr.vtt' }
];

function findEnglishCaptionTest(captions) {
  if (!captions || !captions.length) return null;
  const manualEn = captions.find(c => {
    const loc = (c.locale || '').toLowerCase();
    const lbl = (c.label || '').toLowerCase();
    const isEn = loc === 'en' || loc === 'en_us' || loc === 'en-us' || loc === 'en_gb' || loc === 'en-gb' || lbl.includes('english') || lbl === 'en';
    const isAuto = lbl.includes('auto') || lbl.includes('tự động');
    return isEn && !isAuto;
  });
  if (manualEn) return manualEn;
  const autoEn = captions.find(c => {
    const loc = (c.locale || '').toLowerCase();
    const lbl = (c.label || '').toLowerCase();
    return loc === 'en' || loc === 'en_us' || loc === 'en-us' || loc === 'en_gb' || loc === 'en-gb' || lbl.includes('english') || lbl.includes('tiếng anh') || lbl === 'en';
  });
  if (autoEn) return autoEn;
  return null;
}

const chosen = findEnglishCaptionTest(sampleCaptions);
assert.strictEqual(chosen.label, 'English', 'Phải ưu tiên bản English của giảng viên');

const onlyForeign = [
  { id: '1', label: 'Español', locale: 'es', url: 'http://example.com/es.vtt' },
  { id: '2', label: 'Deutsch', locale: 'de', url: 'http://example.com/de.vtt' }
];
assert.strictEqual(findEnglishCaptionTest(onlyForeign), null, 'Nếu không có English thì phải trả về null');

// 5. Kiểm tra Làm sạch tiêu đề Phần cha (Section) và đường dẫn lồng thư mục
console.log('5. Kiểm tra Làm sạch Section & Thư mục lồng...');
const s1 = cleanSectionTitle('Section 1: Introduction 0 / 5 | 22min');
assert.strictEqual(s1, 'Section 01 - Introduction', 'Section 1 phải định dạng chuẩn');

const s2 = cleanSectionTitle('Phần 3: Cài đặt công cụ 1 / 4 | 30 phút');
assert.strictEqual(s2, 'Phần 03 - Cài đặt công cụ', 'Phần 3 tiếng Việt phải định dạng chuẩn');

const s3 = cleanSectionTitle('Chapter 5: Advanced Python');
assert.strictEqual(s3, 'Chapter 05 - Advanced Python', 'Chapter 5 phải định dạng chuẩn');

const s4 = cleanSectionTitle('Getting Started', 2);
assert.strictEqual(s4, 'Section 02 - Getting Started', 'Section không prefix từ API phải được thêm số thứ tự');

const nestedVideoPath = buildDownloadPath({
  baseFolder: 'Udemy Courses',
  courseTitle: 'Fullstack Course',
  sectionTitle: s1,
  lectureIndex: 1,
  lectureTitle: '01. Welcome to course',
  extension: 'mp4'
});
assert.strictEqual(
  nestedVideoPath,
  'Udemy Courses/Fullstack Course/Section 01 - Introduction/001 - Welcome to course.mp4',
  'Đường dẫn video phải chứa thư mục phần cha'
);

const nestedSubPath = buildDownloadPath({
  baseFolder: 'Udemy Courses',
  courseTitle: 'Fullstack Course',
  sectionTitle: s1,
  lectureIndex: 1,
  lectureTitle: '01. Welcome to course',
  extension: 'srt'
});
assert.strictEqual(
  nestedSubPath,
  'Udemy Courses/Fullstack Course/Section 01 - Introduction/001 - Welcome to course.srt',
  'Đường dẫn phụ đề phải chứa thư mục phần cha và trùng khớp video'
);
console.log('-> Xử lý Thư mục Phần cha (Section): ĐẠT');

console.log('=== TẤT CẢ TEST ĐÃ VƯỢT QUA XUẤT SẮC ===');
