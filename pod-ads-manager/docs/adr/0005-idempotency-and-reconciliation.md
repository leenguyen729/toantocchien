# ADR 0005 — Idempotency, khóa, reservation và đối soát

- Trạng thái: chấp nhận
- Ngày: 2026-10-21

## Quyết định

1. **Proposal bất biến**: hash = SHA-256 của canonical JSON (tập con RFC 8785) trên phần payload. Sửa = revision mới; approval gắn với `(proposal_id, revision, payload_hash)`.
2. **Outbox**: `execution.request` trong một transaction: khóa scope ngân sách (advisory lock / mutex) → kiểm freeze, mode, approval, policy với tổng đã reserve → ghi reservation + job + `QUEUED`. Gọi lại trả `replay=true`.
3. **Khóa account + fencing token**: worker lấy lock theo ad account; mỗi attempt ghi fencing token; lock hết hạn thì token cũ bị từ chối.
4. **Ledger**: `execution_attempts` có `UNIQUE(tenant_id, idempotency_key)`; ghi `pending` **trước** khi gọi adapter.
5. **Tag idempotency** ` [pam:<16 hex>]` gắn vào tên entity khi create. Trước mỗi create, worker tìm entity mang tag: thấy 1 thì nhận (adopt), thấy >1 thì `NEEDS_REVIEW`, không create.
6. **UNKNOWN**: timeout/lỗi không phân loại sau khi gửi ⇒ `UNKNOWN` → `RECONCILING`: create tìm theo tag; update so remote với giá trị `after`. Không chứng minh được ⇒ `NEEDS_REVIEW`, giữ reservation.
7. **Đọc lại remote** sau mỗi mutation; `readback_verified` trong receipt.
8. **Restore DB** khởi động ở trạng thái freeze; nhờ (5) không replay create.

## Hệ quả

- Không có "retry create mù" ở bất kỳ đường nào; đã test bằng fault injection (`timeout_after_commit`, `duplicate_commit`, crash giữa batch).
- Tag nằm trong tên entity có thể bị người sửa tay trên Ads Manager; khi đó đối soát rơi vào `NEEDS_REVIEW` (an toàn, cần người).
