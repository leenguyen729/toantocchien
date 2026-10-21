import { mkdirSync, writeFileSync } from 'node:fs';
import { COMMON_CATEGORIES, runAll } from './lib/skill-evals';

/**
 * `pnpm evals` — deterministic skill evals through the real tool layer.
 * Writes reports/skill-evals/{results.json,REPORT.md}; exits 1 on any failure.
 */
const only = process.argv.slice(2);
const results = (await runAll()).filter((r) => only.length === 0 || only.includes(r.skill));
const ranAt = new Date().toISOString();
mkdirSync('reports/skill-evals', { recursive: true });
writeFileSync(
  'reports/skill-evals/results.json',
  JSON.stringify({ ran_at: ranAt, model: 'none (deterministic tool-layer evals, không gọi Claude API)', prompt_version: 'n/a', results }, null, 2) + '\n',
);
const lines = [
  '# Kết quả skill evals',
  '',
  `Chạy lúc ${ranAt}. Model: không gọi (eval xác định qua tool layer + fake Meta). Fixture hash: ${results[0]?.fixture_hash ?? '-'}.`,
  '',
  '| Skill | Version | Pass | Fail | Critical fail | Thiếu nhóm chung |',
  '|---|---|---|---|---|---|',
];
let failed = 0;
for (const r of results) {
  const pass = r.cases.filter((c) => c.passed).length;
  const fail = r.cases.length - pass;
  const crit = r.cases.filter((c) => !c.passed && c.critical).length;
  const missing = COMMON_CATEGORIES.filter((k) => !r.cases.some((c) => c.category === k));
  failed += fail + missing.length;
  lines.push(`| ${r.skill} | ${r.skill_version} | ${pass} | ${fail} | ${crit} | ${missing.join(', ') || '—'} |`);
}
lines.push('');
for (const r of results) {
  for (const c of r.cases.filter((x) => !x.passed)) lines.push(`- ❌ ${r.skill}/${c.id}: ${c.failures.join(' | ')}`);
}
writeFileSync('reports/skill-evals/REPORT.md', lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exit(failed > 0 ? 1 : 0);
