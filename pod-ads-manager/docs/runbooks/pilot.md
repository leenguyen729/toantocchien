# Pilot (P5) — một store, một account

Chưa bắt đầu. Điều kiện tiên quyết (tất cả phải có, có bằng chứng):

- [ ] Capability Meta/Shopify đã xác minh bằng probe read-only (`docs/api-capabilities`).
- [ ] IdP + MFA cho approver/owner; không còn mock login.
- [ ] Owner xác nhận config: caps, cooldown, TTL, FX, policy.
- [ ] COGS/cost profile do owner cung cấp (không suy đoán).
- [ ] Backup/restore đã diễn tập; RPO/RTO đã chốt.
- [ ] Chạy `read_only` ít nhất N ngày (owner chốt N), đối soát khớp.

Bật ghi: owner tự đặt `EXECUTION_MODE=approval`, `LIVE_WRITES_ENABLED=true`, `META_ACCOUNT_ALLOWLIST=<1 account>`. Từng mutation đều qua người duyệt. Lần đầu chỉ tạo PAUSED rồi đọc lại; kích hoạt là proposal riêng.

Dừng pilot: freeze + owner pause trong Ads Manager + đặt lại `LIVE_WRITES_ENABLED=false`.
