# Rotate / thu hồi token và khóa ký

Áp dụng: Meta token, Shopify token, Anthropic API key, `APPROVAL_SIGNING_KEY`, mật khẩu DB.

1. Nếu nghi lộ: `ops.incident.create(kind=permission_lost, request_freeze=true)`. Ghi thời điểm biết, không dán giá trị token.
2. Thu hồi token cũ tại nhà cung cấp (Business settings / Shopify app / Anthropic console). Tạo token mới với scope tối thiểu.
3. Ghi token mới vào vault; deploy lại process đọc biến đó. Token không bao giờ nằm trong repo, `.env.example`, log hay fixture.
4. Khóa ký approval: thêm khóa mới với `APPROVAL_SIGNING_KEY_ID` mới. Approval cũ (ký bằng khóa cũ) sẽ không verify được nữa ⇒ proposal đã duyệt nhưng chưa chạy cần duyệt lại. Chấp nhận điều này thay vì giữ khóa bị lộ.
5. Kiểm `connections.health`, `ops.health`. Đối soát proposal UNKNOWN nếu có.
6. Owner mở lại ghi trên UI khi xong.
