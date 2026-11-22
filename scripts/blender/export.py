# Export one game model from Blender, headless. Started by scripts/blender-assets.ts:
#
#   blender --background --factory-startup [source.blend] --python scripts/blender/export.py -- \
#       --source <art/x.py or art/x.blend> --out <file.glb>
#
# A .py source is a build script: it starts from an empty scene (kit.clear_scene) and makes the
# model. A .blend source is opened by Blender itself (it's on the command line). Either way the
# scene is then exported as glTF binary: Y up, modifiers applied, every action as an animation.
# Objects whose name starts with "_" (reference images, helper shapes) are left out.
#
# Compression and the game's checks happen afterwards, in Node (scripts/blender-assets.ts).

import argparse
import os
import runpy
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # so build scripts can `import kit`


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser(prog='export.py')
    ap.add_argument('--source', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args(argv)

    if args.source.endswith('.py'):
        runpy.run_path(args.source, run_name='__main__')

    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    keep = [o for o in bpy.context.scene.objects if not o.name.startswith('_')]
    for o in keep:
        o.hide_set(False)
        o.select_set(True)
    if not keep:
        raise SystemExit('nothing to export: the scene is empty')

    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(args.out),
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_force_sampling=True,
        export_frame_step=1,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_texcoords=False,  # plain colour materials: UVs are only weight
        export_draco_mesh_compression_enable=False,  # compressed later, with meshopt like the other models
    )
    print('exported {:d} objects to {:s}'.format(len(keep), args.out))


try:
    main()
except SystemExit:
    raise
except Exception as ex:  # report and fail, so the Node side sees a non-zero exit
    import traceback
    traceback.print_exc()
    sys.exit(1)
sys.exit(0)
