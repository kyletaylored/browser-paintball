// Controller maths and button handling, without a browser: npm run test:input

import { TapOrHold } from './input';
import { BTN, LOOK_DEADZONE, LOOK_YAW_SPEED, MOVE_DEADZONE, PRONE_HOLD, PadState, TURN_BOOST, lookRates, radialDeadzone, turnBoost, type PadLike } from './gamepad';
import { Trigger, MODE_RULES, modeVoteWinner, type FireMode } from '../shared/fire';
import { stickVector, STICK_RADIUS, STICK_DEADZONE, SPRINT_PAST } from './touch';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failed++;
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- deadzone and curve -----------------------------------------------------------------------

check('inside the deadzone is still', radialDeadzone(0.1, 0.05, MOVE_DEADZONE).mag === 0);
const edge = radialDeadzone(MOVE_DEADZONE + 0.01, 0, MOVE_DEADZONE);
check('just outside the deadzone is slow, not a jump', edge.mag > 0 && edge.mag < 0.02, `mag ${edge.mag}`);
const full = radialDeadzone(1, 0, MOVE_DEADZONE);
check('full tilt is full speed', near(full.x, 1) && near(full.mag, 1));
const diag = radialDeadzone(Math.SQRT1_2, Math.SQRT1_2, MOVE_DEADZONE);
check('diagonals are as fast as straight (radial, not per axis)', near(diag.mag, 1) && near(diag.x, diag.y));
const over = radialDeadzone(1, 1, MOVE_DEADZONE);
check('square-gate corners are clamped to 1', near(over.mag, 1), `mag ${over.mag}`);

const half = lookRates(0.5 + LOOK_DEADZONE / 2, 0, 1, 0);
const fullLook = lookRates(1, 0, 1, 0);
check('full right stick turns at the top speed', near(fullLook.yaw, LOOK_YAW_SPEED));
check('half tilt turns about a quarter as fast (squared curve)', near(half.yaw / fullLook.yaw, 0.25, 0.02), `${half.yaw / fullLook.yaw}`);
check('sensitivity scales look speed', near(lookRates(1, 0, 1.5, 0).yaw, LOOK_YAW_SPEED * 1.5));
check('no turn boost on a quick flick', turnBoost(0.1) === 0);
check('turn boost ramps to its maximum', near(turnBoost(5), TURN_BOOST) && turnBoost(0.35) > 0 && turnBoost(0.35) < TURN_BOOST);

// ---- buttons ----------------------------------------------------------------------------------

let stamp = 0;
function pad(pressed: number[] = [], axes: number[] = [0, 0, 0, 0], triggers: Partial<Record<number, number>> = {}): PadLike {
  stamp++;
  return {
    index: 0, connected: true, mapping: 'standard', timestamp: stamp, axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: triggers[i] ?? (pressed.includes(i) ? 1 : 0) })),
  };
}

const s = new PadState({ sensitivity: 1, invertY: false, vibration: true });
s.update(pad(), 1 / 60);
check('a controller with nothing pressed is connected and idle', s.connected && !s.fire && s.moveX === 0 && s.moveY === 0);

s.update(pad([], [0, -1, 0, 0]), 1 / 60);
check('left stick up walks forward', near(s.moveY, 1) && s.touched);
s.update(pad([], [0, 0, 1, 0]), 1 / 60);
check('right stick right turns right (yaw goes down)', s.yawRate < 0);
s.update(pad([], [0, 0, 0, -1]), 1 / 60);
check('right stick up looks up', s.pitchRate > 0);
s.settings.invertY = true;
s.update(pad([], [0, 0, 0, -1]), 1 / 60);
check('invert Y flips looking up and down', s.pitchRate < 0);
s.settings.invertY = false;

s.update(pad([], [0, 0, 0, 0], { [BTN.RT]: 0.2 }), 1 / 60);
check('a light trigger touch does not fire', !s.fire);
s.update(pad([], [0, 0, 0, 0], { [BTN.RT]: 0.6 }), 1 / 60);
check('pulling the trigger fires', s.fire);

s.update(pad([BTN.X]), 1 / 60);
const first = s.reloadPressed;
s.update(pad([BTN.X]), 1 / 60);
check('a press counts once, not every frame it is held', first && !s.reloadPressed);

s.update(pad(), 1 / 60);
s.update(pad([BTN.B]), 1 / 60);
s.update(pad(), 1 / 60);
check('a tap of B crouches', s.crouch && !s.prone);
s.update(pad(), 1 / 60);
check('crouch stays on after letting go', s.crouch);
s.update(pad([BTN.B]), 1 / 60);
s.update(pad(), 1 / 60);
check('another tap stands back up', !s.crouch);
s.update(pad([BTN.B]), 1 / 60);
for (let i = 0; i < 30; i++) s.update(pad([BTN.B]), 1 / 60); // half a second
check(`holding B (${PRONE_HOLD} s) lies down`, s.prone && !s.crouch);
s.update(pad(), 1 / 60);
check('and you stay down after letting go', s.prone);
s.update(pad([BTN.B]), 1 / 60);
s.update(pad(), 1 / 60);
check('a tap from lying down gets you up to a crouch', !s.prone && s.crouch);
s.update(pad([BTN.B]), 1 / 60);
for (let i = 0; i < 30; i++) s.update(pad([BTN.B]), 1 / 60);
s.update(pad([BTN.A]), 1 / 60);
check('jumping gets you up from lying down', !s.prone && !s.crouch);
s.update(pad(), 1 / 60);

s.update(pad([], [0, -1, 0, 0]), 1 / 60);
s.update(pad([BTN.L3], [0, -1, 0, 0]), 1 / 60);
check('clicking the left stick sprints', s.sprint);
s.update(pad([], [0, -1, 0, 0]), 1 / 60);
check('sprint stays on while you keep moving', s.sprint);
s.update(pad([], [0, 0, 0, 0]), 1 / 60);
check('sprint ends when you stop', !s.sprint);
s.update(pad([BTN.LB], [0, -1, 0, 0]), 1 / 60);
check('holding LB sprints too', s.sprint);

// ---- menu navigation --------------------------------------------------------------------------

s.update(pad(), 1 / 60);
s.update(pad([BTN.DOWN]), 1 / 60);
const navFirst = s.nav;
s.update(pad([BTN.DOWN]), 0.1);
check('d-pad down moves once per press in menus', navFirst === 'down' && s.nav === null);
let repeats = 0;
for (let i = 0; i < 10; i++) {
  s.update(pad([BTN.DOWN]), 0.1);
  if (s.nav === 'down') repeats++;
}
check('holding d-pad down repeats after a moment', repeats >= 4 && repeats <= 8, `${repeats} repeats in 1 s`);
s.update(pad([], [0, -0.9, 0, 0]), 1 / 60);
check('the left stick navigates menus too', s.nav === 'up');
s.update(pad(), 1 / 60);
s.update(pad([BTN.B]), 1 / 60);
check('B is reported for "back"', s.bPressed);
s.update(pad(), 1 / 60);

s.update(pad([BTN.UP]), 1 / 60);
const talking = s.talk;
s.update(pad([BTN.UP]), 1 / 60);
check('holding d-pad up is push-to-talk, for as long as it is held', talking && s.talk);
s.update(pad(), 1 / 60);
check('letting go of d-pad up stops talking', !s.talk);

const crouchBefore = s.crouch;
s.update(pad([BTN.R3]), 1 / 60);
const viewFirst = s.viewPressed;
s.update(pad([BTN.R3]), 1 / 60);
check('clicking the right stick switches the view, once per click (and leaves crouch alone)', viewFirst && !s.viewPressed && s.crouch === crouchBefore);
s.update(pad(), 1 / 60);
s.update(pad([BTN.LEFT]), 1 / 60);
const leftFirst = s.shoulderPressed;
s.update(pad([BTN.LEFT]), 1 / 60);
const leftHeld = s.shoulderPressed;
s.update(pad(), 1 / 60);
s.update(pad([BTN.RIGHT]), 1 / 60);
check('d-pad left / right pick the shoulder, once per press', leftFirst === -1 && leftHeld === 0 && s.shoulderPressed === 1);
s.update(pad(), 1 / 60);

s.update(pad([BTN.START]), 1 / 60);
check('Start is reported once', s.startPressed);
s.update(null, 1 / 60);
check('unplugging clears everything', !s.connected && !s.sprint && !s.fire && s.moveY === 0);

// ---- keyboard crouch and lie down: tap to stay down, or hold --------------------------------------

{
  const k = new TapOrHold();
  k.press(0);
  k.release(120);
  check('a quick tap of C stays crouched', k.on);
  k.press(1000);
  k.release(1100);
  check('another tap stands back up', !k.on);
  k.press(2000);
  check('holding it crouches', k.on);
  k.release(2600);
  check('a long hold stands up when you let go', !k.on);
  k.press(3000);
  k.release(3050);
  k.press(4000);
  check('holding it while tapped down keeps you down', k.on);
  k.release(4800);
  check('until you let go', !k.on);
}

// ---- firing modes: what pulling and holding the trigger fires ----------------------------------

{
  /** run a trigger at 60 fps through a list of [seconds, held] steps; how many balls it fired */
  const run = (mode: FireMode, steps: [number, boolean][]) => {
    const t = new Trigger();
    t.mode = mode;
    let n = 0;
    for (const [secs, held] of steps) for (let f = 0; f < Math.round(secs * 60); f++) n += t.update(1 / 60, held);
    return n;
  };
  /** `pulls` quick pulls (down 50 ms, up `gap`), then hold for `hold` seconds */
  const pullsThenHold = (pulls: number, gap: number, hold: number): [number, boolean][] => [
    ...Array.from({ length: pulls }, () => [[0.05, true], [gap, false]] as [number, boolean][]).flat(),
    [hold, true],
  ];
  check('ramp: holding the trigger from cold fires one ball', run('ramp', [[1, true]]) === 1);
  const ramped = run('ramp', pullsThenHold(2, 0.15, 1));
  check(`ramp: two quick pulls, then a third held for a second, ramps to 10 a second (${ramped})`, ramped >= 11 && ramped <= 13);
  const slow = run('ramp', pullsThenHold(2, 0.6, 1));
  check(`ramp: slow pulls don't ramp (${slow})`, slow === 3);
  const letGo = run('ramp', [...pullsThenHold(2, 0.15, 0.5), [0.6, false], [1, true]]);
  check(`ramp: let go for a while and it's one per pull again (${letGo})`, letGo >= 8 && letGo <= 9);
  check('semi: holding fires one ball', run('semi', [[1, true]]) === 1);
  const fast = run('semi', Array.from({ length: 15 }, () => [[1 / 30, true], [1 / 30, false]] as [number, boolean][]).flat());
  check(`semi: pulling 15 times a second still fires no more than 10 a second (${fast})`, fast >= 9 && fast <= 10);
  check('semi: every pull at a human pace fires', run('semi', pullsThenHold(6, 0.12, 0)) === 6);
  const pump = run('pump', Array.from({ length: 8 }, () => [[0.05, true], [0.2, false]] as [number, boolean][]).flat());
  check(`pump: pulls during the pump stroke are lost (${pump} balls from 8 pulls in 2 s)`, pump === 4);
  check('pump: holding fires one ball', run('pump', [[2, true]]) === 1);
  check('pump: a 20-ball tube, ramp and semi a full hopper', MODE_RULES.pump.hopper === 20 && MODE_RULES.ramp.hopper === 200);
  check('the vote: more than half for another mode switches to it',
    modeVoteWinner(['pump', 'pump', null], 'ramp') === 'pump' && modeVoteWinner(['pump', 'semi'], 'ramp') === 'ramp' &&
    modeVoteWinner(['pump', null], 'ramp') === 'ramp' && modeVoteWinner([], 'semi') === 'semi');
}

// ---- on-screen stick (phones) -------------------------------------------------------------------

{
  const still = stickVector(STICK_RADIUS * STICK_DEADZONE * 0.9, 0);
  check('touch stick: a thumb resting where it landed is still', still.x === 0 && still.y === 0 && !still.sprint);
  const up = stickVector(0, -STICK_RADIUS);
  check('touch stick: pushed up to the ring is full speed forward', near(up.y, 1) && near(up.x, 0) && !up.sprint, JSON.stringify(up));
  const right = stickVector(STICK_RADIUS * 0.56, 0);
  check('touch stick: half way out is about half speed', right.x > 0.4 && right.x < 0.6 && right.y === 0, JSON.stringify(right));
  const diag = stickVector(STICK_RADIUS, STICK_RADIUS);
  check('touch stick: diagonals are no faster than straight', near(Math.hypot(diag.x, diag.y), 1), JSON.stringify(diag));
  const far = stickVector(0, -STICK_RADIUS * (SPRINT_PAST + 0.1));
  check('touch stick: pushed well past the ring sprints', far.sprint && near(far.y, 1), JSON.stringify(far));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall controller checks passed');
