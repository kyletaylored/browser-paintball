# Helpers for the Blender build scripts in art/*.py (see docs/BLENDER.md). Runs inside Blender
# (bpy), started by scripts/blender/export.py.
#
# Blender is Z-up and the game (glTF) is Y-up. The glTF exporter turns Blender (x, y, z) into
# game (x, z, -y), so in Blender a model faces +Y (that's the game's -Z, "forward"), up is +Z, and
# x stays x. All sizes are metres.

import math

import bpy


def clear_scene():
    """start from nothing: no default cube, camera or light, no leftover data"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0


def hex_color(h):
    """0xRRGGBB (sRGB, as written in the game's code) to linear RGBA, which is what glTF stores"""
    def lin(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin((h >> 16) & 255), lin((h >> 8) & 255), lin(h & 255), 1.0)


def material(name, color, roughness=0.5, metallic=0.0):
    """a plain Principled BSDF: base colour, roughness, metallic. Name it 'team' to have the game recolour it per team"""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = hex_color(color)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    m.diffuse_color = hex_color(color)
    return m


def _finish(obj, name, mat, parent, smooth):
    obj.name = name
    obj.data.name = name
    if mat is not None:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    if parent is not None:
        obj.parent = parent
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
    return obj


def box(name, size, at, mat, parent=None, bevel=0.0, rot=(0, 0, 0)):
    """a box `size` (x, y, z) centred on `at`, optionally with rounded (bevelled) edges"""
    bpy.ops.mesh.primitive_cube_add(size=1, location=at, rotation=rot)
    obj = bpy.context.active_object
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0:
        mod = obj.modifiers.new('bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = 'ANGLE'
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return _finish(obj, name, mat, parent, smooth=bevel > 0)


def cylinder(name, radius, length, at, mat, parent=None, axis='Y', segments=20, radius2=None):
    """a cylinder along `axis` (Y: forward, the way barrels point), centred on `at`; radius2 tapers the +axis end"""
    rot = {'X': (0, math.pi / 2, 0), 'Y': (-math.pi / 2, 0, 0), 'Z': (0, 0, 0)}[axis]
    if radius2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=segments, radius=radius, depth=length, location=at, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=segments, radius1=radius, radius2=radius2, depth=length, location=at, rotation=rot)
    obj = bpy.context.active_object
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.location = at
    return _finish(obj, name, mat, parent, smooth=True)


def sphere(name, radius, at, mat, parent=None, scale=(1, 1, 1), segments=20, rings=12):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=radius, location=at)
    obj = bpy.context.active_object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _finish(obj, name, mat, parent, smooth=True)


def empty(name, at, parent=None):
    """a named point the game looks up (a muzzle, a hand grip), with no mesh"""
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = at
    if parent is not None:
        obj.parent = parent
    return obj


def join(name, objects, parent=None, origin=(0, 0, 0)):
    """merge meshes into one object (fewer draw calls), with its origin at `origin`; keeps each part's material"""
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    # the origin is where the game holds or places the model (a marker's trigger, a bunker's base)
    bpy.context.scene.cursor.location = origin
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    if parent is not None:
        obj.parent = parent
    return obj


def animate_location(obj, action_name, keys, fps=30):
    """keyframe obj's location: keys = [(seconds, (x, y, z)), ...]. One action per game animation, named as the game expects"""
    scene = bpy.context.scene
    scene.frame_start = 0  # animations start at 0 s in the game
    scene.frame_end = max(scene.frame_end, round(keys[-1][0] * fps))
    for t, loc in keys:
        obj.location = loc
        obj.keyframe_insert(data_path='location', frame=t * fps)
    action = obj.animation_data.action
    action.name = action_name
    obj.location = keys[0][1]
    return action
