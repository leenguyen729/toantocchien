# Ma trận capability API

Không có version, enum hay capability nào trong repo được coi là đã xác minh. Mọi giá trị dùng trong code mock có tiền tố `MOCK_` hoặc version `UNVERIFIED-mock`. Xác minh chỉ hợp lệ khi có: link tài liệu chính thức, ngày xác minh, người xác minh, và kết quả probe **read-only** trên account được owner cho phép.

| Nền tảng | Trạng thái | verified_at | Tài liệu |
|---|---|---|---|
| Meta Marketing API | UNVERIFIED | — | [meta.md](meta.md) |
| Shopify GraphQL Admin API | UNVERIFIED | — | [shopify.md](shopify.md) |
| Claude API | UNVERIFIED (cho runtime production) | — | [claude.md](claude.md) |

Khi xác minh xong một dòng: cập nhật file tương ứng, thêm ADR, cập nhật `MOCK_CAPABILITIES`/adapter, và thêm contract test cho serialization đã xác minh.
