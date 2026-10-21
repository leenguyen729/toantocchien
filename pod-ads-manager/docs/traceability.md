# Yêu cầu → bằng chứng

Đối chiếu acceptance trong `POD_ADS_SKILLS_REQUIREMENTS.md` (§4, §8, §10) với test/eval đã chạy. "Chưa" nghĩa là ngoài phạm vi P1.

| Yêu cầu | Bằng chứng |
|---|---|
| Đúng 18 skills, registry skill→tools→roles→schemas | `.claude/skills/registry.json`, `tests/contract/skills-registry.test.ts`, `tests/contract/schemas.test.ts` |
| Mỗi skill ≥6 eval chung + ca riêng | S01/S17/S18: `tests/skills/skill-evals.test.ts`, `reports/skill-evals/REPORT.md`. 15 skill còn lại: **chưa** (P2–P4) |
| Payload sai/unknown field bị từ chối trước side effect | `tests/contract/schemas.test.ts`, `revisions.test.ts` |
| S01: account khác currency không trộn; thiếu cap không launch; config có version + audit | `config.test.ts`, eval `s01-*` |
| S17: không approval ⇒ zero outbound writes | `approval-gates.test.ts`, eval `s17-missing-*` |
| S17: hash đổi bị chặn | `approval-gates.test.ts` (tampering, stale hash), eval `s17-hash-mismatch-blocked` |
| S17: replay không ghi lần hai | `approval-gates.test.ts`, `concurrency.test.ts`, eval `s17-replay-writes-once` |
| S17: partial failure có reconciliation | `uncertainty.test.ts`, `worker-paths.test.ts` |
| S17: expiry, drift, đổi account, kill switch chặn | `approval-gates.test.ts`, `revisions.test.ts`, `kill-switch.test.ts` |
| S18: kill switch chặn job đã xếp hàng | `kill-switch.test.ts`, eval `s18-kill-switch-*`, UI E2E |
| S18: audit store hỏng ⇒ writes fail-closed | `recovery.test.ts`, eval `s18-audit-unavailable-fails-closed` |
| S18: restore không replay mutation | `recovery.test.ts` |
| State machine đúng §8 | `state-machine.test.ts` |
| Approval: absent/expired/forged/replayed/hash/asset drift/policy change | `approval-gates.test.ts` |
| Concurrency: 2 workers, cap race, stale lock, redelivery | `concurrency.test.ts`, `pg-store.test.ts` |
| Uncertainty: timeout trước/sau commit, partial batch | `uncertainty.test.ts` |
| Security: cross-tenant, injection, secrets, wrong role | `tests/security/*`, eval `*-wrong-tenant-*`, `*-injection-*` |
| SSRF | Không có tool fetch ở P1; manifest cấm trường url (`tool-manifest.test.ts`). Fetch nguồn web: **chưa** (P3) |
| UI E2E: draft, diff, approve/reject/expire, kill switch | `tests/e2e/ui/approval-flow.spec.ts` |
| Recovery: restore, token revoked, audit unavailable | `recovery.test.ts` |
| Economics golden cases | **Chưa** (S03, P2) |
| Data: pagination, async, webhook replay | **Chưa** (S02/S12, P2) |
| Clone sạch chạy mock E2E không token | `pnpm demo`, `tests/e2e/mock-flow.test.ts`, `tests/e2e/api-flow.test.ts` |
| Branch coverage core money/state ≥ 90% | `vitest.config.ts` threshold; kết quả 94.13% (xem test-report.md) |
| CI chỉ mock | `runtime-config.test.ts` (CI refuses anything but mock/off), workflow CI |
| UI nêu nguồn/ngày/currency/attribution | UI E2E test đầu tiên |
