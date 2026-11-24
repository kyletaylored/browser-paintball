// The player characters. They all share one rig and its animations (public/models/player.glb, built
// by art/player.py); each wears its own helmet and build (the "head_<id>" and "torso_<id>" meshes),
// its own accent colour on the pads, boot tops and goggle lens, and thicker or slimmer limbs.
// Look only: every character has the same hitbox, speed and marker.

export interface Character {
  id: string;
  name: string;
  /** the accent colour: pads, boot tops, goggle lens */
  accent: number;
  /** how thick the arms and legs are (1: as modelled) */
  limbs: number;
}

export const CHARACTERS: readonly Character[] = [
  { id: 'rookie', name: 'Rookie', accent: 0xb45cff, limbs: 0.92 },
  { id: 'bruiser', name: 'Bruiser', accent: 0xff8a1f, limbs: 1.2 },
];

export const characterById = (id: string | undefined): Character => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];

/** a character for player `id` when they haven't picked one: spread round the list */
export const characterFor = (id: number): Character => CHARACTERS[((id % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length];
