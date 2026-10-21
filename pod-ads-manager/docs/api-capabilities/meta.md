# Meta Marketing API — capability

- Tài liệu chính thức: https://developers.facebook.com/docs/marketing-apis (và changelog Graph API)
- Version: **UNVERIFIED** — chưa chọn; không hard-code version trong code
- verified_at: —   · verified_by: —

## Dùng trong hệ thống

| Nhu cầu | Skill | Trạng thái |
|---|---|---|
| Đọc campaign/ad set/ad, budget, status | S10/S14/S17 | Mock (fake adapter). Live: chưa |
| Insights (sync/async, phân trang, breakdown, attribution) | S12 | P2 |
| Tạo campaign/ad set/ad ở trạng thái PAUSED | S10 → S17 | Mock. Live: chưa |
| Đổi daily/lifetime budget | S14 → S17 | Mock. Live: chưa |
| Đổi status ACTIVE/PAUSED | S17 | Mock. Live: chưa |
| Upload creative / ảnh / video | S06 → S17 | P3/P4 |
| Pixel/dataset, CAPI diagnostics (đọc) | S09 | P2 |
| Targeting/audience metadata (đọc) | S05 | P3 |

## Chưa biết (phải xác minh, không đoán)

- Version Graph API hiện hành và lịch deprecate.
- Enum objective, optimization goal, billing event hợp lệ cho account (code dùng `MOCK_OBJECTIVE_SALES` v.v.).
- Ràng buộc budget ở cấp campaign vs ad set (CBO/Advantage), giới hạn min budget theo tiền tệ.
- Cách Meta tính chi tiêu vượt daily budget trong ngày (hệ thống không coi daily budget là trần).
- Rate limit / Business Use Case headers và cách đọc quota.
- Có hỗ trợ idempotency key phía server cho create hay không (hiện dựa vào tag trong tên).
- Scope/quyền app cần thiết (ads_read, ads_management…) và quy trình App Review.
- Webhook nào khả dụng cho thay đổi ad object.

## Kế hoạch probe read-only (P2, cần owner cho phép từng bước)

1. Owner cấp token **chỉ đọc** cho một ad account allowlisted, lưu trong vault.
2. `EXECUTION_MODE=read_only`. Chạy probe: đọc account (currency, timezone), liệt kê campaign/ad set (tối đa 1 trang), một truy vấn insights nhỏ.
3. Lưu response đã che token/PII làm fixture contract, ghi version header thực tế.
4. Cập nhật bảng trên với `verified_at`, ADR, và contract test.
5. Không có bước nào gửi mutation. Mutation live chỉ xét ở P5 với approval cụ thể.
