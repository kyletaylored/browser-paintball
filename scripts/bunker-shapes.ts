// The inflatable bunkers every field uses, one per distinct shape and colour (named by bunkerKey), as
// plain data for the Blender build script art/bunkers.py (scripts/blender-assets.ts passes it over in
// a JSON file) and for the model checks (scripts/check-models.ts: every one must be in bunkers.glb).

import { bunkerKey, type Bunker } from '../shared/field';
import { MAP_LIST } from '../shared/maps';

export type InflatableShape =
  | { key: string; kind: 'box'; w: number; d: number; h: number; color: number }
  | { key: string; kind: 'can'; r: number; h: number; color: number }
  | { key: string; kind: 'poly'; pts: [number, number][]; h: number; color: number };

/** a bunker drawn from bunkers.glb (no look, or 'inflatable', and not a log) */
export const isInflatable = (b: Bunker): boolean => (b.look ?? 'inflatable') === 'inflatable' && b.kind !== 'log';

export function inflatableShapes(): InflatableShape[] {
  const out = new Map<string, InflatableShape>();
  for (const m of MAP_LIST) {
    for (const b of m.bunkers) {
      if (!isInflatable(b)) continue;
      const key = bunkerKey(b);
      if (out.has(key)) continue;
      if (b.kind === 'box') out.set(key, { key, kind: 'box', w: b.w, d: b.d, h: b.h, color: b.color });
      else if (b.kind === 'can') out.set(key, { key, kind: 'can', r: b.r, h: b.h, color: b.color });
      else if (b.kind === 'poly') out.set(key, { key, kind: 'poly', pts: b.pts, h: b.h, color: b.color });
    }
  }
  return [...out.values()];
}
