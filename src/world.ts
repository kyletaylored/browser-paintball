// Sky, lights, turf, netting and bunkers. Everything is built from code so the starter has no
// asset files. To use real models, export GLB from Blender and load it with GLTFLoader (see README).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BUNKERS, FIELD_LENGTH, FIELD_WIDTH, HALF_L, HALF_W, NET_MARGIN, bunkerKey } from '../shared/field';
import { bunkerModel, type Models } from './models';
import { TEAM_COLORS } from '../shared/protocol';

const SKY = 0x8cc2f2;

export function buildWorld(scene: THREE.Scene, models: Models | null): void {
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 70, 190);

  scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x56703f, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
  sun.position.set(18, 32, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 24, bottom: -24, near: 1, far: 90 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);

  // grass beyond the nets
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x4f7334, roughness: 1 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.02;
  outer.receiveShadow = true;
  scene.add(outer);

  // turf inside the nets
  const turfW = FIELD_LENGTH + NET_MARGIN * 2;
  const turfD = FIELD_WIDTH + NET_MARGIN * 2;
  const turf = new THREE.Mesh(
    new THREE.PlaneGeometry(turfW, turfD),
    new THREE.MeshStandardMaterial({ map: turfTexture(turfW, turfD), roughness: 0.95 }),
  );
  turf.rotation.x = -Math.PI / 2;
  turf.receiveShadow = true;
  scene.add(turf);

  buildNets(scene);

  for (const b of BUNKERS) {
    const template = models ? bunkerModel(models, bunkerKey(b)) : undefined;
    if (template) {
      const g = template.clone(true);
      g.position.set(b.x, 0, b.z);
      scene.add(g);
      continue;
    }
    // no model for this one: draw it from code
    const mat = new THREE.MeshPhysicalMaterial({ color: b.color, roughness: 0.5, clearcoat: 0.6, clearcoatRoughness: 0.35 });
    const band = new THREE.MeshStandardMaterial({ color: 0x23202a, roughness: 0.7 });
    const g = new THREE.Group();
    if (b.kind === 'box') {
      const body = new THREE.Mesh(new RoundedBoxGeometry(b.w, b.h, b.d, 4, Math.min(0.18, b.h / 4)), mat);
      body.position.y = b.h / 2;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.012, 0.12, b.d + 0.012), band);
      stripe.position.y = b.h * 0.55;
      g.add(body, stripe);
    } else {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(b.r * 0.94, b.r, b.h, 32), mat);
      body.position.y = b.h / 2;
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(b.r * 0.985, b.r * 0.985, 0.12, 32), band);
      stripe.position.y = b.h * 0.55;
      g.add(body, stripe);
    }
    g.position.set(b.x, 0, b.z);
    g.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    scene.add(g);
  }
}

function turfTexture(w: number, d: number): THREE.CanvasTexture {
  const ppm = 24; // pixels per metre
  const c = document.createElement('canvas');
  c.width = Math.round(w * ppm);
  c.height = Math.round(d * ppm);
  const g = c.getContext('2d')!;
  const X = (x: number) => (x + w / 2) * ppm;
  const Z = (z: number) => (z + d / 2) * ppm;

  for (let i = 0; i * 3 < w; i++) {
    g.fillStyle = i % 2 ? '#3f8a3a' : '#46953f';
    g.fillRect(i * 3 * ppm, 0, 3 * ppm + 1, c.height);
  }
  // a little noise so it doesn't look like plastic
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)';
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 2);
  }
  // start boxes in team colours
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  for (const [team, x0] of [[0, -HALF_L], [1, HALF_L - 3]] as const) {
    g.fillStyle = hex(TEAM_COLORS[team]) + '55';
    g.fillRect(X(x0), Z(-7), 3 * ppm, 14 * ppm);
  }
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 0.12 * ppm;
  g.strokeRect(X(-HALF_L), Z(-HALF_W), FIELD_LENGTH * ppm, FIELD_WIDTH * ppm);
  g.beginPath();
  g.moveTo(X(0), Z(-HALF_W));
  g.lineTo(X(0), Z(HALF_W));
  g.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function buildNets(scene: THREE.Scene): void {
  const H = 4;
  const lx = HALF_L + NET_MARGIN;
  const lz = HALF_W + NET_MARGIN;
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
    scene.add(m);
    const n = Math.round(len / 6);
    for (let i = 0; i <= n; i++) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, H, 8), pole);
      const off = -len / 2 + (i * len) / n;
      p.position.set(rot ? x : off, H / 2, rot ? off : z);
      p.castShadow = true;
      scene.add(p);
    }
  }
}
