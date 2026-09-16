# Toán Tốc Chiến — App học toán offline cho Android

App học toán chạy **hoàn toàn offline** (không cần Internet, không quảng cáo), cài trực tiếp lên điện thoại/máy tính bảng Android, **không cần lên chợ ứng dụng**.

## Tính năng (đúng theo yêu cầu)
- **Module Cộng & Trừ — 3 cấp độ** (mỗi phiên 300 câu ngẫu nhiên, phép trừ luôn ra kết quả ≥ 0):
  - **Dễ:** cộng/trừ số **1 chữ số** — **5 giây**/câu.
  - **Vừa:** **2 chữ số ± 1 chữ số** — **20 giây**/câu.
  - **Khó:** các **số nhỏ hơn 100** — **30 giây**/câu.
- **Module Bảng cửu chương (Nhân):** phép nhân **2–9**, 300 câu ngẫu nhiên — **5 giây**/câu.
- Mỗi câu có **thời gian suy nghĩ riêng theo cấp**, kèm **thanh thời gian** rút ngắn dần (xanh → vàng → đỏ) và số giây còn lại.
- **Đúng +1 điểm, sai −1 điểm.**
- Trả lời **sai**: có **âm thanh báo sai** và **hiện đáp án đúng** (ô đúng sáng xanh).
- **Hết 5 giây mà không trả lời → kết thúc phiên** và ghi log điểm.
- **Mọi phiên chơi đều được lưu log** (ngày giờ, cấp, điểm, số câu đúng/sai, lý do kết thúc) — xem ở mục **Lịch sử điểm**. Lưu ngay trên máy, không gửi đi đâu.
- Âm thanh tạo bằng Web Audio (không cần file), lưu điểm bằng localStorage → **100% offline**.

> Muốn chỉnh **số câu** hoặc **điểm**? Mở `app/src/main/assets/index.html`, sửa khối `CONFIG`:
> ```js
> const CONFIG = { QUESTIONS: 300, POINT_RIGHT: +1, POINT_WRONG: -1 };
> ```
> Muốn chỉnh **thời gian mỗi cấp** (hoặc phạm vi số)? Sửa khối `MODES` ngay bên dưới, ví dụ đổi `time` của từng chế độ:
> ```js
> const MODES = {
>   add_easy:   { ... time:5,  gen:genAddSubEasy },
>   add_medium: { ... time:20, gen:genAddSubMedium },
>   add_hard:   { ... time:30, gen:genAddSubHard },
>   mul:        { ... time:5,  gen:genMul }
> };
> ```

---

## Dùng thử NGAY (chưa cần APK)
File `index.html` chính là toàn bộ app. Bạn có thể chơi thử ngay:
- Chép `app/src/main/assets/index.html` vào điện thoại, mở bằng trình duyệt (Chrome).
- Trên Chrome bấm **⋮ → Thêm vào Màn hình chính** để chạy như một app offline, toàn màn hình.

Việc đóng gói thành file **APK** chỉ là "bọc" file này vào một app Android để cài như ứng dụng thật.

---

## Lấy file APK — chọn 1 trong 2 cách

### ✅ Cách 1 (khuyên dùng): Build tự động trên GitHub — KHÔNG cần cài gì trên máy
Chỉ cần một tài khoản GitHub (miễn phí).

1. Vào https://github.com → tạo repository mới (Private hay Public đều được).
2. Tải toàn bộ thư mục project này lên repo đó:
   - Cách dễ nhất: trên trang repo bấm **Add file → Upload files**, kéo–thả **tất cả** file/thư mục (giữ nguyên cấu trúc), rồi **Commit**.
   - Hoặc dùng git:
     ```
     git init
     git add .
     git commit -m "Toan Toc Chien"
     git branch -M main
     git remote add origin https://github.com/<tên-bạn>/<tên-repo>.git
     git push -u origin main
     ```
3. Mở tab **Actions** của repo → chọn workflow **Build APK** → bấm **Run workflow**
   (nếu vừa push lên nhánh `main`/`master` thì nó tự chạy).
4. Đợi ~3–5 phút. Khi xong, mở lần chạy đó, kéo xuống mục **Artifacts** → tải
   **ToanTocChien-apk** → giải nén sẽ được **`app-debug.apk`**.

File `app-debug.apk` này cài thẳng lên máy được ngay (xem phần *Cài APK* bên dưới).

### 🛠️ Cách 2: Build bằng Android Studio (trên máy tính của bạn)
1. Cài **Android Studio** (miễn phí): https://developer.android.com/studio
2. Mở Android Studio → **Open** → chọn thư mục project này (thư mục có `settings.gradle`).
3. Đợi Android Studio tự tải Gradle + Android SDK và **Sync** xong (lần đầu hơi lâu, cần mạng).
4. Menu **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
5. Khi hiện thông báo "APK(s) generated", bấm **locate** để mở thư mục chứa file:
   `app/build/outputs/apk/debug/app-debug.apk`.

---

## Cài APK lên điện thoại / máy tính bảng
1. Chép `app-debug.apk` vào thiết bị (qua USB, Zalo, Google Drive, email…).
2. Mở file APK. Lần đầu Android sẽ hỏi cho phép **"Cài đặt từ nguồn không xác định"** →
   bật cho phép (Cài đặt → Ứng dụng → quyền cài đặt ứng dụng lạ), rồi bấm **Cài đặt**.
3. Xong! App tên **Toán Tốc Chiến** xuất hiện ở màn hình chính, chạy offline.

> APK bản debug đã được ký tự động nên cài trực tiếp được, không cần tạo khóa (keystore).
> Nếu sau này muốn bản release để phân phối rộng, ta có thể thêm bước ký APK — cứ nói mình hỗ trợ.

---

## Cấu trúc project
```
mathgame/
├─ app/
│  ├─ build.gradle                     # cấu hình app (minSdk 21, targetSdk 34)
│  └─ src/main/
│     ├─ AndroidManifest.xml           # KHÔNG xin quyền Internet → thực sự offline
│     ├─ assets/index.html             # ★ TOÀN BỘ GAME nằm ở đây
│     ├─ java/.../MainActivity.java    # WebView nạp index.html
│     └─ res/                          # icon, màu, theme, tên app
├─ build.gradle, settings.gradle, gradle.properties
├─ gradle/ + gradlew + gradlew.bat     # Gradle wrapper (để build)
└─ .github/workflows/build-apk.yml     # build APK tự động trên GitHub
```

## Yêu cầu thiết bị
- Android 5.0 (API 21) trở lên — phủ hầu hết điện thoại & máy tính bảng đang dùng.
- App khóa hướng **dọc (portrait)** để bố cục nút bấm to, dễ cho trẻ.
