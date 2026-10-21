# ADR 0004 — Execution modes và vai trò process

- Trạng thái: chấp nhận
- Ngày: 2026-10-21

## Mode

| `EXECUTION_MODE` | Ý nghĩa | Ghi ra ngoài |
|---|---|---|
| `mock` (mặc định) | Fake Meta trong bộ nhớ, fixture | Chỉ tới simulator |
| `read_only` | Chỉ đọc nguồn thật (P2) | Không bao giờ |
| `approval` | Ghi thật sau khi người duyệt | Chỉ khi `LIVE_WRITES_ENABLED=true` **và** account trong `META_ACCOUNT_ALLOWLIST` **và** adapter live đã nghiệm thu |

`loadRuntimeConfig` từ chối cấu hình mâu thuẫn: CI (`CI=true`) chỉ chạy `mock`; `LIVE_WRITES_ENABLED=true` ngoài `approval` là lỗi; `approval` + live mà thiếu allowlist là lỗi; ngoài mock bắt buộc `APPROVAL_SIGNING_KEY`.

Proposal ghi lại mode lúc tạo. Worker từ chối (INVALIDATED) nếu mode proposal khác mode hệ thống, nếu adapter mock gặp proposal approval hoặc ngược lại.

Hiện tại adapter Meta live (`UnverifiedLiveMetaAdapter`) ném `CAPABILITY_UNSUPPORTED` cho mọi lệnh: bật cờ cũng không ghi được gì cho tới khi P4/P5 nghiệm thu.

## Process

| Role | Giữ write adapter | Dùng khi |
|---|---|---|
| `api` | Không | Production: API chỉ ghi outbox |
| `worker` | Có | `apps/worker`, cần `DATABASE_URL`, từ chối mock |
| `all-in-one` | Có (fake) | Demo/test mock: fake Meta ở trong bộ nhớ nên worker phải chung process |

## Kill switch

`ops.freeze` chặn ghi **nội bộ**: API không xếp hàng, worker giữ job. Không dừng quảng cáo đang chạy (`FreezeState.stops_running_ads` là hằng `false`). Mở lại chỉ owner, bị từ chối khi còn UNKNOWN/RECONCILING/NEEDS_REVIEW trừ khi owner xác nhận.
