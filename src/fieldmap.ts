// A field's layout seen from above, drawn from the same bunker data the game plays on
// (shared/maps.ts): for the vote cards. Red's end on the left, Blue's on the right.

import type { GameMap } from '../shared/maps';
import { logHalf } from '../shared/field';

const GROUND: Record<GameMap['theme']['ground'], string> = { turf: '#2f8a3a', sand: '#cdb27a', forest: '#2c5a2a' };
const cache = new Map<string, string>();

/** a picture of the map's layout (a data: URL), made once per map */
export function layoutImage(map: GameMap, width = 240): string {
  const key = `${map.id}@${width}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const L = map.length / 2 + map.margin;
  const W = map.width / 2 + map.margin;
  const scale = width / (2 * L);
  const height = Math.round(2 * W * scale);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d')!;
  const X = (x: number) => (x + L) * scale;
  const Z = (z: number) => (z + W) * scale;

  g.fillStyle = '#16301a';
  g.fillRect(0, 0, width, height);
  g.fillStyle = GROUND[map.theme.ground];
  g.fillRect(X(-map.length / 2), Z(-map.width / 2), map.length * scale, map.width * scale);
  // the start boxes, tinted in team colours, and the lines
  g.fillStyle = 'rgba(255, 59, 59, 0.28)';
  g.fillRect(X(-map.length / 2), Z(-map.width / 2), 3 * scale, map.width * scale);
  g.fillStyle = 'rgba(59, 139, 255, 0.28)';
  g.fillRect(X(map.length / 2 - 3), Z(-map.width / 2), 3 * scale, map.width * scale);
  g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  g.lineWidth = Math.max(1, scale * 0.15);
  g.strokeRect(X(-map.length / 2), Z(-map.width / 2), map.length * scale, map.width * scale);
  g.setLineDash([scale * 0.8, scale * 0.8]);
  g.beginPath();
  g.moveTo(X(0), Z(-map.width / 2));
  g.lineTo(X(0), Z(map.width / 2));
  g.stroke();
  g.setLineDash([]);

  g.lineWidth = Math.max(1, scale * 0.12);
  g.strokeStyle = '#0b0a10';
  for (const b of map.bunkers) {
    g.fillStyle = `#${b.color.toString(16).padStart(6, '0')}`;
    g.beginPath();
    if (b.kind === 'can') {
      g.arc(X(b.x), Z(b.z), Math.max(1.2, b.r * scale), 0, Math.PI * 2);
    } else if (b.kind === 'poly') {
      b.pts.forEach(([px, pz], i) => (i ? g.lineTo(X(b.x + px), Z(b.z + pz)) : g.moveTo(X(b.x + px), Z(b.z + pz))));
      g.closePath();
    } else {
      const [hx, hz] = b.kind === 'log' ? logHalf(b) : [b.w / 2, b.d / 2];
      g.rect(X(b.x - hx), Z(b.z - hz), Math.max(1.5, 2 * hx * scale), Math.max(1.5, 2 * hz * scale));
    }
    g.fill();
    g.stroke();
  }
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}
