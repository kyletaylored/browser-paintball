// The holiday fields (shared/maps.ts): Halloween, Christmas, Thanksgiving, the Fourth of July and Chinese
// New Year. Their bunkers, ground, surroundings and boundary lines, drawn from code like the rest of
// the field (src/world.ts calls in here for the looks and themes it doesn't draw itself).
//
// Look only, as everywhere in world.ts: paint and players collide with the shapes in shared/field.ts,
// so each bunker here fills its collision shape (a pumpkin is the orb, a Christmas tree is the cone),
// and anything that sticks out past it (a stem, a bow, a star on top) is small.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { orbY, type Bunker, type Look, type ProfileBunker, type TaperBunker } from '../shared/field';
import type { GameMap, MapTheme } from '../shared/maps';

/** the bits of world.ts's material cache this file uses */
export interface Mats {
  get(key: string, make: () => THREE.Material): THREE.Material;
  plain(color: number, roughness?: number, flat?: boolean): THREE.Material;
}

/** world.ts's geometry for tapering shapes and shaped walls, so the drawn shape is the collision shape */
export interface Geos {
  taper(b: TaperBunker, y0?: number, y1?: number, grow?: number): THREE.BufferGeometry;
  profile(b: ProfileBunker, cap?: number, grow?: number): THREE.BufferGeometry;
}

/** something round the field that moves (falling snow, fireworks, swaying lanterns) */
export type Animate = (dt: number, time: number) => void;

const css = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const shade = (n: number, k: number) => new THREE.Color(n).multiplyScalar(k).getHex();

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = false): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** a seeded random number generator, so every machine draws the same field */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** a five-pointed star path at (x, y) */
function starPath(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.42 : r;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
}

// ---- bunkers ----------------------------------------------------------------------------------

export const HOLIDAY_LOOKS: ReadonlySet<Look> = new Set<Look>([
  'pumpkin', 'jacko', 'grave', 'coffin', 'witchhat', 'deadtree',
  'present', 'xtree', 'snowwall', 'ornament',
  'hay', 'haybale', 'cornshock', 'wagon',
  'rocket', 'starbox', 'stripes', 'firecracker',
  'lantern', 'drum', 'dragon', 'pagoda',
]);

/** draw a holiday bunker into g (its base at y 0, centred on its x, z); false if it isn't one */
export function drawHolidayBunker(g: THREE.Group, b: Bunker, look: Look, mats: Mats, geos: Geos): boolean {
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, y = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    g.add(m);
    return m;
  };
  const glow = (color: number) => mats.get(`glow-${color}`, () => new THREE.MeshBasicMaterial({ color }));

  switch (look) {
    // ---- Halloween
    case 'pumpkin':
    case 'jacko': {
      if (b.kind !== 'orb') return false;
      // a jack-o'-lantern's carved face looks toward the middle of the field (both ways on the line)
      const faces = look === 'pumpkin' ? [] : b.x < -0.01 ? [0.5] : b.x > 0.01 ? [0] : [0, 0.5];
      const mat = mats.get(`pumpkin-${b.color}-${look}-${faces.join()}`, () => new THREE.MeshStandardMaterial({
        map: pumpkinTexture(b.color), roughness: 0.75,
        ...(faces.length ? { emissive: 0xffffff, emissiveMap: faceTexture(faces) } : {}),
      }));
      add(new THREE.SphereGeometry(b.r, 36, 22), mat, orbY(b));
      const stem = add(new THREE.CylinderGeometry(b.r * 0.07, b.r * 0.11, b.r * 0.32, 7), mats.plain(0x5a6a2a, 1), orbY(b) + b.r * 1.04);
      stem.rotation.z = 0.25;
      return true;
    }
    case 'grave': {
      if (b.kind !== 'profile') return false;
      add(geos.profile(b), mats.get(`stone-${b.color}`, () => new THREE.MeshStandardMaterial({ color: b.color, roughness: 1, flatShading: true })));
      // a cross cut into both faces, and moss along the bottom
      const cut = mats.plain(shade(b.color, 0.55), 1);
      const top = Math.max(...b.line.map(([, y]) => y));
      for (const s of [-1, 1]) {
        const off = s * (b.d / 2 + 0.004);
        const upright = add(new THREE.BoxGeometry(0.01, 0.42, 0.09), cut, top - 0.52);
        const arm = add(new THREE.BoxGeometry(0.01, 0.09, 0.3), cut, top - 0.44);
        if (b.axis === 'z') upright.position.x = arm.position.x = off;
        else {
          upright.rotation.y = arm.rotation.y = Math.PI / 2;
          upright.position.z = arm.position.z = off;
        }
      }
      add(geos.profile(b, 0.14, 1.02), mats.plain(0x4a5a34, 1), 0);
      return true;
    }
    case 'coffin': {
      if (b.kind !== 'box') return false;
      const wood = mats.get(`coffin-${b.color}`, () => new THREE.MeshStandardMaterial({ map: grainTexture(b.color), roughness: 0.8 }));
      add(new RoundedBoxGeometry(b.w, b.h, b.d, 2, 0.05), wood, b.h / 2);
      const brass = mats.plain(0xc9a24a, 0.4);
      const trim = mats.plain(shade(b.color, 0.6), 0.8);
      if (b.h < 0.9) {
        // lying down: a lid with a cross on top
        add(new THREE.BoxGeometry(b.w * 0.96, 0.05, b.d * 0.92), trim, b.h - 0.02);
        const along = b.w > b.d;
        add(new THREE.BoxGeometry(along ? 0.62 : 0.12, 0.02, along ? 0.12 : 0.62), brass, b.h + 0.01);
        add(new THREE.BoxGeometry(along ? 0.12 : 0.34, 0.02, along ? 0.34 : 0.12), brass, b.h + 0.01).position[along ? 'x' : 'z'] = -0.12;
      } else {
        // stood on its side: a cross on each face toward the teams
        for (const s of [-1, 1]) {
          add(new THREE.BoxGeometry(0.02, 0.62, 0.12), brass, b.h * 0.55).position.x = s * (b.w / 2 + 0.006);
          add(new THREE.BoxGeometry(0.02, 0.12, 0.38), brass, b.h * 0.62).position.x = s * (b.w / 2 + 0.006);
        }
      }
      return true;
    }
    case 'witchhat': {
      if (b.kind !== 'taper') return false;
      add(geos.taper(b), mats.plain(b.color, 0.9, true));
      add(geos.taper(b, b.h * 0.12, b.h * 0.24, 1.03), mats.plain(0x7a3fb0, 0.6));
      // a wide, floppy brim at the bottom and a gold buckle on the band
      const brim = add(new THREE.CylinderGeometry(1.0, 1.0, 0.06, 24), mats.plain(shade(b.color, 1.2), 0.9), 0.03);
      const r = Math.max(...b.pts.map(([x, z]) => Math.hypot(x, z)));
      brim.scale.set(r * 1.02, 1, r * 1.02);
      for (const s of [-1, 1]) {
        const buckle = add(new THREE.BoxGeometry(0.03, 0.2, 0.22), mats.plain(0xf0c040, 0.4), b.h * 0.18);
        buckle.position.x = s * r * 0.83;
      }
      return true;
    }
    case 'deadtree': {
      if (b.kind !== 'can') return false;
      const bark = mats.plain(b.color, 1, true);
      add(new THREE.CylinderGeometry(b.r * 0.55, b.r, b.h, 8), bark, b.h / 2);
      // bare, crooked branches, all up out of reach
      const rnd = seeded(Math.round(b.x * 97 + b.z * 31 + 500));
      for (let i = 0; i < 6; i++) {
        const len = 1.2 + rnd() * 1.6;
        const br = add(new THREE.CylinderGeometry(0.035, 0.09, len, 5), bark, 0);
        const y = b.h * (0.45 + rnd() * 0.5);
        const a = rnd() * Math.PI * 2;
        const tilt = 0.6 + rnd() * 0.6;
        br.position.set(Math.cos(a) * len * 0.4 * Math.sin(tilt), y + len * 0.4 * Math.cos(tilt), Math.sin(a) * len * 0.4 * Math.sin(tilt));
        br.rotation.set(Math.sin(a) * tilt, 0, -Math.cos(a) * tilt);
      }
      return true;
    }

    // ---- Christmas
    case 'present': {
      if (b.kind !== 'box') return false;
      add(new THREE.BoxGeometry(b.w, b.h, b.d), mats.plain(b.color, 0.7), b.h / 2);
      const ribbonColor = b.color === 0xe8b839 ? 0xd8263a : 0xf2d36b;
      const ribbon = mats.plain(ribbonColor, 0.45);
      const rw = Math.min(b.w, b.d) * 0.16;
      add(new THREE.BoxGeometry(b.w + 0.01, b.h + 0.01, rw), ribbon, b.h / 2);
      add(new THREE.BoxGeometry(rw, b.h + 0.01, b.d + 0.01), ribbon, b.h / 2);
      // a bow on top
      for (const s of [-1, 1]) {
        const loop = add(new THREE.TorusGeometry(rw * 0.9, rw * 0.28, 8, 16), ribbon, b.h + rw * 0.7);
        loop.position.x = s * rw * 0.8;
        loop.rotation.y = Math.PI / 2;
        loop.rotation.z = s * 0.5;
      }
      return true;
    }
    case 'xtree': {
      if (b.kind !== 'taper') return false;
      add(geos.taper(b), mats.plain(b.color, 0.95, true));
      // snow on the lower branches, then baubles and a star
      add(geos.taper(b, 0, b.h * 0.08, 1.02), mats.plain(0xf2f6fb, 1));
      const r = Math.max(...b.pts.map(([x, z]) => Math.hypot(x, z)));
      const rnd = seeded(Math.round(b.x * 13 + b.z * 7 + 900));
      const colors = [0xd8263a, 0xf2c14e, 0x3b7bd8, 0xf2f2f2, 0xb45cff];
      for (let i = 0; i < 14; i++) {
        const t = 0.12 + rnd() * 0.72;
        const a = rnd() * Math.PI * 2;
        const rr = r * 0.93 * (1 - t);
        const bauble = add(new THREE.SphereGeometry(0.075 + rnd() * 0.03, 10, 8), glow(colors[i % colors.length]), b.h * t);
        bauble.position.x = Math.cos(a) * rr;
        bauble.position.z = Math.sin(a) * rr;
      }
      const star = add(starGeometry(0.22, 0.06), glow(0xffe27a), b.h + 0.12);
      star.rotation.y = b.x > 0 ? Math.PI / 2 : -Math.PI / 2;
      return true;
    }
    case 'snowwall': {
      if (b.kind !== 'box') return false;
      // rows of packed snow blocks filling the footprint
      const snow = mats.plain(b.color, 1);
      const rows = Math.max(2, Math.round(b.h / 0.36));
      const along = b.w >= b.d;
      const len = along ? b.w : b.d;
      const n = Math.max(1, Math.round(len / 0.8));
      const bl = len / n;
      const rh = b.h / rows;
      for (let row = 0; row < rows; row++) {
        const shift = row % 2 ? bl / 2 : 0;
        for (let i = 0; i <= n; i++) {
          const u0 = Math.max(-len / 2, -len / 2 + i * bl - shift);
          const u1 = Math.min(len / 2, -len / 2 + (i + 1) * bl - shift);
          if (u1 - u0 < 0.08) continue;
          const s = u1 - u0;
          const geo = new RoundedBoxGeometry(along ? s : b.w, rh, along ? b.d : s, 2, Math.min(rh, s) * 0.3);
          const m = add(geo, snow, rh / 2 + row * rh);
          if (along) m.position.x = (u0 + u1) / 2;
          else m.position.z = (u0 + u1) / 2;
        }
      }
      return true;
    }
    case 'ornament': {
      if (b.kind !== 'orb') return false;
      const y = orbY(b);
      add(new THREE.SphereGeometry(b.r, 36, 24), mats.get(`bauble-${b.color}`, () => new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.25, metalness: 0.3 })), y);
      const band = b.color === 0xf2c14e ? 0xd8263a : 0xf2f2f2;
      add(new THREE.CylinderGeometry(b.r * 1.004, b.r * 1.004, b.r * 0.16, 36, 1, true), mats.plain(band, 0.5), y);
      add(new THREE.CylinderGeometry(b.r * 0.22, b.r * 0.26, b.r * 0.22, 14), mats.plain(0xc9a24a, 0.35), y + b.r * 1.03);
      const loop = add(new THREE.TorusGeometry(b.r * 0.1, b.r * 0.025, 6, 14), mats.plain(0xc9a24a, 0.35), y + b.r * 1.22);
      loop.rotation.y = Math.PI / 2;
      return true;
    }

    // ---- Thanksgiving
    case 'hay': {
      if (b.kind !== 'box') return false;
      const straw = mats.get(`straw-${b.color}`, () => new THREE.MeshStandardMaterial({ map: strawTexture(b.color), roughness: 1 }));
      const twine = mats.plain(0x6b4a2a, 1);
      const along = b.w >= b.d;
      const len = along ? b.w : b.d;
      const n = Math.max(1, Math.round(len / 1.1));
      const rows = Math.max(1, Math.round(b.h / 0.46));
      const bl = len / n;
      const rh = b.h / rows;
      for (let row = 0; row < rows; row++) {
        for (let i = 0; i < n; i++) {
          const u = -len / 2 + bl / 2 + i * bl;
          const m = add(new RoundedBoxGeometry(along ? bl - 0.02 : b.w, rh - 0.02, along ? b.d : bl - 0.02, 2, 0.05), straw, rh / 2 + row * rh);
          if (along) m.position.x = u;
          else m.position.z = u;
          for (const k of [-0.22, 0.22]) {
            const t = add(new THREE.BoxGeometry(along ? 0.03 : b.w + 0.01, rh - 0.01, along ? b.d + 0.01 : 0.03), twine, rh / 2 + row * rh);
            if (along) t.position.x = u + k * bl;
            else t.position.z = u + k * bl;
          }
        }
      }
      return true;
    }
    case 'haybale': {
      if (b.kind !== 'log') return false;
      const side = mats.get(`bale-${b.color}`, () => new THREE.MeshStandardMaterial({ map: strawTexture(b.color), roughness: 1 }));
      const end = mats.get(`bale-end-${b.color}`, () => new THREE.MeshStandardMaterial({ map: spiralTexture(b.color), roughness: 1 }));
      const m = add(new THREE.CylinderGeometry(b.r, b.r, b.len, 24, 1, false), [side, end, end] as unknown as THREE.Material, b.r);
      if (b.axis === 'x') m.rotation.z = Math.PI / 2;
      else m.rotation.x = Math.PI / 2;
      return true;
    }
    case 'cornshock': {
      if (b.kind !== 'taper') return false;
      add(geos.taper(b), mats.get(`corn-${b.color}`, () => new THREE.MeshStandardMaterial({ color: b.color, roughness: 1, flatShading: true })));
      add(geos.taper(b, b.h * 0.62, b.h * 0.7, 1.04), mats.plain(0x6b4a2a, 1));
      // the stalk tops fanning out above the tie
      const r = Math.max(...b.pts.map(([x, z]) => Math.hypot(x, z)));
      const tops = mats.plain(shade(b.color, 1.1), 1, true);
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        const stalk = add(new THREE.BoxGeometry(0.05, 0.5, 0.05), tops, b.h + 0.18);
        stalk.position.x = Math.cos(a) * r * b.top * 0.6;
        stalk.position.z = Math.sin(a) * r * b.top * 0.6;
        stalk.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
      }
      return true;
    }
    case 'wagon': {
      if (b.kind !== 'box') return false;
      const body = mats.plain(b.color, 0.8);
      const dark = mats.plain(0x2e2620, 1);
      const bed = 0.5;
      add(new THREE.BoxGeometry(b.w, b.h - bed, b.d), body, bed + (b.h - bed) / 2);
      add(new THREE.BoxGeometry(b.w * 0.9, 0.08, b.d * 0.92), mats.get(`straw-${0xd9b45a}`, () => new THREE.MeshStandardMaterial({ map: strawTexture(0xd9b45a), roughness: 1 })), b.h + 0.02);
      add(new THREE.BoxGeometry(b.w * 0.8, bed, b.d * 0.9), dark, bed / 2);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const wheel = add(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 18), mats.plain(0x3a2a1c, 0.9), 0.42);
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(sx * (b.w / 2 - 0.05), 0.42, sz * (b.d / 2 - 0.48));
        }
      }
      // white trim along the top
      add(new THREE.BoxGeometry(b.w + 0.01, 0.07, b.d + 0.01), mats.plain(0xf1ead8, 0.7), b.h - 0.06);
      return true;
    }

    // ---- Fourth of July
    case 'rocket': {
      if (b.kind !== 'taper') return false;
      add(geos.taper(b), mats.plain(b.color, 0.6));
      const stripe = mats.plain(b.color === 0xf1f1ef ? 0xd23a3a : 0xf1f1ef, 0.6);
      for (const [y0, y1] of [[0.18, 0.3], [0.42, 0.54], [0.66, 0.76]]) add(geos.taper(b, b.h * y0, b.h * y1, 1.012), stripe);
      const r = Math.max(...b.pts.map(([x, z]) => Math.hypot(x, z)));
      // the nose cone and four fins at the bottom
      add(new THREE.ConeGeometry(r * b.top * 1.05, 0.45, 8), mats.plain(0x23356f, 0.5), b.h + 0.22);
      for (let k = 0; k < 4; k++) {
        const fin = add(new THREE.BoxGeometry(r * 0.9, 0.5, 0.05), mats.plain(0x23356f, 0.5), 0.25);
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        fin.position.x = Math.cos(a) * r * 0.55;
        fin.position.z = Math.sin(a) * r * 0.55;
        fin.rotation.y = -a;
      }
      return true;
    }
    case 'starbox': {
      if (b.kind !== 'box') return false;
      const mat = mats.get(`stars-${b.color}`, () => new THREE.MeshStandardMaterial({ map: starsTexture(b.color), roughness: 0.6 }));
      add(new RoundedBoxGeometry(b.w, b.h, b.d, 2, 0.06), mat, b.h / 2);
      add(new THREE.BoxGeometry(b.w + 0.012, 0.12, b.d + 0.012), mats.plain(0xd23a3a, 0.6), b.h * 0.9);
      return true;
    }
    case 'stripes': {
      if (b.kind !== 'box') return false;
      const mat = mats.get('stripes', () => new THREE.MeshStandardMaterial({ map: stripesTexture(), roughness: 0.6 }));
      add(new RoundedBoxGeometry(b.w, b.h, b.d, 2, 0.06), mat, b.h / 2);
      return true;
    }
    case 'firecracker': {
      if (b.kind !== 'can') return false;
      add(new THREE.CylinderGeometry(b.r, b.r, b.h, 24), mats.plain(b.color, 0.55), b.h / 2);
      const bandColor = b.color === 0xf1f1ef ? 0x23356f : 0xf2c14e;
      for (const y of [b.h * 0.12, b.h * 0.88]) add(new THREE.CylinderGeometry(b.r * 1.01, b.r * 1.01, b.h * 0.08, 24), mats.plain(bandColor, 0.45), y);
      add(new THREE.CylinderGeometry(b.r * 0.6, b.r * 0.6, 0.02, 20), mats.plain(0x2a2226, 0.8), b.h + 0.005);
      // a fuse with a glowing tip
      const fuse = add(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 5), mats.plain(0x4a3a2a, 1), b.h + 0.16);
      fuse.rotation.z = 0.35;
      const tip = add(new THREE.SphereGeometry(0.045, 8, 6), glow(0xffb040), b.h + 0.32);
      tip.position.x = -0.06;
      return true;
    }

    // ---- Chinese New Year
    case 'drum': {
      if (b.kind !== 'can') return false;
      add(new THREE.CylinderGeometry(b.r, b.r, b.h, 32), mats.plain(b.color, 0.55), b.h / 2);
      const rim = b.color === 0x23356f ? 0xf1f1ef : 0xf0b43a;
      for (const y of [0.05, b.h - 0.05]) add(new THREE.CylinderGeometry(b.r * 1.015, b.r * 1.015, 0.1, 32), mats.plain(rim, 0.4), y);
      add(new THREE.CylinderGeometry(b.r * 0.97, b.r * 0.97, 0.02, 32), mats.plain(0xefe2c4, 0.8), b.h + 0.005);
      // studs round the top edge
      const studs = Math.round(b.r * 22);
      for (let i = 0; i < studs; i++) {
        const a = (i / studs) * Math.PI * 2;
        const s = add(new THREE.SphereGeometry(0.03, 6, 5), mats.plain(rim, 0.35), b.h - 0.16);
        s.position.x = Math.cos(a) * b.r;
        s.position.z = Math.sin(a) * b.r;
      }
      return true;
    }
    case 'lantern': {
      if (b.kind !== 'can') return false;
      // a round paper lantern, glowing from inside, with gold caps
      const prof: THREE.Vector2[] = [];
      const cap = Math.min(0.16, b.h * 0.09);
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        prof.push(new THREE.Vector2(b.r * (0.86 + 0.14 * Math.sin(t * Math.PI)), cap + t * (b.h - 2 * cap)));
      }
      const paper = mats.get(`lantern-${b.color}`, () => new THREE.MeshStandardMaterial({
        map: lanternTexture(b.color), emissive: b.color, emissiveIntensity: 0.55, roughness: 0.9,
      }));
      add(new THREE.LatheGeometry(prof, 28), paper);
      const gold = mats.plain(b.color === 0xf0b43a ? 0xd8282e : 0xf0b43a, 0.35);
      add(new THREE.CylinderGeometry(b.r * 0.86, b.r * 0.86, cap, 28), gold, cap / 2);
      add(new THREE.CylinderGeometry(b.r * 0.86, b.r * 0.86, cap, 28), gold, b.h - cap / 2);
      add(new THREE.CylinderGeometry(b.r * 0.12, b.r * 0.2, 0.18, 10), gold, b.h + 0.09);
      return true;
    }
    case 'dragon': {
      if (b.kind !== 'log') return false;
      const along = b.axis;
      const scales = mats.get(`dragon-${b.color}`, () => new THREE.MeshStandardMaterial({ map: scaleTexture(b.color), roughness: 0.6 }));
      const body = add(new THREE.CylinderGeometry(b.r, b.r, b.len - 0.5, 18), scales, b.r);
      if (along === 'x') body.rotation.z = Math.PI / 2;
      else body.rotation.x = Math.PI / 2;
      // which end the head is: toward the middle of the field (or +x on the centre line)
      const sgn = along === 'x' ? (b.x > 0.01 ? -1 : 1) : b.z > 0.01 ? -1 : 1;
      const at = (u: number, y: number, m: THREE.Object3D) => {
        if (along === 'x') m.position.set(u, y, 0);
        else m.position.set(0, y, u);
        return m;
      };
      const gold = mats.plain(0xf0b43a, 0.35);
      const red = mats.plain(0xd8282e, 0.6);
      const headU = sgn * (b.len / 2 - 0.3);
      at(headU, b.r * 1.05, add(new THREE.BoxGeometry(along === 'x' ? 0.6 : b.r * 1.9, b.r * 1.9, along === 'x' ? b.r * 1.9 : 0.6), red));
      at(headU + sgn * 0.26, b.r * 0.8, add(new THREE.BoxGeometry(along === 'x' ? 0.2 : b.r * 1.4, b.r * 0.7, along === 'x' ? b.r * 1.4 : 0.2), gold));
      for (const s of [-1, 1]) {
        const eye = add(new THREE.SphereGeometry(0.08, 8, 6), glow(0xffffff), 0);
        if (along === 'x') eye.position.set(headU + sgn * 0.2, b.r * 1.45, s * b.r * 0.6);
        else eye.position.set(s * b.r * 0.6, b.r * 1.45, headU + sgn * 0.2);
        const horn = add(new THREE.ConeGeometry(0.06, 0.4, 6), gold, 0);
        if (along === 'x') horn.position.set(headU - sgn * 0.1, b.r * 2.1, s * b.r * 0.45);
        else horn.position.set(s * b.r * 0.45, b.r * 2.1, headU - sgn * 0.1);
        horn.rotation[along === 'x' ? 'z' : 'x'] = sgn * (along === 'x' ? 0.5 : -0.5);
      }
      // spines along the back, and a tail tuft
      const n = Math.round(b.len / 0.45);
      for (let i = 1; i < n - 1; i++) {
        const u = -b.len / 2 + (i + 0.5) * (b.len / n);
        if (Math.abs(u - headU) < 0.4) continue;
        at(u, b.r * 2 + 0.07, add(new THREE.ConeGeometry(0.07, 0.18, 5), gold, 0));
      }
      at(-headU, b.r, add(new THREE.SphereGeometry(b.r * 0.85, 10, 8), red, 0));
      return true;
    }
    case 'pagoda': {
      if (b.kind !== 'profile') return false;
      add(geos.profile(b), mats.get(`temple-${b.color}`, () => new THREE.MeshStandardMaterial({ map: templeTexture(b.color), roughness: 0.7 })));
      // a tiled roof along the top, overhanging a little, with gold trim under it
      add(roofBand(b, -0.02, 0.26, 1.14), mats.plain(0x2f4a4a, 0.7));
      add(roofBand(b, 0.26, 0.34, 1.06), mats.plain(0xf0b43a, 0.4));
      return true;
    }
  }
  return false;
}

/** a strip along a wall's top line, from `from` to `to` metres under it, `grow` times as thick (a roof) */
function roofBand(b: ProfileBunker, from: number, to: number, grow: number): THREE.BufferGeometry {
  const l = b.line;
  const hi = l.map(([u, y]) => new THREE.Vector2(u * 1.02, y - from));
  const lo = l.map(([u, y]) => new THREE.Vector2(u * 1.02, y - to)).reverse();
  const d = b.d * grow;
  const geo = new THREE.ExtrudeGeometry(new THREE.Shape([...hi, ...lo]), { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  if (b.axis === 'z') geo.rotateY(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

/** a flat five-pointed star, standing up (facing x) */
function starGeometry(r: number, depth: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.42 : r;
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    if (i) s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

// ---- bunker textures ----------------------------------------------------------------------------

function pumpkinTexture(color: number): THREE.CanvasTexture {
  return canvasTexture(512, 256, (g) => {
    g.fillStyle = css(color);
    g.fillRect(0, 0, 512, 256);
    // ribs: darker grooves running top to bottom
    for (let i = 0; i < 12; i++) {
      const x = (i / 12) * 512;
      const grad = g.createLinearGradient(x - 22, 0, x + 22, 0);
      grad.addColorStop(0, 'rgba(120,40,0,0)');
      grad.addColorStop(0.5, 'rgba(120,40,0,0.45)');
      grad.addColorStop(1, 'rgba(120,40,0,0)');
      g.fillStyle = grad;
      g.fillRect(x - 22, 0, 44, 256);
    }
    g.fillStyle = 'rgba(255,220,150,0.12)';
    for (let i = 0; i < 12; i++) g.fillRect((i / 12) * 512 + 14, 0, 8, 256);
  });
}

/** the carved face, glowing: black everywhere else (it's the emissive map) */
function faceTexture(us: number[]): THREE.CanvasTexture {
  return canvasTexture(512, 256, (g) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, 512, 256);
    g.fillStyle = '#ffb22e';
    for (const u of us) {
      for (const cx of [u * 512, u * 512 + 512, u * 512 - 512]) {
        // eyes and nose: triangles; a jagged grin
        for (const s of [-1, 1]) {
          g.beginPath();
          g.moveTo(cx + s * 18, 96);
          g.lineTo(cx + s * 52, 96);
          g.lineTo(cx + s * 36, 66);
          g.closePath();
          g.fill();
        }
        g.beginPath();
        g.moveTo(cx - 9, 122);
        g.lineTo(cx + 9, 122);
        g.lineTo(cx, 106);
        g.closePath();
        g.fill();
        g.beginPath();
        g.moveTo(cx - 62, 134);
        for (let i = 0; i <= 8; i++) g.lineTo(cx - 62 + i * 15.5, i % 2 ? 146 : 136);
        g.lineTo(cx + 62, 134);
        g.quadraticCurveTo(cx, 196, cx - 62, 134);
        g.fill();
      }
    }
  });
}

function grainTexture(color: number): THREE.CanvasTexture {
  return canvasTexture(128, 128, (g) => {
    g.fillStyle = css(color);
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(0,0,0,0.22)';
    for (let y = 4; y < 128; y += 7) {
      g.beginPath();
      for (let x = 0; x <= 128; x += 8) g.lineTo(x, y + Math.sin(x * 0.08 + y) * 1.5);
      g.stroke();
    }
  });
}

function strawTexture(color: number): THREE.CanvasTexture {
  const rnd = seeded(77);
  return canvasTexture(128, 128, (g) => {
    g.fillStyle = css(color);
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 700; i++) {
      g.strokeStyle = rnd() < 0.5 ? 'rgba(120,80,20,0.35)' : 'rgba(255,240,170,0.4)';
      const x = rnd() * 128;
      const y = rnd() * 128;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (rnd() - 0.5) * 10, y + 4 + rnd() * 10);
      g.stroke();
    }
  });
}

function spiralTexture(color: number): THREE.CanvasTexture {
  return canvasTexture(128, 128, (g) => {
    g.fillStyle = css(color);
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(120,80,20,0.45)';
    g.lineWidth = 2;
    g.beginPath();
    for (let a = 0; a < Math.PI * 14; a += 0.1) g.lineTo(64 + Math.cos(a) * a * 1.4, 64 + Math.sin(a) * a * 1.4);
    g.stroke();
  });
}

function starsTexture(color: number): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = css(color);
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#f4f4f0';
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        starPath(g, 32 + col * 64 + (row % 2) * 16, 32 + row * 64, 17);
        g.fill();
      }
    }
  });
}

function stripesTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 256, (g) => {
    for (let i = 0; i < 7; i++) {
      g.fillStyle = i % 2 ? '#f1f1ef' : '#d23a3a';
      g.fillRect(0, (i * 256) / 7, 64, 256 / 7 + 1);
    }
  });
}

function lanternTexture(color: number): THREE.CanvasTexture {
  return canvasTexture(256, 128, (g) => {
    g.fillStyle = css(color);
    g.fillRect(0, 0, 256, 128);
    // ribs, and a gold medallion on each side
    g.strokeStyle = 'rgba(80,0,0,0.35)';
    g.lineWidth = 3;
    for (let x = 0; x < 256; x += 21) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, 128);
      g.stroke();
    }
    const gold = color === 0xf0b43a ? '#d8282e' : '#f6c64a';
    for (const cx of [64, 192]) {
      g.fillStyle = gold;
      g.beginPath();
      g.arc(cx, 64, 26, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = css(color);
      g.beginPath();
      g.arc(cx, 64, 18, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = gold;
      g.fillRect(cx - 12, 61, 24, 6);
      g.fillRect(cx - 3, 52, 6, 24);
    }
    g.fillStyle = gold;
    g.fillRect(0, 6, 256, 5);
    g.fillRect(0, 117, 256, 5);
  });
}

function scaleTexture(color: number): THREE.CanvasTexture {
  return canvasTexture(256, 128, (g) => {
    g.fillStyle = css(color);
    g.fillRect(0, 0, 256, 128);
    g.strokeStyle = css(shade(color, 0.6));
    g.lineWidth = 2;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 16; col++) {
        g.beginPath();
        g.arc(col * 16 + (row % 2) * 8, row * 16, 9, 0, Math.PI);
        g.stroke();
      }
    }
    // a gold belly stripe
    g.fillStyle = '#f0b43a';
    g.fillRect(0, 54, 256, 20);
  });
}

function templeTexture(color: number): THREE.CanvasTexture {
  return canvasTexture(256, 128, (g) => {
    g.fillStyle = css(color);
    g.fillRect(0, 0, 256, 128);
    // two dark red pillars and a gold door panel
    g.fillStyle = css(shade(color, 0.7));
    g.fillRect(14, 0, 22, 128);
    g.fillRect(220, 0, 22, 128);
    g.fillStyle = '#f0b43a';
    g.fillRect(100, 40, 56, 88);
    g.fillStyle = css(color);
    g.fillRect(106, 46, 20, 82);
    g.fillRect(130, 46, 20, 82);
  });
}

// ---- ground -------------------------------------------------------------------------------------

/** draw a holiday ground on the field's canvas; false if `kind` isn't one */
export function holidayGround(kind: MapTheme['ground'], g: CanvasRenderingContext2D, c: HTMLCanvasElement, ppm: number): boolean {
  const rnd = seeded(c.width * 7 + c.height);
  const blobs = (n: number, colors: string[], min: number, max: number) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = colors[i % colors.length];
      g.beginPath();
      g.ellipse(rnd() * c.width, rnd() * c.height, min + rnd() * max, (min + rnd() * max) * 0.7, rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }
  };
  const flecks = (n: number, colors: string[], w = 3, h = 2) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = colors[i % colors.length];
      g.fillRect(rnd() * c.width, rnd() * c.height, w, h);
    }
  };
  if (kind === 'patch') {
    // dead grass and bare earth, with fallen leaves
    g.fillStyle = '#4b4a34';
    g.fillRect(0, 0, c.width, c.height);
    blobs(220, ['rgba(70,52,36,0.35)', 'rgba(90,96,52,0.3)', 'rgba(40,36,30,0.25)'], 20, 70);
    flecks(9000, ['rgba(200,110,30,0.55)', 'rgba(140,70,30,0.5)', 'rgba(30,26,20,0.35)', 'rgba(170,150,90,0.35)']);
    return true;
  }
  if (kind === 'snow') {
    g.fillStyle = '#eef3f9';
    g.fillRect(0, 0, c.width, c.height);
    blobs(160, ['rgba(150,175,210,0.12)', 'rgba(255,255,255,0.5)'], 30, 90);
    flecks(14000, ['rgba(170,190,220,0.25)', 'rgba(255,255,255,0.9)'], 2, 2);
    return true;
  }
  if (kind === 'farm') {
    // mown autumn grass in stripes, with leaves blown across it
    for (let i = 0; i * 3 * ppm < c.width; i++) {
      g.fillStyle = i % 2 ? '#9c9446' : '#a7a052';
      g.fillRect(i * 3 * ppm, 0, 3 * ppm + 1, c.height);
    }
    blobs(90, ['rgba(120,90,40,0.18)'], 20, 60);
    flecks(7000, ['rgba(220,110,30,0.7)', 'rgba(190,50,30,0.6)', 'rgba(240,190,50,0.65)', 'rgba(90,70,30,0.3)'], 4, 3);
    return true;
  }
  if (kind === 'stone') {
    // square paving, each slab a little different
    g.fillStyle = '#6e5a55';
    g.fillRect(0, 0, c.width, c.height);
    const s = 1.2 * ppm;
    for (let y = 0; y < c.height; y += s) {
      for (let x = 0; x < c.width; x += s) {
        const k = 0.88 + rnd() * 0.22;
        g.fillStyle = `rgb(${Math.round(132 * k)},${Math.round(108 * k)},${Math.round(100 * k)})`;
        g.fillRect(x + 2, y + 2, s - 4, s - 4);
      }
    }
    flecks(9000, ['rgba(0,0,0,0.12)', 'rgba(255,255,255,0.08)'], 2, 2);
    return true;
  }
  return false;
}

/** what's under everything outside the field */
export function outerGroundColor(surround: MapTheme['surround']): number | null {
  switch (surround) {
    case 'graveyard': return 0x34302a;
    case 'winter': return 0xe6ecf4;
    case 'farm': return 0x9a8a44;
    case 'fireworks': return 0x2c4a2a;
    case 'festival': return 0x5c4844;
    default: return null;
  }
}

// ---- around the field -----------------------------------------------------------------------------

/** spots outside the boundary (and inside `reach` of it), seeded */
function spotsAround(seed: number, ex: number, ez: number, reach: number, n: number, gap = 3): [number, number, number][] {
  const r = seeded(seed);
  const out: [number, number, number][] = [];
  for (let i = 0; i < n * 4 && out.length < n; i++) {
    const x = (r() * 2 - 1) * (ex + reach);
    const z = (r() * 2 - 1) * (ez + reach);
    if (Math.abs(x) < ex + gap && Math.abs(z) < ez + gap) continue;
    out.push([x, z, r()]);
  }
  return out;
}

/** one instanced mesh of `geo` at every spot, scaled by s, turned by its position */
function instanced(root: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, spots: [number, number, number][], scale: (s: number) => number, colors?: (s: number) => number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  spots.forEach(([x, z, s], i) => {
    const k = scale(s);
    q.setFromAxisAngle(up, x * 3.1 + z);
    m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(k, k, k));
    mesh.setMatrixAt(i, m);
    if (colors) mesh.setColorAt(i, c.setHex(colors(s)));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
}

/** draw a holiday surround; returns what to animate each frame (or null), or undefined if it isn't one */
export function buildHolidaySurround(root: THREE.Group, map: GameMap, ex: number, ez: number): Animate | null | undefined {
  switch (map.theme.surround) {
    case 'graveyard': return graveyard(root, ex, ez);
    case 'winter': return winter(root, ex, ez);
    case 'farm': return farm(root, ex, ez);
    case 'fireworks': return fireworksPark(root, ex, ez);
    case 'festival': return festival(root, ex, ez);
    default: return undefined;
  }
}

/** a big full moon low in the sky, and its glow (no fog: it's far past it) */
function fullMoon(root: THREE.Group, at: THREE.Vector3, r: number, color: number): void {
  const moon = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 20), new THREE.MeshBasicMaterial({ color, fog: false }));
  moon.position.copy(at);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(r * 1.6, 32, 20),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, fog: false, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  halo.position.copy(at);
  moon.renderOrder = halo.renderOrder = -1;
  root.add(moon, halo);
}

function graveyard(root: THREE.Group, ex: number, ez: number): Animate {
  fullMoon(root, new THREE.Vector3(-120, 70, -190), 18, 0xfff1c8);
  // bare trees all round
  const trunk = new THREE.CylinderGeometry(0.18, 0.34, 8, 6);
  trunk.translate(0, 4, 0);
  const parts = [trunk];
  for (let i = 0; i < 5; i++) {
    const br = new THREE.CylinderGeometry(0.05, 0.12, 3, 5);
    br.translate(0, 1.5, 0);
    br.rotateZ(0.7 + (i % 2) * 0.3);
    br.rotateY((i / 5) * Math.PI * 2);
    br.translate(0, 4.5 + i * 0.7, 0);
    parts.push(br);
  }
  instanced(root, mergeGeometries(parts)!, new THREE.MeshStandardMaterial({ color: 0x2c2420, roughness: 1, flatShading: true }),
    spotsAround(31, ex, ez, 40, 120, 6), (s) => 0.7 + s * 0.6);
  // rows of old gravestones outside the fence
  const stone = new RoundedBoxGeometry(0.8, 1.1, 0.22, 2, 0.12);
  stone.translate(0, 0.45, 0);
  instanced(root, stone, new THREE.MeshStandardMaterial({ color: 0x77737d, roughness: 1 }), spotsAround(57, ex, ez, 14, 90, 2), (s) => 0.7 + s * 0.5);
  // jack-o'-lanterns along both sidelines, flickering
  const lamps: THREE.MeshBasicMaterial[] = [];
  const pumpkin = new THREE.MeshStandardMaterial({ color: 0xf07a1a, roughness: 0.8 });
  for (const s of [-1, 1]) {
    for (let x = -ex + 4; x <= ex - 4; x += 8) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.4, 14, 10), pumpkin);
      p.scale.y = 0.85;
      p.position.set(x, 0.34, s * (ez + 1.4));
      const glowMat = new THREE.MeshBasicMaterial({ color: 0xffb030 });
      lamps.push(glowMat);
      const face = new THREE.Mesh(new THREE.CircleGeometry(0.16, 3), glowMat);
      face.position.set(x, 0.38, s * (ez + 1.4) - s * 0.39);
      face.rotation.y = s > 0 ? Math.PI : 0;
      root.add(p, face);
    }
  }
  return (_dt, t) => {
    lamps.forEach((m, i) => m.color.setRGB(1, 0.6 + 0.12 * Math.sin(t * 9 + i * 1.7) + 0.06 * Math.sin(t * 23 + i), 0.15));
  };
}

function winter(root: THREE.Group, ex: number, ez: number): Animate {
  // snowy pines all round
  const tiers = [0, 1, 2].map((i) => {
    const c = new THREE.ConeGeometry(2.6 - i * 0.7, 3.2, 8);
    c.translate(0, 2.2 + i * 2, 0);
    return c;
  });
  const trunk = new THREE.CylinderGeometry(0.2, 0.28, 1.4, 6);
  trunk.translate(0, 0.7, 0);
  const spots = spotsAround(11, ex, ez, 40, 170, 5);
  instanced(root, mergeGeometries(tiers)!, new THREE.MeshStandardMaterial({ color: 0x2f6a45, roughness: 0.95, flatShading: true }), spots, (s) => 0.8 + s * 0.6);
  instanced(root, trunk, new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }), spots, (s) => 0.8 + s * 0.6);
  const caps = [0, 1, 2].map((i) => {
    const c = new THREE.ConeGeometry((2.6 - i * 0.7) * 0.45, 1.2, 8);
    c.translate(0, 3.3 + i * 2, 0);
    return c;
  });
  instanced(root, mergeGeometries(caps)!, new THREE.MeshStandardMaterial({ color: 0xf4f8fc, roughness: 1, flatShading: true }), spots, (s) => 0.8 + s * 0.6);
  // cabins with lit windows behind both ends
  const wall = new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.9 });
  const roof = new THREE.MeshStandardMaterial({ color: 0xf2f6fb, roughness: 1 });
  const window = new THREE.MeshBasicMaterial({ color: 0xffd27a });
  for (const end of [-1, 1]) {
    for (const z of [-ez * 0.5, ez * 0.45]) {
      const x = end * (ex + 9);
      const body = new THREE.Mesh(new THREE.BoxGeometry(5, 3.2, 4), wall);
      body.position.set(x, 1.6, z);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 3.4, 2.2, 4, 1), roof);
      top.rotation.y = Math.PI / 4;
      top.scale.z = 1.35;
      top.position.set(x, 4.3, z);
      const win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1), window);
      win.position.set(x - end * 2.51, 1.7, z);
      win.rotation.y = end > 0 ? -Math.PI / 2 : Math.PI / 2;
      body.castShadow = top.castShadow = true;
      root.add(body, top, win);
    }
  }
  // snow falling over the field
  const n = 1800;
  const pos = new Float32Array(n * 3);
  const rnd = seeded(5);
  const span = { x: ex + 14, z: ez + 14, y: 22 };
  for (let i = 0; i < n; i++) pos.set([(rnd() * 2 - 1) * span.x, rnd() * span.y, (rnd() * 2 - 1) * span.z], i * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  const flakes = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.9, depthWrite: false }));
  flakes.frustumCulled = false;
  root.add(flakes);
  return (dt, t) => {
    for (let i = 0; i < n; i++) {
      let y = pos[i * 3 + 1] - dt * (1.1 + (i % 7) * 0.12);
      if (y < 0) y += span.y;
      pos[i * 3 + 1] = y;
      pos[i * 3] += Math.sin(t * 0.8 + i) * dt * 0.25;
    }
    geo.attributes.position.needsUpdate = true;
  };
}

function farm(root: THREE.Group, ex: number, ez: number): null {
  // autumn trees all round, each its own colour
  const trunk = new THREE.CylinderGeometry(0.2, 0.3, 4, 6);
  trunk.translate(0, 2, 0);
  const crown = new THREE.IcosahedronGeometry(2.4, 0);
  crown.translate(0, 5.2, 0);
  const spots = spotsAround(23, ex, ez, 40, 110, 7);
  instanced(root, trunk, new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 1 }), spots, (s) => 0.8 + s * 0.6);
  const leaves = [0xe0731f, 0xc8402a, 0xf0b42e, 0xb8602a, 0x9a8a2a];
  instanced(root, crown, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), spots, (s) => 0.8 + s * 0.6,
    (s) => leaves[Math.floor(s * 997) % leaves.length]);
  // a red barn and a silo behind Blue's end, a farmhouse behind Red's
  const red = new THREE.MeshStandardMaterial({ color: 0xa8322d, roughness: 0.85 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf1ead8, roughness: 0.8 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.5, metalness: 0.3 });
  const barn = new THREE.Mesh(new THREE.BoxGeometry(9, 6, 12), red);
  barn.position.set(ex + 14, 3, -4);
  const roofShape = new THREE.Shape([new THREE.Vector2(-5, 0), new THREE.Vector2(-3.4, 2.6), new THREE.Vector2(0, 3.8), new THREE.Vector2(3.4, 2.6), new THREE.Vector2(5, 0)]);
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 12.4, bevelEnabled: false });
  roofGeo.translate(0, 0, -6.2);
  const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color: 0x4a3a34, roughness: 0.9 }));
  roof.position.set(ex + 14, 6, -4);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 4), white);
  door.position.set(ex + 9.48, 2, -4);
  door.rotation.y = -Math.PI / 2;
  const silo = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 11, 20), grey);
  silo.position.set(ex + 13, 5.5, 7);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2.4, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), grey);
  dome.position.set(ex + 13, 11, 7);
  const house = new THREE.Mesh(new THREE.BoxGeometry(7, 4.5, 9), white);
  house.position.set(-ex - 13, 2.25, 3);
  const houseRoof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 6, 3, 4, 1), new THREE.MeshStandardMaterial({ color: 0x5a3a2a, roughness: 0.9 }));
  houseRoof.rotation.y = Math.PI / 4;
  houseRoof.scale.z = 1.3;
  houseRoof.position.set(-ex - 13, 6, 3);
  for (const m of [barn, roof, silo, dome, house, houseRoof]) m.castShadow = m.receiveShadow = true;
  root.add(barn, roof, door, silo, dome, house, houseRoof);
  // a corn field along the far side
  const stalk = new THREE.ConeGeometry(0.45, 2.6, 5);
  stalk.translate(0, 1.3, 0);
  const rows: [number, number, number][] = [];
  const rnd = seeded(41);
  for (let x = -ex; x <= ex; x += 1.2) for (let z = ez + 4; z < ez + 14; z += 1.4) rows.push([x + rnd() * 0.4, z + rnd() * 0.4, rnd()]);
  instanced(root, stalk, new THREE.MeshStandardMaterial({ color: 0xd2b066, roughness: 1, flatShading: true }), rows, (s) => 0.8 + s * 0.4);
  // and round bales scattered past the other side
  const bale = new THREE.CylinderGeometry(0.8, 0.8, 1.3, 14);
  bale.rotateZ(Math.PI / 2);
  bale.translate(0, 0.8, 0);
  instanced(root, bale, new THREE.MeshStandardMaterial({ map: strawTexture(0xd9b45a), roughness: 1 }), spotsAround(67, ex, ez, 16, 26, 3).filter(([, z]) => z < 0), () => 1);
  return null;
}

interface Rocket { pts: THREE.Points; mat: THREE.PointsMaterial; vel: Float32Array; age: number; life: number; wait: number; up: number; }

function fireworksPark(root: THREE.Group, ex: number, ez: number): Animate {
  // dark trees round the park, and a city skyline far off with lit windows
  const crown = new THREE.IcosahedronGeometry(2.6, 0);
  crown.translate(0, 5.5, 0);
  const trunk = new THREE.CylinderGeometry(0.22, 0.3, 4, 6);
  trunk.translate(0, 2, 0);
  const spots = spotsAround(19, ex, ez, 30, 90, 7);
  instanced(root, trunk, new THREE.MeshStandardMaterial({ color: 0x3a2e26, roughness: 1 }), spots, (s) => 0.8 + s * 0.5);
  instanced(root, crown, new THREE.MeshStandardMaterial({ color: 0x24402a, roughness: 1, flatShading: true }), spots, (s) => 0.8 + s * 0.5);
  const windows = canvasTexture(64, 128, (g) => {
    g.fillStyle = '#121626';
    g.fillRect(0, 0, 64, 128);
    const r = seeded(3);
    for (let y = 6; y < 128; y += 10) for (let x = 6; x < 64; x += 12) {
      g.fillStyle = r() < 0.45 ? '#ffd88a' : '#1c2238';
      g.fillRect(x, y, 6, 5);
    }
  }, true);
  const city = new THREE.MeshBasicMaterial({ map: windows, fog: false });
  const r = seeded(29);
  for (let i = 0; i < 40; i++) {
    const a = -0.6 + (i / 40) * 1.2;
    const h = 20 + r() * 50;
    const w = 10 + r() * 14;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), city);
    b.position.set(Math.sin(a) * 260, h / 2 - 2, -Math.cos(a) * 260);
    b.lookAt(0, h / 2, 0);
    root.add(b);
  }
  // fireworks: a few shells at a time, launched from behind the ends, bursting high over the field
  const colors = [0xff4a4a, 0xffffff, 0x4a8cff, 0xffd84a, 0x8cff6a, 0xff6ad8];
  const N = 110;
  const rockets: Rocket[] = [];
  for (let k = 0; k < 6; k++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({ size: 1.3, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    root.add(pts);
    rockets.push({ pts, mat, vel: new Float32Array(N * 3), age: 0, life: 0, wait: k * 0.9, up: 0 });
  }
  const rnd = seeded(808);
  const burst = (f: Rocket) => {
    // over the far ends (where players look) or the sidelines, low enough to be in view
    const end = rnd() < 0.65;
    const sgn = rnd() < 0.5 ? -1 : 1;
    const at = end
      ? new THREE.Vector3(sgn * (ex + 10 + rnd() * 22), 16 + rnd() * 12, (rnd() * 2 - 1) * ez)
      : new THREE.Vector3((rnd() * 2 - 1) * ex, 18 + rnd() * 12, sgn * (ez + 12 + rnd() * 18));
    const p = f.pts.geometry.attributes.position.array as Float32Array;
    const speed = 9 + rnd() * 6;
    for (let i = 0; i < N; i++) {
      const u = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      p.set([at.x, at.y, at.z], i * 3);
      f.vel.set([Math.cos(a) * s * speed, u * speed, Math.sin(a) * s * speed], i * 3);
    }
    f.mat.color.setHex(colors[Math.floor(rnd() * colors.length)]);
    f.age = 0;
    f.life = 2.2 + rnd() * 0.8;
  };
  return (dt) => {
    for (const f of rockets) {
      if (f.wait > 0) {
        f.wait -= dt;
        if (f.wait <= 0) burst(f);
        continue;
      }
      f.age += dt;
      const p = f.pts.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < N; i++) {
        f.vel[i * 3 + 1] -= 4 * dt;
        for (let k = 0; k < 3; k++) {
          f.vel[i * 3 + k] *= 1 - 0.9 * dt;
          p[i * 3 + k] += f.vel[i * 3 + k] * dt;
        }
      }
      f.pts.geometry.attributes.position.needsUpdate = true;
      const t = f.age / f.life;
      f.mat.opacity = t < 0.08 ? t / 0.08 : Math.max(0, 1 - (t - 0.08) / 0.92);
      if (f.age >= f.life) {
        f.mat.opacity = 0;
        f.wait = 0.4 + rnd() * 1.8;
      }
    }
  };
}

function festival(root: THREE.Group, ex: number, ez: number): Animate {
  // temple buildings with upturned roofs along both sidelines
  const wall = new THREE.MeshStandardMaterial({ color: 0xb8322a, roughness: 0.8 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x2f4a4a, roughness: 0.7 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xf0b43a, roughness: 0.4 });
  const roofShape = (w: number) => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2 - 1.4, 0.9);
    s.quadraticCurveTo(-w / 2 - 0.4, 0, -w / 2, 0.2);
    s.lineTo(0, 2.4);
    s.lineTo(w / 2, 0.2);
    s.quadraticCurveTo(w / 2 + 0.4, 0, w / 2 + 1.4, 0.9);
    s.lineTo(0, 2.9);
    s.closePath();
    return s;
  };
  for (const side of [-1, 1]) {
    for (let x = -ex + 4; x < ex; x += 12) {
      const w = 7;
      const d = 6;
      const z = side * (ez + 8);
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, 4, d), wall);
      body.position.set(x, 2, z);
      const geo = new THREE.ExtrudeGeometry(roofShape(w), { depth: d + 1.2, bevelEnabled: false });
      geo.translate(0, 0, -(d + 1.2) / 2);
      const top = new THREE.Mesh(geo, roof);
      top.position.set(x, 4, z);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.25, d + 0.2), gold);
      trim.position.set(x, 4, z);
      body.castShadow = top.castShadow = true;
      root.add(body, top, trim);
    }
  }
  // a gate at each end: two red pillars and a roofed beam
  for (const end of [-1, 1]) {
    const x = end * (ex + 6);
    for (const z of [-5, 5]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 7, 12), wall);
      p.position.set(x, 3.5, z);
      p.castShadow = true;
      root.add(p);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 13), gold);
    beam.position.set(x, 6.6, 0);
    const geo = new THREE.ExtrudeGeometry(roofShape(12), { depth: 1.8, bevelEnabled: false });
    geo.translate(0, 0, -0.9);
    geo.rotateY(Math.PI / 2);
    const top = new THREE.Mesh(geo, roof);
    top.position.set(x, 7, 0);
    root.add(beam, top);
  }
  // strings of glowing lanterns along both sides, swaying
  const lanternGeo = new THREE.SphereGeometry(0.32, 12, 8);
  lanternGeo.scale(1, 1.2, 1);
  const lit = new THREE.MeshBasicMaterial({ color: 0xff4a3a });
  const wire = new THREE.MeshBasicMaterial({ color: 0x2a1a1a });
  const swing: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const z = side * (ez + 3.5);
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, ex * 2 + 8, 4), wire);
    line.rotation.z = Math.PI / 2;
    line.position.set(0, 5.4, z);
    root.add(line);
    for (const x of [-ex - 4, ex + 4]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 5.6, 8), wall);
      pole.position.set(x, 2.8, z);
      root.add(pole);
    }
    for (let x = -ex - 2; x <= ex + 2; x += 2.5) {
      const hang = new THREE.Group();
      hang.position.set(x, 5.4, z);
      const l = new THREE.Mesh(lanternGeo, lit);
      l.position.y = -0.7;
      hang.add(l);
      hang.userData.phase = x * 0.7;
      root.add(hang);
      swing.push(hang);
    }
  }
  return (_dt, t) => {
    for (const h of swing) h.rotation.x = Math.sin(t * 1.3 + h.userData.phase) * 0.12;
  };
}

// ---- boundaries ---------------------------------------------------------------------------------

/** draw a holiday boundary; false if `kind` isn't one */
export function buildHolidayBoundary(root: THREE.Group, kind: MapTheme['boundary'], lx: number, lz: number): boolean {
  if (kind !== 'iron' && kind !== 'candy' && kind !== 'fence' && kind !== 'lanterns') return false;
  const sides: [number, number, number, boolean][] = [
    [0, -lz, lx * 2, false],
    [0, lz, lx * 2, false],
    [-lx, 0, lz * 2, true],
    [lx, 0, lz * 2, true],
  ];
  const place = (m: THREE.Object3D, alongZ: boolean, x: number, z: number, off: number, y: number) => {
    m.position.set(alongZ ? x : off, y, alongZ ? off : z);
    root.add(m);
    return m;
  };
  const rail = (mat: THREE.Material, alongZ: boolean, x: number, z: number, len: number, y: number, r: number) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 5), mat);
    if (alongZ) m.rotation.x = Math.PI / 2;
    else m.rotation.z = Math.PI / 2;
    m.position.set(x, y, z);
    root.add(m);
  };
  const candy = canvasTexture(32, 128, (g) => {
    g.fillStyle = '#f6f2ee';
    g.fillRect(0, 0, 32, 128);
    g.fillStyle = '#d8263a';
    for (let y = -32; y < 160; y += 24) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(32, y + 16);
      g.lineTo(32, y + 26);
      g.lineTo(0, y + 10);
      g.fill();
    }
  });
  const iron = new THREE.MeshStandardMaterial({ color: 0x1c1a22, roughness: 0.5, metalness: 0.5 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 1 });
  const red = new THREE.MeshStandardMaterial({ color: 0xc23028, roughness: 0.7 });
  const lanternLit = new THREE.MeshBasicMaterial({ color: 0xff5a3a });
  for (const [x, z, len, alongZ] of sides) {
    const step = kind === 'iron' ? 1.2 : kind === 'fence' ? 2.5 : 4;
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i <= n; i++) {
      const off = -len / 2 + (i * len) / n;
      if (kind === 'iron') {
        place(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.1, 5), iron), alongZ, x, z, off, 0.55);
        place(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), iron), alongZ, x, z, off, 1.18);
      } else if (kind === 'fence') {
        place(new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.2, 0.14), wood), alongZ, x, z, off, 0.6);
      } else if (kind === 'candy') {
        const post = place(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 10), new THREE.MeshStandardMaterial({ map: candy, roughness: 0.4 })), alongZ, x, z, off, 0.55);
        post.castShadow = true;
        const hook = place(new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.06, 8, 12, Math.PI), new THREE.MeshStandardMaterial({ color: 0xd8263a, roughness: 0.4 })), alongZ, x, z, off, 1.1);
        hook.position[alongZ ? 'z' : 'x'] += 0.14;
        if (alongZ) hook.rotation.y = Math.PI / 2;
      } else {
        place(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.4, 8), red), alongZ, x, z, off, 0.7);
        if (i < n) {
          const lan = place(new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), lanternLit), alongZ, x, z, off + len / n / 2, 1.0);
          lan.scale.y = 1.25;
        }
      }
    }
    if (kind === 'iron') {
      rail(iron, alongZ, x, z, len, 0.25, 0.02);
      rail(iron, alongZ, x, z, len, 1.0, 0.02);
    } else if (kind === 'fence') {
      rail(wood, alongZ, x, z, len, 0.45, 0.05);
      rail(wood, alongZ, x, z, len, 0.95, 0.05);
    } else if (kind === 'candy') {
      rail(new THREE.MeshStandardMaterial({ color: 0x2f7a46, roughness: 0.9 }), alongZ, x, z, len, 0.9, 0.05);
    } else {
      rail(new THREE.MeshStandardMaterial({ color: 0xf0b43a, roughness: 0.6 }), alongZ, x, z, len, 1.25, 0.015);
    }
  }
  return true;
}
