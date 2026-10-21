# Mức độ sự cố và phản ứng mặc định

Nguồn chuẩn: `SEVERITY` và `recoveryChecklist` trong `packages/domain/src/ops-service.ts`.

| signal.kind | Severity | Khóa ghi đề xuất | Ghi chú |
|---|---|---|---|
| `audit_unavailable` | sev1 | Có | Không có audit thì không được ghi gì; hệ thống đã fail-closed sẵn |
| `unknown_mutation` | sev2 | Có | Đối soát theo tag `[pam:...]`, không tạo lại |
| `permission_lost` | sev2 | Có | Rotate/thu hồi token theo `docs/runbooks/token-rotation.md` |
| `spend_anomaly` | sev2 | Có | Kill switch KHÔNG dừng chi tiêu; pause thật cần proposal được duyệt hoặc owner tự làm |
| `connector_error` | sev3 | Tùy | Backoff, đánh dấu dữ liệu stale |
| `data_stale` | sev3 | Không | Policy đã chặn proposal dựa trên dữ liệu cũ |
| `other` | sev4 | Tùy | Thu thập bằng chứng không secret |

Mở lại ghi: chỉ owner, trên UI, sau khi không còn proposal UNKNOWN/RECONCILING/NEEDS_REVIEW (hoặc owner xác nhận rõ đã xử lý thủ công).
