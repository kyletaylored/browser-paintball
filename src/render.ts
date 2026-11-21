import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from 'postprocessing';

/**
 * Add ?low to the URL to turn off shadows, bloom and anti-aliasing (for weak laptops / no GPU).
 * Phones and tablets start low (add ?high to override): a big screen to fill on a phone's GPU and
 * battery.
 */
const params = new URLSearchParams(location.search);
const TOUCH_DEVICE = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
export const QUALITY_KEY = 'splat-arena.quality';
export type Quality = 'auto' | 'low' | 'high';
export function savedQuality(): Quality {
  try {
    const q = localStorage.getItem(QUALITY_KEY);
    return q === 'low' || q === 'high' ? q : 'auto';
  } catch {
    return 'auto';
  }
}
const chosen = params.has('low') ? 'low' : params.has('high') ? 'high' : savedQuality();
export const LOW_QUALITY = chosen === 'low' || (chosen === 'auto' && TOUCH_DEVICE);

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  // postprocessing recommends turning these off on the renderer: the composer has its own buffers and does AA itself.
  const renderer = new THREE.WebGLRenderer({ canvas, powerPreference: 'high-performance', antialias: false, stencil: false, depth: false });
  // phone screens are dense enough that 1.25 still looks sharp, and it's far cheaper than their native 3
  renderer.setPixelRatio(LOW_QUALITY ? (TOUCH_DEVICE ? Math.min(window.devicePixelRatio, 1.25) : 1) : Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = !LOW_QUALITY;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}

/** pmndrs/postprocessing: effects in one EffectPass get merged into one shader. */
export function createComposer(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
  composer.addPass(new RenderPass(scene, camera));
  if (LOW_QUALITY) composer.addPass(new EffectPass(camera, new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL })));
  else composer.addPass(
    new EffectPass(
      camera,
      new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.8, intensity: 0.6 }),
      new VignetteEffect({ darkness: 0.42, offset: 0.32 }),
      // NEUTRAL keeps bright paint/bunker colours saturated; try AGX or ACES_FILMIC for a more filmic look
      new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }),
    ),
  );
  if (!LOW_QUALITY) composer.addPass(new EffectPass(camera, new SMAAEffect()));

  const resize = () => {
    // a minimised or hidden window can report 0×0; keep the last good size instead of a NaN aspect
    if (!window.innerWidth || !window.innerHeight) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    composer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);
  resize();
  return composer;
}
