// Paint splats (decals stuck to surfaces) and little bursts of paint droplets.
// Both use fixed-size pools of meshes and particles.
//
// A splat on the ground is a flat square. A splat on a bunker is projected onto the bunker's own
// model (three's DecalGeometry): the shape is cut out of the model's surface where the ball hit, so
// it wraps round a can, over the top of a roll and round a corner instead of sticking out into the
// air. It's a child of the bunker, so it wobbles with an inflatable. Only faces turned toward the
// shot get paint, so it doesn't come through on the back of a thin wall.

import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const DECALS = 500;
const PARTICLES = 900;
const VARIANTS = 4;
/** how deep a splat on a bunker reaches into and out of the surface (m): enough for a curve or a seam */
const DECAL_DEPTH = 0.3;
/** faces turned further than this from the shot get no paint (cos of the angle) */
const FACING = 0.15;

export class Fx {
  private decals: THREE.Mesh[] = [];
  private nextDecal = 0;
  private textures: THREE.CanvasTexture[] = [];
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  private tmp = new THREE.Vector3();
  private plane = new THREE.PlaneGeometry(1, 1);
  private aim = new THREE.Object3D();
  private inv = new THREE.Matrix4();
  private box = new THREE.Box3();
  private reach = new THREE.Sphere();

  private points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private vel = new Float32Array(PARTICLES * 3);
  private life = new Float32Array(PARTICLES);
  private nextP = 0;
  private color = new THREE.Color();

  constructor(private scene: THREE.Scene) {
    for (let i = 0; i < VARIANTS; i++) this.textures.push(splatTexture());
    for (let i = 0; i < DECALS; i++) {
      const m = new THREE.Mesh(this.plane);
      m.visible = false;
      m.receiveShadow = true;
      scene.add(m);
      this.decals.push(m);
    }

    this.pos = new Float32Array(PARTICLES * 3).fill(-999);
    this.col = new Float32Array(PARTICLES * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.05, vertexColors: true, sizeAttenuation: true }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  /** wipe every splat (the field changed): call before the old field is disposed, as some hang off its bunkers */
  clear(): void {
    for (const m of this.decals) this.reset(m);
    this.pos.fill(-999);
    this.life.fill(0);
  }

  /**
   * Stick a splat on a surface at (x,y,z) facing along the normal. `on` is the bunker that was hit
   * (its model, from World.bunker), or nothing for the ground.
   */
  splat(x: number, y: number, z: number, nx: number, ny: number, nz: number, color: number, on?: THREE.Object3D | null): void {
    const m = this.decals[this.nextDecal];
    this.reset(m);
    m.material = this.material(color, Math.floor(Math.random() * VARIANTS));
    m.renderOrder = this.nextDecal; // newer splats draw over older ones
    this.nextDecal = (this.nextDecal + 1) % DECALS;
    const s = 0.2 + Math.random() * 0.22;
    const spin = Math.random() * Math.PI * 2;
    const wrapped = on ? this.wrap(on, x, y, z, nx, ny, nz, s, spin) : null;
    if (wrapped) {
      m.geometry = wrapped;
      on!.add(m);
    } else {
      m.position.set(x + nx * 0.004, y + ny * 0.004, z + nz * 0.004);
      m.lookAt(this.tmp.set(x + nx, y + ny, z + nz)); // a plane faces +z, lookAt points +z at the target
      m.rotateZ(spin);
      m.scale.set(s, s, 1);
    }
    m.visible = true;
  }

  /** a pooled splat back to an unused flat square in the scene */
  private reset(m: THREE.Mesh): void {
    if (m.geometry !== this.plane) {
      m.geometry.dispose();
      m.geometry = this.plane;
    }
    if (m.parent !== this.scene) this.scene.add(m);
    m.position.set(0, 0, 0);
    m.quaternion.identity();
    m.scale.set(1, 1, 1);
    m.visible = false;
  }

  /**
   * The splat cut out of bunker `on`'s surface: a box `size` across and DECAL_DEPTH deep, centred on
   * the hit and pointing along the normal, turned by `spin`. Worked out with the bunker at rest (the
   * paint hit its resting shape, shared/field.ts) and returned in its own coordinates, so it sits
   * right whatever the wobble is doing. Null if it missed the model (a gap between the model and the
   * shape the paint hits): the caller falls back to a flat splat.
   */
  private wrap(on: THREE.Object3D, x: number, y: number, z: number, nx: number, ny: number, nz: number, size: number, spin: number): THREE.BufferGeometry | null {
    // straighten a wobbling bunker for a moment
    const q = on.quaternion.clone();
    const sc = on.scale.clone();
    on.quaternion.identity();
    on.scale.set(1, 1, 1);
    on.updateMatrixWorld(true);
    const at = this.tmp.set(x, y, z);
    this.aim.position.copy(at);
    this.aim.lookAt(at.x + nx, at.y + ny, at.z + nz);
    this.aim.rotateZ(spin);
    const dims = new THREE.Vector3(size, size, DECAL_DEPTH);
    this.reach.set(at, size);
    const parts: THREE.BufferGeometry[] = [];
    on.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || this.decals.includes(mesh) || !mesh.geometry.attributes.normal) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      this.box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
      if (!this.box.intersectsSphere(this.reach)) return;
      const g = facing(new DecalGeometry(mesh, at, this.aim.rotation, dims), nx, ny, nz);
      if (g) parts.push(g);
    });
    // back into its own coordinates, then the wobble back as it was
    this.inv.copy(on.matrixWorld).invert();
    on.quaternion.copy(q);
    on.scale.copy(sc);
    on.updateMatrixWorld(true);
    if (!parts.length) return null;
    const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts);
    if (parts.length > 1) for (const p of parts) p.dispose();
    if (!geo) return null;
    geo.applyMatrix4(this.inv);
    return geo;
  }

  burst(x: number, y: number, z: number, nx: number, ny: number, nz: number, color: number, count = 12): void {
    this.color.setHex(color);
    for (let k = 0; k < count; k++) {
      const i = this.nextP;
      this.nextP = (this.nextP + 1) % PARTICLES;
      const sp = 1.5 + Math.random() * 3;
      this.pos.set([x, y, z], i * 3);
      this.vel.set(
        [(nx + (Math.random() - 0.5) * 1.6) * sp, (ny + Math.random() * 0.8) * sp, (nz + (Math.random() - 0.5) * 1.6) * sp],
        i * 3,
      );
      this.col.set([this.color.r, this.color.g, this.color.b], i * 3);
      this.life[i] = 0.25 + Math.random() * 0.3;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      if (this.life[i] <= 0) {
        this.pos[j + 1] = -999;
        continue;
      }
      this.vel[j + 1] -= 9.8 * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] = Math.max(0.01, this.pos[j + 1] + this.vel[j + 1] * dt);
      this.pos[j + 2] += this.vel[j + 2] * dt;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }

  private material(color: number, variant: number): THREE.MeshStandardMaterial {
    const key = `${color}:${variant}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        map: this.textures[variant], color, transparent: true, depthWrite: false, roughness: 0.3,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
      this.mats.set(key, m);
    }
    return m;
  }
}

/**
 * Keep only the triangles of a projected splat that face the shot (normal (nx, ny, nz)), so the box
 * reaching through a thin wall doesn't paint its far side. Null if none are left.
 */
function facing(g: THREE.BufferGeometry, nx: number, ny: number, nz: number): THREE.BufferGeometry | null {
  // nothing in the box: DecalGeometry leaves the attributes off
  if (!g.attributes.position || !g.attributes.normal || !g.attributes.uv) {
    g.dispose();
    return null;
  }
  const pos = g.attributes.position.array as Float32Array;
  const nor = g.attributes.normal.array as Float32Array;
  const uv = g.attributes.uv.array as Float32Array;
  const keep: number[] = [];
  for (let t = 0; t < pos.length / 9; t++) {
    let d = 0;
    for (let k = 0; k < 3; k++) {
      const i = (t * 3 + k) * 3;
      d += nor[i] * nx + nor[i + 1] * ny + nor[i + 2] * nz;
    }
    if (d / 3 > FACING) keep.push(t);
  }
  if (keep.length === pos.length / 9) return keep.length ? g : (g.dispose(), null);
  g.dispose();
  if (!keep.length) return null;
  const p = new Float32Array(keep.length * 9);
  const n = new Float32Array(keep.length * 9);
  const u = new Float32Array(keep.length * 6);
  keep.forEach((t, j) => {
    p.set(pos.subarray(t * 9, t * 9 + 9), j * 9);
    n.set(nor.subarray(t * 9, t * 9 + 9), j * 9);
    u.set(uv.subarray(t * 6, t * 6 + 6), j * 6);
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(p, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(u, 2));
  return out;
}

/** a white splat shape on transparent; the material tints it with the paint colour */
function splatTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = g.strokeStyle = '#fff';
  g.lineCap = 'round';
  const blob = (x: number, y: number, r: number) => {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  blob(64, 64, 22 + Math.random() * 8);
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2;
    const len = 26 + Math.random() * 30;
    g.lineWidth = 3 + Math.random() * 6;
    g.beginPath();
    g.moveTo(64, 64);
    g.lineTo(64 + Math.cos(a) * len, 64 + Math.sin(a) * len);
    g.stroke();
    blob(64 + Math.cos(a) * len, 64 + Math.sin(a) * len, 2 + Math.random() * 4);
  }
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 30 + Math.random() * 30;
    blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 1.5 + Math.random() * 3.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
