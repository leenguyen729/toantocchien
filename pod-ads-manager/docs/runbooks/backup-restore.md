# Backup và restore

RPO/RTO **chưa chốt** (cần owner quyết định và diễn tập trước production).

## Backup

- `pg_dump --format=custom` định kỳ + WAL archiving nếu cần RPO nhỏ. Mã hóa backup, lưu ngoài host DB.
- Không backup ra máy cá nhân. Không đưa dump vào repo.

## Restore

1. Bật freeze trước khi restore (hoặc dừng worker).
2. `pg_restore` vào DB mới; `pnpm db:migrate` (idempotent).
3. Trạng thái freeze sau restore: giữ freeze. Kiểm `ops.health` → `audit_chain.ok`.
4. Job đã xếp hàng trong bản backup có thể đã chạy ở bản cũ. Worker không gửi lại create vì tìm thấy entity mang tag `[pam:…]` và nhận nó (đã test trong `tests/integration/recovery.test.ts`). Update được kiểm before-state: nếu remote đã khác `before` (ví dụ đã là `after`), action dừng với `REMOTE_DRIFT` và không gửi lại.
5. Đối soát mọi proposal EXECUTING/UNKNOWN. Owner mở lại ghi.

## Diễn tập

Chạy restore trên môi trường staging với dữ liệu mock mỗi quý; ghi thời gian thực tế làm RTO đo được.
