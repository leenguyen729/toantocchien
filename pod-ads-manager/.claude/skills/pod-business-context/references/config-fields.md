# Trường BusinessConfig

Định nghĩa chuẩn nằm trong `schemas/pod-contracts.schema.json#/$defs/BusinessConfig`. Bảng dưới giải thích ý nghĩa nghiệp vụ; khi bảng và schema khác nhau, schema thắng.

| Trường | Ý nghĩa | Ai quyết định | Thiếu thì sao |
|---|---|---|---|
| `markets[]` | Quốc gia + tiền tệ bán | Owner | `blocked` |
| `account_currency` | Tiền tệ ad account (đọc từ Meta khi có read thật) | Nguồn Meta | `blocked` nếu sai |
| `store_currency` | Tiền tệ Shopify | Nguồn Shopify | `blocked` nếu sai |
| `reporting_timezone` / `account_timezone` | IANA timezone, dùng cho kỳ báo cáo và lịch | Owner / Meta | `blocked` nếu không phải IANA |
| `kpi.*` | KPI chính, target CPA/ROAS (nullable) | Owner, dựa trên S03 | Không chặn S01; S14 sẽ chặn tăng tiền |
| `caps.daily_budget_cap_minor` | Tổng daily budget tối đa của account, đơn vị minor | Owner | `blocked`, không launch |
| `caps.lifetime_budget_cap_minor` | Tổng lifetime budget tối đa | Owner | `blocked` |
| `caps.proposal_exposure_cap_minor` | Exposure tối đa của một proposal | Owner | `blocked` |
| `max_change_pct`, `max_change_amount_minor` | Giới hạn mỗi lần đổi budget | Owner | `blocked` |
| `cooldown_seconds` | Khoảng tối thiểu giữa hai lần đổi cùng entity | Owner | `blocked` |
| `approval_ttl_seconds` | Thời hạn hiệu lực của approval | Owner | Mặc định code 1800s chỉ dùng cho TTL, không cho tiền |
| `separation_of_duties` | Người tạo không tự duyệt | Owner | — |
| `fx.source`, `fx.method` | Nguồn và phương pháp quy đổi khi đa tiền tệ | Owner | `blocked` khi có >1 tiền tệ |

Lưu ý:

- Daily budget **không phải** trần chi tiêu tuyệt đối; Meta có thể chi vượt trong ngày theo quy tắc của họ. Trần nội bộ là lớp kiểm soát của hệ thống này, không thay đổi hành vi phân phối của Meta.
- Số tiền luôn là số nguyên minor unit theo exponent của tiền tệ (`packages/contracts/src/currency.ts`). Tiền tệ ngoài allowlist bị từ chối.
