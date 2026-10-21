# Hướng dẫn cho Claude Code trong repo này

Đây là POD AI Facebook Ads Manager. Đọc `docs/adr/` và `POD_ADS_SKILLS_REQUIREMENTS.md` (nếu có) trước khi sửa lớn.

## Không bao giờ

- Đổi mặc định `EXECUTION_MODE=mock` / `LIVE_WRITES_ENABLED=false`, dùng token thật, kết nối account thật, deploy production, hay gửi mutation quảng cáo thật (kể cả tạo PAUSED hoặc upload creative).
- Cho model/tool quyền duyệt, HTTP/shell/SQL tùy ý, hay credential ghi.
- Bịa API version, enum, capability, COGS, số tiền. Thiếu thì fail-closed và ghi blocker.
- Retry create mù sau timeout. Kết quả không rõ là `UNKNOWN` → đối soát.
- Đưa secret/PII vào code, fixture, log, audit. `.env.example` chỉ có placeholder.
- Nói hệ thống "production-ready", hay nói kill switch dừng quảng cáo đang chạy.

## Lệnh

```bash
pnpm install --frozen-lockfile
pnpm run verify          # schemas, docs, lint, typecheck, skills:check, test+coverage, evals
pnpm demo                # mock E2E trên CLI
pnpm dev:api & pnpm dev:web   # UI tại http://localhost:3000
pnpm e2e:ui              # Playwright (PW_CHROMIUM_PATH nếu cần)
DATABASE_URL=… pnpm test:integration:pg
```

## Quy ước

- Schema: sửa `packages/contracts/src/schemas.ts` → `pnpm gen:schemas`. Tool: `packages/adapters/claude/src/manifest.ts` → `pnpm gen:docs`.
- Tiền là số nguyên minor unit; không float. Mọi phép tính tiền/quyền/trạng thái là code xác định có test.
- Skill mới: thêm vào `.claude/skills/registry.json`, viết `SKILL.md` đủ 13 mục, `evals/evals.json` ≥ 6 nhóm chung; `pnpm skills:check && pnpm evals`.
- UI, thông báo nghiệp vụ, tài liệu: tiếng Việt. Identifier: tiếng Anh.
