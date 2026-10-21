# Rate limit / quota

Triệu chứng: lỗi `RATE_LIMITED` trong ledger, job bị release để thử lại.

1. Không tăng tần suất, không chạy song song thêm worker để "vượt" quota.
2. Read: backoff có giới hạn + jitter (S12, P2). Mutation: lỗi `RATE_LIMITED` trước khi gửi là an toàn để thử lại; lỗi sau khi gửi được xử lý như UNKNOWN.
3. Nếu kéo dài: `ops.incident.create(kind=connector_error)`. Đánh dấu dữ liệu liên quan stale; policy sẽ tự chặn proposal dựa trên dữ liệu cũ.
4. Ghi lại header quota thực tế khi đã có adapter live (chưa xác minh, xem `docs/api-capabilities/meta.md`).
