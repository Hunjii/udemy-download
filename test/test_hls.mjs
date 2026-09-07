import assert from 'node:assert';
import { parseMasterPlaylist, parseMediaPlaylist } from '../src/utils/hlsParser.js';

console.log('--- BẮT ĐẦU KIỂM TRA HLS PARSER ---');

// 1. Kiểm tra parseMasterPlaylist với cả Video và Subtitles
console.log('1. Kiểm tra phân tích Master Playlist...');
const sampleMaster = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English [Auto]",DEFAULT=YES,LANGUAGE="en",URI="captions/en.vtt"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Tiếng Việt",LANGUAGE="vi",URI="captions/vi.vtt"
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",SUBTITLES="subs"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720/index.m3u8
`;

const baseUrl = 'https://udemy-cdn.com/stream/master.m3u8?token=xyz';
const { variants, subtitles } = parseMasterPlaylist(sampleMaster, baseUrl);

assert.strictEqual(variants.length, 2, 'Số lượng độ phân giải phải là 2');
assert.strictEqual(variants[0].label, '1080', 'Bản cao nhất phải là 1080');
assert.strictEqual(subtitles.length, 2, 'Phải trích xuất được 2 ngôn ngữ phụ đề');
assert.strictEqual(subtitles[0].label, 'English [Auto]', 'Tên phụ đề 1 chuẩn');
assert.strictEqual(subtitles[0].url, 'https://udemy-cdn.com/stream/captions/en.vtt?token=xyz', 'URL phụ đề 1 chuẩn');
assert.strictEqual(subtitles[1].label, 'Tiếng Việt', 'Tên phụ đề 2 chuẩn');

// Kiểm tra Master Playlist với thuộc tính KHÔNG có dấu ngoặc kép (unquoted attributes)
const unquotedMaster = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME=English,DEFAULT=YES,LANGUAGE=en,URI=captions/en.vtt
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720
720.m3u8
`;
const unquotedParsed = parseMasterPlaylist(unquotedMaster, 'https://udemy.com/test/master.m3u8');
assert.strictEqual(unquotedParsed.subtitles.length, 1, 'Phải parse được phụ đề không có ngoặc kép');
assert.strictEqual(unquotedParsed.subtitles[0].label, 'English', 'Label unquoted chuẩn');
assert.strictEqual(unquotedParsed.subtitles[0].locale, 'en', 'Locale unquoted chuẩn');
assert.strictEqual(unquotedParsed.subtitles[0].url, 'https://udemy.com/test/captions/en.vtt', 'URL unquoted chuẩn');
console.log('-> parseMasterPlaylist: ĐẠT');

// 2. Kiểm tra parseMediaPlaylist với AES-128 và fMP4
console.log('2. Kiểm tra phân tích Media Playlist (AES-128 & fMP4)...');
const sampleMedia = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="https://udemy.com/api/key?token=123",IV=0x0123456789ABCDEF0123456789ABCDEF
#EXTINF:6.000,
segment-0.m4s
#EXTINF:5.500,
segment-1.m4s
#EXT-X-ENDLIST
`;

const mediaUrl = 'https://udemy-cdn.com/stream/1080/index.m3u8';
const parsedMedia = parseMediaPlaylist(sampleMedia, mediaUrl);

assert.strictEqual(parsedMedia.isFmp4, true, 'Phải nhận diện được fMP4');
assert.strictEqual(parsedMedia.initSegmentUrl, 'https://udemy-cdn.com/stream/1080/init.mp4', 'Init segment URL đúng');
assert.strictEqual(parsedMedia.segments.length, 2, 'Phải có 2 phân đoạn');
assert.strictEqual(parsedMedia.segments[0].duration, 6.0, 'Thời lượng phân đoạn 1 là 6.0s');
assert.strictEqual(parsedMedia.totalDuration, 11.5, 'Tổng thời lượng là 11.5s');
assert.strictEqual(parsedMedia.segments[0].keyInfo?.method, 'AES-128', 'Phương thức mã hóa là AES-128');
assert.strictEqual(parsedMedia.segments[0].keyInfo?.uri, 'https://udemy.com/api/key?token=123', 'Key URI chính xác');
console.log('-> parseMediaPlaylist: ĐẠT');

// 3. Kiểm tra bảo toàn token / query parameters trên segment relative URLs
console.log('3. Kiểm tra bảo toàn Token/Query params trên phân đoạn...');
const tokenMediaUrl = 'https://udemy-cdn.com/stream/1080/index.m3u8?token=SECRET_TOKEN_XYZ&hdnts=exp=999';
const tokenParsedMedia = parseMediaPlaylist(sampleMedia, tokenMediaUrl);
assert.strictEqual(
  tokenParsedMedia.initSegmentUrl,
  'https://udemy-cdn.com/stream/1080/init.mp4?token=SECRET_TOKEN_XYZ&hdnts=exp=999',
  'Init segment URL phải giữ lại query params từ m3u8 cha'
);
assert.strictEqual(
  tokenParsedMedia.segments[0].url,
  'https://udemy-cdn.com/stream/1080/segment-0.m4s?token=SECRET_TOKEN_XYZ&hdnts=exp=999',
  'Segment URL phải giữ lại query params từ m3u8 cha'
);
console.log('-> Bảo toàn Query Params: ĐẠT');

console.log('=== TẤT CẢ KIỂM TRA HLS ĐỀU ĐẠT CHUẨN XUẤT SẮC ===');
