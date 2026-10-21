import { formatMinor } from '@pod/contracts';
import { MockAnalyst, ToolExecutor } from '@pod/adapter-claude';
import { DEMO, ManualClock, claudeRuntimePrincipal, createSystem, loadRuntimeConfig, seedDemo, verifyAuditChain } from '@pod/domain';

/**
 * `pnpm demo` — clone sạch, không token: draft → người duyệt → worker giả lập → receipt.
 * Mọi thứ chạy trong bộ nhớ với fake Meta; không có request mạng nào.
 */
const runtime = loadRuntimeConfig({ EXECUTION_MODE: 'mock', LIVE_WRITES_ENABLED: 'false' });
const clock = new ManualClock('2026-10-21T03:00:00Z');
const sys = createSystem({ runtime, clock, role: 'all-in-one' });
const people = await seedDemo(sys);
const meta = sys.fakeMeta!;
const say = (s: string) => console.log(s);

say(`Mode=${runtime.mode}, LIVE_WRITES_ENABLED=${runtime.liveWritesEnabled}, adapter=${sys.deps.metaRead.kind}. Không gọi Meta thật.`);
const analyst = new MockAnalyst(new ToolExecutor(sys), claudeRuntimePrincipal(DEMO.tenant_id, [DEMO.ad_account_id]));
const r = await analyst.draftDailyBudgetChange(DEMO.ad_account_id, 'adset_demo', 1100, ['snapshot_demo'], 'Demo: CPA fixture dưới target (dữ liệu mô phỏng).');
if (r.status !== 'ok') throw new Error(`Mock analyst lỗi: ${JSON.stringify(r.errors)}`);
const p = r.data as { proposal_id: string; revision: number; payload_hash: string; status: string; impact: { exposure_minor: number; currency: string } };
say(`1. Mock analyst (qua tool layer) tạo ${p.proposal_id} r${p.revision}: ${p.status}, exposure ${formatMinor(p.impact.exposure_minor, p.impact.currency)}, hash ${p.payload_hash.slice(0, 16)}…`);

try {
  await sys.execution.request(people.u_analyst!, p.proposal_id, p.revision, p.payload_hash);
} catch (e) {
  say(`2. Xin thực thi khi chưa duyệt → bị chặn: ${(e as { code?: string }).code}. Outbound writes: ${meta.outboundWrites.length}`);
}

await sys.approvals.decide(people.u_approver!, p.proposal_id, p.revision, p.payload_hash, 'approved', 'Demo duyệt');
say('3. Approver (con người, đã xác thực) duyệt đúng hash.');
await sys.execution.request(people.u_approver!, p.proposal_id, p.revision, p.payload_hash);
await sys.worker!.drain();
const receipt = await sys.deps.store.getReceipt(DEMO.tenant_id, p.proposal_id, p.revision);
const after = await meta.getEntity(DEMO.ad_account_id, 'adset_demo');
say(`4. Worker giả lập: ${receipt?.final_status}, simulated=${receipt?.simulated}, đọc lại remote daily=${formatMinor(after!.daily_budget_minor!, 'USD')}.`);
say(`5. Outbound writes tới simulator: ${meta.outboundWrites.length}. Chuỗi audit: ${verifyAuditChain(await sys.deps.store.listAudit(DEMO.tenant_id)).ok ? 'hợp lệ' : 'HỎNG'}.`);
say('Không có quảng cáo thật nào được chạy; LIVE_WRITES_ENABLED vẫn false.');
