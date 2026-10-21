import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { TOOLS, toClaudeApiTools } from '@pod/adapter-claude';
import { createSystem, loadRuntimeConfig } from '@pod/domain';
import { buildApp } from '../apps/api/src/app';

/**
 * `pnpm gen:docs` — sinh tài liệu từ code để không lệch: tool manifest,
 * export tool cho Claude API, danh sách route HTTP. `--check` báo lỗi nếu file cũ.
 */
const check = process.argv.includes('--check');
const out: Record<string, string> = {};

const registry = JSON.parse(readFileSync('.claude/skills/registry.json', 'utf8')) as { skills: { id: string; slug: string; tools: string[] }[] };
const usedBy = (t: string) => registry.skills.filter((s) => s.tools.includes(t)).map((s) => s.id).join(', ') || '—';
const rows = TOOLS.map(
  (t) => `| \`${t.name}\` | ${t.status} | ${t.phase} | ${t.llm_exposed ? 'có' : '**không**'} | ${t.side_effect} | \`${t.permission}\` | ${t.required_role.join(', ')} | ${t.retry_class} | ${t.timeout_ms} | ${t.audit_event ?? '—'} | ${usedBy(t.name)} | ${t.description.replace(/\|/g, '\\|')} |`,
);
out['docs/generated/tool-manifest.md'] = [
  '# Tool manifest (sinh tự động)',
  '',
  'Nguồn: `packages/adapters/claude/src/manifest.ts`. Đừng sửa tay; chạy `pnpm gen:docs`.',
  'Tool `planned` trả `CAPABILITY_UNSUPPORTED`. Tool `llm_exposed=không` không bao giờ gửi cho model.',
  '',
  '| Tool | Trạng thái | Phase | Cho LLM | Side effect | Permission | Vai trò | Retry | Timeout ms | Audit | Skill | Mô tả |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows,
  '',
].join('\n');
out['docs/generated/claude-api-tools.json'] = JSON.stringify(toClaudeApiTools(), null, 2) + '\n';

const sys = createSystem({ runtime: loadRuntimeConfig({ EXECUTION_MODE: 'mock', LIVE_WRITES_ENABLED: 'false' }), role: 'all-in-one' });
const routes: string[] = [];
const app = await buildApp({ sys, mockTools: true });
await app.ready();
for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) if (line.trim()) routes.push(line);
await app.close();
out['docs/generated/http-routes.md'] = [
  '# HTTP routes (sinh tự động)',
  '',
  'Nguồn: `apps/api/src/app.ts` (Fastify `printRoutes`). Route `/api/mock/*` chỉ được đăng ký ở mock mode; `/api/auth/*` (login demo) trả `CAPABILITY_UNSUPPORTED` ngoài mock mode.',
  'Mọi route trừ `/api/health`, `/api/tools` và login demo yêu cầu `Authorization: Bearer <session>` của người dùng. Body được validate bằng JSON Schema (`additionalProperties: false`).',
  '',
  '```text',
  ...routes,
  '```',
  '',
].join('\n');

let stale = false;
mkdirSync('docs/generated', { recursive: true });
for (const [f, c] of Object.entries(out)) {
  let cur = '';
  try {
    cur = readFileSync(f, 'utf8');
  } catch {
    /* new file */
  }
  if (cur !== c) {
    stale = true;
    if (!check) writeFileSync(f, c);
  }
}
if (check && stale) {
  console.error('docs/generated đã cũ: chạy pnpm gen:docs');
  process.exit(1);
}
console.log(check ? 'docs/generated khớp code' : 'Đã sinh docs/generated');
