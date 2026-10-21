# Báo cáo test và eval

Chạy ngày 2026-10-21 trong container phát triển (Node 22.22, pnpm 10.28, Postgres 16 local). Mọi lần chạy đều ở `EXECUTION_MODE=mock`, `LIVE_WRITES_ENABLED=false`, không token, không gọi Meta/Shopify/Claude thật.

| Bộ | Lệnh | Kết quả |
|---|---|---|
| Schema sinh ra khớp nguồn | `pnpm check:schemas` | đạt |
| Tài liệu sinh ra khớp code | `pnpm check:docs` | đạt |
| Lint | `pnpm lint` | đạt |
| Typecheck (packages, apps, tests, web) | `pnpm typecheck` | đạt |
| Registry + cấu trúc skill | `pnpm skills:check` | đạt (18 skill; 3 implemented) |
| Unit/contract/integration/e2e/security/skills (store bộ nhớ) | `pnpm test:coverage` | **197/197 pass**, 23 file |
| Integration Postgres | `DATABASE_URL=… pnpm test:integration:pg` | **6/6 pass** |
| Skill evals xác định | `pnpm evals` | S01 7/7, S17 10/10, S18 8/8; critical fail 0 |
| UI E2E (Playwright, Chromium) | `pnpm e2e:ui` | **6/6 pass** |
| Demo CLI | `pnpm demo` | draft → chặn khi chưa duyệt → duyệt → SUCCEEDED (giả lập) |

## Coverage (lõi tiền/trạng thái, ngưỡng branch 90%)

| Phạm vi | Branch |
|---|---|
| Tổng phạm vi đo | **94.13%** |
| `policy/src` (engine, impact) | 98.2% |
| `domain/src` (proposal/approval/execution services, rbac, state machine) | 91.86% |
| `execution-service.ts` riêng | 90.37% |
| `contracts/src` (canonical, currency) | 96% |

Coverage không thay cho test hành vi; các gate an toàn được kiểm bằng test hành vi trong `docs/traceability.md`.

## Lỗi thật tìm ra khi viết test (đã sửa)

- Ném lỗi trong transaction làm rollback luôn chuyển trạng thái EXPIRED khi duyệt proposal hết hạn.
- Không phát hiện provider tạo trùng entity khi response vẫn bình thường.
- Proposal kẹt ở RECONCILING nếu đọc remote lỗi trong lúc đối soát.
- UI: reload trang huỷ request đang chạy làm xoá session (đăng xuất nhầm).
- Incident evidence lưu nguyên văn mô tả, có thể chứa token; nay được che.

## Không đo / chưa chạy

- Eval có model Claude thật (cần key của owner).
- Load test, SLO, chaos ngoài fault injection của fake Meta.
- Bất kỳ lệnh nào tới API thật.
