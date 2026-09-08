import assert from 'node:assert';

console.log('--- BẮT ĐẦU KIỂM TRA LECTURE TRANSITION & ANTI-FLAPPING ---');

// 1. Phân tích URL: hỗ trợ lecture, quiz, practice
function parseLectureId(pathname) {
  const m = pathname.match(/\/(?:lecture|quiz|practice)\/(\d+)/);
  return m ? m[1] : null;
}
assert.strictEqual(parseLectureId('/course/fullstack/learn/lecture/101'), '101');
assert.strictEqual(parseLectureId('/course/fullstack/learn/quiz/102'), '102');
assert.strictEqual(parseLectureId('/course/fullstack/learn/practice/103'), '103');
console.log('1. Phân tích URL đa dạng (Lecture/Quiz/Practice): ĐẠT');

// 2. Kiểm tra ID Validation chống nhận nhầm bài cũ
function isPayloadValidForCurrentPage(currentPageId, payloadId) {
  if (currentPageId && payloadId && String(currentPageId) !== String(payloadId)) {
    return false;
  }
  return true;
}
assert.strictEqual(isPayloadValidForCurrentPage('102', '101'), false, 'Gói tin bài cũ 101 phải bị từ chối');
assert.strictEqual(isPayloadValidForCurrentPage('102', '102'), true, 'Gói tin bài hiện tại 102 phải được nhận');
console.log('2. ID Validation chống nhận nhầm bài cũ: ĐẠT');

// 3. Kiểm tra Epoch Invalidation chống bất đồng bộ trả về lệch thứ tự
class SessionManager {
  constructor() {
    this.currentEpoch = 0;
    this.currentLecture = null;
  }
  startTransition(newId) {
    this.currentEpoch++;
    this.currentLecture = null;
    return this.currentEpoch;
  }
  resolveData(epoch, data) {
    if (epoch !== this.currentEpoch) return false;
    this.currentLecture = data;
    return true;
  }
}
const sm = new SessionManager();
const epochA = sm.startTransition('101');
const epochB = sm.startTransition('102');
assert.strictEqual(sm.resolveData(epochA, { id: '101' }), false, 'Epoch cũ A không được phép ghi đè');
assert.strictEqual(sm.resolveData(epochB, { id: '102' }), true, 'Epoch mới B được phép ghi đè');
assert.strictEqual(sm.currentLecture.id, '102');
console.log('3. Quản lý Epoch & Sequence Token: ĐẠT');

// 4. Kiểm tra Chống reset lặp lại khi cùng 1 bài giảng (Nguyên nhân gây kẹt loading)
class SafeTransitionManager {
  constructor() {
    this.currentEpoch = 0;
    this.lastMonitoredLectureId = null;
    this.currentLecture = null;
  }
  handleLectureTransition(newId) {
    if (!newId) return this.currentEpoch;
    // Nếu cùng 1 ID bài giảng, TUYỆT ĐỐI không được reset hay tăng epoch
    if (this.lastMonitoredLectureId === String(newId)) {
      return this.currentEpoch;
    }
    this.currentEpoch++;
    this.lastMonitoredLectureId = String(newId);
    this.currentLecture = null;
    return this.currentEpoch;
  }
}

const stm = new SafeTransitionManager();
const ep1 = stm.handleLectureTransition('101');
assert.strictEqual(ep1, 1);
assert.strictEqual(stm.lastMonitoredLectureId, '101');

// Kích hoạt transition lặp lại cho cùng 1 ID (ví dụ khi popup mở hoặc interval chạy)
const ep1_repeat = stm.handleLectureTransition('101');
assert.strictEqual(ep1_repeat, 1, 'Epoch không được phép tăng khi vẫn ở cùng bài 101');
assert.strictEqual(stm.currentEpoch, 1, 'Epoch phải giữ nguyên để không hủy fetch đang chạy');

// Chuyển sang bài mới 102
const ep2 = stm.handleLectureTransition('102');
assert.strictEqual(ep2, 2, 'Epoch phải tăng khi thực sự chuyển sang bài mới 102');
assert.strictEqual(stm.lastMonitoredLectureId, '102');
console.log('4. Chống reset lặp lại khi cùng 1 bài giảng (Chống kẹt loading): ĐẠT');

console.log('=== TẤT CẢ TEST TRANSITION ĐÃ VƯỢT QUA XUẤT SẮC ===');

