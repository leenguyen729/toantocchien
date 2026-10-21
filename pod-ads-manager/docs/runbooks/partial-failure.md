# Proposal PARTIAL

Một số action thành công, số khác lỗi (thường `REMOTE_DRIFT`, lỗi validation, hoặc action phụ thuộc bị bỏ qua).

1. Đọc receipt: action nào `succeeded` (có `readback_verified`), action nào `failed`/`skipped` và `recovery_plan`.
2. Không chạy lại proposal cũ. Lập revision/proposal mới từ trạng thái remote **hiện tại** cho phần còn thiếu, hoặc proposal rollback cho phần đã chạy.
3. Rollback chỉ là best effort và cần duyệt như mọi mutation; không khôi phục được chi tiêu đã xảy ra hay trạng thái learning của Meta.
4. Entity đã tạo luôn ở PAUSED; kích hoạt là proposal riêng.
