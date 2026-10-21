# Deploy và rollback

Trạng thái P1: chưa có môi trường production. Đây là quy trình đề xuất, chưa diễn tập.

## Nguyên tắc

- Deploy hay migration **không bao giờ** tự bật `LIVE_WRITES_ENABLED`. Giá trị đó do operator đặt riêng, có audit ngoài hệ thống.
- CI chỉ chạy mock (`loadRuntimeConfig` từ chối mode khác khi `CI=true`).
- Pin version dependency (lockfile), model Claude, API version (khi đã xác minh), skill version.

## Deploy

1. `pnpm run verify` xanh trên commit cần deploy.
2. Bật freeze nếu migration thay đổi bảng thực thi.
3. `pnpm db:migrate` (mỗi file trong transaction riêng).
4. Deploy API (role `api`) rồi worker (role `worker`).
5. Smoke: `/api/health`, `ops.health`, `connections.health` ở `read_only`.
6. Owner mở lại ghi.

## Rollback

- Code: deploy lại bản trước. Migration chỉ thêm (additive) để bản cũ vẫn chạy; nếu không tương thích, job cũ được invalidate và đưa về review thay vì chạy với schema mới.
- Không rollback DB bằng cách restore trừ khi có sự cố dữ liệu (xem backup-restore.md).
