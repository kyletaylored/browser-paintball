// Loads the game's models (public/models/*.glb, built by `npm run assets`). They're meshopt-compressed,
// so GLTFLoader needs three's MeshoptDecoder. If anything fails to load, the game falls back to
// the shapes it draws from code, so a missing file never stops you playing.

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { toonify } from './toon';

export interface Models {
  /** bunker templates by node name; look them up with bunkerModel() */
  bunkers: Map<string, THREE.Object3D>;
  /** first-person marker (origin at the trigger, barrel along -Z) */
  marker: THREE.Object3D;
  /** the player figure and its animation clips */
  player: { scene: THREE.Object3D; clips: THREE.AnimationClip[] };
  /**
   * the first-person pump marker for pump mode (made in Blender: art/pump-marker.py), with its
   * "pump" animation; null if it didn't load (then pump mode uses the usual marker)
   */
  pumpMarker: { scene: THREE.Object3D; clips: THREE.AnimationClip[] } | null;
}

const FILES = ['bunkers', 'marker', 'player'] as const;

export async function loadModels(onProgress: (fraction: number) => void): Promise<Models | null> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const base = `${import.meta.env.BASE_URL}models/`;
  const loaded = new Map<string, number>();
  const total = new Map<string, number>();
  // once we've given up (one file failed) or finished, late progress from the other downloads is ignored
  let settled = false;
  const report = () => {
    if (settled) return;
    let l = 0;
    let t = 0;
    for (const f of FILES) {
      l += loaded.get(f) ?? 0;
      t += total.get(f) ?? 0;
    }
    onProgress(t ? Math.min(1, l / t) : 0);
  };
  try {
    const [bunkers, marker, player] = await Promise.all(
      FILES.map(
        (f) =>
          new Promise<GLTF>((resolve, reject) =>
            loader.load(
              `${base}${f}.glb`,
              resolve,
              (e) => {
                loaded.set(f, e.loaded);
                if (e.total) total.set(f, e.total);
                report();
              },
              reject,
            ),
          ),
      ),
    );
    settled = true;
    onProgress(1);
    for (const g of [bunkers, marker, player]) {
      g.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
      });
      toonify(g.scene); // the arcade look: every copy shares the converted materials
    }
    const byKey = new Map<string, THREE.Object3D>();
    bunkers.scene.traverse((o) => {
      if (o.name.startsWith('bunker')) byKey.set(o.name, o);
    });
    const markerNode = marker.scene.getObjectByName('marker');
    if (!markerNode) throw new Error('marker.glb has no "marker" node');
    // optional: a missing pump marker only means pump mode looks like the others
    const pump = await new Promise<GLTF | null>((resolve) => loader.load(`${base}pump-marker.glb`, resolve, undefined, () => resolve(null)));
    if (pump) toonify(pump.scene);
    const pumpNode = pump?.scene.getObjectByName('marker') ?? null;
    if (pump && !pumpNode) console.warn('pump-marker.glb has no "marker" node: using the usual marker for pump mode');
    return {
      bunkers: byKey, marker: markerNode, player: { scene: player.scene, clips: player.animations },
      pumpMarker: pump && pumpNode ? { scene: pumpNode, clips: pump.animations } : null,
    };
  } catch (e) {
    settled = true;
    console.warn('Could not load models, using built-in shapes instead:', e);
    return null;
  }
}

/** the model for a bunkerKey(), if bunkers.glb has one */
export function bunkerModel(models: Models, key: string): THREE.Object3D | undefined {
  // GLTFLoader strips characters like ':' and '.' from node names, so look up the cleaned-up name
  return models.bunkers.get(THREE.PropertyBinding.sanitizeNodeName(`bunker:${key}`));
}

/** give every material named "team" in this object its own copy in the team colour */
export function paintTeam(root: THREE.Object3D, color: number): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map((m) => {
      if (m.name !== 'team') return m;
      const c = (m as THREE.MeshStandardMaterial).clone();
      c.color.setHex(color);
      if (m.userData.teamCopy) m.dispose(); // replacing a copy we made earlier
      c.userData.teamCopy = true;
      return c;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
  });
}
