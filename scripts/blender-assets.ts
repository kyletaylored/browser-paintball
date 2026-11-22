// Exports the Blender-made models (art/models.json) to public/models:
//
//   npm run assets:blender              every model
//   npm run assets:blender -- pump      just the ones whose source or file name contains "pump"
//
// For each: Blender runs headless (scripts/blender/export.py builds or opens the source and writes
// a .glb), then the file is welded, deduplicated and meshopt-compressed like the code-made models
// (scripts/build-assets.ts), and checked against its rules. See docs/BLENDER.md.
//
// Finds Blender from the BLENDER environment variable, then `blender` on the PATH, then the usual
// install folders on Windows and macOS.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedup, meshopt, prune, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { checkModel, gltfIO, loadRules } from './model-rules';
import { inflatableShapes } from './bunker-shapes';
import { addPlayerClips, rigData } from './player-rig';

function findBlender(): string {
  if (process.env.BLENDER) return process.env.BLENDER;
  try {
    execFileSync('blender', ['--version'], { stdio: 'ignore' });
    return 'blender';
  } catch {
    // not on the PATH
  }
  const candidates: string[] = [];
  const pf = process.env.ProgramFiles;
  if (pf && existsSync(join(pf, 'Blender Foundation'))) {
    // newest version first
    const versions = readdirSync(join(pf, 'Blender Foundation'))
      .filter((d) => /^Blender \d/.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) candidates.push(join(pf, 'Blender Foundation', v, 'blender.exe'));
  }
  candidates.push('/Applications/Blender.app/Contents/MacOS/Blender');
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("can't find Blender: install it, or set BLENDER to its executable");
  return found;
}

const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const rules = loadRules().filter((r) => !filter.length || filter.some((f) => r.source.includes(f) || r.out.includes(f)));
if (!rules.length) throw new Error(`no model in art/models.json matches ${filter.join(' ')}`);

const blender = findBlender();
console.log(`Blender: ${execFileSync(blender, ['--version']).toString().split('\n')[0].trim()}`);
const tmp = mkdtempSync(join(tmpdir(), 'splat-blender-'));
let failed = 0;
try {
  for (const rule of rules) {
    if (!existsSync(rule.source)) throw new Error(`${rule.source} doesn't exist`);
    const raw = join(tmp, rule.out);
    const args = ['--background', '--factory-startup', '--python-exit-code', '1'];
    if (rule.source.endsWith('.blend')) args.push(rule.source);
    args.push('--python', 'scripts/blender/export.py', '--', '--source', rule.source, '--out', raw);
    // game data the build script needs (the bunker shapes from shared/maps.ts), as a JSON file
    const env = { ...process.env };
    if (rule.input) {
      const file = join(tmp, `${rule.input}.json`);
      writeFileSync(file, JSON.stringify(rule.input === 'bunkers' ? inflatableShapes() : rigData()));
      env.SPLAT_INPUT = file;
    }
    const run = spawnSync(blender, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0 || !existsSync(raw)) {
      console.log(`FAIL  ${rule.out}: Blender couldn't export ${rule.source}\n${run.stdout}\n${run.stderr}`);
      failed++;
      continue;
    }
    // compress like the code-made models
    const io = await gltfIO();
    const doc = await io.read(raw);
    // animations kept in code (the player's: scripts/player-rig.ts) go on before compressing
    if (rule.clips === 'player') addPlayerClips(doc);
    await doc.transform(
      weld(),
      dedup(),
      prune({ keepLeaves: true }),
      meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14, quantizeNormal: 10 }),
    );
    const out = join('public/models', rule.out);
    await io.write(out, doc);
    const { problems, summary } = await checkModel(rule, out);
    console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${rule.out.padEnd(18)} ${summary}  (${(statSync(raw).size / 1024).toFixed(0)} KB before compression)`);
    for (const p of problems) console.log(`      ${p}`);
    if (problems.length) failed++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
