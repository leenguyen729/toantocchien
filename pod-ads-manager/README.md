# POD AI Facebook Ads Manager

Hệ thống giúp cửa hàng Print-on-Demand (Shopify) quản lý quảng cáo Meta với Claude làm analyst, **mọi thay đổi ra ngoài đều phải được con người duyệt**. Bản này là giai đoạn **P0/P1**: nền tảng, hợp đồng dữ liệu, cổng duyệt/thực thi, vận hành sự cố, 3 skill đầu tiên, UI và test, chạy hoàn toàn ở **mock mode**.

> Không chạy quảng cáo thật. Mặc định `EXECUTION_MODE=mock`, `LIVE_WRITES_ENABLED=false`, và adapter Meta live cố ý từ chối mọi lệnh. Đây **không phải** bản production-ready; xem [docs/blockers.md](docs/blockers.md).

## Chạy thử trong 2 phút (không cần token, không cần DB)

```bash
pnpm install --frozen-lockfile
pnpm demo                      # luồng mock trên CLI
pnpm dev:api                   # API in-memory, mock, :4000
pnpm dev:web                   # UI tiếng Việt, http://localhost:3000
```

Trên UI: đăng nhập demo bằng **Analyst** → "Soạn proposal" (mock analyst chạy qua đúng tool layer của Claude) → đăng xuất, vào **Approver** → mở proposal, xem diff/exposure/hạn → **Duyệt** → **Xin thực thi** → xem receipt và audit. Trang "Vận hành & sự cố" có kill switch.

## Cấu trúc

```text
apps/api          Fastify API (không giữ write adapter khi chạy role api)
apps/worker       Worker thực thi (giữ write adapter; cần Postgres; từ chối mock)
apps/web          Next.js UI tiếng Việt
packages/contracts JSON Schema 2020-12 + type sinh, canonical hash, tiền tệ
packages/policy   Policy engine xác định (R_*), tính exposure
packages/domain   Proposal/approval/execution/reconcile/ops, RBAC, state machine, store Memory/Postgres
packages/adapters/meta     Fake Meta (fault injection) + live adapter chưa xác minh (fail-closed)
packages/adapters/claude   Tool manifest, ToolExecutor, MockAnalyst, export tool cho Claude API
packages/adapters/shopify  Chưa triển khai (P2)
.claude/skills    Registry 18 skill; S01, S17, S18 có SKILL.md + evals
fixtures/demo     Dữ liệu mô phỏng (không PII)
docs/             ADR, capability, runbook, threat model, traceability, test report
```

## Lệnh kiểm tra

| Lệnh | Làm gì |
|---|---|
| `pnpm run verify` | schemas + docs sinh ra khớp code, lint, typecheck, skills:check, test + coverage, evals |
| `pnpm test` | 197 test (unit, contract, integration, e2e API, security, skill evals) |
| `pnpm e2e:ui` | Playwright UI E2E (tự build web, chạy API mock với đồng hồ cố định) |
| `pnpm evals` | Skill evals xác định → `reports/skill-evals/` |
| `pnpm test:integration:pg` | Test Postgres; cần `DATABASE_URL` (xem `docker-compose.yml`) |
| `pnpm db:migrate` | Áp migration |

Kết quả lần chạy gần nhất: [docs/test-report.md](docs/test-report.md).

## An toàn: điều hệ thống đảm bảo

- Model không duyệt được, không có credential ghi, chỉ gọi tool trong manifest với schema đóng; principal do server dựng.
- Mỗi mutation cần: proposal bất biến có hash, người duyệt đã xác thực (hạn mức, tách người tạo/người duyệt), TTL + phạm vi account, kiểm lại remote trước khi gửi, khóa + reservation ngân sách, audit nối chuỗi hash.
- Timeout không rõ kết quả ⇒ `UNKNOWN` ⇒ đối soát theo tag idempotency; **không retry create mù**.
- Thiếu trần tiền, FX, COGS ⇒ chặn (fail-closed). Không có số nào được đoán.
- **Kill switch chỉ chặn ghi nội bộ. Quảng cáo đang chạy trên Meta vẫn tiếp tục chi tiêu.** Muốn dừng: pause trong Ads Manager hoặc proposal pause được duyệt.

## Tài liệu

- Quyết định kiến trúc: [docs/adr](docs/adr)
- Capability API (tất cả **UNVERIFIED**): [docs/api-capabilities](docs/api-capabilities)
- Kiến trúc + ERD: [docs/architecture/overview.md](docs/architecture/overview.md), threat model: [docs/architecture/threat-model.md](docs/architecture/threat-model.md)
- Tool manifest, route HTTP, export tool Claude (sinh tự động): [docs/generated](docs/generated)
- Yêu cầu → bằng chứng: [docs/traceability.md](docs/traceability.md)
- Runbooks: [docs/runbooks](docs/runbooks)
- Blockers: [docs/blockers.md](docs/blockers.md)
