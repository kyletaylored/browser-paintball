// The burst over an eliminated player on the themed fields (theme.outFx): a big shape pops up over
// them, spins and shrinks away, and a ring of little ones flies out of it. Stars on the moon, and on
// the holiday fields bats, snowflakes, autumn leaves, fireworks or firecracker sparks. Sprites from a
// fixed pool, so nothing is allocated mid-game. Look only: the server decides who's out.

import * as THREE from 'three';
import type { OutFx } from '../shared/maps';

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

/** how one kind of burst looks */
interface Style {
  big: THREE.Texture;
  spark: THREE.Texture;
  /** the big one's colour, and each spark's (k is its number, team the team colour) */
  bigColor: (team: number) => number;
  sparkColor: (k: number, team: number) => number;
  /** glowing (added on top) or solid (bats and leaves are dark or opaque) */
  additive: boolean;
  /** how much the sparks drop as they go (leaves drift down, bats fly up) */
  fall: number;
  bigSize: number;
  sparkSize: number;
}

const GOLD = 0xffe27a;

export class StarBursts {
  private bursts: Burst[] = [];
  private next = 0;
  private styles = new Map<OutFx, Style>();
  private style: Style;

  constructor(scene: THREE.Scene) {
    this.style = this.styleFor('stars');
    for (let i = 0; i < BURSTS; i++) {
      const mat = () => new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: false });
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
    this.apply();
  }

  /** which kind of burst this field uses */
  setStyle(kind: OutFx): void {
    this.clear();
    this.style = this.styleFor(kind);
    this.apply();
  }

  /** pop a burst over (x, y, z), the eliminated player's feet, in their team's colour */
  pop(x: number, y: number, z: number, color: number): void {
    const b = this.bursts[this.next];
    this.next = (this.next + 1) % BURSTS;
    b.at.set(x, y + 2.1, z); // just over their head
    b.age = 0;
    const st = this.style;
    (b.big.material as THREE.SpriteMaterial).color.setHex(st.bigColor(color));
    b.big.visible = true;
    b.sparks.forEach((s, k) => {
      const a = (k / SPARKS) * Math.PI * 2 + Math.random() * 0.4;
      // out round the middle, tipped up a little
      b.dirs[k].set(Math.cos(a), 0.35 + Math.random() * 0.5, Math.sin(a)).normalize().multiplyScalar(2.2 + Math.random() * 1.4);
      (s.material as THREE.SpriteMaterial).color.setHex(st.sparkColor(k, color));
      s.visible = true;
    });
  }

  /** wipe every burst (the field changed) */
  clear(): void {
    for (const b of this.bursts) this.hide(b);
  }

  update(dt: number): void {
    const st = this.style;
    for (const b of this.bursts) {
      if (b.age >= LIFE) continue;
      b.age += dt;
      if (b.age >= LIFE) {
        this.hide(b);
        continue;
      }
      const t = b.age / LIFE;
      // the big one: pops past full size, settles, then shrinks and fades as it spins
      const pop = t < 0.15 ? (t / 0.15) * 1.25 : t < 0.3 ? 1.25 - ((t - 0.15) / 0.15) * 0.25 : 1 - ((t - 0.3) / 0.7) * 0.6;
      const m = b.big.material as THREE.SpriteMaterial;
      b.big.position.copy(b.at).y += t * 0.5;
      b.big.scale.setScalar(st.bigSize * pop);
      m.rotation = t * 5;
      m.opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      b.sparks.forEach((s, k) => {
        const d = b.dirs[k];
        // fly out fast, slowing down
        const out = 1 - (1 - t) * (1 - t);
        s.position.set(b.at.x + d.x * out * 0.9, b.at.y + d.y * out * 0.9 - t * t * st.fall, b.at.z + d.z * out * 0.9);
        s.scale.setScalar(st.sparkSize * (1 - t * 0.7));
        const sm = s.material as THREE.SpriteMaterial;
        sm.rotation = -t * 7 + k;
        sm.opacity = 1 - t;
      });
    }
  }

  private apply(): void {
    const st = this.style;
    for (const b of this.bursts) {
      for (const s of [b.big, ...b.sparks]) {
        const m = s.material as THREE.SpriteMaterial;
        m.map = s === b.big ? st.big : st.spark;
        m.blending = st.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
        m.needsUpdate = true;
      }
    }
  }

  private styleFor(kind: OutFx): Style {
    let st = this.styles.get(kind);
    if (st) return st;
    const mix = (a: number, b: number, k: number) => new THREE.Color(a).lerp(new THREE.Color(b), k).getHex();
    switch (kind) {
      case 'bats': {
        const bat = shapeTexture(drawBat, false);
        st = { big: bat, spark: bat, bigColor: () => 0xa070f0, sparkColor: (k) => (k % 2 ? 0x8a5ae0 : 0x2a1838), additive: false, fall: -1.2, bigSize: 1.5, sparkSize: 0.45 };
        break;
      }
      case 'snowflakes': {
        const flake = shapeTexture(drawFlake, true);
        st = { big: flake, spark: flake, bigColor: () => 0xeaf6ff, sparkColor: (k) => (k % 2 ? 0xffffff : 0xbfe3ff), additive: true, fall: 0.3, bigSize: 1.5, sparkSize: 0.4 };
        break;
      }
      case 'leaves': {
        const leaf = shapeTexture(drawLeaf, false);
        const colors = [0xe0731f, 0xc8402a, 0xf0b42e, 0xb8602a];
        st = { big: leaf, spark: leaf, bigColor: () => 0xe0731f, sparkColor: (k) => colors[k % colors.length], additive: false, fall: 1.4, bigSize: 1.3, sparkSize: 0.42 };
        break;
      }
      case 'fireworks': {
        const ring = shapeTexture(drawBurstRing, true);
        const dot = shapeTexture(drawDot, true);
        const colors = [0xff4a4a, 0xffffff, 0x4a8cff];
        st = { big: ring, spark: dot, bigColor: () => colors[Math.floor(Math.random() * 3)], sparkColor: (k) => colors[k % 3], additive: true, fall: 0.9, bigSize: 1.9, sparkSize: 0.32 };
        break;
      }
      case 'firecrackers': {
        const burst = shapeTexture(drawBurstRing, true);
        const dot = shapeTexture(drawDot, true);
        st = { big: burst, spark: dot, bigColor: () => 0xffc04a, sparkColor: (k) => (k % 2 ? 0xff3a2a : 0xffd84a), additive: true, fall: 0.6, bigSize: 1.6, sparkSize: 0.3 };
        break;
      }
      default: {
        const star = shapeTexture(drawStar, true);
        st = { big: star, spark: star, bigColor: () => GOLD, sparkColor: (k, team) => mix(k % 2 ? team : 0xffffff, GOLD, 0.25), additive: true, fall: 0.4, bigSize: 1.4, sparkSize: 0.35 };
      }
    }
    this.styles.set(kind, st);
    return st;
  }

  private hide(b: Burst): void {
    b.age = LIFE;
    b.big.visible = false;
    for (const s of b.sparks) s.visible = false;
  }
}

// ---- shapes (white, so the material can tint them) ------------------------------------------------

function shapeTexture(draw: (g: CanvasRenderingContext2D) => void, glow: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  if (glow) {
    const halo = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    halo.addColorStop(0, 'rgba(255,255,255,0.5)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, 128, 128);
  }
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  draw(g);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function drawStar(g: CanvasRenderingContext2D): void {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 20 : 50;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
}

function drawBat(g: CanvasRenderingContext2D): void {
  // body and head, and two scalloped wings
  g.beginPath();
  g.ellipse(64, 66, 9, 14, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(58, 52);
  g.lineTo(56, 40);
  g.lineTo(62, 48);
  g.lineTo(66, 48);
  g.lineTo(72, 40);
  g.lineTo(70, 52);
  g.fill();
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(64, 58);
    g.quadraticCurveTo(64 + s * 30, 34, 64 + s * 60, 46);
    g.quadraticCurveTo(64 + s * 50, 56, 64 + s * 48, 72);
    g.quadraticCurveTo(64 + s * 40, 64, 64 + s * 32, 76);
    g.quadraticCurveTo(64 + s * 24, 66, 64 + s * 14, 78);
    g.closePath();
    g.fill();
  }
}

function drawFlake(g: CanvasRenderingContext2D): void {
  g.lineWidth = 6;
  g.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    g.beginPath();
    g.moveTo(64, 64);
    g.lineTo(64 + dx * 48, 64 + dy * 48);
    g.stroke();
    // little branches off each arm
    for (const k of [0.5, 0.75]) {
      const bx = 64 + dx * 48 * k;
      const by = 64 + dy * 48 * k;
      for (const s of [-1, 1]) {
        const b = a + s * 0.8;
        g.beginPath();
        g.moveTo(bx, by);
        g.lineTo(bx + Math.cos(b) * 13, by + Math.sin(b) * 13);
        g.stroke();
      }
    }
  }
}

function drawLeaf(g: CanvasRenderingContext2D): void {
  // a five-lobed autumn leaf with a stem
  g.beginPath();
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 10;
    const r = i % 2 ? 24 : 50;
    g.lineTo(64 + Math.cos(a) * r, 60 + Math.sin(a) * r * 0.9);
  }
  g.closePath();
  g.fill();
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(64, 70);
  g.lineTo(64, 118);
  g.stroke();
}

function drawBurstRing(g: CanvasRenderingContext2D): void {
  // rays out from the middle, each ending in a dot
  g.lineWidth = 4;
  g.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    g.beginPath();
    g.moveTo(64 + Math.cos(a) * 14, 64 + Math.sin(a) * 14);
    g.lineTo(64 + Math.cos(a) * 46, 64 + Math.sin(a) * 46);
    g.stroke();
    g.beginPath();
    g.arc(64 + Math.cos(a) * 52, 64 + Math.sin(a) * 52, 5, 0, Math.PI * 2);
    g.fill();
  }
}

function drawDot(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.arc(64, 64, 22, 0, Math.PI * 2);
  g.fill();
}
