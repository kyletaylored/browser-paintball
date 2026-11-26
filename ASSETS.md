# Assets

Every 3D model in this game is original and made for it: by `scripts/build-assets.ts` in code, from a source in
`art/` in Blender (docs/BLENDER.md), or, for some characters, generated from the project's own concept drawings with an
image-to-3D tool (Tripo) and turned into a game figure by `scripts/character-assets.ts`. There are no downloaded or
third-party models, textures or sounds.

| file | what | made by |
|---|---|---|
| `public/models/bunkers.glb` | every inflatable bunker on every field, one per shape and colour | `art/bunkers.py`, built in Blender from the field data |
| `public/models/marker.glb` | the first-person marker | `scripts/build-assets.ts` |
| `public/models/player.glb` | the player figure, with idle / run / crouch / crouchMove / shoot / out / outWalk animations | `art/player.py`, built in Blender round the joints in `scripts/player-rig.ts`, which also adds the animations |
| `public/models/sniper.glb` | the sniper character: its own body on the player rig, with the same animations | `art/characters/sniper.glb` (generated with Tripo from `art/characters/concept/3-sniper-*.png`), recipe `art/characters/sniper.json`, built by `npm run assets:characters`, which colours it from the drawings |
| `art/characters/concept/*.png` | concept drawings of the six characters, front and back | the project's own art, cut out of one character sheet |
| `public/models/pump-marker.glb` | the first-person pump marker for pump mode, with a "pump" animation | `art/pump-marker.py`, built in Blender |
| sound effects | synthesised at runtime | `src/audio.ts` |
| turf texture, paint splats | drawn at runtime on a canvas | `src/world.ts`, `src/fx.ts` |

Rebuild the code-made model (the first-person marker) with `npm run assets`. `npm run check:assets` (run in CI) fails if the committed files
don't match the script. Export the Blender-made ones with `npm run assets:blender`; `npm run check:models` (run in CI)
checks the committed files against the rules in `art/models.json`. Rebuild the generated characters with
`npm run assets:characters` (after `npm run assets:blender -- player` if the rig or its animations changed).

If you add third-party assets, list each one here with its source, author and license, and only use licenses that allow
redistribution (for example CC0 or CC-BY with credit).
