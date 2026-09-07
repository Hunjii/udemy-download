/**
 * WebVTT to SubRip (.srt) Converter
 * Chuyển đổi định dạng phụ đề WebVTT từ máy chủ Udemy sang định dạng SRT phổ biến.
 */

/**
 * Chuẩn hóa timestamp thành định dạng SRT: 00:00:00,000
 * @param {string} timestamp - ví dụ: "01:23.456" hoặc "00:01:23.456"
 * @returns {string} ví dụ: "00:01:23,456"
 */
function formatSrtTimestamp(timestamp) {
  let [timePart, msPart = '000'] = timestamp.trim().split('.');
  msPart = msPart.padEnd(3, '0').substring(0, 3);

  const parts = timePart.split(':');
  let hours = '00';
  let minutes = '00';
  let seconds = '00';

  if (parts.length === 3) {
    hours = parts[0].padStart(2, '0');
    minutes = parts[1].padStart(2, '0');
    seconds = parts[2].padStart(2, '0');
  } else if (parts.length === 2) {
    minutes = parts[0].padStart(2, '0');
    seconds = parts[1].padStart(2, '0');
  }

  return `${hours}:${minutes}:${seconds},${msPart}`;
}

/**
 * Chuyển đổi toàn bộ nội dung chuỗi WebVTT sang chuỗi SRT
 * @param {string} vttContent 
 * @returns {string} Nội dung SRT
 */
export function convertVttToSrt(vttContent) {
  if (!vttContent || typeof vttContent !== 'string') {
    return '';
  }

  // Chuẩn hóa ký tự ngắt dòng
  const cleanContent = vttContent.replace(/\r\n|\r/g, '\n');
  const lines = cleanContent.split('\n');

  const srtBlocks = [];
  let currentCue = null;
  let cueIndex = 1;
  let inStyleOrNote = false;

  // Regex nhận diện dòng timestamp WebVTT:
  // ví dụ: "00:00:01.000 --> 00:00:04.000" hoặc "00:01.000 --> 00:04.000"
  const timestampRegex = /((?:\d{1,2}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}\.\d{3})/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Bỏ qua header WEBVTT
    if (line.startsWith('WEBVTT') || line.startsWith('Kind:') || line.startsWith('Language:')) {
      continue;
    }

    // Bỏ qua khối STYLE hoặc NOTE
    if (line.startsWith('STYLE') || line.startsWith('NOTE')) {
      inStyleOrNote = true;
      continue;
    }

    if (inStyleOrNote) {
      if (line === '') {
        inStyleOrNote = false;
      }
      continue;
    }

    const match = line.match(timestampRegex);
    if (match) {
      // Nếu đã có cue trước đó đang tích lũy nội dung, đẩy vào danh sách
      if (currentCue) {
        srtBlocks.push(currentCue);
      }

      const startTime = formatSrtTimestamp(match[1]);
      const endTime = formatSrtTimestamp(match[2]);

      currentCue = {
        index: cueIndex++,
        time: `${startTime} --> ${endTime}`,
        textLines: []
      };
    } else if (currentCue) {
      if (line === '') {
        // Kết thúc một cue
        srtBlocks.push(currentCue);
        currentCue = null;
      } else {
        // Làm sạch các thẻ HTML WebVTT như <v Name>, <c.color>, ...
        const cleanedText = line
          .replace(/<[^>]+>/g, '')
          .replace(/&rlm;|&lrm;/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');

        if (cleanedText) {
          currentCue.textLines.push(cleanedText);
        }
      }
    }
  }

  // Nếu còn cue cuối cùng chưa đẩy
  if (currentCue) {
    srtBlocks.push(currentCue);
  }

  // Kết xuất thành chuỗi SRT hoàn chỉnh
  return srtBlocks
    .map(cue => `${cue.index}\n${cue.time}\n${cue.textLines.join('\n')}`)
    .join('\n\n') + '\n';
}
