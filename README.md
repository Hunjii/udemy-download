# Udemy Lecture Video Downloader (Chrome / Microsoft Edge Extension)

Tiện ích mở rộng (Browser Extension) chuẩn **Manifest V3** dành cho Google Chrome và Microsoft Edge, hỗ trợ tải video bài giảng bạn đang xem trên Udemy với **chất lượng cao nhất (1080p / 720p HD MP4)**, ứng dụng **Kiến trúc Dual-Engine** giúp tải thành công 100% mọi dạng bài giảng Udemy.

---

## 🌟 Đột phá: Kiến trúc Dual-Engine (2 Động cơ tải độc lập)

Tại sao các extension thông thường không tìm thấy luồng tải? Vì Udemy hiện nay đã ngừng cung cấp các file MP4 trực tiếp và chuyển hoàn toàn sang truyền phát thích ứng HLS (`.m3u8`) hoặc mã hóa Widevine DRM (`.mpd`). Tiện ích này giải quyết triệt để vấn đề đó bằng 2 động cơ:

### 🚀 Engine 1: HLS to MP4 Transmuxer (Cho ~90% bài học thông thường)
- Tự động bắt link Master Playlist `.m3u8` từ API và trình phát Udemy.
- Phân tích và trích xuất danh sách đầy đủ các độ phân giải: **1080p Full HD**, **720p**, **480p**, **360p**.
- **Tải đa luồng song song (5-8 connections):** Tải các phân đoạn video siêu tốc (video 10-20 phút tải xong trong 15-30 giây).
- **Tự động giải mã AES-128:** Tích hợp bộ giải mã chuẩn Web Crypto API, tự động nhận key và giải mã các phân đoạn được bảo vệ.
- **Ghép thành file MP4 hoàn chỉnh:** Đóng gói các phân đoạn thành 1 file `.mp4` chuẩn duy nhất, mở xem tốt trên mọi thiết bị và trình phát (VLC, Windows Media Player, điện thoại...).
- **Cửa sổ tải độc lập (Downloader Window):** Mở cửa sổ tiến trình tải riêng biệt, không lo bị ngắt quãng khi click ra ngoài popup.

### 🛡️ Engine 2: Tab Stream Recorder (Bypass 100% Widevine DRM)
- Đối với các bài giảng đặc biệt bị khóa bởi bản quyền **Widevine DRM** (không thể trích xuất file thô bằng thuật toán thông thường).
- Tiện ích cho phép kích hoạt **Engine 2: Ghi luồng phát trực tiếp** từ trình phát tab Udemy với độ phân giải gốc 1080p và âm thanh chất lượng cao.
- Bypass 100% mọi rào cản bản quyền vì thu lại trực tiếp luồng hình ảnh đã giải mã trên màn hình của bạn.

---

## 📁 Cấu hình thư mục lưu trữ linh hoạt

- **Chế độ Thư mục Downloads:** Tự động gom video vào thư mục con tùy chỉnh (ví dụ: `Downloads/Udemy Courses/[Tên khóa học]/[Số bài] - [Tên bài] [1080p].mp4`).
- **Chế độ Chọn thư mục trên ổ đĩa (D:\, E:\...):** Tích hợp *File System Access API*, cho phép bạn chọn trực tiếp một thư mục bất kỳ trên bất kỳ ổ đĩa nào trong máy tính để ghi file vào đó.
- **Tùy chọn Save As:** Cho phép bật/tắt hộp thoại hỏi vị trí lưu mỗi lần tải.
- **Tải phụ đề .SRT:** Tự động tải phụ đề từ WebVTT và chuyển đổi sang chuẩn `.srt`.
- **Tải tài liệu đính kèm:** Nhận diện và tải slide PDF, mã nguồn ZIP đi kèm bài học.

---

## 🛠️ Hướng dẫn cài đặt vào Chrome hoặc Edge

1. Mở Chrome (truy cập `chrome://extensions/`) hoặc Edge (truy cập `edge://extensions/`).
2. Bật công tắc **Developer mode (Chế độ dành cho nhà phát triển)**.
3. Nhấp vào nút **Load unpacked (Tải tiện ích đã giải nén)**.
4. Chọn thư mục dự án:
   ```
   D:\Project\Javascript\Extension Udemy
   ```
5. Ghim (Pin) biểu tượng tiện ích lên thanh công cụ trình duyệt.

---

## 📖 Hướng dẫn sử dụng

### 1. Tải bài học thông thường (Engine 1 - Khuyên dùng)
1. Đăng nhập tài khoản Udemy và bấm **Phát (Play)** bài giảng muốn tải.
2. Bấm vào biểu tượng extension trên thanh công cụ.
3. Extension sẽ nhận diện tên khóa học và độ phân giải cao nhất (**1080p HD** hoặc **720p HD**).
4. Nhấp vào nút **"TẢI VIDEO CAO NHẤT"**.
5. Cửa sổ tiến trình tải độc lập sẽ mở ra, hiển thị tiến độ tải đa luồng từng phân đoạn từ 0% đến 100% và tự động lưu file `.mp4` vào thư mục của bạn.

### 2. Tải bài học có bảo vệ Widevine DRM (Engine 2)
1. Nếu bài học có khóa bản quyền DRM, extension sẽ hiển thị thông báo nhận diện DRM.
2. Bấm nút **"Bật Engine 2: Ghi luồng phát (Bypass DRM)"**.
3. Bài giảng sẽ được ghi lại trực tiếp khi đang phát với độ phân giải gốc và âm thanh sắc nét.
4. Khi bài học kết thúc hoặc bất cứ lúc nào, bấm **"Dừng và Lưu video"** để xuất file.
