# Runbooks

Nguyên tắc chung cho mọi runbook:

- Kill switch (`ops.freeze`) chỉ chặn hệ thống này gửi thay đổi. **Quảng cáo đang chạy trên Meta vẫn tiếp tục chi tiêu.** Muốn dừng chi tiêu: owner pause trong Ads Manager, hoặc proposal `SET_STATUS PAUSED` được người duyệt.
- Không dán token, mật khẩu, PII vào incident, ticket hay chat. Hệ thống che các mẫu giống credential nhưng đó chỉ là lưới an toàn.
- Mọi thao tác ghi đều để lại audit; kiểm `GET /api/ops/health` → `audit_chain.ok` sau mỗi bước.

| Runbook | Khi nào |
|---|---|
| [token-rotation.md](token-rotation.md) | Token lộ/hết hạn, mất quyền, rotate định kỳ |
| [quota.md](quota.md) | Rate limit / quota |
| [stale-data.md](stale-data.md) | Snapshot cũ/thiếu |
| [unknown-mutation.md](unknown-mutation.md) | Proposal UNKNOWN / NEEDS_REVIEW |
| [partial-failure.md](partial-failure.md) | Proposal PARTIAL |
| [kill-switch.md](kill-switch.md) | Bật/mở khóa ghi |
| [backup-restore.md](backup-restore.md) | Sao lưu và khôi phục DB |
| [deploy-rollback.md](deploy-rollback.md) | Triển khai và rollback |
| [pilot.md](pilot.md) | Pilot một account (P5) |
