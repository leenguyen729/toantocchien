# Fixture demo (không phải dữ liệu thật)

Toàn bộ số trong thư mục này là **fixture mô phỏng** cho mock mode và test. Không phải
chi phí, trần ngân sách, doanh thu hay cấu hình thật của bất kỳ cửa hàng nào. Không chứa PII.

- `tenant.json` — tenant/store/ad account demo và người dùng demo (tên vai trò, không email).
- `business-config.json` — BusinessConfig đã được "owner demo" xác nhận để chạy E2E. Trần tiền là số fixture.
- `remote-entities.json` — trạng thái ban đầu của fake Meta account.
- `snapshots.json` — DataSnapshot fixture (fetched_at được ghi đè bằng giờ seed để luôn "fresh").
- `creative.json` — asset + review policy/IP fixture.
