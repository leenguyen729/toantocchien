# Dữ liệu stale / incomplete

Triệu chứng: policy chặn với `R_FRESHNESS`, `R_COMPLETENESS`, `R_FRESHNESS_SOURCE`.

1. Không tối ưu trên dữ liệu cũ; không "nới" `freshness_seconds` để lách (đổi config cần owner xác nhận và có audit).
2. Chạy sync/backfill gần nhất (S12, P2). Xác nhận completeness/watermark.
3. Số thiếu là `null`, không phải 0. Báo cáo ghi "unavailable".
4. Tạo proposal mới từ snapshot mới; proposal cũ để hết hạn.
