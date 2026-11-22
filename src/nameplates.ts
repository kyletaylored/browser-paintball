// Names floating over other players' heads. Plain DOM labels positioned by projecting each head
// into screen space, hidden when a bunker is in the way (an analytic ray test against the field,
// the same one paintballs use) or when the player is far away.

import * as THREE from 'three';
import { traceWorld } from '../shared/sim';
import { TEAM_COLORS, type Team } from '../shared/protocol';

export interface PlateTarget {
  id: number;
  name: string;
  team: Team;
  /** talking on voice chat right now */
  speaking?: boolean;
  /** world position of the top of the head */
  x: number;
  y: number;
  z: number;
  alive: boolean;
}

const MAX_DISTANCE = 45;
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export class Nameplates {
  private plates = new Map<number, HTMLDivElement>();
  private v = new THREE.Vector3();

  constructor(private root: HTMLElement) {}

  update(camera: THREE.PerspectiveCamera, targets: PlateTarget[]): void {
    const seen = new Set<number>();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cam = camera.position;
    for (const t of targets) {
      seen.add(t.id);
      let el = this.plates.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'plate';
        this.root.appendChild(el);
        this.plates.set(t.id, el);
      }
      if (el.textContent !== t.name) el.textContent = t.name; // textContent: names are never parsed as HTML
      el.classList.toggle('speaking', !!t.speaking);
      el.style.color = hex(TEAM_COLORS[t.team]);

      const dist = Math.hypot(t.x - cam.x, t.y - cam.y, t.z - cam.z);
      this.v.set(t.x, t.y, t.z).project(camera);
      const onScreen = this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1;
      const visible = t.alive && onScreen && dist < MAX_DISTANCE && !traceWorld(cam.x, cam.y, cam.z, t.x, t.y, t.z);
      el.hidden = !visible;
      if (!visible) continue;
      const sx = (this.v.x * 0.5 + 0.5) * w;
      const sy = (-this.v.y * 0.5 + 0.5) * h;
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
      el.style.opacity = String(Math.max(0.35, 1 - dist / MAX_DISTANCE));
    }
    for (const [id, el] of this.plates) {
      if (seen.has(id)) continue;
      el.remove();
      this.plates.delete(id);
    }
  }
}
