# ADR 0001 — Stack và cấu trúc repo

- Trạng thái: chấp nhận (P1)
- Ngày: 2026-10-21

## Bối cảnh

Spec yêu cầu monorepo có `apps/{web,api,worker}`, `packages/{contracts,domain,policy}`, `packages/adapters/{meta,shopify,claude}`, chạy được hoàn toàn ở mock mode từ clone sạch, có migrations, lockfile, CI và JSON Schema là nguồn sự thật cho hợp đồng dữ liệu.

## Quyết định

| Phần | Chọn | Lý do |
|---|---|---|
| Ngôn ngữ | TypeScript 5.9 strict, Node ≥ 22 | Một ngôn ngữ cho UI/API/worker/skills tooling; type sinh từ schema |
| Package manager | pnpm 10 workspace, lockfile commit | Cài đặt xác định, `--frozen-lockfile` trong CI |
| Hợp đồng | JSON Schema 2020-12 (`schemas/pod-contracts.schema.json`) + Ajv 8, type sinh bằng json-schema-to-typescript | Một nguồn cho validate runtime, type, và schema tool Claude |
| API | Fastify 5 | Validate theo schema, nhanh, ít phụ thuộc |
| Worker | Process Node riêng (`apps/worker`), outbox trong DB | Chỉ worker giữ write adapter |
| DB | PostgreSQL 16 (`pg`), in-memory store cho demo/test | Advisory lock, `SKIP LOCKED`, trigger append-only cho audit |
| Tiền | Số nguyên minor unit + allowlist exponent ISO 4217; `decimal.js` cho phép chia | Không dùng float cho tiền |
| Web | Next.js 16 (App Router, client components), React 19 | UI tiếng Việt; gọi API qua HTTP, không giữ secret |
| Test | Vitest 4 (+ v8 coverage), Playwright 1.56 | Unit/contract/integration/security/e2e + UI E2E |

Packages export trực tiếp `src/index.ts` (không có bước build), chạy bằng `tsx`. Next.js transpile `@pod/contracts` khi cần.

## Hệ quả

- Không có bundle production cho API/worker ở P1; đóng gói container là việc của P5 (xem `docs/runbooks/deploy-rollback.md`).
- Đổi schema phải chạy `pnpm gen:schemas`; CI chạy `check:schemas` để chặn lệch.
