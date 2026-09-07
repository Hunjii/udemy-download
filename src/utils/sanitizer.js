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
 * Làm sạch và định dạng tiêu đề phần cha (Section / Chapter / Phần)
 * Chuẩn hóa thành: "Section 01 - [Tên phần]" hoặc "Phần 01 - [Tên phần]"
 * @param {string} rawSectionTitle 
 * @param {number|string} [sectionIndex]
 * @returns {string}
 */
export function cleanSectionTitle(rawSectionTitle, sectionIndex = null) {
  if (!rawSectionTitle || typeof rawSectionTitle !== 'string') {
    if (sectionIndex) {
      return `Section ${padIndex(sectionIndex, 2)}`;
    }
    return '';
  }

  // 1. Loại bỏ các nhãn trạng thái và thời lượng
  let cleaned = rawSectionTitle
    .replace(/(?:Chưa\s+hoàn\s+thành|Hoàn\s+thành|Incomplete|Completed|Uncompleted)/gi, ' ')
    .replace(/\b\d+\s*\/\s*\d+\b/g, ' ') // bỏ "0 / 5" hoặc "3/8"
    .replace(/\|\s*.*$/g, '')             // bỏ "| 22min"
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\b\d+\s*(?:phút|min|hr|h|giây|sec)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 2. Nhận diện tiền tố: Section, Phần, Chapter, Chương...
  const prefixMatch = cleaned.match(/^(section|phần|chapter|chương)?\s*(\d+)[\.\s\-:]+/i);
  let finalIndex = sectionIndex ? parseInt(sectionIndex, 10) : null;
  let prefixWord = 'Section';

  if (prefixMatch) {
    if (prefixMatch[1]) {
      prefixWord = prefixMatch[1].charAt(0).toUpperCase() + prefixMatch[1].slice(1).toLowerCase();
    }
    finalIndex = parseInt(prefixMatch[2], 10);
    cleaned = cleaned.substring(prefixMatch[0].length).trim();
  }

  cleaned = cleaned.replace(/^[\.\s\-:]+/, '').trim();

  if (finalIndex) {
    const idxStr = padIndex(finalIndex, 2);
    if (cleaned) {
      return `${prefixWord} ${idxStr} - ${sanitizeName(cleaned, 'Chapter')}`;
    }
    return `${prefixWord} ${idxStr}`;
  }

  return sanitizeName(cleaned, '');
}

/**
 * Xây dựng đường dẫn file tải về: Chuẩn "[Base]/[Course]/[Section]/[Index] - [Tên bài].[ext]"
 * @param {Object} params
 * @param {string} params.baseFolder - Thư mục cơ sở tùy chỉnh (ví dụ: "Udemy Courses")
 * @param {string} params.courseTitle - Tên khóa học
 * @param {string} [params.sectionTitle] - Tên phần / chương cha
 * @param {number|string} params.lectureIndex - Số thứ tự bài giảng
 * @param {string} params.lectureTitle - Tên bài giảng
 * @param {string} params.extension - Đuôi file ("mp4", "srt", "pdf"...)
 * @param {string} params.subDir - Thư mục con bổ sung nếu có (ví dụ: "Tài liệu")
 * @returns {string} Đường dẫn tương đối chuẩn cho chrome.downloads
 */
export function buildDownloadPath({
  baseFolder = 'Udemy Courses',
  courseTitle = 'Course',
  sectionTitle = '',
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

  // 3. Thư mục phần cha (Section / Chapter folder) nếu có
  if (sectionTitle) {
    const cleanSection = sanitizeName(sectionTitle, '');
    if (cleanSection) {
      parts.push(cleanSection);
    }
  }

  // 4. Thư mục con đặc biệt (ví dụ Tài liệu)
  if (subDir) {
    const cleanSubDir = sanitizeName(subDir, '');
    if (cleanSubDir) {
      parts.push(cleanSubDir);
    }
  }

  // 5. Tên file: Chuẩn xác "[Index] - [Tên bài].[ext]" (Video và Phụ đề có tên khớp nhau 100%)
  const cleanedMeta = cleanLectureTitle(lectureTitle);
  const finalIndex = cleanedMeta.index || lectureIndex;
  const indexStr = padIndex(finalIndex);
  const cleanTitle = sanitizeName(cleanedMeta.title, 'Lesson');
  const cleanExt = extension.replace(/^\./, '').trim() || 'mp4';

  const fileName = `${indexStr} - ${cleanTitle}.${cleanExt}`;
  parts.push(fileName);

  return parts.join('/');
}

/**
 * Kiểm tra xem một đối tượng phụ đề có phải là Tiếng Anh hay không
 * @param {object} c
 * @returns {boolean}
 */
export function isEnglishCaption(c) {
  if (!c) return false;
  const loc = (c.locale || '').toLowerCase().replace(/_/g, '-');
  const lbl = (c.label || '').toLowerCase();
  const url = (c.url || '').toLowerCase();

  // 1. Kiểm tra locale (en, en-us, en-gb, en-ca, en-au, eng, etc.)
  if (loc === 'en' || loc.startsWith('en-') || loc.startsWith('en_') || loc === 'eng') {
    return true;
  }

  // 2. Kiểm tra nhãn label
  if (lbl.includes('english') || lbl.includes('tiếng anh') || /\beng?\b/i.test(lbl)) {
    return true;
  }

  // 3. Kiểm tra URL (en_US.vtt, en-US.vtt, /en/, locale_id=en, locale=en)
  if (/[\b_\/\-\.]en(?:[-_]us|[-_]gb|[-_]ca|[-_]au)?[\b_\/\-\.]/i.test(url) || 
      url.includes('locale_id=en') || 
      url.includes('locale=en') || 
      url.includes('/en/')) {
    return true;
  }

  return false;
}

/**
 * Tự động tìm và chỉ lấy tùy chọn tải phụ đề Tiếng Anh (Ưu tiên Manual > Auto > Fallback duy nhất 1 track)
 * @param {Array<object>} captions
 * @returns {object|null}
 */
export function findEnglishCaption(captions) {
  if (!captions || !captions.length) return null;

  // 1. Lọc tất cả các track tiếng Anh
  const enCandidates = captions.filter(isEnglishCaption);

  if (enCandidates.length > 0) {
    // Ưu tiên bản do người tạo (manual, không gắn nhãn auto / tự động)
    const manualEn = enCandidates.find(c => {
      const lbl = (c.label || '').toLowerCase();
      return !lbl.includes('auto') && !lbl.includes('tự động');
    });
    return manualEn || enCandidates[0];
  }

  // 2. Fallback: Nếu bài giảng chỉ có DUY NHẤT 1 track phụ đề và không phải thứ tiếng khác rõ ràng
  if (captions.length === 1) {
    const single = captions[0];
    const loc = (single.locale || '').toLowerCase();
    const NON_EN = ['vi', 'es', 'fr', 'de', 'zh', 'ja', 'pt', 'ru', 'ko', 'it', 'ar', 'hi', 'tr', 'pl', 'nl', 'id'];
    const isOther = NON_EN.some(lang => loc.startsWith(lang));
    if (!isOther) {
      return single;
    }
  }

  return null;
}

