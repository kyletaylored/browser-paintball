// Paint splats (decals stuck to surfaces) and little bursts of paint droplets.
// Both use fixed-size pools so nothing is allocated mid-game.

import * as THREE from 'three';

const DECALS = 500;
const PARTICLES = 900;
const VARIANTS = 4;

export class Fx {
  private decals: THREE.Mesh[] = [];
  private nextDecal = 0;
  private textures: THREE.CanvasTexture[] = [];
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  private tmp = new THREE.Vector3();

  private points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private vel = new Float32Array(PARTICLES * 3);
  private life = new Float32Array(PARTICLES);
  private nextP = 0;
  private color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < VARIANTS; i++) this.textures.push(splatTexture());
    const geo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < DECALS; i++) {
      const m = new THREE.Mesh(geo);
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

  /** wipe every splat (the field changed) */
  clear(): void {
    for (const m of this.decals) m.visible = false;
    this.pos.fill(-999);
    this.life.fill(0);
  }

  /** stick a splat on a surface at (x,y,z) facing along the normal */
  splat(x: number, y: number, z: number, nx: number, ny: number, nz: number, color: number): void {
    const m = this.decals[this.nextDecal];
    m.material = this.material(color, Math.floor(Math.random() * VARIANTS));
    m.renderOrder = this.nextDecal; // newer splats draw over older ones
    this.nextDecal = (this.nextDecal + 1) % DECALS;
    m.position.set(x + nx * 0.004, y + ny * 0.004, z + nz * 0.004);
    m.lookAt(this.tmp.set(x + nx, y + ny, z + nz)); // a plane faces +z, lookAt points +z at the target
    m.rotateZ(Math.random() * Math.PI * 2);
    const s = 0.2 + Math.random() * 0.22;
    m.scale.set(s, s, 1);
    m.visible = true;
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
