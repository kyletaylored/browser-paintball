// The field you play on: sky, lights, ground, boundary, bunkers and the scenery around it, built
// from code for whichever map is on (shared/maps.ts). buildWorld returns a handle; dispose it and
// build again when the map changes. The arena's bunkers use the models in public/models/bunkers.glb
// when they've loaded; everything else is drawn here.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  field, bunkerKey, topOf, logHalf, profileBox, centreOf, orbY,
  type Bunker, type Look, type PolyBunker, type TaperBunker, type ProfileBunker, type OrbBunker,
} from '../shared/field';
import type { GameMap } from '../shared/maps';
import { bunkerModel, type Models } from './models';
import { toonify } from './toon';
import { TEAM_COLORS } from '../shared/protocol';
import {
  HOLIDAY_LOOKS, drawHolidayBunker, holidayGround, outerGroundColor, buildHolidaySurround, buildHolidayBoundary, type Animate, type Geos,
} from './holidays';

export interface World {
  /** remove everything this map added and free its GPU memory */
  dispose(): void;
  /**
   * Paint hit bunker i (an index into field.bunkers) on a face with outward normal (nx, nz), with
   * strength 0..1 (a direct hit is 1, a glancing bounce less). Inflatables wobble; wood and rock don't.
   */
  hit(i: number, nx: number, nz: number, strength: number): void;
  /** let the wobbles settle; once per rendered frame */
  update(dt: number): void;
}

/** bunker looks that are air-filled and wobble when hit */
const SOFT: ReadonlySet<Look> = new Set<Look>(['inflatable', 'tower']);

/**
 * A wobbling bunker: a spring on how far its top leans (a vector along the ground), damped so a
 * hit dies away in about a second. It leans about its base, away from the paint.
 */
interface Wobble {
  g: THREE.Object3D;
  /** taller bunkers lean less per hit */
  give: number;
  tx: number;
  tz: number;
  vx: number;
  vz: number;
}
const WOBBLE_W = 15; // rad/s: about 2.4 wobbles a second
const WOBBLE_DAMP = 3.2;
const WOBBLE_KICK = 0.42; // rad/s of lean speed for a direct hit
const WOBBLE_MAX = 0.1; // rad

export function buildWorld(scene: THREE.Scene, models: Models | null): World {
  const map = field.map;
  const t = map.theme;
  const root = new THREE.Group();
  root.name = `map-${map.id}`;
  scene.add(root);
  scene.background = new THREE.Color(t.sky);
  scene.fog = new THREE.Fog(t.sky, t.fog[0], t.fog[1]);

  const ex = field.halfL + field.margin; // to the boundary
  const ez = field.halfW + field.margin;

  root.add(new THREE.HemisphereLight(t.hemi.sky, t.hemi.ground, t.hemi.intensity));
  const sun = new THREE.DirectionalLight(t.sun.color, t.sun.intensity);
  sun.position.set(18, 32, 12).multiplyScalar(Math.max(1, ex / 30));
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // cover the whole field (and a little past it) with the shadow map
  Object.assign(sun.shadow.camera, { left: -ex - 4, right: ex + 4, top: ez + 6, bottom: -ez - 6, near: 1, far: 90 * Math.max(1, ex / 30) });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  root.add(sun, sun.target);

  const animate = buildSurround(root, map);
  buildGround(root, map);
  if (buildHolidayBoundary(root, t.boundary, ex, ez)) {
    // drawn in holidays.ts
  } else if (t.boundary === 'net') buildNets(root, ex, ez);
  else if (t.boundary === 'glow') buildGlowLine(root, ex, ez);
  else buildRope(root, ex, ez);

  const mats = new Materials();
  const wobbles: (Wobble | null)[] = [];
  const addWobble = (g: THREE.Object3D, b: Bunker) => {
    const h = topOf(b);
    wobbles.push(SOFT.has(b.look ?? 'inflatable') ? { g, give: 1.6 / Math.max(1.2, h), tx: 0, tz: 0, vx: 0, vz: 0 } : null);
  };
  for (const b of field.bunkers) {
    const template = models ? bunkerModel(models, bunkerKey(b)) : undefined;
    if (template && (b.look ?? 'inflatable') === 'inflatable') {
      // place a wrapper, not the model itself: the model's own transform isn't empty (mesh compression
      // stores a dequantizing offset and scale on it), so overwriting its position would sink it
      const g = new THREE.Group();
      g.name = template.name;
      g.add(template.clone(true));
      g.position.set(b.x, 0, b.z);
      root.add(g);
      addWobble(g, b);
      if (import.meta.env.DEV) checkFit(g, b);
      continue;
    }
    const g = drawBunker(b, mats);
    g.position.set(b.x, 0, b.z);
    g.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    root.add(g);
    addWobble(g, b);
  }
  // the arcade look: flat banded shading on the whole field (src/toon.ts)
  toonify(root);
  // planets turn slowly on their tilted axes
  const spinners: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.userData.spin) spinners.push(o);
  });

  const moving = new Set<Wobble>();
  const axis = new THREE.Vector3();
  let time = 0;
  return {
    hit(i, nx, nz, strength) {
      const w = wobbles[i];
      if (!w) return;
      // the top leans away from the paint: along -n
      const len = Math.hypot(nx, nz) || 1;
      const k = WOBBLE_KICK * w.give * Math.min(1, strength);
      w.vx -= (nx / len) * k;
      w.vz -= (nz / len) * k;
      moving.add(w);
    },
    update(dt) {
      const step = Math.min(dt, 0.05);
      time += step;
      for (const o of spinners) o.rotation.y += step * o.userData.spin;
      animate?.(step, time);
      for (const w of moving) {
        // damped spring, semi-implicit Euler
        w.vx += (-WOBBLE_W * WOBBLE_W * w.tx - WOBBLE_DAMP * w.vx) * step;
        w.vz += (-WOBBLE_W * WOBBLE_W * w.tz - WOBBLE_DAMP * w.vz) * step;
        w.tx += w.vx * step;
        w.tz += w.vz * step;
        let a = Math.hypot(w.tx, w.tz);
        if (a > WOBBLE_MAX) {
          w.tx *= WOBBLE_MAX / a;
          w.tz *= WOBBLE_MAX / a;
          a = WOBBLE_MAX;
        }
        if (a < 1e-4 && Math.hypot(w.vx, w.vz) < 1e-3) {
          w.tx = w.tz = w.vx = w.vz = 0;
          w.g.quaternion.identity();
          w.g.scale.setScalar(1);
          moving.delete(w);
          continue;
        }
        // lean the top toward (tx, tz): rotate about up × that direction; squash a little as it leans
        w.g.quaternion.setFromAxisAngle(axis.set(w.tz / (a || 1), 0, -w.tx / (a || 1)), a);
        const squash = a * 0.9;
        w.g.scale.set(1 + squash * 0.5, 1 - squash, 1 + squash * 0.5);
      }
    },
    dispose() {
      scene.remove(root);
      const seen = new Set<unknown>();
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && !seen.has(m.geometry)) {
          seen.add(m.geometry);
          m.geometry.dispose();
        }
        const ms = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
        for (const mat of ms) {
          if (seen.has(mat)) continue;
          seen.add(mat);
          for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
          mat.dispose();
        }
      });
    },
  };
}

/**
 * Development only: warn if a placed bunker model doesn't fill the shape paintballs collide with
 * (shared/field.ts). A mismatch shows up in game as paint splatting on thin air.
 */
function checkFit(g: THREE.Object3D, b: Bunker): void {
  const box = new THREE.Box3().setFromObject(g);
  const want = footprintBox(b);
  // 0.2 m of slack: seams, the valve and the flared base skirt stick out a little past the shape
  const off = (got: number, w: number) => Math.abs(got - w) > 0.2;
  if (off(box.min.y, 0) || off(box.max.y, topOf(b)) || off(box.min.x, want.x0) || off(box.max.x, want.x1) ||
      off(box.min.z, want.z0) || off(box.max.z, want.z1)) {
    console.warn(`bunker model ${bunkerKey(b)} at (${b.x}, ${b.z}) doesn't match its collision shape`, box);
  }
}

/** a bunker's footprint as a world-space box seen from above */
function footprintBox(b: Bunker): { x0: number; x1: number; z0: number; z1: number } {
  let hx: number;
  let hz: number;
  if (b.kind === 'poly' || b.kind === 'taper') {
    const xs = b.pts.map(([x]) => b.x + x);
    const zs = b.pts.map(([, z]) => b.z + z);
    return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  }
  if (b.kind === 'profile') {
    const f = profileBox(b);
    return { x0: f.x - f.hx, x1: f.x + f.hx, z0: f.z - f.hz, z1: f.z + f.hz };
  }
  if (b.kind === 'can' || b.kind === 'orb') hx = hz = b.r;
  else if (b.kind === 'log') [hx, hz] = logHalf(b);
  else [hx, hz] = [b.w / 2, b.d / 2];
  return { x0: b.x - hx, x1: b.x + hx, z0: b.z - hz, z1: b.z + hz };
}

// ---- bunkers ----------------------------------------------------------------------------------

/** materials shared by every bunker of the same colour and look */
class Materials {
  private cache = new Map<string, THREE.Material>();
  get(key: string, make: () => THREE.Material): THREE.Material {
    let m = this.cache.get(key);
    if (!m) {
      m = make();
      this.cache.set(key, m);
    }
    return m;
  }
  inflatable(color: number) {
    return this.get(`inf-${color}`, () => new THREE.MeshPhysicalMaterial({ color, roughness: 0.5, clearcoat: 0.6, clearcoatRoughness: 0.35 }));
  }
  plain(color: number, roughness = 0.9, flat = false) {
    return this.get(`plain-${color}-${roughness}-${flat}`, () => new THREE.MeshStandardMaterial({ color, roughness, flatShading: flat }));
  }
  textured(name: string, make: () => THREE.Texture, color = 0xffffff, roughness = 0.9) {
    return this.get(`tex-${name}-${color}`, () => new THREE.MeshStandardMaterial({ map: make(), color, roughness }));
  }
  get band() {
    return this.plain(0x23202a, 0.7);
  }
}

/** a bunker drawn from code, its base at y 0 and centred on its x, z (the caller places it) */
function drawBunker(b: Bunker, mats: Materials): THREE.Group {
  const g = new THREE.Group();
  const look: Look = b.look ?? 'inflatable';
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, y = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    g.add(m);
    return m;
  };

  if (HOLIDAY_LOOKS.has(look) && drawHolidayBunker(g, b, look, mats, GEOS)) return g;

  if (b.kind === 'orb') {
    drawPlanet(g, b, look, mats);
    return g;
  }

  if (b.kind === 'box') {
    if (look === 'sandbag') {
      // rows of bags filling the footprint exactly
      const rows = Math.max(2, Math.round(b.h / 0.3));
      const along = b.w >= b.d;
      const len = along ? b.w : b.d;
      const n = Math.max(2, Math.round(len / 0.75));
      const bl = len / n;
      const rh = b.h / rows;
      const mat = mats.plain(b.color, 1);
      for (let r = 0; r < rows; r++) {
        const shift = r % 2 ? bl / 2 : 0;
        for (let i = 0; i < n; i++) {
          let u = -len / 2 + bl / 2 + i * bl + shift;
          let s = bl;
          if (u + bl / 2 > len / 2) {
            s = len / 2 - (u - bl / 2);
            u = len / 2 - s / 2;
          }
          if (s < 0.1) continue;
          const geo = new RoundedBoxGeometry(along ? s : b.w, rh, along ? b.d : s, 2, Math.min(rh, s) * 0.35);
          const m = add(geo, mat, rh / 2 + r * rh);
          if (along) m.position.x = u;
          else m.position.z = u;
        }
      }
      return g;
    }
    if (look === 'wood') {
      add(new THREE.BoxGeometry(b.w, b.h, b.d), mats.textured('planks', plankTexture, b.color), b.h / 2);
      return g;
    }
    if (look === 'hut' || look === 'tower') {
      const walls = look === 'hut' ? () => stripeTexture(b.color) : () => towerTexture(b.color);
      add(new THREE.BoxGeometry(b.w, b.h * 0.86, b.d), mats.textured(`${look}-${b.color}`, walls, 0xffffff, 0.75), b.h * 0.43);
      // the roof stays inside the footprint so paint never splats on air
      add(new THREE.BoxGeometry(b.w, b.h * 0.14, b.d), mats.plain(look === 'hut' ? 0xf4efe6 : 0xd9473b, 0.6), b.h * 0.93);
      return g;
    }
    const body = new THREE.Mesh(new RoundedBoxGeometry(b.w, b.h, b.d, 4, Math.min(0.18, b.h / 4)), mats.inflatable(b.color));
    body.position.y = b.h / 2;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.012, 0.12, b.d + 0.012), mats.band);
    stripe.position.y = b.h * 0.55;
    g.add(body, stripe);
    return g;
  }

  if (b.kind === 'can') {
    if (look === 'tree') {
      add(new THREE.CylinderGeometry(b.r * 0.8, b.r, b.h, 10), mats.textured('bark', barkTexture, 0xffffff, 1), b.h / 2);
      // a crown of leaves up out of reach, so it never blocks paint at head height
      const leaves = mats.plain(0x3f6b2e, 0.95, true);
      const s = 1.4 + b.r * 4;
      for (const [y, k] of [[b.h - 3.2, 1], [b.h - 1.6, 0.8], [b.h - 0.2, 0.55]] as const) {
        const m = add(new THREE.IcosahedronGeometry(s * k, 0), leaves, y);
        m.scale.y = 0.75;
        m.rotation.y = b.x * 7.1 + y;
      }
      return g;
    }
    if (look === 'dune') {
      add(new THREE.CylinderGeometry(b.r * 0.72, b.r, b.h, 28, 1), mats.plain(b.color, 1), b.h / 2);
      return g;
    }
    if (look === 'spool') {
      const wood = mats.textured('planks', plankTexture, b.color);
      add(new THREE.CylinderGeometry(b.r, b.r, 0.12, 24), wood, 0.06);
      add(new THREE.CylinderGeometry(b.r, b.r, 0.12, 24), wood, b.h - 0.06);
      add(new THREE.CylinderGeometry(b.r * 0.97, b.r * 0.97, b.h - 0.24, 24), mats.plain(0x3a3a3a, 0.6), b.h / 2); // wound cable
      return g;
    }
    if (look === 'barrel') {
      const mat = mats.get(`barrel-${b.color}`, () => new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.45, metalness: 0.5 }));
      add(new THREE.CylinderGeometry(b.r, b.r, b.h, 20), mat, b.h / 2);
      for (const y of [b.h * 0.3, b.h * 0.7]) add(new THREE.CylinderGeometry(b.r * 1.01, b.r * 1.01, 0.04, 20), mats.band, y);
      return g;
    }
    add(new THREE.CylinderGeometry(b.r * 0.94, b.r, b.h, 32), mats.inflatable(b.color), b.h / 2);
    add(new THREE.CylinderGeometry(b.r * 0.985, b.r * 0.985, 0.12, 32), mats.band, b.h * 0.55);
    return g;
  }

  if (b.kind === 'log') {
    const geo = new THREE.CylinderGeometry(b.r, b.r * 0.94, b.len, 14);
    const m = add(geo, mats.textured('bark', barkTexture, b.color === 0x5a4632 ? 0xffffff : b.color, 1), b.r);
    if (b.axis === 'x') m.rotation.z = Math.PI / 2;
    else m.rotation.x = Math.PI / 2;
    // cut ends
    const end = mats.plain(0xc9a77c, 0.9);
    for (const s of [-1, 1]) {
      const cap = add(new THREE.CircleGeometry(b.r * 0.97, 14), end, b.r);
      if (b.axis === 'x') {
        cap.position.x = (s * b.len) / 2 + s * 0.002;
        cap.rotation.y = (s * Math.PI) / 2;
      } else {
        cap.position.z = (s * b.len) / 2 + s * 0.002;
        cap.rotation.y = s > 0 ? 0 : Math.PI;
      }
    }
    return g;
  }

  if (b.kind === 'taper') {
    add(taperGeometry(b), mats.inflatable(b.color));
    const y = b.h * 0.4;
    add(taperGeometry(b, y - 0.06, y + 0.06, 1.012), mats.band);
    return g;
  }

  if (b.kind === 'profile') {
    add(profileGeometry(b), mats.inflatable(b.color));
    const low = Math.min(...b.line.map(([, y]) => y));
    add(profileGeometry(b, 0.12, 1.01), mats.band, low * 0.5 - 0.06); // a strip along it, under the lowest dip
    return g;
  }

  // poly: an upright prism over the footprint
  const geo = prismGeometry(b);
  if (look === 'rock') {
    add(geo, mats.get(`rock-${b.color}`, () => new THREE.MeshStandardMaterial({ color: b.color, roughness: 1, flatShading: true })));
    return g;
  }
  if (look === 'boat') {
    add(geo, mats.get(`hull-${b.color}`, () => new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.55 })));
    const stripe = prismGeometry(b, 0.12, 1.004);
    add(stripe, mats.plain(0xf3efe6, 0.6), b.h * 0.6);
    return g;
  }
  add(geo, mats.inflatable(b.color));
  add(prismGeometry(b, 0.12, 1.006), mats.band, b.h * 0.55);
  return g;
}

/**
 * A planet: a ball on a tilted axis that turns slowly (world.update spins anything with userData.spin),
 * banded, ringed or cratered by its look. Rings are only drawn: paint flies through them.
 */
function drawPlanet(g: THREE.Group, b: OrbBunker, look: Look, mats: Materials): void {
  const tilted = new THREE.Group();
  tilted.position.y = orbY(b);
  // a different tilt for each planet, from where it is (the same on every machine)
  tilted.rotation.set(0.22 + 0.12 * Math.sin(b.z * 1.3), 0, 0.3 * Math.cos(b.z * 0.7));
  g.add(tilted);
  const kind = look === 'ringed' || look === 'moon' ? look : 'planet';
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(b.r, 40, 28),
    mats.get(`planet-${kind}-${b.color}`, () => new THREE.MeshStandardMaterial({ map: planetTexture(kind, b.color), roughness: 0.9 })),
  );
  ball.rotation.y = b.x * 0.9 + b.z * 0.4;
  ball.userData.spin = (kind === 'moon' ? 0.05 : 0.16) * (b.z >= 0 ? 1 : -1);
  tilted.add(ball);
  if (kind !== 'ringed') return;
  // three bands of ring, with gaps between them
  const bands: [number, number, number, number][] = [[1.32, 1.5, 0.95, 0.75], [1.56, 1.78, 0.8, 0.6], [1.82, 1.9, 0.65, 0.4]];
  for (const [r0, r1, light, opacity] of bands) {
    const c = new THREE.Color(b.color).lerp(new THREE.Color(0xfff6e0), light * 0.6);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(b.r * r0, b.r * r1, 72, 1),
      mats.get(`ring-${b.color}-${r0}`, () => new THREE.MeshStandardMaterial({
        color: c, roughness: 0.8, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
      })),
    );
    ring.rotation.x = -Math.PI / 2;
    tilted.add(ring);
  }
}

/** a planet's surface, wrapped round the ball: bands of cloud, or craters */
function planetTexture(kind: 'planet' | 'ringed' | 'moon', color: number): THREE.CanvasTexture {
  const base = new THREE.Color(color);
  const shade = (k: number) => `#${base.clone().multiplyScalar(k).getHexString()}`;
  const tint = (k: number) => `#${base.clone().lerp(new THREE.Color(0xffffff), k).getHexString()}`;
  let seed = (color % 9973) + 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return canvasTexture(256, 128, (g) => {
    g.fillStyle = css(color);
    g.fillRect(0, 0, 256, 128);
    if (kind === 'moon') {
      for (let i = 0; i < 55; i++) {
        const x = rnd() * 256;
        const y = 14 + rnd() * 100;
        const r = 2 + rnd() * rnd() * 16;
        g.fillStyle = shade(0.72);
        g.beginPath();
        g.ellipse(x, y, r, r * 0.8, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = tint(0.35);
        g.lineWidth = Math.max(1, r * 0.25);
        g.beginPath();
        g.ellipse(x - r * 0.15, y - r * 0.15, r, r * 0.8, 0, Math.PI * 0.9, Math.PI * 1.9);
        g.stroke();
      }
      return;
    }
    // bands that wobble a little along their length
    let y = 0;
    let k = 0;
    while (y < 128) {
      const hgt = 6 + rnd() * (kind === 'ringed' ? 10 : 16);
      g.fillStyle = k % 2 ? shade(0.78 + rnd() * 0.1) : tint(0.18 + rnd() * 0.25);
      const phase = rnd() * 6;
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= 256; x += 8) g.lineTo(x, y + Math.sin(x * 0.05 + phase) * 1.8);
      for (let x = 256; x >= 0; x -= 8) g.lineTo(x, y + hgt + Math.sin(x * 0.04 + phase + 1) * 1.8);
      g.fill();
      y += hgt;
      k++;
    }
    if (kind === 'planet') {
      // a big storm
      const sx = 80 + rnd() * 100;
      g.fillStyle = shade(0.6);
      g.beginPath();
      g.ellipse(sx, 72, 16, 7, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = tint(0.4);
      g.beginPath();
      g.ellipse(sx + 3, 72, 8, 3, 0, 0, Math.PI * 2);
      g.fill();
    }
  });
}

/** the shape geometry holidays.ts draws its tapering and shaped-wall bunkers with */
const GEOS: Geos = { taper: (b, y0, y1, grow) => taperGeometry(b, y0, y1, grow), profile: (b, cap, grow) => profileGeometry(b, cap, grow) };

/** a prism over a poly bunker's footprint, `h` tall from y 0 (optionally grown a hair, for stripes) */
function prismGeometry(b: PolyBunker, h = b.h, grow = 1): THREE.BufferGeometry {
  // Shape is in x/y; extruding along +z then turning it upright maps shape (x, y) to world (x, -z)
  const shape = new THREE.Shape(b.pts.map(([x, z]) => new THREE.Vector2(x * grow, -z * grow)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A slice of a taper from height y0 to y1 (the whole thing by default), relative to its x, z;
 * grow pushes it out from the middle a little (for a band round it).
 */
function taperGeometry(b: TaperBunker, y0 = 0, y1 = b.h, grow = 1): THREE.BufferGeometry {
  const [ax, az] = b.apex ?? centreOf(b.pts);
  const [cx, cz] = centreOf(b.pts);
  const ring = (y: number) => {
    const k = 1 - (1 - b.top) * (y / b.h);
    return b.pts.map(([px, pz]) => {
      const x = ax + (px - ax) * k;
      const z = az + (pz - az) * k;
      return new THREE.Vector3(cx + (x - cx) * grow, y, cz + (z - cz) * grow);
    });
  };
  const lo = ring(y0);
  const hi = ring(y1);
  const n = lo.length;
  const pos: number[] = [];
  const tri = (a: THREE.Vector3, b2: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b2.x, b2.y, b2.z, c.x, c.y, c.z);
  // wind every face so it's seen from outside, whichever way round the corners were given
  let area = 0;
  for (let i = 0; i < n; i++) area += lo[i].x * lo[(i + 1) % n].z - lo[(i + 1) % n].x * lo[i].z;
  const flip = area > 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (flip) {
      tri(lo[i], hi[j], lo[j]);
      tri(lo[i], hi[i], hi[j]);
    } else {
      tri(lo[i], lo[j], hi[j]);
      tri(lo[i], hi[j], hi[i]);
    }
  }
  for (let i = 1; i < n - 1; i++) {
    if (flip) {
      tri(hi[0], hi[i + 1], hi[i]);
      tri(lo[0], lo[i], lo[i + 1]);
    } else {
      tri(hi[0], hi[i], hi[i + 1]);
      tri(lo[0], lo[i + 1], lo[i]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * A wall with a shaped top, relative to its x, z: its outline under the top line, as thick as the wall.
 * `cap` cuts it off at that height (for a band along it); grow makes it a little thicker and longer.
 */
function profileGeometry(b: ProfileBunker, cap = Infinity, grow = 1): THREE.BufferGeometry {
  const l = b.line;
  const pts = [new THREE.Vector2(l[0][0] * grow, 0), ...l.map(([u, y]) => new THREE.Vector2(u * grow, Math.min(y, cap))), new THREE.Vector2(l[l.length - 1][0] * grow, 0)];
  const d = b.d * grow;
  const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  // the shape is drawn in (u, y) and pushed out along +z: that's a wall along x; turn it for one along z
  if (b.axis === 'z') geo.rotateY(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

// ---- ground -----------------------------------------------------------------------------------

function buildGround(root: THREE.Group, map: GameMap): void {
  const w = map.length + map.margin * 2;
  const d = map.width + map.margin * 2;
  const tex = groundTexture(map, w, d);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);
}

function groundTexture(map: GameMap, w: number, d: number): THREE.CanvasTexture {
  const ppm = w > 70 ? 14 : 24; // pixels per metre; big fields get fewer so the texture stays small
  const c = document.createElement('canvas');
  c.width = Math.round(w * ppm);
  c.height = Math.round(d * ppm);
  const g = c.getContext('2d')!;
  const X = (x: number) => (x + w / 2) * ppm;
  const Z = (z: number) => (z + d / 2) * ppm;
  const hl = map.length / 2;
  const hw = map.width / 2;
  const kind = map.theme.ground;

  if (holidayGround(kind, g, c, ppm)) {
    // drawn in holidays.ts
  } else if (kind === 'turf') {
    for (let i = 0; i * 3 < w; i++) {
      g.fillStyle = i % 2 ? '#3f8a3a' : '#46953f';
      g.fillRect(i * 3 * ppm, 0, 3 * ppm + 1, c.height);
    }
    speckle(g, c, 9000, 'rgba(0,0,0,0.05)', 'rgba(255,255,255,0.04)');
  } else if (kind === 'moon') {
    g.fillStyle = '#8f8c86';
    g.fillRect(0, 0, c.width, c.height);
    // soft grey patches, then craters with a lit rim on the sun's side
    for (let i = 0; i < 120; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(60,58,55,0.07)' : 'rgba(200,198,190,0.07)';
      g.beginPath();
      g.ellipse(Math.random() * c.width, Math.random() * c.height, 30 + Math.random() * 90, 20 + Math.random() * 60, Math.random() * 3, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 160; i++) {
      const x = Math.random() * c.width;
      const y = Math.random() * c.height;
      const r = (0.15 + Math.random() * Math.random() * 0.9) * ppm;
      g.fillStyle = 'rgba(70,68,64,0.22)';
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(225,222,212,0.35)';
      g.lineWidth = Math.max(1, r * 0.18);
      g.beginPath();
      g.arc(x, y, r, Math.PI * 1.0, Math.PI * 1.8);
      g.stroke();
    }
    speckle(g, c, 16000, 'rgba(40,40,40,0.10)', 'rgba(255,255,255,0.08)');
  } else if (kind === 'sand') {
    g.fillStyle = '#e2cc95';
    g.fillRect(0, 0, c.width, c.height);
    // wind ripples
    g.strokeStyle = 'rgba(150,120,70,0.12)';
    g.lineWidth = 2;
    for (let y = 0; y < c.height; y += 9) {
      g.beginPath();
      for (let x = 0; x <= c.width; x += 24) g.lineTo(x, y + Math.sin(x * 0.02 + y * 0.3) * 3);
      g.stroke();
    }
    speckle(g, c, 14000, 'rgba(120,90,50,0.08)', 'rgba(255,255,255,0.10)');
  } else {
    g.fillStyle = '#3e4a2b';
    g.fillRect(0, 0, c.width, c.height);
    // patches of moss and bare earth, then fallen leaves
    for (let i = 0; i < 260; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(90,110,50,0.25)' : 'rgba(80,60,40,0.25)';
      g.beginPath();
      g.ellipse(Math.random() * c.width, Math.random() * c.height, 20 + Math.random() * 70, 14 + Math.random() * 50, Math.random() * 3, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 16000; i++) {
      const r = Math.random();
      g.fillStyle = r < 0.35 ? 'rgba(150,100,40,0.5)' : r < 0.6 ? 'rgba(170,140,60,0.4)' : 'rgba(30,35,20,0.35)';
      g.fillRect(Math.random() * c.width, Math.random() * c.height, 3, 2);
    }
  }

  // start boxes in team colours
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  for (const [team, x0] of [[0, -hl], [1, hl - 3]] as const) {
    g.fillStyle = hex(TEAM_COLORS[team]) + (kind === 'forest' ? '40' : '55');
    g.fillRect(X(x0), Z(-7), 3 * ppm, 14 * ppm);
  }
  // field lines: chalk on turf and sand, fainter paint in the woods
  g.strokeStyle = kind === 'forest' ? 'rgba(255,255,255,0.35)' : kind === 'snow' ? 'rgba(200,40,55,0.75)' : 'rgba(255,255,255,0.85)';
  g.lineWidth = 0.12 * ppm;
  g.strokeRect(X(-hl), Z(-hw), map.length * ppm, map.width * ppm);
  g.beginPath();
  g.moveTo(X(0), Z(-hw));
  g.lineTo(X(0), Z(hw));
  g.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function speckle(g: CanvasRenderingContext2D, c: HTMLCanvasElement, n: number, dark: string, light: string): void {
  for (let i = 0; i < n; i++) {
    g.fillStyle = Math.random() < 0.5 ? dark : light;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 2);
  }
}

// ---- around the field ------------------------------------------------------------------------

/** everything round the field; returns what moves there each frame, if anything does */
function buildSurround(root: THREE.Group, map: GameMap): Animate | null {
  const t = map.theme;
  const ex = field.halfL + field.margin;
  const ez = field.halfW + field.margin;
  const outerColor = outerGroundColor(t.surround) ?? (t.surround === 'sea' ? 0xd9c38a : t.surround === 'forest' ? 0x34402a : t.surround === 'space' ? 0x7a7872 : 0x4f7334);
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: outerColor, roughness: 1 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.02;
  outer.receiveShadow = true;
  root.add(outer);

  if (t.surround === 'sea') {
    // the sea along the +z side, with a strip of wet sand and foam at the waterline
    const shore = ez + 9;
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 300),
      new THREE.MeshStandardMaterial({ color: 0x2c8fb8, roughness: 0.18, metalness: 0.15 }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, 0.02, shore + 150);
    root.add(sea);
    const wet = new THREE.Mesh(new THREE.PlaneGeometry(600, 4), new THREE.MeshStandardMaterial({ color: 0xb59e6a, roughness: 0.6 }));
    wet.rotation.x = -Math.PI / 2;
    wet.position.set(0, 0, shore - 2);
    root.add(wet);
    const foam = new THREE.Mesh(new THREE.PlaneGeometry(600, 1.2), new THREE.MeshBasicMaterial({ color: 0xf4fbff, transparent: true, opacity: 0.85 }));
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(0, 0.03, shore);
    root.add(foam);
    // palms behind the far rope line
    palms(root, ex, -ez - 5);
  } else if (t.surround === 'forest') {
    forestRing(root, ex, ez);
  } else if (t.surround === 'stands') {
    stands(root, ex, ez);
  } else if (t.surround === 'space') {
    spaceSky(root);
    moonRocks(root, ex, ez);
    moonbase(root, ex, ez);
  } else {
    return buildHolidaySurround(root, map, ex, ez) ?? null;
  }
  return null;
}

/**
 * Stars all over the sky and a big planet hanging in it. Lambert, basic and points materials, so the
 * toon pass leaves them alone, and no fog: they're far beyond it.
 */
function spaceSky(root: THREE.Group): void {
  const n = 2600;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let seed = 4242;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tints = [new THREE.Color(0xffffff), new THREE.Color(0xcfe0ff), new THREE.Color(0xfff0d0), new THREE.Color(0xffd6e8)];
  for (let i = 0; i < n; i++) {
    // a point on a big dome over the field (a little below the horizon too, past the moon's edge)
    const u = rnd() * Math.PI * 2;
    const v = Math.asin(rnd() * 1.1 - 0.1);
    const r = 380;
    pos.set([Math.cos(u) * Math.cos(v) * r, Math.sin(v) * r, Math.sin(u) * Math.cos(v) * r], i * 3);
    const c = tints[Math.floor(rnd() * tints.length)].clone().multiplyScalar(0.45 + rnd() * 0.55);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const stars = new THREE.Points(geo, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
  stars.renderOrder = -2;
  root.add(stars);

  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(46, 48, 32),
    new THREE.MeshLambertMaterial({ map: planetTexture('planet', 0x3f7fd0), fog: false }),
  );
  planet.position.set(-150, 95, -250);
  planet.rotation.z = 0.4;
  const haze = new THREE.Mesh(
    new THREE.SphereGeometry(49, 48, 32),
    new THREE.MeshBasicMaterial({
      color: 0x7fc4ff, transparent: true, opacity: 0.18, side: THREE.BackSide, fog: false, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  haze.position.copy(planet.position);
  planet.renderOrder = haze.renderOrder = -1;
  root.add(planet, haze);
}

/** grey boulders scattered past the boundary (one instanced mesh) */
function moonRocks(root: THREE.Group, ex: number, ez: number): void {
  const spots: [number, number, number][] = [];
  let seed = 99;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 400 && spots.length < 140; i++) {
    const x = (r() * 2 - 1) * (ex + 60);
    const z = (r() * 2 - 1) * (ez + 60);
    if (Math.abs(x) < ex + 3 && Math.abs(z) < ez + 3) continue;
    spots.push([x, z, 0.4 + r() * r() * 2.6]);
  }
  const geo = new THREE.IcosahedronGeometry(1, 0);
  geo.scale(1, 0.6, 1);
  const rocks = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x8a877f, roughness: 1, flatShading: true }), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  spots.forEach(([x, z, s], i) => {
    q.setFromEuler(e.set(x * 0.3, x * 3.1 + z, z * 0.2));
    m.compose(new THREE.Vector3(x, s * 0.15, z), q, new THREE.Vector3(s, s, s));
    rocks.setMatrixAt(i, m);
  });
  rocks.castShadow = rocks.receiveShadow = true;
  root.add(rocks);
}

/** white domes with a lit window band and an aerial, behind both ends */
function moonbase(root: THREE.Group, ex: number, ez: number): void {
  const shell = new THREE.MeshStandardMaterial({ color: 0xeef0f4, roughness: 0.6 });
  const glass = new THREE.MeshBasicMaterial({ color: 0x9fe8ff });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa0aa, roughness: 0.4, metalness: 0.5 });
  const beacon = new THREE.MeshBasicMaterial({ color: 0xff5a5a });
  for (const end of [-1, 1]) {
    for (const [dz, r] of [[-ez * 0.55, 4.5], [ez * 0.35, 3.2]] as const) {
      const x = end * (ex + 9 + r);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), shell);
      dome.position.set(x, 0, dz);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.93, r * 0.97, 0.35, 32, 1, true), glass);
      band.position.set(x, r * 0.32, dz);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, r * 0.9, 6), metal);
      mast.position.set(x, r * 1.4, dz);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), beacon);
      tip.position.set(x, r * 1.85, dz);
      dome.castShadow = dome.receiveShadow = true;
      root.add(dome, band, mast, tip);
    }
  }
}

/** bleachers along both sidelines */
function stands(root: THREE.Group, ex: number, ez: number): void {
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.8 });
  const seat = new THREE.MeshStandardMaterial({ color: 0x2b3a67, roughness: 0.7 });
  for (const s of [-1, 1]) {
    for (let step = 0; step < 5; step++) {
      // each step is a block from the ground up, a little taller and further back than the last
      const h = 0.45 * (1 + step * 2);
      const m = new THREE.Mesh(new THREE.BoxGeometry(ex * 1.4, h, 0.9), step % 2 ? seat : mat);
      m.position.set(0, h / 2, s * (ez + 3 + step * 0.9));
      m.castShadow = m.receiveShadow = true;
      root.add(m);
    }
  }
}

/** palm trees in a row along z = z0 */
function palms(root: THREE.Group, ex: number, z0: number): void {
  const trunk = new THREE.MeshStandardMaterial({ color: 0x8b6b4a, roughness: 1 });
  const leaf = new THREE.MeshStandardMaterial({ color: 0x3f8f3a, roughness: 0.9, side: THREE.DoubleSide, flatShading: true });
  for (let x = -ex; x <= ex; x += 7) {
    const p = new THREE.Group();
    const lean = Math.sin(x * 1.7) * 0.18;
    for (let i = 0; i < 6; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.2, 7), trunk);
      seg.position.set(lean * i * i * 0.25, 0.6 + i * 1.15, 0);
      seg.rotation.z = -lean * i * 0.35;
      p.add(seg);
    }
    const top = new THREE.Vector3(lean * 25 * 0.25, 7.3, 0);
    for (let k = 0; k < 7; k++) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.5, 3.4, 4, 1, true), leaf);
      f.position.copy(top);
      f.rotation.set(Math.PI / 2 - 0.5, (k / 7) * Math.PI * 2, 0, 'YXZ');
      f.translateY(1.5);
      f.scale.z = 0.25;
      p.add(f);
    }
    p.position.set(x + Math.sin(x) * 1.5, 0, z0 - Math.abs(Math.cos(x * 0.7)) * 4);
    p.traverse((o) => (o.castShadow = true));
    root.add(p);
  }
}

/** a ring of trees outside the rope, as instanced meshes (cheap: two draw calls) */
function forestRing(root: THREE.Group, ex: number, ez: number): void {
  const spots: [number, number, number][] = [];
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 520; i++) {
    const x = (r() * 2 - 1) * (ex + 34);
    const z = (r() * 2 - 1) * (ez + 34);
    if (Math.abs(x) < ex + 2 && Math.abs(z) < ez + 2) continue;
    spots.push([x, z, 0.7 + r() * 0.7]);
  }
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 9, 7);
  trunkGeo.translate(0, 4.5, 0);
  const crownGeo = new THREE.IcosahedronGeometry(2.6, 0);
  crownGeo.scale(1, 1.25, 1);
  crownGeo.translate(0, 8.2, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ map: barkTexture(), roughness: 1 }), spots.length);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x395f2a, roughness: 0.95, flatShading: true }), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  spots.forEach(([x, z, s], i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), x * 3.1);
    m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(i, m);
    crowns.setMatrixAt(i, m);
  });
  trunks.castShadow = crowns.castShadow = true;
  root.add(trunks, crowns);
}

// ---- boundaries -------------------------------------------------------------------------------

function buildNets(root: THREE.Group, lx: number, lz: number): void {
  const H = 4;
  const net = new THREE.MeshBasicMaterial({ color: 0x141218, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false });
  const pole = new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.6 });
  const sides: [number, number, number, number][] = [
    [0, -lz, lx * 2, 0],
    [0, lz, lx * 2, 0],
    [-lx, 0, lz * 2, Math.PI / 2],
    [lx, 0, lz * 2, Math.PI / 2],
  ];
  for (const [x, z, len, rot] of sides) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, H), net);
    m.position.set(x, H / 2, z);
    m.rotation.y = rot;
    root.add(m);
    const n = Math.round(len / 6);
    for (let i = 0; i <= n; i++) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, H, 8), pole);
      const off = -len / 2 + (i * len) / n;
      p.position.set(rot ? x : off, H / 2, rot ? off : z);
      p.castShadow = true;
      root.add(p);
    }
  }
}

/** a waist-high rope on posts (beach, woods): paint flying past it is out of play */
function buildRope(root: THREE.Group, lx: number, lz: number): void {
  const post = new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 1 });
  const rope = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.8 });
  const sides: [number, number, number, boolean][] = [
    [0, -lz, lx * 2, false],
    [0, lz, lx * 2, false],
    [-lx, 0, lz * 2, true],
    [lx, 0, lz * 2, true],
  ];
  for (const [x, z, len, alongZ] of sides) {
    const n = Math.max(1, Math.round(len / 5));
    for (let i = 0; i <= n; i++) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.2, 6), post);
      const off = -len / 2 + (i * len) / n;
      p.position.set(alongZ ? x : off, 0.6, alongZ ? off : z);
      p.castShadow = true;
      root.add(p);
    }
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, len, 4), rope);
    r.position.set(x, 1.05, z);
    if (alongZ) r.rotation.x = Math.PI / 2;
    else r.rotation.z = Math.PI / 2;
    root.add(r);
  }
}

/** a glowing line on short posts (space): paint flying past it is out of play */
function buildGlowLine(root: THREE.Group, lx: number, lz: number): void {
  const post = new THREE.MeshStandardMaterial({ color: 0xc9ccd3, roughness: 0.5, metalness: 0.4 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x67f0ff });
  const halo = new THREE.MeshBasicMaterial({ color: 0x67f0ff, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending });
  const sides: [number, number, number, boolean][] = [
    [0, -lz, lx * 2, false],
    [0, lz, lx * 2, false],
    [-lx, 0, lz * 2, true],
    [lx, 0, lz * 2, true],
  ];
  for (const [x, z, len, alongZ] of sides) {
    const n = Math.max(1, Math.round(len / 5));
    for (let i = 0; i <= n; i++) {
      const off = -len / 2 + (i * len) / n;
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.1, 8), post);
      p.position.set(alongZ ? x : off, 0.55, alongZ ? off : z);
      p.castShadow = true;
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), glow);
      light.position.set(alongZ ? x : off, 1.12, alongZ ? off : z);
      root.add(p, light);
    }
    for (const [r, mat] of [[0.018, glow], [0.07, halo]] as const) {
      const line = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), mat);
      line.position.set(x, 0.95, z);
      if (alongZ) line.rotation.x = Math.PI / 2;
      else line.rotation.z = Math.PI / 2;
      root.add(line);
    }
  }
}

// ---- textures ----------------------------------------------------------------------------------

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

function barkTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 256, (g) => {
    g.fillStyle = '#5a4632';
    g.fillRect(0, 0, 64, 256);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(30,20,12,0.45)' : 'rgba(120,95,70,0.35)';
      g.fillRect(Math.random() * 64, Math.random() * 256, 2 + Math.random() * 3, 20 + Math.random() * 60);
    }
  });
}

function plankTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (g) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 21) {
      g.fillStyle = 'rgba(60,40,20,0.55)';
      g.fillRect(0, y, 128, 3);
      for (let i = 0; i < 6; i++) {
        g.fillStyle = 'rgba(90,60,30,0.15)';
        g.fillRect(0, y + 4 + Math.random() * 15, 128, 1);
      }
    }
  });
}

const css = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** beach hut boards: white and the hut's colour */
function stripeTexture(color: number): THREE.CanvasTexture {
  return canvasTexture(128, 64, (g) => {
    g.fillStyle = '#f6f2ea';
    g.fillRect(0, 0, 128, 64);
    g.fillStyle = css(color);
    for (let x = 0; x < 128; x += 32) g.fillRect(x, 0, 16, 64);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = 0; x < 128; x += 16) g.fillRect(x, 0, 1, 64);
  });
}

/** lifeguard tower: its colour with a red band */
function towerTexture(color: number): THREE.CanvasTexture {
  return canvasTexture(64, 128, (g) => {
    g.fillStyle = css(color);
    g.fillRect(0, 0, 64, 128);
    g.fillStyle = '#d9473b';
    g.fillRect(0, 40, 64, 22);
  });
}
