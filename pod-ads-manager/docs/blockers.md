# Blockers và việc chưa làm

Hệ thống **chưa sẵn sàng production**. Ghi thật vẫn tắt (`LIVE_WRITES_ENABLED=false`) và adapter Meta live cố ý không làm gì.

## Cần owner / bên ngoài

| # | Blocker | Ai | Chặn giai đoạn |
|---|---|---|---|
| B1 | Xác minh capability Meta (version, enum, scope, App Review) bằng probe read-only | Owner cấp token đọc | P2 |
| B2 | Xác minh Shopify API version/scope; nguồn fulfillability POD | Owner | P2 |
| B3 | COGS / cost profile thật (hệ thống không suy đoán) | Owner | P2 (S03) |
| B4 | Chốt model Claude, cách nạp Skills ở runtime, hạn mức token/chi phí | Owner + kỹ thuật | P2 |
| B5 | IdP + MFA thay mock login | Owner | P5 |
| B6 | Trần ngân sách, cooldown, TTL, FX cho account thật | Owner | P5 |
| B7 | RPO/RTO, nơi lưu backup, diễn tập restore | Owner | P5 |
| B8 | Vault cho token và `APPROVAL_SIGNING_KEY` | Owner | P2 |

## Kỹ thuật còn thiếu

- 15 skills (S02–S16) mới ở registry `planned`; tool trả `CAPABILITY_UNSUPPORTED`.
- `packages/adapters/shopify` chưa có code.
- Eval có model thật (model-in-the-loop) chưa chạy; eval hiện tại chỉ đo guardrail qua tool layer.
- Chưa có row-level security Postgres; chưa ký neo chuỗi audit ra ngoài.
- Chưa đóng gói container/hạ tầng deploy; SLO chưa đo.
- UI chưa có màn sửa config (dùng API `/api/config/draft|confirm`).
