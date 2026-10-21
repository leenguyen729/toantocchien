# Threat model (P1)

Phạm vi: hệ thống ở mock mode và đường đi tới ghi thật trong tương lai. Phương pháp: STRIDE theo ranh giới tin cậy (người dùng ↔ API, model ↔ tool layer, worker ↔ Meta, DB).

| # | Mối đe dọa | Ranh giới | Kiểm soát hiện có | Bằng chứng | Còn hở |
|---|---|---|---|---|---|
| T1 | Prompt injection khiến model tự duyệt/thực thi | Model ↔ tools | `approval.decide` không expose; principal do server dựng; `LLM_ALLOWED`; kết quả tool gắn `untrusted_tool_output` | `tests/security/llm-boundary.test.ts`, eval `*-injection-*` | Chất lượng từ chối của model thật chưa đo |
| T2 | Model gọi HTTP/SQL/shell tùy ý, SSRF | Model ↔ tools | Chỉ tool trong manifest; schema đóng; test cấm trường url/sql/shell | `tests/contract/tool-manifest.test.ts` | Tool fetch nguồn web (S04) P3 cần allowlist domain + chặn IP nội bộ |
| T3 | Duyệt payload khác cái người duyệt đã thấy | UI ↔ API | `expected_payload_hash`, hash tính lại ở enqueue và worker | `approval-gates.test.ts` | — |
| T4 | Giả mạo / replay approval | DB, API | HMAC theo `key_id`, TTL, gắn account, idempotent enqueue | `approval-gates.test.ts` | Rotate khóa làm mất hiệu lực approval cũ (chấp nhận) |
| T5 | Vượt trần ngân sách do race | API ↔ DB | Lock scope + reservation trong transaction; Postgres advisory xact lock | `concurrency.test.ts`, `pg-store.test.ts` | Trần nội bộ ≠ chi tiêu thực tế của Meta |
| T6 | Ghi trùng khi timeout | Worker ↔ Meta | Ledger pending trước gửi, tag idempotency, UNKNOWN→reconcile, không retry create | `uncertainty.test.ts`, `worker-paths.test.ts` | Hành vi idempotency phía Meta chưa xác minh |
| T7 | Truy cập chéo tenant | API ↔ DB | Mọi truy vấn theo `tenant_id` principal; not-found thay vì forbidden | `tenant-isolation.test.ts` | Chưa có row-level security ở Postgres |
| T8 | Lộ secret/PII trong log, audit, fixture | Tất cả | Audit chỉ hash + tóm tắt; `redactSecrets`; quét repo trong test; `.env.example` placeholder | `secrets.test.ts` | Chưa có secret scanning ở CI ngoài test này |
| T9 | Sửa audit để che dấu vết | DB | Chuỗi hash theo tenant; trigger append-only | `secrets.test.ts`, `pg-store.test.ts` | Chưa ký/neo chuỗi ra ngoài hệ thống |
| T10 | Bật ghi thật do nhầm cấu hình/deploy | Ops | `loadRuntimeConfig` fail-closed; CI chỉ mock; live adapter ném lỗi; allowlist | `runtime-config.test.ts`, `fake-meta.test.ts` | Quy trình đổi cờ cần kiểm soát ngoài hệ thống |
| T11 | Người dùng tưởng kill switch dừng ads | UI | Câu cảnh báo trên banner, API, tool, runbook; schema `stops_running_ads=false` | UI E2E, `kill-switch.test.ts` | — |
| T12 | Vòng lặp agent vô hạn / chi phí | Model ↔ tools | `RunBudget.maxToolCalls` | `llm-boundary.test.ts` | Chưa giới hạn token/chi phí Claude |
| T13 | Đánh cắp session | UI ↔ API | Token ngẫu nhiên, lưu hash, TTL 8h, sessionStorage, CORS hẹp | `tenant-isolation.test.ts` | Mock login; chưa có IdP/MFA (blocker) |
