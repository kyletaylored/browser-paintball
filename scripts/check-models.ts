// Checks the committed Blender-made models (art/models.json) without Blender: each source is in the
// repo, and each exported file in public/models still has the nodes, animations and materials the
// game looks up, is compressed, and is within its size and triangle budgets.   npm run check:models

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkModel, loadRules } from './model-rules';

let failed = 0;
for (const rule of loadRules()) {
  const file = join('public/models', rule.out);
  const problems: string[] = [];
  let summary = '';
  if (!existsSync(rule.source)) problems.push(`its source ${rule.source} isn't in the repo`);
  if (!existsSync(file)) {
    problems.push(`${file} is missing: run npm run assets:blender`);
  } else {
    const r = await checkModel(rule, file);
    problems.push(...r.problems);
    summary = r.summary;
  }
  console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${rule.out}: ${rule.what}${summary ? ` (${summary})` : ''}`);
  for (const p of problems) console.log(`      ${p}`);
  if (problems.length) failed++;
}
if (failed) console.log(`\n${failed} model(s) need fixing: see docs/BLENDER.md`);
process.exit(failed ? 1 : 0);
