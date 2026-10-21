# Shopify GraphQL Admin API — capability

- Tài liệu chính thức: https://shopify.dev/docs/api/admin-graphql
- Version: **UNVERIFIED** (Shopify dùng version theo quý; chưa chọn)
- verified_at: —   · verified_by: —

## Dùng trong hệ thống

| Nhu cầu | Skill | Trạng thái |
|---|---|---|
| Đọc product/variant/SKU/URL, phân trang hoặc bulk query | S02 | P2 (adapter chưa có `src`) |
| Đọc order/refund để tính actuals | S03/S16 | P2 |
| Webhook (HMAC verify, replay/out-of-order) | S02/S12 | P2 |
| Ghi catalog | — | **Không** trong phạm vi |

## Chưa biết

- Version API và scope tối thiểu (read_products, read_orders…).
- Giới hạn cost-based rate limit và cách đọc `throttleStatus`.
- Nguồn fulfillability cho POD (app POD bên thứ ba?), vì POD không có tồn kho vật lý.
- Cách lấy COGS: Shopify không có COGS POD đáng tin; **không suy đoán COGS** (S03 chặn khi thiếu).

## Kế hoạch probe read-only

Custom app chỉ scope đọc trên store dev/được phép → đọc 1 trang product, 1 trang order 7 ngày → lưu fixture đã che PII → contract test.
