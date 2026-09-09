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

// 4. Kiểm tra nhận diện và suy đoán Master URL từ Child Playlist
console.log('4. Kiểm tra Child Playlist & suy đoán Master URL...');
import { isM3u8PlaylistUrl, isChildPlaylistUrl, isMasterPlaylistUrl, deriveMasterPlaylistUrl } from '../src/utils/hlsParser.js';

const child1080Url = 'https://mp4-a.udemycdn.com/stream-hash/1080/index.m3u8?token=xyz123';
const child720Url = 'https://mp4-a.udemycdn.com/stream-hash/index_720.m3u8?token=xyz123';
const masterPlaylistUrl = 'https://mp4-a.udemycdn.com/stream-hash/master.m3u8?token=xyz123';
const segmentTsUrl = 'https://mp4-a.udemycdn.com/stream-hash/hls/1080/segment_0001.ts?token=xyz123';
const segmentM4sUrl = 'https://mp4-a.udemycdn.com/stream-hash/hls/1080/segment-0.m4s?token=xyz123';
const videoMp4Url = 'https://mp4-a.udemycdn.com/stream-hash/1080/init.mp4?token=xyz123';

// Kiểm tra isM3u8PlaylistUrl: Chặn triệt để các phân đoạn video
assert.strictEqual(isM3u8PlaylistUrl(masterPlaylistUrl), true, 'Master m3u8 phải là playlist');
assert.strictEqual(isM3u8PlaylistUrl(child1080Url), true, 'Child m3u8 phải là playlist');
assert.strictEqual(isM3u8PlaylistUrl(segmentTsUrl), false, 'Phân đoạn .ts không được coi là playlist');
assert.strictEqual(isM3u8PlaylistUrl(segmentM4sUrl), false, 'Phân đoạn .m4s không được coi là playlist');
assert.strictEqual(isM3u8PlaylistUrl(videoMp4Url), false, 'Phân đoạn .mp4 không được coi là playlist');

// Kiểm tra isChildPlaylistUrl & isMasterPlaylistUrl
assert.strictEqual(isChildPlaylistUrl(child1080Url), true, 'Phải nhận diện được 1080 child playlist');
assert.strictEqual(isChildPlaylistUrl(child720Url), true, 'Phải nhận diện được index_720 child playlist');
assert.strictEqual(isChildPlaylistUrl(masterPlaylistUrl), false, 'Master playlist không phải là child playlist');
assert.strictEqual(isChildPlaylistUrl(segmentTsUrl), false, 'Phân đoạn .ts không phải là child playlist');

assert.strictEqual(isMasterPlaylistUrl(masterPlaylistUrl), true, 'Master playlist phải là master');
assert.strictEqual(isMasterPlaylistUrl(child1080Url), false, 'Child playlist không phải là master');
assert.strictEqual(isMasterPlaylistUrl(segmentTsUrl), false, 'Phân đoạn .ts tuyệt đối không phải là master playlist');

assert.strictEqual(
  deriveMasterPlaylistUrl(child1080Url),
  'https://mp4-a.udemycdn.com/stream-hash/master.m3u8?token=xyz123',
  'Phải suy đoán chính xác master URL từ /1080/index.m3u8'
);
assert.strictEqual(
  deriveMasterPlaylistUrl(child720Url),
  'https://mp4-a.udemycdn.com/stream-hash/master.m3u8?token=xyz123',
  'Phải suy đoán chính xác master URL từ index_720.m3u8'
);

// Kiểm tra parseMasterPlaylist khi đưa vào child playlist 1080p
const childParsed = parseMasterPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6.0,\nseg1.ts', child1080Url);
assert.strictEqual(childParsed.variants[0].resolution, 1080, 'Phải giữ nguyên 1080p khi đưa vào child playlist 1080 thay vì ép về 720p');
console.log('-> Xử lý Child Playlist & Master suy đoán: ĐẠT');

// 5. Kiểm tra logic ưu tiên luồng HLS 1080p so với MP4 720p khi chuyển bài giảng
console.log('5. Kiểm tra ưu tiên luồng 1080p HLS...');
const mockHlsVariants = [
  { label: '1080', resolution: 1080, file: 'https://cdn.udemy.com/1080/index.m3u8', type: 'hls' },
  { label: '720', resolution: 720, file: 'https://cdn.udemy.com/720/index.m3u8', type: 'hls' },
  { label: '480', resolution: 480, file: 'https://cdn.udemy.com/480/index.m3u8', type: 'hls' },
];
const mockMp4Streams = [
  { label: '720', resolution: 720, file: 'https://cdn.udemy.com/video-720.mp4', type: 'video/mp4' },
  { label: '480', resolution: 480, file: 'https://cdn.udemy.com/video-480.mp4', type: 'video/mp4' },
  { label: '360', resolution: 360, file: 'https://cdn.udemy.com/video-360.mp4', type: 'video/mp4' },
];

let testMerged = [];
if (mockHlsVariants.length > 0) {
  testMerged = [...mockHlsVariants];
  const existingRes = new Set(testMerged.map(s => s.resolution));
  mockMp4Streams.forEach(mp4 => {
    if (!existingRes.has(mp4.resolution)) {
      testMerged.push(mp4);
      existingRes.add(mp4.resolution);
    }
  });
} else {
  testMerged = [...mockMp4Streams];
}
testMerged.sort((a, b) => b.resolution - a.resolution);

assert.strictEqual(testMerged[0].resolution, 1080, 'Luồng cao nhất phải luôn là 1080p');
assert.strictEqual(testMerged[0].type, 'hls', 'Luồng 1080p phải là HLS');
assert.strictEqual(testMerged.length, 4, 'Độ phân giải 360p từ MP4 được thêm vào đầy đủ');
console.log('-> Ưu tiên HLS 1080p khi chuyển bài: ĐẠT');

console.log('=== TẤT CẢ KIỂM TRA HLS ĐỀU ĐẠT CHUẨN XUẤT SẮC ===');


