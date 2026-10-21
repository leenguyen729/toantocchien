import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES, SCHEMA_NAMES, SKILL_PAYLOAD_SCHEMAS, SKILL_SLUGS } from '@pod/contracts';
import { TOOLS_BY_NAME } from '@pod/adapter-claude';
import { COMMON_CATEGORIES, type EvalFile } from './skill-evals';

export const REQUIRED_SECTIONS = [
  'Mục đích',
  'Trigger và anti-trigger',
  'Preconditions',
  'Input/Output schema',
  'Nguồn dữ liệu',
  'Tools cho phép',
  'Workflow',
  'Công thức',
  'Lỗi và fallback',
  'Approval',
  'Bảo mật',
  'Ví dụ',
  'Tests và acceptance',
] as const;

type RegistrySkill = {
  id: string;
  slug: string;
  status: 'implemented' | 'planned';
  phase: string;
  version: string;
  tools: string[];
  invoker_roles: string[];
  input_schema: string;
  output_schema: string;
  skill_md: string | null;
  evals: string | null;
};

function frontmatter(md: string): Record<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Static checks for `.claude/skills`. Returns a list of problems; empty means OK. */
export function checkSkills(root = '.claude/skills'): string[] {
  const errs: string[] = [];
  const reg = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')) as { skills: RegistrySkill[] };
  const skills = reg.skills;
  if (skills.length !== 18) errs.push(`registry có ${skills.length} skill, phải đúng 18`);
  const slugs = skills.map((s) => s.slug);
  if (JSON.stringify(slugs) !== JSON.stringify(SKILL_SLUGS)) errs.push('slug registry không khớp SKILL_SLUGS (thứ tự S01..S18)');
  skills.forEach((s, i) => {
    if (s.id !== `S${String(i + 1).padStart(2, '0')}`) errs.push(`${s.slug}: id ${s.id} sai thứ tự`);
  });
  if (new Set(slugs).size !== slugs.length) errs.push('slug trùng');

  for (const s of skills) {
    const tag = `${s.id} ${s.slug}`;
    const expected = SKILL_PAYLOAD_SCHEMAS[s.slug as (typeof SKILL_SLUGS)[number]];
    if (!expected || expected.input !== s.input_schema || expected.output !== s.output_schema) errs.push(`${tag}: schema không khớp SKILL_PAYLOAD_SCHEMAS`);
    for (const n of [s.input_schema, s.output_schema]) if (!SCHEMA_NAMES.includes(n)) errs.push(`${tag}: schema ${n} không có trong bundle`);
    for (const r of s.invoker_roles) if (!(ROLES as readonly string[]).includes(r)) errs.push(`${tag}: role lạ ${r}`);
    if (s.tools.length === 0) errs.push(`${tag}: không có tool`);
    for (const t of s.tools) {
      const def = TOOLS_BY_NAME.get(t);
      if (!def) errs.push(`${tag}: tool ${t} không có trong manifest`);
      else if (s.status === 'implemented' && (def.status !== 'implemented' || !def.llm_exposed)) errs.push(`${tag}: tool ${t} chưa implemented hoặc không expose cho LLM`);
    }

    const dir = join(root, s.slug);
    const mdPath = join(dir, 'SKILL.md');
    if (s.status === 'planned') {
      // A planned skill must not ship a hollow SKILL.md that a runtime could load.
      if (existsSync(mdPath)) errs.push(`${tag}: planned nhưng đã có SKILL.md; đổi status hoặc bỏ file`);
      if (s.skill_md !== null || s.evals !== null) errs.push(`${tag}: planned phải có skill_md/evals = null`);
      continue;
    }
    if (s.skill_md !== mdPath || s.evals !== join(dir, 'evals', 'evals.json')) errs.push(`${tag}: đường dẫn skill_md/evals sai`);
    if (!existsSync(mdPath)) {
      errs.push(`${tag}: thiếu SKILL.md`);
      continue;
    }
    const md = readFileSync(mdPath, 'utf8');
    const fm = frontmatter(md);
    if (!fm) errs.push(`${tag}: thiếu YAML frontmatter`);
    else {
      if (fm.name !== s.slug) errs.push(`${tag}: frontmatter name khác slug`);
      const d = fm.description ?? '';
      if (d.length < 50 || d.length > 1024) errs.push(`${tag}: description phải 50..1024 ký tự`);
      if (!/Không dùng/.test(d)) errs.push(`${tag}: description thiếu anti-trigger ("Không dùng ...")`);
      if (/[<>]/.test(d)) errs.push(`${tag}: description không được chứa < >`);
    }
    const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
    for (const h of REQUIRED_SECTIONS) if (!headings.includes(h)) errs.push(`${tag}: thiếu mục "## ${h}"`);
    const toolsSection = md.split('## Tools cho phép')[1]?.split('\n## ')[0] ?? '';
    for (const t of s.tools) if (!toolsSection.includes(`\`${t}\``)) errs.push(`${tag}: mục Tools cho phép không nhắc ${t}`);

    const evalPath = join(dir, 'evals', 'evals.json');
    if (!existsSync(evalPath)) {
      errs.push(`${tag}: thiếu evals`);
      continue;
    }
    const ev = JSON.parse(readFileSync(evalPath, 'utf8')) as EvalFile;
    if (ev.skill !== s.slug || ev.skill_version !== s.version) errs.push(`${tag}: evals skill/version khác registry`);
    if (ev.cases.length < 6) errs.push(`${tag}: cần ≥6 eval`);
    for (const k of COMMON_CATEGORIES) if (!ev.cases.some((c) => c.category === k)) errs.push(`${tag}: thiếu eval nhóm ${k}`);
    if (new Set(ev.cases.map((c) => c.id)).size !== ev.cases.length) errs.push(`${tag}: eval id trùng`);
  }

  for (const d of readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    if (!slugs.includes(d.name)) errs.push(`thư mục .claude/skills/${d.name} không có trong registry`);
  }
  return errs;
}
