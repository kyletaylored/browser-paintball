// The player characters. They all share one rig and its animations (scripts/player-rig.ts). Most
// wear their own helmet and build on the built-in figure (public/models/player.glb, made by
// art/player.py: the "head_<id>" and "torso_<id>" meshes), with thicker or slimmer limbs; one with a
// `model` has a whole body of its own instead (public/models/<model>.glb, made from a generated model
// by scripts/character-assets.ts). Each has its accent colour (pads, boot tops, goggle lens).
// Look only: every character has the same hitbox, speed and marker.

export interface Character {
  id: string;
  name: string;
  /** the accent colour: pads, boot tops, goggle lens */
  accent: number;
  /** how thick the arms and legs are (1: as modelled; the built-in figure only) */
  limbs: number;
  /** its own body: public/models/<model>.glb (otherwise it's the built-in figure) */
  model?: string;
}

export const CHARACTERS: readonly Character[] = [
  { id: 'rookie', name: 'Rookie', accent: 0xb45cff, limbs: 0.92 },
  { id: 'bruiser', name: 'Bruiser', accent: 0xffc21f, limbs: 1.2 },
  { id: 'sniper', name: 'Sniper', accent: 0xf0509a, limbs: 1, model: 'sniper' },
];

export const characterById = (id: string | undefined): Character => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];

/** a character for player `id` when they haven't picked one: spread round the list */
export const characterFor = (id: number): Character => CHARACTERS[((id % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length];
