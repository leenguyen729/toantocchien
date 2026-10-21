import { checkSkills } from './lib/check-skills';

const errs = checkSkills();
if (errs.length > 0) {
  console.error(`skills:check FAIL (${errs.length})`);
  for (const e of errs) console.error(`- ${e}`);
  process.exit(1);
}
console.log('skills:check OK — registry 18 skills, SKILL.md/evals hợp lệ cho các skill đã triển khai');
