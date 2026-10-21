# ADR 0002 — Claude runtime và cách nạp Skills

- Trạng thái: chấp nhận cho P1; phần model/API live **chưa xác minh**
- Ngày: 2026-10-21

## Bối cảnh

Spec tách Claude Code (công cụ phát triển) khỏi Claude runtime (production). Thư mục `.claude/skills` không phải scheduler; LLM không giữ credential ghi, không được HTTP/shell/SQL tùy ý, không tự duyệt.

## Quyết định

1. **Runtime production** gọi Claude qua Messages API với tool use do backend định nghĩa (`packages/adapters/claude`). Model chỉ thấy tool trong `llmTools()`; `approval.decide` có `llm_exposed=false`.
2. **Principal** của model do server dựng (`claudeRuntimePrincipal`, vai analyst, giới hạn bởi `LLM_ALLOWED`). Không trường input nào đổi được principal.
3. **Tool execution** qua `ToolExecutor`: validate JSON Schema → RBAC → handler domain. Kết quả luôn gắn `trust: "untrusted_tool_output"`. Giới hạn số tool call mỗi lượt (`RunBudget`).
4. **Skills**: `SKILL.md` là hướng dẫn quy trình cho model (Claude Code khi dev; runtime khi có cơ chế nạp được xác minh). Mọi phép tính tiền/quyền/trạng thái nằm trong code. `.claude/skills/registry.json` là nguồn skill → tools → roles → schemas.
5. **Scheduler** (sync, báo cáo) là job backend (P2), không phải skill tự kích hoạt.
6. **Mock mode**: `MockAnalyst` thay model, đi qua đúng `ToolExecutor` và principal; được gắn nhãn mock trên UI.

## Chưa xác minh (blocker trước P2)

- Model ID, giá, giới hạn context/tool, và cơ chế nạp Agent Skills qua API: phải đọc tài liệu chính thức hiện hành (xem `docs/api-capabilities/claude.md`) và chốt bằng ADR mới. Không có giá trị nào trong repo được giả định là đúng.
- Prompt caching, streaming, retry policy cho API Claude.

## Hệ quả

- Eval hiện tại là **xác định qua tool layer**, không đo chất lượng câu chữ của model. Eval có model-in-the-loop cần `ANTHROPIC_API_KEY` và chưa chạy.
- `docs/generated/claude-api-tools.json` là bản export tool cho API (tên `.` → `__`, schema tự chứa).
