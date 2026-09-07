/**
 * Sanitizer Utilities
 * Làm sạch ký tự không hợp lệ trong tên file/thư mục trên Windows và macOS/Linux.
 */

// Ký tự cấm trên Windows: \ / : * ? " < > | cùng các ký tự điều khiển (0-31)
const ILLEGAL_CHARS_REGEX = /[\/\?<>\\:\*\|":]/g;
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x80-\x9f]/g;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Làm sạch tiêu đề bài giảng, loại bỏ các nhãn trạng thái như "Chưa hoàn thành", "Hoàn thành", thời lượng...
 * @param {string} rawTitle 
 * @returns {{ title: string, index: number|null }}
 */
export function cleanLectureTitle(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') {
    return { title: 'Lesson', index: null };
  }

  let cleaned = rawTitle
    .replace(/(?:Chưa\s+hoàn\s+thành|Hoàn\s+thành|Incomplete|Completed|Uncompleted)/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ') // Bỏ thời lượng như 08:35 hoặc 1:12:40
    .replace(/\b\d+\s*(?:phút|min|giây|sec)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Tìm số thứ tự ở đầu bài: ví dụ "15. ", "15 - ", "Bài 15: ", "Lecture 15: "
  let index = null;
  const indexMatch = cleaned.match(/^(?:bài|lecture|section)?\s*(\d+)[\.\s\-:]+/i);
  if (indexMatch) {
    index = parseInt(indexMatch[1], 10);
    cleaned = cleaned.substring(indexMatch[0].length).trim();
  }

  // Làm sạch các ký tự phân cách còn thừa ở đầu
  cleaned = cleaned.replace(/^[\.\s\-:]+/, '').trim();

  return {
    title: cleaned || 'Lesson',
    index
  };
}

/**
 * Làm sạch một đoạn tên file hoặc tên thư mục
 * @param {string} input 
 * @param {string} fallback 
 * @returns {string}
 */
export function sanitizeName(input, fallback = 'untitled') {
  if (!input || typeof input !== 'string') {
    return fallback;
  }

  let cleaned = input
    .trim()
    .replace(ILLEGAL_CHARS_REGEX, '-')
    .replace(CONTROL_CHARS_REGEX, '')
    .replace(/\s+/g, ' '); // Gộp nhiều khoảng trắng thành 1

  // Loại bỏ các dấu chấm và khoảng trắng ở đầu và cuối (Windows cấm file kết thúc bằng dấu chấm)
  cleaned = cleaned.replace(/^[\.\s]+/, '').replace(/[\.\s]+$/, '');

  // Tránh các tên thiết bị đặc biệt trên Windows (CON, NUL, AUX, PRN, COM1...)
  if (RESERVED_WINDOWS_NAMES.test(cleaned)) {
    cleaned = `${cleaned}_file`;
  }

  // Giới hạn độ dài để tránh vượt quá MAX_PATH (260 ký tự)
  if (cleaned.length > 120) {
    cleaned = cleaned.substring(0, 120).trim().replace(/[\.\s]+$/, '');
  }

  return cleaned || fallback;
}

/**
 * Định dạng số thứ tự (ví dụ: 1 -> "001", 12 -> "012")
 * @param {number|string} num 
 * @param {number} digits 
 * @returns {string}
 */
export function padIndex(num, digits = 3) {
  const n = parseInt(num, 10);
  if (isNaN(n)) return '001';
  return String(n).padStart(digits, '0');
}

/**
 * Xây dựng đường dẫn file tải về: Chuẩn "[Index] - [Tên bài].[ext]" (Không gắn tag độ phân giải thừa)
 * @param {Object} params
 * @param {string} params.baseFolder - Thư mục cơ sở tùy chỉnh (ví dụ: "Udemy Courses")
 * @param {string} params.courseTitle - Tên khóa học
 * @param {number|string} params.lectureIndex - Số thứ tự bài giảng
 * @param {string} params.lectureTitle - Tên bài giảng
 * @param {string} params.extension - Đuôi file ("mp4", "srt", "pdf"...)
 * @param {string} params.subDir - Thư mục con bổ sung nếu có (ví dụ: "Tài liệu")
 * @returns {string} Đường dẫn tương đối chuẩn cho chrome.downloads
 */
export function buildDownloadPath({
  baseFolder = 'Udemy Courses',
  courseTitle = 'Course',
  lectureIndex = 1,
  lectureTitle = 'Lecture',
  extension = 'mp4',
  subDir = ''
}) {
  const parts = [];

  // 1. Thư mục cơ sở (Base folder)
  const cleanBase = sanitizeName(baseFolder, '');
  if (cleanBase) {
    parts.push(cleanBase);
  }

  // 2. Thư mục khóa học (Course folder)
  const cleanCourse = sanitizeName(courseTitle, 'Udemy Course');
  parts.push(cleanCourse);

  // 3. Thư mục con đặc biệt (ví dụ Tài liệu)
  if (subDir) {
    const cleanSubDir = sanitizeName(subDir, '');
    if (cleanSubDir) {
      parts.push(cleanSubDir);
    }
  }

  // 4. Tên file: Chuẩn xác "[Index] - [Tên bài].[ext]" (Video và Phụ đề có tên khớp nhau 100%)
  const cleanedMeta = cleanLectureTitle(lectureTitle);
  const finalIndex = cleanedMeta.index || lectureIndex;
  const indexStr = padIndex(finalIndex);
  const cleanTitle = sanitizeName(cleanedMeta.title, 'Lesson');
  const cleanExt = extension.replace(/^\./, '').trim() || 'mp4';

  const fileName = `${indexStr} - ${cleanTitle}.${cleanExt}`;
  parts.push(fileName);

  return parts.join('/');
}
