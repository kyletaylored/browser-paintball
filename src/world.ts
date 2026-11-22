// The field you play on: sky, lights, ground, boundary, bunkers and the scenery around it, built
// from code for whichever map is on (shared/maps.ts). buildWorld returns a handle; dispose it and
// build again when the map changes. The arena's bunkers use the models in public/models/bunkers.glb
// when they've loaded; everything else is drawn here.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { field, bunkerKey, type Bunker, type Look, type PolyBunker } from '../shared/field';
import type { GameMap } from '../shared/maps';
import { bunkerModel, type Models } from './models';
import { toonify } from './toon';
import { TEAM_COLORS } from '../shared/protocol';

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

  buildSurround(root, map);
  buildGround(root, map);
  if (t.boundary === 'net') buildNets(root, ex, ez);
  else buildRope(root, ex, ez);

  const mats = new Materials();
  const wobbles: (Wobble | null)[] = [];
  const addWobble = (g: THREE.Object3D, b: Bunker) => {
    const h = b.kind === 'log' ? b.r * 2 : b.h;
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

  const moving = new Set<Wobble>();
  const axis = new THREE.Vector3();
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
  if (b.kind !== 'box' && b.kind !== 'can') return;
  const box = new THREE.Box3().setFromObject(g);
  const w = b.kind === 'box' ? b.w : b.r * 2;
  const d = b.kind === 'box' ? b.d : b.r * 2;
  // 0.2 m of slack: seams, the valve and the flared base skirt stick out a little past the shape
  const off = (got: number, want: number) => Math.abs(got - want) > 0.2;
  if (off(box.min.y, 0) || off(box.max.y, b.h) || off(box.max.x - box.min.x, w) || off(box.max.z - box.min.z, d) ||
      off((box.min.x + box.max.x) / 2, b.x) || off((box.min.z + box.max.z) / 2, b.z)) {
    console.warn(`bunker model ${bunkerKey(b)} at (${b.x}, ${b.z}) doesn't match its collision shape`, box);
  }
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

/** a prism over a poly bunker's footprint, `h` tall from y 0 (optionally grown a hair, for stripes) */
function prismGeometry(b: PolyBunker, h = b.h, grow = 1): THREE.BufferGeometry {
  // Shape is in x/y; extruding along +z then turning it upright maps shape (x, y) to world (x, -z)
  const shape = new THREE.Shape(b.pts.map(([x, z]) => new THREE.Vector2(x * grow, -z * grow)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
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

  if (kind === 'turf') {
    for (let i = 0; i * 3 < w; i++) {
      g.fillStyle = i % 2 ? '#3f8a3a' : '#46953f';
      g.fillRect(i * 3 * ppm, 0, 3 * ppm + 1, c.height);
    }
    speckle(g, c, 9000, 'rgba(0,0,0,0.05)', 'rgba(255,255,255,0.04)');
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
  g.strokeStyle = kind === 'forest' ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.85)';
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

function buildSurround(root: THREE.Group, map: GameMap): void {
  const t = map.theme;
  const ex = field.halfL + field.margin;
  const ez = field.halfW + field.margin;
  const outerColor = t.surround === 'sea' ? 0xd9c38a : t.surround === 'forest' ? 0x34402a : 0x4f7334;
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
