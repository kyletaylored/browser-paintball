// The star burst on the moon (theme.outFx 'stars'): wherever someone is eliminated, a big star pops up
// over them, spins and shrinks away, and a ring of little stars flies out of it. Sprites from a fixed
// pool, so nothing is allocated mid-game. Look only: the server decides who's out.

import * as THREE from 'three';

const BURSTS = 8;
const SPARKS = 10;
const LIFE = 1.3;

interface Burst {
  big: THREE.Sprite;
  sparks: THREE.Sprite[];
  /** each spark's direction out (x, y, z) */
  dirs: THREE.Vector3[];
  at: THREE.Vector3;
  age: number;
}

export class StarBursts {
  private bursts: Burst[] = [];
  private next = 0;

  constructor(scene: THREE.Scene) {
    const tex = starTexture();
    for (let i = 0; i < BURSTS; i++) {
      const mat = () => new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const big = new THREE.Sprite(mat());
      big.visible = false;
      scene.add(big);
      const sparks: THREE.Sprite[] = [];
      const dirs: THREE.Vector3[] = [];
      for (let k = 0; k < SPARKS; k++) {
        const s = new THREE.Sprite(mat());
        s.visible = false;
        scene.add(s);
        sparks.push(s);
        dirs.push(new THREE.Vector3());
      }
      this.bursts.push({ big, sparks, dirs, at: new THREE.Vector3(), age: LIFE });
    }
  }

  /** pop a burst over (x, y, z), the eliminated player's feet, in their team's colour */
  pop(x: number, y: number, z: number, color: number): void {
    const b = this.bursts[this.next];
    this.next = (this.next + 1) % BURSTS;
    b.at.set(x, y + 2.1, z); // just over their head
    b.age = 0;
    const gold = new THREE.Color(0xffe27a);
    (b.big.material as THREE.SpriteMaterial).color.copy(gold);
    b.big.visible = true;
    b.sparks.forEach((s, k) => {
      const a = (k / SPARKS) * Math.PI * 2 + Math.random() * 0.4;
      // out round the middle, tipped up a little
      b.dirs[k].set(Math.cos(a), 0.35 + Math.random() * 0.5, Math.sin(a)).normalize().multiplyScalar(2.2 + Math.random() * 1.4);
      (s.material as THREE.SpriteMaterial).color.setHex(k % 2 ? color : 0xffffff).lerp(gold, 0.25);
      s.visible = true;
    });
  }

  /** wipe every burst (the field changed) */
  clear(): void {
    for (const b of this.bursts) this.hide(b);
  }

  update(dt: number): void {
    for (const b of this.bursts) {
      if (b.age >= LIFE) continue;
      b.age += dt;
      if (b.age >= LIFE) {
        this.hide(b);
        continue;
      }
      const t = b.age / LIFE;
      // the big star: pops past full size, settles, then shrinks and fades as it spins
      const pop = t < 0.15 ? (t / 0.15) * 1.25 : t < 0.3 ? 1.25 - ((t - 0.15) / 0.15) * 0.25 : 1 - ((t - 0.3) / 0.7) * 0.6;
      const m = b.big.material as THREE.SpriteMaterial;
      b.big.position.copy(b.at).y += t * 0.5;
      b.big.scale.setScalar(1.4 * pop);
      m.rotation = t * 5;
      m.opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      b.sparks.forEach((s, k) => {
        const d = b.dirs[k];
        // fly out fast, slowing down
        const out = 1 - (1 - t) * (1 - t);
        s.position.set(b.at.x + d.x * out * 0.9, b.at.y + d.y * out * 0.9 - t * t * 0.4, b.at.z + d.z * out * 0.9);
        s.scale.setScalar(0.35 * (1 - t * 0.7));
        const sm = s.material as THREE.SpriteMaterial;
        sm.rotation = -t * 7 + k;
        sm.opacity = 1 - t;
      });
    }
  }

  private hide(b: Burst): void {
    b.age = LIFE;
    b.big.visible = false;
    for (const s of b.sparks) s.visible = false;
  }
}

/** a five-pointed star with a soft glow round it, white so the material can tint it */
function starTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const glow = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  glow.addColorStop(0, 'rgba(255,255,255,0.55)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 128, 128);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 20 : 50;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
  }
  g.closePath();
  g.fillStyle = '#fff';
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
