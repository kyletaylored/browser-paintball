# Making models in Blender

Most of the game's models are built in code (`scripts/build-assets.ts`). Anything more detailed is easier to make in
Blender, and this pipeline gets it from Blender into the game in one command. The first model made this way is the pump
marker you hold in pump mode (`art/pump-marker.py` → `public/models/pump-marker.glb`).

```
art/
  models.json        every Blender-made model: its source, output file, and the rules it must meet
  pump-marker.py     a build script: makes the model in Blender with Python
  *.blend            hand-made sources go here too
scripts/
  blender/export.py  runs inside Blender: builds or opens a source and exports glTF
  blender/kit.py     helpers for build scripts (materials, boxes, cylinders, joining, keyframes)
  blender-assets.ts  npm run assets:blender: Blender headless → compress → check → public/models
  check-models.ts    npm run check:models (CI): checks the committed files, no Blender needed
  model-rules.ts     the checks both of them use
```

## Exporting

```
npm run assets:blender            # every model in art/models.json
npm run assets:blender -- pump    # just the ones whose name contains "pump"
```

For each model this runs Blender in the background (no window), builds the source (a `.py` script) or opens it (a
`.blend` file), and exports it as glTF binary. Then Node welds, deduplicates and meshopt-compresses it like the
code-made models, writes it to `public/models/`, and checks it against its entry in `art/models.json`. It finds
Blender from the `BLENDER` environment variable, `blender` on the PATH, or the usual install folder on Windows and
macOS. It needs Blender 4.2 or newer (made with 5.3).

Commit the source and the exported `.glb` together. CI doesn't have Blender, so `npm run check:models` checks the
committed file instead: the nodes, animations and materials the game looks up are there, it's compressed, and it's
within its size and triangle budgets.

## Rules for a model

- **Units and axes.** 1 Blender unit is 1 metre. Model facing **+Y** with **+Z** up: the glTF export turns that into the
  game's -Z forward, Y up. Apply rotation and scale (Ctrl+A) before exporting.
- **Origin.** Where the game holds or places it: a marker's trigger, a bunker's or player's feet (on the ground, in the
  middle).
- **Names.** The objects the game looks up keep exactly the names listed in `art/models.json` (`nodes`), like
  `marker`, `pump` and `muzzle`. Name helpers and reference images with a leading `_` and they're left out of the export.
- **Materials.** Principled BSDF with a base colour, roughness and metallic, nothing else: no textures yet, so models
  stay small and match the rest of the game. A material named `team` is recoloured red or blue per team.
- **Animations.** One action per animation, named as the game expects (`pump`), starting at frame 0. Keyframe object
  transforms (or bones, for a rigged figure). Its length in seconds is checked against `art/models.json`.
- **Budgets.** Each model has a triangle and file-size budget in `art/models.json`. The pump marker is 1,756 triangles
  and 22 KB; keep first-person models under a few thousand triangles, and bunkers under a few hundred each, as there
  are dozens on a field.
- **Original work only.** No downloaded models or textures unless their license allows it and they're listed in
  `ASSETS.md`. Don't copy the look of any real marker, bunker or other product.

## Adding a model

1. Make it: write `art/<name>.py` with the helpers in `scripts/blender/kit.py` (see `art/pump-marker.py`), or model it
   by hand and save `art/<name>.blend`.
2. Add it to `art/models.json`: source, output file, the nodes, animations and materials the game needs, and budgets.
3. `npm run assets:blender -- <name>`, and fix whatever it reports.
4. Load it in `src/models.ts` and use it in the game. Optional models should fall back to something built in if they
   don't load, like the pump marker does.
5. List it in `ASSETS.md`.

## Working with Claude through the Blender MCP server

The Blender MCP add-on (from Blender Lab) lets Claude look at and change a running Blender over the Model Context
Protocol, which suits building or tweaking a model by describing it.

1. In Blender, install the MCP add-on (Edit > Preferences > Get Extensions), allow online access (it only listens on
   your own machine), and start its server from the add-on's preferences.
2. Connect Claude to it:
   - **Claude desktop app:** install the Blender extension, and Claude can use it in chat.
   - **Claude Code:** add the same server to your own Claude Code config, not this repository's, as the command
     points at your machine: `claude mcp add blender --scope local -- uv run --directory "<Blender extension folder>" blender-mcp`,
     where the folder is the one the desktop app installed the Blender extension into (it holds `pyproject.toml` and
     `blmcp/`). Use the Blender Lab server, not the unrelated `blender-mcp` package on PyPI.
3. Ask for what you want. Keep the rules above in mind, or point Claude at this file.
4. Save the result as `art/<name>.blend` (or have Claude write it up as a build script in `art/<name>.py`, which is easier
   to review and change later), add it to `art/models.json`, and export it as above.
