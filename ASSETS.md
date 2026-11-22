# Assets

Every 3D model in this game is original and made in this repository: by `scripts/build-assets.ts` in code, or from a
source in `art/` in Blender (docs/BLENDER.md). There are no downloaded or third-party models, textures or sounds.

| file | what | made by |
|---|---|---|
| `public/models/bunkers.glb` | every inflatable bunker on every field, one per shape and colour | `art/bunkers.py`, built in Blender from the field data |
| `public/models/marker.glb` | the first-person marker | `scripts/build-assets.ts` |
| `public/models/player.glb` | the player figure, with idle / run / crouch / crouchMove / shoot / out / outWalk animations | `scripts/build-assets.ts` |
| `public/models/pump-marker.glb` | the first-person pump marker for pump mode, with a "pump" animation | `art/pump-marker.py`, built in Blender |
| sound effects | synthesised at runtime | `src/audio.ts` |
| turf texture, paint splats | drawn at runtime on a canvas | `src/world.ts`, `src/fx.ts` |

Rebuild the code-made models with `npm run assets`. `npm run check:assets` (run in CI) fails if the committed files
don't match the script. Export the Blender-made ones with `npm run assets:blender`; `npm run check:models` (run in CI)
checks the committed files against the rules in `art/models.json`.

If you add third-party assets, list each one here with its source, author and license, and only use licenses that allow
redistribution (for example CC0 or CC-BY with credit).
