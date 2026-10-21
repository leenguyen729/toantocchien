# Kill switch (khóa ghi nội bộ)

## Bật

- UI: Vận hành & sự cố → "Bật khóa ghi" (operator/owner), hoặc tool `ops.freeze_writes` (Claude runtime được phép bật).
- Hiệu lực ngay: `execution.request` bị từ chối (`WRITE_FROZEN`), job đã xếp hàng bị giữ lại, không gửi gì.

## Điều kill switch KHÔNG làm

- Không dừng quảng cáo đang chạy. Chúng **vẫn tiếp tục chi tiêu**.
- Không hủy job: mở lại thì job đã xếp hàng sẽ chạy tiếp (sau khi worker kiểm lại approval/policy/before-state từng action). Nếu không muốn, hủy proposal trước khi mở.

## Muốn dừng chi tiêu thật

Owner pause trong Ads Manager, hoặc lập proposal `SET_STATUS PAUSED` → người duyệt → thực thi (cần mở khóa ghi tạm hoặc làm thủ công trên Meta).

## Mở lại

Chỉ owner, trên UI. Bị từ chối khi còn proposal UNKNOWN/RECONCILING/NEEDS_REVIEW, trừ khi owner tick "đã xử lý thủ công". Đóng incident không tự mở khóa.
