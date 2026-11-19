// A simple player figure built from primitives. Swap this for a rigged GLB character
// (GLTFLoader + AnimationMixer) when you have one; keep the same set() interface.

import * as THREE from 'three';
import { STAND_HEIGHT } from '../shared/sim';

export class Avatar {
  readonly root = new THREE.Group();
  private head = new THREE.Group();
  private mats: THREE.MeshStandardMaterial[] = [];
  private alive = true;

  constructor(color: number) {
    const suit = this.mat({ color, roughness: 0.8 });
    const dark = this.mat({ color: 0x1b1b22, roughness: 0.35, metalness: 0.2 });
    const lens = this.mat({ color: 0x0b0d12, roughness: 0.1, metalness: 0.6 });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.85, 6, 14), suit);
    body.position.y = 0.72;

    this.head.position.y = 1.56;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 14), dark);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.1, 0.08), lens);
    visor.position.set(0, 0.02, -0.13);
    this.head.add(skull, visor);

    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.45), dark);
    gun.position.set(0.17, 1.18, -0.3);
    const hopper = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 10), suit);
    hopper.position.set(0.17, 1.3, -0.24);

    this.root.add(body, this.head, gun, hopper);
    this.root.traverse((o) => (o.castShadow = true));
  }

  set(x: number, y: number, z: number, yaw: number, pitch: number, height: number, alive: boolean): void {
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;
    this.root.scale.y = height / STAND_HEIGHT;
    this.head.rotation.x = pitch * 0.6;
    if (alive !== this.alive) {
      this.alive = alive;
      // eliminated players turn see-through until they respawn
      for (const m of this.mats) {
        m.transparent = !alive;
        m.opacity = alive ? 1 : 0.35;
        m.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.mats) m.dispose();
  }

  private mat(p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial(p);
    this.mats.push(m);
    return m;
  }
}
