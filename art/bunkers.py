# Every inflatable bunker on every field, in the arcade look: puffy, rounded shapes in bold flat
# colours, a darker lower panel and base skirt, sewn seams, a belt strap round the middle and
# tie-down loops at the base.  npm run assets:blender -- bunkers
#
# The shapes come from the game's own field data (shared/maps.ts), so the models always match what
# the server collides with: scripts/blender-assets.ts writes them to a JSON file and passes its
# path in SPLAT_INPUT. Each model is an object named "bunker:<key>" (bunkerKey in shared/field.ts),
# standing on its base at the origin. Y is the game's -Z (see kit.py), Z is up, metres.

import json
import math
import os

import bmesh
import bpy

import kit

kit.clear_scene()
shapes = json.load(open(os.environ['SPLAT_INPUT'], encoding='utf-8'))

INK = kit.material('trim', 0x1b1922, roughness=0.8)
mats = {}


def colours(c):
    """the bunker's own colour, a darker shade for its lower panel and seams"""
    if c not in mats:
        r, g, b = (c >> 16) & 255, (c >> 8) & 255, c & 255
        dark = (int(r * 0.62) << 16) | (int(g * 0.62) << 8) | int(b * 0.62)
        mats[c] = (
            kit.material('skin-{:06x}'.format(c), c, roughness=0.55),
            kit.material('panel-{:06x}'.format(c), dark, roughness=0.6),
        )
    return mats[c]


def link(mesh, name, mat):
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mesh.materials.append(mat)
    return obj


def prism(name, pts, z0, z1, mat, grow=0.0):
    """an upright prism over the footprint pts (Blender x, y), from z0 to z1; grow pushes it out from its centre"""
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    bm = bmesh.new()
    ring = []
    for x, y in pts:
        dx, dy = x - cx, y - cy
        d = math.hypot(dx, dy) or 1
        ring.append(bm.verts.new((x + dx / d * grow, y + dy / d * grow, z0)))
    face = bm.faces.new(ring)
    if face.normal.z > 0:
        face.normal_flip()  # the bottom faces down
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    top = [v for v in ext['geom'] if isinstance(v, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=top, vec=(0, 0, z1 - z0))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return link(mesh, name, mat)


def soften(obj, width, segments=4):
    """round every edge (the inflatable look), applied so the export carries the shape"""
    if width <= 0:
        return obj
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mod = obj.modifiers.new('round', 'BEVEL')
    mod.width = width
    mod.segments = segments
    mod.profile = 0.62
    mod.limit_method = 'ANGLE'
    mod.harden_normals = False
    bpy.ops.object.modifier_apply(modifier=mod.name)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def torus(name, at, rot, mat, major=0.045, minor=0.012):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=12, minor_segments=6, location=at, rotation=rot)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def footprint(s):
    """the outline seen from above, as Blender (x, y) points (y = -game z), counter-clockwise"""
    if s['kind'] == 'box':
        hw, hd = s['w'] / 2, s['d'] / 2
        return [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)]
    if s['kind'] == 'can':
        n = 28
        return [(math.cos(i / n * math.tau) * s['r'], math.sin(i / n * math.tau) * s['r']) for i in range(n)]
    pts = [(px, -pz) for px, pz in s['pts']]
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    return pts if area > 0 else pts[::-1]


def bunker(s):
    skin, panel = colours(s['color'])
    pts = footprint(s)
    h = s['h']
    # how wide a bunker is at its narrowest, for how round its edges can be
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    small = min(max(xs) - min(xs), max(ys) - min(ys), h)
    r = min(0.24, small * 0.22)
    parts = []
    # the body: the colour up top, a darker panel round the bottom third (bold two-tone, easy to read)
    split = h * 0.34
    body = soften(prism('body', pts, split - 0.02, h, skin), r)
    parts.append(body)
    low = soften(prism('low', pts, 0, split, panel, grow=0.004), min(r, split * 0.3), 3)
    parts.append(low)
    # a belt strap round the middle and a skirt round the base, in ink
    belt = h * 0.62
    parts.append(soften(prism('belt', pts, belt - 0.035, belt + 0.035, INK, grow=0.014 - r * 0.0), 0.012, 2))
    parts.append(soften(prism('skirt', pts, 0, 0.08, INK, grow=0.02), 0.015, 2))
    # seams up the faces of a box or wedge (every corner of a can would be too busy: rings instead)
    if s['kind'] == 'can':
        rr = s['r']
        for f in (0.2, 0.86):
            ring = [(math.cos(i / 28 * math.tau) * (rr + 0.006), math.sin(i / 28 * math.tau) * (rr + 0.006)) for i in range(28)]
            parts.append(prism('seam', ring, h * f - 0.018, h * f + 0.018, panel))
        parts.append(kit.cylinder('valve', 0.032, 0.05, (0, 0, h + 0.015), INK, axis='Z', segments=12))
    else:
        n = len(pts)
        for i in range(n):
            ax, ay = pts[i]
            bx, by = pts[(i + 1) % n]
            ex, ey = bx - ax, by - ay
            L = math.hypot(ex, ey)
            if L < 0.9:
                continue
            nx, ny = ey / L, -ex / L  # outward for a counter-clockwise outline
            cx = sum(xs) / n
            cy = sum(ys) / n
            if (ax - cx) * nx + (ay - cy) * ny < 0:
                nx, ny = -nx, -ny
            count = 2 if L > 1.8 else 1
            for k in range(count):
                t = (k + 1) / (count + 1)
                px, py = ax + ex * t + nx * 0.006, ay + ey * t + ny * 0.006
                strip = kit.box('seam', (0.03, 0.03, h - 2 * r - split), (px, py, split + (h - split) / 2), panel, rot=(0, 0, math.atan2(ey, ex)))
                parts.append(strip)
        parts.append(kit.cylinder('valve', 0.03, 0.04, (sum(xs) / n, sum(ys) / n, h + 0.01), INK, axis='Z', segments=12))
    # tie-down loops at the base, one per corner (four round a can)
    corners = pts if s['kind'] != 'can' else [pts[int(i * len(pts) / 4) + len(pts) // 8] for i in range(4)]
    cx = sum(xs) / len(xs)
    cy = sum(ys) / len(ys)
    for (x, y) in corners:
        dx, dy = x - cx, y - cy
        d = math.hypot(dx, dy) or 1
        a = math.atan2(dy, dx)
        parts.append(torus('loop', (x + dx / d * 0.05, y + dy / d * 0.05, 0.06), (math.pi / 2, 0, a + math.pi / 2), INK))
    return kit.join('bunker:' + s['key'], parts)


for s in shapes:
    bunker(s)
print('built {:d} bunkers'.format(len(shapes)))
