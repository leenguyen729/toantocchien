# State machine proposal

Nguồn chuẩn: `packages/domain/src/state-machine.ts` (theo spec §8). Bảng này chỉ để đọc nhanh.

```text
DRAFT → VALIDATED → PENDING_APPROVAL
PENDING_APPROVAL → APPROVED | REJECTED | EXPIRED | CANCELLED
APPROVED → QUEUED | EXPIRED | INVALIDATED | CANCELLED
QUEUED → EXECUTING | EXPIRED | INVALIDATED | CANCELLED
EXECUTING → SUCCEEDED | PARTIAL | FAILED | UNKNOWN
UNKNOWN → RECONCILING → SUCCEEDED | PARTIAL | FAILED | NEEDS_REVIEW
Trạng thái cuối: SUCCEEDED, PARTIAL, FAILED, NEEDS_REVIEW, REJECTED, EXPIRED, CANCELLED, INVALIDATED
```

Ý nghĩa cho người dùng:

- **DRAFT**: policy chặn, chưa trình duyệt. Sửa bằng revision mới (revision cũ giữ làm lịch sử).
- **VALIDATED**: policy pass, chuyển ngay sang chờ duyệt.
- **PENDING_APPROVAL**: chờ người duyệt trên UI, có `expires_at`.
- **APPROVED**: đã duyệt, chưa xếp hàng. Approval có TTL riêng.
- **QUEUED / EXECUTING**: worker đang xử lý; kill switch giữ job ở hàng đợi.
- **UNKNOWN**: không chắc remote đã nhận. Không bao giờ gửi lại create; đối soát theo tag `[pam:<16hex>]` trong tên entity.
- **NEEDS_REVIEW**: đối soát không chứng minh được (không thấy, hoặc thấy >1 entity cùng tag). Reservation vẫn giữ; người xử lý thủ công.
- **INVALIDATED**: điều kiện không còn đúng (mode, drift, policy). Không thực thi.

Idempotency key = SHA-256(tenant, proposal, revision, action_id). Ledger `execution_attempts` ghi `pending` trước khi gọi adapter; nếu process chết giữa chừng, lần sau coi là UNKNOWN và đối soát.
