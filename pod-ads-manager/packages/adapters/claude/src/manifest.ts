import { defRef, type Role } from '@pod/contracts';
import type { Permission } from '@pod/domain';

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  side_effect: 'none' | 'internal' | 'external';
  /** Permission enforced by backend RBAC. `required_role` is documentation derived from it. */
  permission: Permission;
  required_role: Role[];
  timeout_ms: number;
  retry_class: 'none' | 'safe_read' | 'idempotent_internal';
  data_classification: 'internal' | 'confidential';
  audit_event: string | null;
  adapter_version: string;
  /** false = never sent to the model; reachable only from authenticated UI/service routes. */
  llm_exposed: boolean;
  status: 'implemented' | 'planned';
  phase: 'P1' | 'P2' | 'P3' | 'P4';
};

const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const id = defRef('Id');
const sha = defRef('Sha256');
const rev = { type: 'integer', minimum: 1 };
const anyObj = { type: 'object' };

const P1 = { status: 'implemented' as const, phase: 'P1' as const, adapter_version: 'p1-mock' };
const planned = (phase: ToolDefinition['phase']) => ({ status: 'planned' as const, phase, adapter_version: 'unimplemented' });

const base = {
  timeout_ms: 10_000,
  retry_class: 'safe_read' as const,
  data_classification: 'internal' as const,
  audit_event: null,
  llm_exposed: true,
  side_effect: 'none' as const,
};

function plannedTool(name: string, description: string, permission: Permission, required_role: Role[], phase: ToolDefinition['phase'], side_effect: ToolDefinition['side_effect'] = 'none'): ToolDefinition {
  return { ...base, ...planned(phase), name, description, permission, required_role, side_effect, input_schema: closed({}), output_schema: anyObj };
}

/**
 * Tool contracts between the Claude runtime and the backend. Names are
 * project-internal contracts, not Meta/Shopify endpoint names. Inputs never
 * carry tenant_id, role, tokens, URLs, SQL or shell — the backend binds the
 * principal from the server-side session.
 */
export const TOOLS: ToolDefinition[] = [
  // ---- S01 pod-business-context
  { ...base, ...P1, name: 'context.get', description: 'Đọc BusinessConfig mới nhất của ad account.', permission: 'config.read', required_role: ['viewer', 'analyst', 'approver', 'operator', 'owner'], input_schema: closed({ ad_account_id: id }), output_schema: anyObj },
  { ...base, ...P1, name: 'context.validate', description: 'Kiểm tra config nháp: currency/timezone/caps/FX; trả readiness và missing_fields. Không lưu.', permission: 'config.read', required_role: ['analyst', 'owner'], input_schema: closed({ config_draft: defRef('BusinessConfig') }), output_schema: anyObj },
  { ...base, ...P1, name: 'context.save_draft', description: 'Lưu config nháp thành version mới (status draft). Owner phải xác nhận riêng trên UI.', permission: 'config.save_draft', required_role: ['analyst', 'owner'], side_effect: 'internal', retry_class: 'none', audit_event: 'config.draft_saved', input_schema: closed({ config_draft: defRef('BusinessConfig') }), output_schema: anyObj },
  { ...base, ...P1, name: 'connections.health', description: 'Trạng thái connector Meta/Shopify/Claude và mode hiện tại.', permission: 'ops.health', required_role: ['analyst', 'approver', 'operator', 'owner'], input_schema: closed({}), output_schema: anyObj },
  // ---- S17 pod-approval-execution
  { ...base, ...P1, name: 'meta.structure.read', description: 'Đọc cấu trúc campaign/ad set/ad và remote_fingerprint hiện tại (read-only) để lập precondition.', permission: 'report.read', required_role: ['viewer', 'analyst', 'approver', 'operator', 'owner'], input_schema: closed({ ad_account_id: id }), output_schema: anyObj },
  { ...base, ...P1, name: 'proposal.create', description: 'Tạo proposal (hoặc revision) từ action allowlist; backend tự tính hash, impact, policy. Không thực thi.', permission: 'proposal.create', required_role: ['analyst', 'owner'], side_effect: 'internal', retry_class: 'none', audit_event: 'proposal.created', input_schema: closed({ ad_account_id: id, proposal_id: { anyOf: [id, { type: 'null' }] }, actions: { type: 'array', minItems: 1, maxItems: 50, items: defRef('Action') }, reason: { type: 'string', minLength: 1, maxLength: 2000 }, rollback_plan: { type: 'string', minLength: 1, maxLength: 2000 }, source_snapshot_ids: { type: 'array', items: id } }), output_schema: anyObj },
  { ...base, ...P1, name: 'proposal.validate', description: 'Chạy lại policy với trạng thái hiện tại; không đổi gì.', permission: 'report.read', required_role: ['analyst', 'approver', 'owner'], input_schema: closed({ proposal_id: id, revision: rev }), output_schema: anyObj },
  { ...base, ...P1, name: 'approval.status', description: 'Trạng thái approval của một revision (none/approved/rejected/expired). Không thể duyệt qua tool này.', permission: 'report.read', required_role: ['analyst', 'approver', 'owner'], input_schema: closed({ proposal_id: id, revision: rev }), output_schema: anyObj },
  { ...base, ...P1, name: 'execution.request', description: 'Xin xếp hàng thực thi proposal ĐÃ được người duyệt. Chỉ nhận proposal_id/revision/expected_payload_hash.', permission: 'execution.request', required_role: ['analyst', 'approver', 'owner'], side_effect: 'internal', retry_class: 'idempotent_internal', audit_event: 'execution.queued', input_schema: closed({ proposal_id: id, revision: rev, expected_payload_hash: sha }), output_schema: anyObj },
  { ...base, ...P1, name: 'execution.reconcile', description: 'Đối soát proposal UNKNOWN với remote (read-only, không tạo lại).', permission: 'execution.reconcile', required_role: ['analyst', 'approver', 'operator', 'owner'], side_effect: 'internal', retry_class: 'idempotent_internal', audit_event: 'execution.reconcile_finished', timeout_ms: 60_000, input_schema: closed({ proposal_id: id, revision: rev }), output_schema: anyObj },
  // UI/service only — documented so reviewers can see it exists and is excluded from the model.
  { ...base, ...P1, name: 'approval.decide', description: 'Ghi quyết định duyệt/từ chối của người đã xác thực. KHÔNG expose cho LLM.', permission: 'proposal.approve', required_role: ['approver'], side_effect: 'internal', retry_class: 'none', audit_event: 'approval.approved', llm_exposed: false, data_classification: 'confidential', input_schema: closed({ proposal_id: id, revision: rev, expected_payload_hash: sha, decision: { enum: ['approved', 'rejected'] }, comment: { anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'null' }] } }), output_schema: anyObj },
  // ---- S18 pod-operations-incident
  { ...base, ...P1, name: 'ops.health', description: 'Sức khỏe hệ thống: mode, freeze, hàng đợi, UNKNOWN, incident, chuỗi audit.', permission: 'ops.health', required_role: ['analyst', 'approver', 'operator', 'owner'], input_schema: closed({}), output_schema: anyObj },
  { ...base, ...P1, name: 'ops.freeze_writes', description: 'Bật khóa ghi nội bộ (fail-closed). KHÔNG dừng quảng cáo đang chạy. Mở lại chỉ owner trên UI.', permission: 'ops.freeze', required_role: ['operator', 'owner'], side_effect: 'internal', retry_class: 'idempotent_internal', audit_event: 'ops.freeze_changed', input_schema: closed({ reason: { type: 'string', minLength: 1, maxLength: 1000 } }), output_schema: anyObj },
  { ...base, ...P1, name: 'ops.incident.create', description: 'Tạo incident từ tín hiệu, tùy chọn khóa ghi nội bộ.', permission: 'ops.incident.create', required_role: ['analyst', 'operator', 'owner'], side_effect: 'internal', retry_class: 'none', audit_event: 'ops.incident_created', input_schema: defRef('OperationsIncidentInput'), output_schema: anyObj },
  { ...base, ...P1, name: 'ops.recovery.draft', description: 'Checklist khôi phục xác định theo loại tín hiệu.', permission: 'ops.health', required_role: ['analyst', 'operator', 'owner'], input_schema: closed({ kind: { enum: ['connector_error', 'data_stale', 'permission_lost', 'spend_anomaly', 'unknown_mutation', 'audit_unavailable', 'other'] } }), output_schema: anyObj },

  // ---- Planned (P2–P4): contracts reserved, handlers return CAPABILITY_UNSUPPORTED.
  plannedTool('shopify.catalog.read', 'Đọc product/variant Shopify (read-only).', 'report.read', ['analyst'], 'P2'),
  plannedTool('catalog.upsert_internal', 'Upsert catalog nội bộ.', 'proposal.create', ['analyst'], 'P2', 'internal'),
  plannedTool('catalog.validate_mapping', 'Kiểm SKU/variant mapping.', 'report.read', ['analyst'], 'P2'),
  plannedTool('costs.read', 'Đọc CostProfile có version.', 'report.read', ['analyst'], 'P2'),
  plannedTool('fx.read', 'Đọc tỷ giá có nguồn/ngày.', 'report.read', ['analyst'], 'P2'),
  plannedTool('economics.compute', 'Tính contribution/break-even bằng code xác định.', 'report.read', ['analyst'], 'P2'),
  plannedTool('research.search_approved', 'Tìm trong nguồn đã duyệt.', 'report.read', ['analyst'], 'P3'),
  plannedTool('research.fetch_approved', 'Fetch nguồn đã duyệt (allowlist domain, chặn SSRF).', 'report.read', ['analyst'], 'P3'),
  plannedTool('knowledge.read', 'Đọc knowledge nội bộ.', 'report.read', ['analyst'], 'P3'),
  plannedTool('meta.targeting.capabilities', 'Capability targeting đã xác minh.', 'report.read', ['analyst'], 'P3'),
  plannedTool('meta.audiences.read_metadata', 'Metadata audience (không PII).', 'report.read', ['analyst'], 'P3'),
  plannedTool('audience.validate_plan', 'Kiểm audience plan.', 'report.read', ['analyst'], 'P3'),
  plannedTool('brand.read', 'Đọc brand guide.', 'report.read', ['analyst'], 'P3'),
  plannedTool('assets.search', 'Tìm asset theo rights.', 'report.read', ['analyst'], 'P3'),
  plannedTool('creative.brief.validate', 'Kiểm creative brief.', 'report.read', ['analyst'], 'P3'),
  plannedTool('copy.generate_draft', 'Lưu bản nháp copy.', 'proposal.create', ['analyst'], 'P3', 'internal'),
  plannedTool('copy.validate', 'Kiểm giới hạn ký tự/claim.', 'report.read', ['analyst'], 'P3'),
  plannedTool('landing.read_snapshot', 'Snapshot landing (allowlist domain).', 'report.read', ['analyst'], 'P3'),
  plannedTool('policy.content.evaluate', 'Sàng lọc policy nội dung.', 'report.read', ['analyst'], 'P3'),
  plannedTool('rights.lookup', 'Tra rights registry.', 'report.read', ['analyst'], 'P3'),
  plannedTool('landing.inspect', 'Kiểm landing nhất quán.', 'report.read', ['analyst'], 'P3'),
  plannedTool('meta.tracking.read', 'Đọc pixel/dataset metadata.', 'report.read', ['analyst'], 'P2'),
  plannedTool('tracking.audit', 'Audit event coverage/dedup.', 'report.read', ['analyst'], 'P2'),
  plannedTool('attribution.compare', 'So sánh nguồn theo attribution window.', 'report.read', ['analyst'], 'P2'),
  plannedTool('utm.build', 'Dựng UTM theo policy.', 'report.read', ['analyst'], 'P2'),
  plannedTool('meta.account.capabilities', 'Capability account đã xác minh.', 'report.read', ['analyst'], 'P3'),
  plannedTool('campaign.plan.validate', 'Kiểm campaign plan graph.', 'report.read', ['analyst'], 'P3'),
  plannedTool('budget.simulate', 'Mô phỏng exposure.', 'report.read', ['analyst'], 'P3'),
  plannedTool('experiment.design', 'Thiết kế experiment.', 'report.read', ['analyst'], 'P3'),
  plannedTool('experiment.power_estimate', 'Ước lượng power.', 'report.read', ['analyst'], 'P3'),
  plannedTool('experiment.register', 'Pre-register experiment.', 'proposal.create', ['analyst'], 'P3', 'internal'),
  plannedTool('meta.insights.request', 'Tạo Insights job (read).', 'report.read', ['analyst'], 'P2'),
  plannedTool('meta.insights.poll', 'Poll Insights job.', 'report.read', ['analyst'], 'P2'),
  plannedTool('meta.insights.page', 'Đọc trang Insights.', 'report.read', ['analyst'], 'P2'),
  plannedTool('insights.normalize', 'Chuẩn hóa MetricRow.', 'report.read', ['analyst'], 'P2', 'internal'),
  plannedTool('metrics.compute', 'Tính CPA/ROAS (null khi mẫu số 0).', 'report.read', ['analyst'], 'P2'),
  plannedTool('anomaly.detect', 'Phát hiện bất thường.', 'report.read', ['analyst'], 'P2'),
  plannedTool('diagnosis.explain', 'Giải thích có provenance.', 'report.read', ['analyst'], 'P2'),
  plannedTool('budget.optimize_draft', 'Nháp thay đổi budget.', 'report.read', ['analyst'], 'P4'),
  plannedTool('budget.exposure.compute', 'Tính exposure batch + reservation.', 'report.read', ['analyst'], 'P4'),
  plannedTool('creative.performance.read', 'Chuỗi hiệu suất creative.', 'report.read', ['analyst'], 'P3'),
  plannedTool('fatigue.evaluate', 'Đánh giá fatigue.', 'report.read', ['analyst'], 'P3'),
  plannedTool('creative.refresh.draft', 'Nháp refresh brief.', 'report.read', ['analyst'], 'P3'),
  plannedTool('reports.build', 'Dựng report có revision.', 'report.read', ['analyst'], 'P2'),
  plannedTool('knowledge.propose_learning', 'Đề xuất LearningRecord (không tự sửa policy).', 'proposal.create', ['analyst'], 'P2', 'internal'),
  plannedTool('audit.read', 'Đọc audit đã lọc.', 'audit.read', ['analyst', 'approver', 'operator', 'owner'], 'P2'),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Only these definitions are ever sent to the model. */
export const llmTools = (): ToolDefinition[] => TOOLS.filter((t) => t.llm_exposed && t.status === 'implemented');

/**
 * Claude API tool names allow [a-zA-Z0-9_-]{1,64}; our contract names use dots.
 * Bidirectional mapping keeps the internal names stable.
 */
export const toApiToolName = (name: string): string => name.replace(/\./g, '__');
export const fromApiToolName = (name: string): string => name.replace(/__/g, '.');
