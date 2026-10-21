# Claude API — capability cho runtime

- Tài liệu chính thức: https://docs.claude.com (Messages API, tool use, Agent Skills, Agent SDK)
- Model ID, giá, giới hạn: **UNVERIFIED** — chốt bằng ADR khi bắt đầu P2, pin trong config, không hard-code trong code
- verified_at: —

## Đã có trong code (không gọi API)

- Export tool sang định dạng tool của Messages API: `toClaudeApiTools()` → `docs/generated/claude-api-tools.json` (tên `.` → `__`, schema tự chứa, bỏ keyword `discriminator` của Ajv).
- Executor tool phía server, principal do server dựng, giới hạn số tool call.

## Chưa biết / cần quyết định

- Cách nạp Skills ở runtime (Agent Skills qua API hay chèn nội dung SKILL.md vào system prompt) và yêu cầu beta header nếu có.
- Model nào cho analyst (cân bằng chất lượng/chi phí), có dùng prompt caching không.
- Hạn mức token/chi phí mỗi lượt và mỗi ngày; cách đo cost thực tế.
- Data retention / zero data retention theo hợp đồng của owner.

## Kế hoạch

Chạy eval model-in-the-loop trên fixture (không dữ liệu thật) với key của owner, so với eval xác định hiện có; chỉ khi đạt rubric owner duyệt mới bật analyst thật ở `read_only`.
