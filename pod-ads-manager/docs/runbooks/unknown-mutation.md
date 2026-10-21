# Mutation UNKNOWN / NEEDS_REVIEW

UNKNOWN nghĩa là hệ thống không biết remote đã nhận thay đổi hay chưa (timeout, mất kết nối, process chết giữa chừng).

1. **Không** tạo lại, **không** bấm thực thi lại.
2. Khóa ghi nếu có nhiều proposal UNKNOWN: `ops.incident.create(kind=unknown_mutation, request_freeze=true)`.
3. Chạy đối soát: UI "Đối soát" hoặc `execution.reconcile`. Worker tìm theo tag `[pam:<16hex>]` (create) hoặc so giá trị `after` (update). Đối soát chạy được cả khi đang freeze.
4. Nếu kết quả `NEEDS_REVIEW`: mở Ads Manager, tìm tên chứa tag (xem cột "Idempotency tag" trong ledger trên trang proposal).
   - Không thấy entity: thay đổi chưa áp dụng. Đóng proposal (hủy/để hết hạn), tạo proposal mới nếu vẫn cần.
   - Thấy đúng 1: ghi nhận remote ID vào incident, owner quyết định.
   - Thấy > 1 (provider tạo trùng): owner pause/xử lý bản thừa trong Ads Manager, ghi bằng chứng.
5. Reservation vẫn giữ cho tới khi xử lý xong, nên trần ngân sách nội bộ vẫn bảo thủ.
6. Owner mở lại ghi (xác nhận đã xử lý thủ công nếu còn NEEDS_REVIEW).
