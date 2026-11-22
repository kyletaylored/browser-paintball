// The arcade look: flat, banded (cel) shading on everything, and ink outlines round every shape.
//
// - toonify() swaps the standard (realistic) materials in a model or the field for toon ones in the
//   same colours, lit in three flat bands. It runs on the models when they load, on the field when
//   it's built, and on every player figure.
// - InkEffect draws the outlines after the scene is rendered, from the depth buffer: wherever the
//   distance to what's on screen jumps or bends (a silhouette, the edge where two faces meet), it
//   inks a line. One full-screen pass, whatever's in the scene, so code-made and Blender-made
//   things get the same lines.

import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';

/** the light bands: shadow, mid, lit (a tiny texture, sampled without blending between steps) */
function gradient(): THREE.DataTexture {
  const tones = [70, 150, 235, 255];
  const data = new Uint8Array(tones.length * 4);
  tones.forEach((t, i) => data.set([t, t, t, 255], i * 4));
  const tex = new THREE.DataTexture(data, tones.length, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
const GRADIENT = gradient();
const swapped = new WeakMap<THREE.Material, THREE.Material>();

function toToon(m: THREE.Material): THREE.Material {
  if (!(m instanceof THREE.MeshStandardMaterial) || m instanceof THREE.MeshPhysicalMaterial) return m;
  const hit = swapped.get(m);
  if (hit) return hit;
  const t = new THREE.MeshToonMaterial({
    name: m.name, color: m.color, map: m.map, gradientMap: GRADIENT,
    emissive: m.emissive, emissiveMap: m.emissiveMap, emissiveIntensity: m.emissiveIntensity,
    normalMap: m.normalMap, alphaMap: m.alphaMap, alphaTest: m.alphaTest,
    transparent: m.transparent, opacity: m.opacity, side: m.side, vertexColors: m.vertexColors,
    depthWrite: m.depthWrite, polygonOffset: m.polygonOffset, polygonOffsetFactor: m.polygonOffsetFactor, polygonOffsetUnits: m.polygonOffsetUnits,
  });
  t.userData = { ...m.userData };
  swapped.set(m, t);
  swapped.set(t, t);
  return t;
}

/** give everything under `root` the toon look (each material is converted once and then shared) */
export function toonify(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toToon) : toToon(mesh.material);
  });
}

const INK_SHADER = /* glsl */ `
uniform float thickness;
uniform float threshold;
uniform vec3 ink;

// 1 / distance: straight lines on screen for any flat surface, so a flat face (the ground at a
// grazing angle, a wall) has no second difference, and only edges and creases show up
float inv(const in vec2 uv) {
  return 1.0 / max(-getViewZ(readDepth(uv)), 0.001);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec2 t = texelSize * thickness;
  float c = 1.0 / max(-getViewZ(depth), 0.001);
  float dx = abs(inv(uv - vec2(t.x, 0.0)) + inv(uv + vec2(t.x, 0.0)) - 2.0 * c);
  float dy = abs(inv(uv - vec2(0.0, t.y)) + inv(uv + vec2(0.0, t.y)) - 2.0 * c);
  float edge = max(dx, dy) / c;
  // the sky (nothing drawn) gets no line; lines fade out in the distance so far fields don't go grey
  float dist = 1.0 / c;
  float e = smoothstep(threshold, threshold * 2.5, edge) * (1.0 - smoothstep(70.0, 160.0, dist)) * step(depth, 0.9999);
  outputColor = vec4(mix(inputColor.rgb, ink, e), inputColor.a);
}
`;

/** ink outlines from the depth buffer (see the top of this file) */
export class InkEffect extends Effect {
  /** line width in pixels at 720 lines tall; it grows with the screen, so lines look as bold on a big one */
  private base: number;

  constructor({ thickness = 1.6, threshold = 0.035, color = 0x0b0a10 } = {}) {
    super('InkEffect', INK_SHADER, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['thickness', new THREE.Uniform(thickness)],
        ['threshold', new THREE.Uniform(threshold)],
        ['ink', new THREE.Uniform(new THREE.Color(color))],
      ]),
    });
    this.base = thickness;
  }

  override setSize(_width: number, height: number): void {
    this.uniforms.get('thickness')!.value = this.base * Math.max(1, height / 720);
  }
}
