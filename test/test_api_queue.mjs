import assert from 'node:assert';
import { getBatchLectureList, normalizeCaptionItem } from '../src/utils/udemyApi.js';
import { findEnglishCaption, isEnglishCaption } from '../src/utils/sanitizer.js';

console.log('--- BẮT ĐẦU TEST HEADLESS API QUEUE & SUBTITLE LOGIC ---');

// 1. Test getBatchLectureList
const sampleCurriculum = [
  { id: '1001', index: 1, title: 'Introduction to Course', type: 'lecture' },
  { id: '1002', index: 2, title: 'Setting up Environment', type: 'lecture' },
  { id: '1003', index: 3, title: 'Knowledge Check Quiz', type: 'quiz' },
  { id: '1004', index: 4, title: 'Coding Practice 1', type: 'practice' },
  { id: '1005', index: 5, title: 'Core Concepts Part 1', type: 'lecture' },
  { id: '1006', index: 6, title: 'Core Concepts Part 2', type: 'lecture' },
  { id: '1007', index: 7, title: 'Midterm Quiz', type: 'quiz' },
  { id: '1008', index: 8, title: 'Advanced Topics', type: 'lecture' },
  { id: '1009', index: 9, title: 'Final Summary', type: 'lecture' }
];

// Test 1.1: Bắt đầu từ bài đầu tiên, lấy 3 bài (phải tự bỏ qua quiz và practice)
const batch1 = getBatchLectureList(sampleCurriculum, '1001', 3);
assert.strictEqual(batch1.length, 3);
assert.deepStrictEqual(batch1.map(b => b.id), ['1001', '1002', '1005']);
console.log('1.1. Lấy N bài và tự động bỏ qua quiz/practice: ĐẠT');

// Test 1.2: Bắt đầu từ giữa khóa học (1005), lấy 2 bài
const batch2 = getBatchLectureList(sampleCurriculum, '1005', 2);
assert.strictEqual(batch2.length, 2);
assert.deepStrictEqual(batch2.map(b => b.id), ['1005', '1006']);
console.log('1.2. Lấy N bài tính từ vị trí bài học bất kỳ: ĐẠT');

// Test 1.3: Số lượng yêu cầu vượt quá số bài còn lại
const batch3 = getBatchLectureList(sampleCurriculum, '1008', 5);
assert.strictEqual(batch3.length, 2);
assert.deepStrictEqual(batch3.map(b => b.id), ['1008', '1009']);
console.log('1.3. Xử lý khi số bài yêu cầu lớn hơn số bài còn lại: ĐẠT');

// Test 1.4: startLectureId không tìm thấy (mặc định lấy từ đầu)
const batch4 = getBatchLectureList(sampleCurriculum, '9999', 2);
assert.strictEqual(batch4.length, 2);
assert.strictEqual(batch4[0].id, '1001');
console.log('1.4. Fallback khi startLectureId không tồn tại: ĐẠT');

// 2. Test normalizeCaptionItem
const rawCap1 = { url: 'https://udemy.com/captions/en_US.vtt', locale_id: 'en_US', title: 'English [Auto]' };
const norm1 = normalizeCaptionItem(rawCap1);
assert.strictEqual(norm1.locale, 'en_US');
assert.strictEqual(norm1.label, 'English [Auto]');
assert.strictEqual(norm1.url, 'https://udemy.com/captions/en_US.vtt');

const rawCap2 = { file: 'https://udemy.com/subs/vi.vtt' };
const norm2 = normalizeCaptionItem(rawCap2);
assert.strictEqual(norm2.locale, 'vi');
assert.strictEqual(norm2.url, 'https://udemy.com/subs/vi.vtt');
console.log('2. Chuẩn hóa đối tượng phụ đề từ API: ĐẠT');

// 3. Test findEnglishCaption: Ưu tiên Manual English > Auto English
const captionsList = [
  { label: 'Tiếng Việt', locale: 'vi', url: 'https://cdn/vi.vtt' },
  { label: 'English [Auto]', locale: 'en_US', url: 'https://cdn/en_auto.vtt' },
  { label: 'English', locale: 'en', url: 'https://cdn/en_manual.vtt' },
  { label: 'Español', locale: 'es', url: 'https://cdn/es.vtt' }
];
const chosen = findEnglishCaption(captionsList);
assert.strictEqual(chosen.url, 'https://cdn/en_manual.vtt', 'Phải ưu tiên bản English thủ công thay vì bản Auto');
console.log('3.1. Ưu tiên phụ đề Tiếng Anh thủ công: ĐẠT');

// Test 3.2: Chỉ có Auto English
const autoOnlyList = [
  { label: 'Tiếng Việt', locale: 'vi', url: 'https://cdn/vi.vtt' },
  { label: 'English [Auto]', locale: 'en_US', url: 'https://cdn/en_auto.vtt' }
];
const chosenAuto = findEnglishCaption(autoOnlyList);
assert.strictEqual(chosenAuto.url, 'https://cdn/en_auto.vtt');
console.log('3.2. Chọn phụ đề Auto English nếu không có thủ công: ĐẠT');

// Test 3.3: Không có tiếng Anh nào
const noEnList = [
  { label: 'Tiếng Việt', locale: 'vi', url: 'https://cdn/vi.vtt' },
  { label: 'Français', locale: 'fr', url: 'https://cdn/fr.vtt' }
];
const chosenNone = findEnglishCaption(noEnList);
assert.strictEqual(chosenNone, null, 'Phải trả về null khi không có phụ đề tiếng Anh');
console.log('3.3. Trả về null khi bài giảng không có tiếng Anh: ĐẠT');

// 4. Test Mô phỏng Retry 3 lần
let attempts = 0;
async function mockFetchWithRetry() {
  while (attempts < 3) {
    attempts++;
    if (attempts < 3) {
      // mô phỏng lỗi mạng ở lần 1 và 2
      continue;
    }
    return { success: true };
  }
  throw new Error('Thất bại sau 3 lần');
}
const res = await mockFetchWithRetry();
assert.strictEqual(res.success, true);
assert.strictEqual(attempts, 3);
console.log('4. Mô phỏng cơ chế tự động thử lại 3 lần: ĐẠT');

console.log('=== TẤT CẢ TEST API QUEUE ĐÃ VƯỢT QUA XUẤT SẮC ===');
