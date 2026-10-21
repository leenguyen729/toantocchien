# Tool manifest (sinh tự động)

Nguồn: `packages/adapters/claude/src/manifest.ts`. Đừng sửa tay; chạy `pnpm gen:docs`.
Tool `planned` trả `CAPABILITY_UNSUPPORTED`. Tool `llm_exposed=không` không bao giờ gửi cho model.

| Tool | Trạng thái | Phase | Cho LLM | Side effect | Permission | Vai trò | Retry | Timeout ms | Audit | Skill | Mô tả |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `context.get` | implemented | P1 | có | none | `config.read` | viewer, analyst, approver, operator, owner | safe_read | 10000 | — | S01 | Đọc BusinessConfig mới nhất của ad account. |
| `context.validate` | implemented | P1 | có | none | `config.read` | analyst, owner | safe_read | 10000 | — | S01 | Kiểm tra config nháp: currency/timezone/caps/FX; trả readiness và missing_fields. Không lưu. |
| `context.save_draft` | implemented | P1 | có | internal | `config.save_draft` | analyst, owner | none | 10000 | config.draft_saved | S01 | Lưu config nháp thành version mới (status draft). Owner phải xác nhận riêng trên UI. |
| `connections.health` | implemented | P1 | có | none | `ops.health` | analyst, approver, operator, owner | safe_read | 10000 | — | S01 | Trạng thái connector Meta/Shopify/Claude và mode hiện tại. |
| `meta.structure.read` | implemented | P1 | có | none | `report.read` | viewer, analyst, approver, operator, owner | safe_read | 10000 | — | S17 | Đọc cấu trúc campaign/ad set/ad và remote_fingerprint hiện tại (read-only) để lập precondition. |
| `proposal.create` | implemented | P1 | có | internal | `proposal.create` | analyst, owner | none | 10000 | proposal.created | S14, S17 | Tạo proposal (hoặc revision) từ action allowlist; backend tự tính hash, impact, policy. Không thực thi. |
| `proposal.validate` | implemented | P1 | có | none | `report.read` | analyst, approver, owner | safe_read | 10000 | — | S17 | Chạy lại policy với trạng thái hiện tại; không đổi gì. |
| `approval.status` | implemented | P1 | có | none | `report.read` | analyst, approver, owner | safe_read | 10000 | — | S17 | Trạng thái approval của một revision (none/approved/rejected/expired). Không thể duyệt qua tool này. |
| `execution.request` | implemented | P1 | có | internal | `execution.request` | analyst, approver, owner | idempotent_internal | 10000 | execution.queued | S17 | Xin xếp hàng thực thi proposal ĐÃ được người duyệt. Chỉ nhận proposal_id/revision/expected_payload_hash. |
| `execution.reconcile` | implemented | P1 | có | internal | `execution.reconcile` | analyst, approver, operator, owner | idempotent_internal | 60000 | execution.reconcile_finished | S17 | Đối soát proposal UNKNOWN với remote (read-only, không tạo lại). |
| `approval.decide` | implemented | P1 | **không** | internal | `proposal.approve` | approver | none | 10000 | approval.approved | — | Ghi quyết định duyệt/từ chối của người đã xác thực. KHÔNG expose cho LLM. |
| `ops.health` | implemented | P1 | có | none | `ops.health` | analyst, approver, operator, owner | safe_read | 10000 | — | S18 | Sức khỏe hệ thống: mode, freeze, hàng đợi, UNKNOWN, incident, chuỗi audit. |
| `ops.freeze_writes` | implemented | P1 | có | internal | `ops.freeze` | operator, owner | idempotent_internal | 10000 | ops.freeze_changed | S18 | Bật khóa ghi nội bộ (fail-closed). KHÔNG dừng quảng cáo đang chạy. Mở lại chỉ owner trên UI. |
| `ops.incident.create` | implemented | P1 | có | internal | `ops.incident.create` | analyst, operator, owner | none | 10000 | ops.incident_created | S18 | Tạo incident từ tín hiệu, tùy chọn khóa ghi nội bộ. |
| `ops.recovery.draft` | implemented | P1 | có | none | `ops.health` | analyst, operator, owner | safe_read | 10000 | — | S18 | Checklist khôi phục xác định theo loại tín hiệu. |
| `shopify.catalog.read` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S02 | Đọc product/variant Shopify (read-only). |
| `catalog.upsert_internal` | planned | P2 | có | internal | `proposal.create` | analyst | safe_read | 10000 | — | S02 | Upsert catalog nội bộ. |
| `catalog.validate_mapping` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S02 | Kiểm SKU/variant mapping. |
| `costs.read` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S03 | Đọc CostProfile có version. |
| `fx.read` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S03 | Đọc tỷ giá có nguồn/ngày. |
| `economics.compute` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S03 | Tính contribution/break-even bằng code xác định. |
| `research.search_approved` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S04 | Tìm trong nguồn đã duyệt. |
| `research.fetch_approved` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S04 | Fetch nguồn đã duyệt (allowlist domain, chặn SSRF). |
| `knowledge.read` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S04 | Đọc knowledge nội bộ. |
| `meta.targeting.capabilities` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S05 | Capability targeting đã xác minh. |
| `meta.audiences.read_metadata` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S05 | Metadata audience (không PII). |
| `audience.validate_plan` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S05 | Kiểm audience plan. |
| `brand.read` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S06 | Đọc brand guide. |
| `assets.search` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S06 | Tìm asset theo rights. |
| `creative.brief.validate` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S06 | Kiểm creative brief. |
| `copy.generate_draft` | planned | P3 | có | internal | `proposal.create` | analyst | safe_read | 10000 | — | S07 | Lưu bản nháp copy. |
| `copy.validate` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S07 | Kiểm giới hạn ký tự/claim. |
| `landing.read_snapshot` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S07 | Snapshot landing (allowlist domain). |
| `policy.content.evaluate` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S08 | Sàng lọc policy nội dung. |
| `rights.lookup` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S08 | Tra rights registry. |
| `landing.inspect` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S08 | Kiểm landing nhất quán. |
| `meta.tracking.read` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S09 | Đọc pixel/dataset metadata. |
| `tracking.audit` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S09 | Audit event coverage/dedup. |
| `attribution.compare` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S09 | So sánh nguồn theo attribution window. |
| `utm.build` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S09 | Dựng UTM theo policy. |
| `meta.account.capabilities` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S10 | Capability account đã xác minh. |
| `campaign.plan.validate` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S10 | Kiểm campaign plan graph. |
| `budget.simulate` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S10 | Mô phỏng exposure. |
| `experiment.design` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S11 | Thiết kế experiment. |
| `experiment.power_estimate` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S11 | Ước lượng power. |
| `experiment.register` | planned | P3 | có | internal | `proposal.create` | analyst | safe_read | 10000 | — | S11 | Pre-register experiment. |
| `meta.insights.request` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S12 | Tạo Insights job (read). |
| `meta.insights.poll` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S12 | Poll Insights job. |
| `meta.insights.page` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S12 | Đọc trang Insights. |
| `insights.normalize` | planned | P2 | có | internal | `report.read` | analyst | safe_read | 10000 | — | S12 | Chuẩn hóa MetricRow. |
| `metrics.compute` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S13 | Tính CPA/ROAS (null khi mẫu số 0). |
| `anomaly.detect` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S13 | Phát hiện bất thường. |
| `diagnosis.explain` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S13 | Giải thích có provenance. |
| `budget.optimize_draft` | planned | P4 | có | none | `report.read` | analyst | safe_read | 10000 | — | S14 | Nháp thay đổi budget. |
| `budget.exposure.compute` | planned | P4 | có | none | `report.read` | analyst | safe_read | 10000 | — | S14 | Tính exposure batch + reservation. |
| `creative.performance.read` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S15 | Chuỗi hiệu suất creative. |
| `fatigue.evaluate` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S15 | Đánh giá fatigue. |
| `creative.refresh.draft` | planned | P3 | có | none | `report.read` | analyst | safe_read | 10000 | — | S15 | Nháp refresh brief. |
| `reports.build` | planned | P2 | có | none | `report.read` | analyst | safe_read | 10000 | — | S16 | Dựng report có revision. |
| `knowledge.propose_learning` | planned | P2 | có | internal | `proposal.create` | analyst | safe_read | 10000 | — | S16 | Đề xuất LearningRecord (không tự sửa policy). |
| `audit.read` | planned | P2 | có | none | `audit.read` | analyst, approver, operator, owner | safe_read | 10000 | — | S16 | Đọc audit đã lọc. |
