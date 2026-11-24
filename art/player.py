# The player figures, in the arcade look: one rig and one set of animations, worn by several
# characters. Shared by all of them: shorts with a pod pack, sleeves, elbow and knee pads, chunky
# gloves, high-top boots with white soles, and a marker with a big hopper. Each character has its own
# head (helmet) and torso (build), named "head_<character>" and "torso_<character>"; the game shows
# one of each (src/characters.ts) and makes the limbs thicker or slimmer to suit.
#
# Two materials are recoloured by the game: "team" (the jersey, red or blue) and "accent" (the
# character's own colour: pads, boot tops and goggle lens).  npm run assets:blender -- player
#
# The joints come from the game (scripts/player-rig.ts, handed over in SPLAT_INPUT), and so do the
# animations: scripts/blender-assets.ts adds them after the export. This script only builds the
# shapes round the joints. Each joint is an empty named like the game expects ("hips", "torso",
# "head", …), with its shapes in a child mesh "<joint>_mesh", so turning a joint turns its part.
# The top of the helmet is at the standing height, where the hitbox ends.
#
# Measurements below are in the game's axes (x right, y up, z back: the figure faces -z) and are
# turned into Blender's (x, -z, y) as they're placed.

import json
import os

import bpy

import kit

kit.clear_scene()
rig = json.load(open(os.environ['SPLAT_INPUT'], encoding='utf-8'))
BONES = rig['bones']
HEAD_TOP = rig['headTop']

M = {
    'team': kit.material('team', 0xff3b3b, roughness=0.6),
    'side': kit.material('side', 0x2b2f3a, roughness=0.8),
    'pants': kit.material('pants', 0x262a34, roughness=0.85),
    'pad': kit.material('pad', 0x1d1b24, roughness=0.6),
    'glove': kit.material('glove', 0x1c1c20, roughness=0.7),
    'boot': kit.material('boot', 0x17161c, roughness=0.6),
    'sole': kit.material('sole', 0xf3efe4, roughness=0.7),
    'white': kit.material('white', 0xf3efe4, roughness=0.6),
    'mask': kit.material('mask', 0x30343c, roughness=0.45),
    'accent': kit.material('accent', 0xb45cff, roughness=0.45),
    'trim': kit.material('trim', 0x14131a, roughness=0.6),
    'gun': kit.material('gunbody', 0x2d3442, roughness=0.4, metallic=0.5),
    'barrel': kit.material('barrel', 0x1a1c22, roughness=0.3, metallic=0.6),
    'tank': kit.material('tank', 0x8a8f99, roughness=0.3, metallic=0.7),
}


def b(v):
    """game (x, y, z) to Blender (x, -z, y)"""
    return (v[0], -v[2], v[1])


# where every joint is in the world (game axes), from the chain of parents
world = {}


def place(name):
    if name in world:
        return world[name]
    bone = BONES[name]
    at = bone['at']
    if bone['parent'] is None:
        world[name] = tuple(at)
    else:
        px, py, pz = place(bone['parent'])
        world[name] = (px + at[0], py + at[1], pz + at[2])
    return world[name]


for n in BONES:
    place(n)

# the joints: empties in a chain, each at its spot in its parent, with no rotation at rest
empties = {}
for n in BONES:  # parents come before children in the rig
    bone = BONES[n]
    parent = empties.get(bone['parent']) if bone['parent'] else None
    empties[n] = kit.empty(n, b(bone['at']), parent=parent)


class Part:
    """the shapes for one joint, measured from the joint (game axes)"""

    def __init__(self, bone):
        self.bone = bone
        self.origin = world[bone]
        self.objs = []

    def _at(self, v):
        o = self.origin
        return b((o[0] + v[0], o[1] + v[1], o[2] + v[2]))

    def box(self, mat, size, at, bevel=0.0, rot=(0, 0, 0)):
        # size is (x, y, z) in game axes: Blender's is (x, z, y)
        self.objs.append(kit.box('p', (size[0], size[2], size[1]), self._at(at), M[mat], bevel=bevel, rot=rot))
        return self

    def cyl(self, mat, r, length, at, axis='y', segments=16, r2=None):
        # an upright (game y) cylinder is Blender Z; along game z is Blender Y
        self.objs.append(kit.cylinder('p', r, length, self._at(at), M[mat], axis={'x': 'X', 'y': 'Z', 'z': 'Y'}[axis], segments=segments, radius2=r2))
        return self

    def ball(self, mat, r, at, scale=(1, 1, 1), segments=18, rings=12):
        self.objs.append(kit.sphere('p', r, self._at(at), M[mat], scale=(scale[0], scale[2], scale[1]), segments=segments, rings=rings))
        return self

    def done(self, name=None):
        mesh = kit.join(name or self.bone + '_mesh', self.objs, origin=b(self.origin))
        mesh.parent = empties[self.bone]
        mesh.location = (0, 0, 0)
        return mesh


# ---- hips: shorts, belt and the pod pack --------------------------------------------------------
(Part('hips')
 .box('pants', (0.42, 0.24, 0.28), (0, -0.01, 0), bevel=0.06)
 .box('trim', (0.44, 0.06, 0.3), (0, 0.09, 0), bevel=0.02)
 .box('white', (0.07, 0.05, 0.01), (0, 0.09, -0.152))  # belt buckle
 .box('pad', (0.34, 0.14, 0.1), (0, 0.03, 0.18), bevel=0.03)
 .cyl('pad', 0.034, 0.22, (-0.1, 0.15, 0.23)).cyl('pad', 0.034, 0.22, (0, 0.15, 0.23)).cyl('pad', 0.034, 0.22, (0.1, 0.15, 0.23))
 .cyl('team', 0.037, 0.035, (-0.1, 0.27, 0.23)).cyl('team', 0.037, 0.035, (0, 0.27, 0.23)).cyl('team', 0.037, 0.035, (0.1, 0.27, 0.23))
 .done())

# ---- the characters: a torso (build) and a head (helmet) each --------------------------------------
# The top of every helmet is at the standing height, where the hitbox ends.
R = 0.17
cy = HEAD_TOP - R


def torso_rookie():
    """the rookie: the standard kit, a boxy jersey with a number patch front and back"""
    return (Part('torso')
            .box('team', (0.5, 0.5, 0.31), (0, 0.29, 0), bevel=0.08)
            .box('side', (0.06, 0.4, 0.315), (-0.24, 0.26, 0), bevel=0.02)
            .box('side', (0.06, 0.4, 0.315), (0.24, 0.26, 0), bevel=0.02)
            .box('white', (0.2, 0.15, 0.012), (0, 0.33, -0.158), bevel=0.01)
            .box('white', (0.24, 0.18, 0.012), (0, 0.34, 0.158), bevel=0.01)
            .box('trim', (0.52, 0.05, 0.33), (0, 0.05, 0), bevel=0.015)  # hem
            .cyl('side', 0.1, 0.07, (0, 0.56, 0))  # collar
            .ball('accent', 0.12, (-0.28, 0.47, 0), scale=(1.05, 0.75, 1.1))  # shoulder pads
            .ball('accent', 0.12, (0.28, 0.47, 0), scale=(1.05, 0.75, 1.1)))


def head_rookie():
    """the rookie: a round helmet, a wide goggle, a mouth vent and a little visor brim"""
    return (Part('head')
            .ball('mask', R, (0, cy, 0), segments=24, rings=16)
            .box('team', (0.33, 0.14, 0.08), (0, cy + 0.02, -0.13), bevel=0.03)  # goggle frame
            .box('accent', (0.27, 0.09, 0.05), (0, cy + 0.02, -0.165), bevel=0.02)  # lens
            .box('mask', (0.19, 0.12, 0.1), (0, cy - 0.11, -0.12), bevel=0.035)  # mouth vent
            .box('trim', (0.13, 0.015, 0.02), (0, cy - 0.09, -0.172)).box('trim', (0.13, 0.015, 0.02), (0, cy - 0.125, -0.172))
            .box('team', (0.3, 0.03, 0.12), (0, cy + 0.12, -0.14), bevel=0.01)  # visor brim
            .cyl('trim', 0.055, 0.36, (0, cy + 0.01, 0.0), axis='x'))  # ear pieces


def torso_bruiser():
    """the bruiser: a barrel chest under a dark chest plate, and huge shoulder pads with a rim"""
    t = (Part('torso')
         .box('team', (0.6, 0.52, 0.4), (0, 0.29, 0), bevel=0.12)
         .box('side', (0.07, 0.4, 0.405), (-0.29, 0.25, 0), bevel=0.025)
         .box('side', (0.07, 0.4, 0.405), (0.29, 0.25, 0), bevel=0.025)
         .box('pad', (0.44, 0.2, 0.05), (0, 0.39, -0.2), bevel=0.03)  # chest plate
         .box('accent', (0.44, 0.035, 0.055), (0, 0.3, -0.205), bevel=0.01)  # a stripe under it
         .box('white', (0.26, 0.2, 0.012), (0, 0.33, 0.203), bevel=0.01)  # number patch on the back
         .box('trim', (0.62, 0.06, 0.42), (0, 0.05, 0), bevel=0.02)  # hem
         .cyl('pad', 0.13, 0.09, (0, 0.56, 0)))  # thick collar
    for x in (-0.34, 0.34):
        t.ball('accent', 0.16, (x, 0.47, 0), scale=(1.1, 0.8, 1.15))
        t.cyl('pad', 0.15, 0.05, (x, 0.43, 0), r2=0.17)  # the pad's dark rim
    return t


def head_bruiser():
    """the bruiser: a wide, heavy helmet with a brow ridge, a narrow goggle and a barred jaw guard"""
    h = (Part('head')
         .ball('mask', R, (0, cy, 0), scale=(1.16, 1, 1.06), segments=24, rings=16)
         .box('pad', (0.36, 0.06, 0.12), (0, cy + 0.07, -0.12), bevel=0.025)  # brow ridge
         .box('team', (0.34, 0.09, 0.08), (0, cy + 0.005, -0.135), bevel=0.025)  # goggle frame
         .box('accent', (0.28, 0.05, 0.05), (0, cy + 0.005, -0.17), bevel=0.015)  # narrow lens
         .box('mask', (0.27, 0.15, 0.13), (0, cy - 0.105, -0.11), bevel=0.045)  # jaw guard
         .cyl('trim', 0.065, 0.4, (0, cy - 0.01, 0.0), axis='x'))  # ear pieces
    for x in (-0.08, 0, 0.08):  # bars across the jaw
        h.box('trim', (0.025, 0.11, 0.02), (x, cy - 0.105, -0.178))
    return h


CHARACTERS = {
    'rookie': (torso_rookie, head_rookie),
    'bruiser': (torso_bruiser, head_bruiser),
}
for name, (torso, head) in CHARACTERS.items():
    torso().done('torso_' + name)
    head().done('head_' + name)

# ---- arms: sleeves, elbow pads, chunky gloves --------------------------------------------------
for side in ('R', 'L'):
    (Part('shoulder' + side)
     .cyl('team', 0.075, 0.24, (0, -0.13, 0))
     .done())
    (Part('elbow' + side)
     .ball('accent', 0.07, (0, 0, -0.01), scale=(1, 0.9, 1.1))
     .cyl('side', 0.062, 0.2, (0, -0.12, 0))
     .ball('glove', 0.088, (0, -0.27, 0), scale=(1, 1.05, 1.15))
     .box('team', (0.13, 0.04, 0.13), (0, -0.2, 0), bevel=0.015)  # glove cuff
     .done())

# ---- legs: thighs, knee pads, shins, high-top boots with white soles ------------------------------
for side in ('R', 'L'):
    (Part('thigh' + side)
     .cyl('pants', 0.095, 0.4, (0, -0.21, 0))
     .done())
    knee = world['knee' + side]
    foot = -knee[1]  # down to the ground
    (Part('knee' + side)
     .ball('accent', 0.085, (0, 0.0, -0.06), scale=(1, 1.2, 0.8))
     .cyl('pants', 0.078, 0.3, (0, -0.18, 0))
     .box('boot', (0.16, 0.16, 0.3), (0, foot + 0.1, -0.05), bevel=0.05)
     .box('sole', (0.17, 0.035, 0.31), (0, foot + 0.0175, -0.05), bevel=0.012)
     .box('accent', (0.165, 0.03, 0.2), (0, foot + 0.17, -0.01), bevel=0.01)  # top of the boot
     .done())

# ---- the marker in their hands: chunky, with a big team-colour hopper -------------------------------
(Part('gun')
 .box('gun', (0.06, 0.09, 0.3), (0, 0.035, -0.06), bevel=0.015)
 .cyl('barrel', 0.017, 0.32, (0, 0.05, -0.36), axis='z')
 .cyl('gun', 0.021, 0.025, (0, 0.05, -0.52), axis='z')
 .box('glove', (0.04, 0.12, 0.05), (0, -0.05, 0.035), bevel=0.012, rot=(-0.26, 0, 0))
 .ball('team', 0.1, (0, 0.16, -0.06), scale=(0.85, 0.8, 1.25))
 .box('trim', (0.07, 0.03, 0.12), (0, 0.235, -0.06), bevel=0.012)  # hopper lid
 .cyl('tank', 0.042, 0.2, (0, -0.085, 0.17), axis='z')
 .done())

print('built the player figures: ' + ', '.join(CHARACTERS))
