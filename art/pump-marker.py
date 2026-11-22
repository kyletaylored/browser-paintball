# The pump marker, for pump mode: a receiver with a stick-feed tube on top, a long barrel, and a
# ribbed pump handle under it that racks back after every shot.  npm run assets:blender
#
# Built in Blender by script (see docs/BLENDER.md): Y is forward (the barrel), Z is up, metres. The
# origin is at the trigger, like marker.glb, so the game holds both the same way.
#
# What the game looks up (art/models.json checks these are there):
#   "marker"  the marker, every part but the handle, in one mesh
#   "pump"    the pump handle (a child of "marker"); the "pump" animation slides it back and forward
#   "muzzle"  an empty at the barrel's tip
# The "team" material is recoloured per team.

import kit

kit.clear_scene()

body = kit.material('body', 0x2d3442, roughness=0.35, metallic=0.6)
barrel = kit.material('barrel', 0x1a1c22, roughness=0.3, metallic=0.7)
grip = kit.material('grip', 0x15161a, roughness=0.9)
chrome = kit.material('chrome', 0xb8bcc6, roughness=0.2, metallic=1.0)
tank = kit.material('tank', 0x8a8f99, roughness=0.28, metallic=0.8)
team = kit.material('team', 0xff3b3b, roughness=0.35)

BORE = 0.05  # barrel height above the trigger
parts = [
    # receiver, with the barrel coming out of its front (y = 0.165)
    kit.box('receiver', (0.042, 0.25, 0.07), (0, 0.04, 0.04), body, bevel=0.008),
    kit.box('rail', (0.02, 0.2, 0.008), (0, 0.04, 0.079), barrel),
    # stick feed: a short upright tube of paint on top, with a team-coloured band and cap
    kit.cylinder('feed', 0.016, 0.16, (0, 0.07, 0.155), chrome, axis='Z'),
    kit.cylinder('feed_band', 0.0175, 0.03, (0, 0.07, 0.12), team, axis='Z'),
    kit.cylinder('feed_cap', 0.019, 0.02, (0, 0.07, 0.245), team, axis='Z'),
    # barrel: slightly tapered, with a muzzle ring
    kit.cylinder('barrel', 0.0125, 0.34, (0, 0.335, BORE), barrel, radius2=0.0118),
    kit.cylinder('tip', 0.015, 0.02, (0, 0.515, BORE), body),
    # the rod the pump handle slides on, under the barrel
    kit.cylinder('rod', 0.006, 0.24, (0, 0.28, 0.012), chrome),
    kit.box('rod_front', (0.012, 0.012, 0.045), (0, 0.395, 0.03), body),
    # grip (raked back), trigger and guard
    kit.box('grip', (0.032, 0.046, 0.11), (0, -0.035, -0.05), grip, bevel=0.008, rot=(-0.26, 0, 0)),
    kit.box('trigger', (0.008, 0.008, 0.03), (0, 0.015, -0.012), chrome, rot=(0.15, 0, 0)),
    kit.box('guard', (0.01, 0.06, 0.006), (0, 0.012, -0.04), body),
    kit.box('guard_front', (0.01, 0.006, 0.04), (0, 0.04, -0.02), body),
    # a small air tank under the back, on a regulator
    kit.box('adapter', (0.026, 0.03, 0.05), (0, -0.06, -0.06), body),
    kit.cylinder('regulator', 0.02, 0.045, (0, -0.07, -0.085), chrome),
    kit.cylinder('tank', 0.03, 0.16, (0, -0.17, -0.085), tank),
    kit.sphere('tank_end', 0.03, (0, -0.25, -0.085), tank, scale=(1, 0.6, 1)),
]
marker = kit.join('marker', parts)

# the pump handle: a ribbed sleeve round the rod
handle = [kit.cylinder('sleeve', 0.019, 0.1, (0, 0, 0), grip, segments=16)]
for i in range(5):
    handle.append(kit.cylinder('rib{}'.format(i), 0.0215, 0.007, (0, -0.04 + i * 0.02, 0), grip, segments=16))
handle.append(kit.cylinder('handle_band', 0.0205, 0.012, (0, 0.056, 0), team, segments=16))
pump = kit.join('pump', handle, parent=marker)
REST = (0, 0.31, 0.012)
BACK = (0, 0.24, 0.012)
pump.location = REST

# rack it: back, a beat, forward again. 0.5 s, the length of a pump stroke in shared/fire.ts
kit.animate_location(pump, 'pump', [(0, REST), (0.16, BACK), (0.22, BACK), (0.42, REST), (0.5, REST)])

kit.empty('muzzle', (0, 0.525, BORE), parent=marker)
