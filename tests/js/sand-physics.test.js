import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_OBJECTS,
    MAX_SPRINGS,
    OBJECT_TYPES,
    PHYSICS,
    placeObject,
    SIDES,
    substepsFor,
    talusHeight,
    toggleSpring,
    tool,
    toolForKey,
    TOOLS,
    uvToWorld,
    WATER_SPEED,
    waterRuns,
    worldToUv,
} from '../../assets/lib/sand-physics.js';

test('wet sand holds steeper than dry sand, which holds steeper than sand under water', () => {
    const dry = talusHeight({ wetness: 0, underwater: false });
    const damp = talusHeight({ wetness: 0.5, underwater: false });
    const wet = talusHeight({ wetness: 1, underwater: false });
    const under = talusHeight({ wetness: 1, underwater: true });
    assert.ok(under < dry && dry < damp && damp < wet);
    // ~32° dry: tan 32° ≈ 0.625 times the cell size
    assert.ok(Math.abs(dry / (PHYSICS.world / PHYSICS.size) - 0.625) < 0.01);
});

test('substeps keep up with the frame time and stay bounded', () => {
    assert.equal(substepsFor(1 / 60), 4);
    assert.equal(substepsFor(0.0001), 1);
    assert.equal(substepsFor(1), PHYSICS.maxSubsteps, 'a frozen tab must not trigger hundreds of steps');
    assert.equal(substepsFor(Number.NaN), 1);
    assert.equal(substepsFor(-1), 1);
});

test('water stays stable: one step never moves it further than a cell', () => {
    const cell = PHYSICS.world / PHYSICS.size;
    const dt = PHYSICS.dt / PHYSICS.waterSteps;
    assert.ok(PHYSICS.maxSpeed * dt < cell, 'CFL condition for the current');
    // Waves travel at sqrt(g · depth); in 2D the pipe model needs sqrt(2 · g · depth) · dt below one cell.
    // Checked for water up to the top of the sand, the deepest the tank is meant to hold.
    assert.ok(Math.sqrt(2 * PHYSICS.gravity * PHYSICS.maxSand) * dt < cell, 'CFL for a tank full to the brim');
    assert.ok(PHYSICS.fillLevel < PHYSICS.maxSand, 'the water stays inside the glass');
});

test('tools have unique ids and keys', () => {
    assert.equal(new Set(TOOLS.map((t) => t.id)).size, TOOLS.length);
    assert.equal(new Set(TOOLS.map((t) => t.key)).size, TOOLS.length);
    assert.equal(toolForKey('6').id, 'water');
    assert.equal(toolForKey('x'), null);
});

test('springs toggle on and off, with a maximum', () => {
    let springs = toggleSpring([], [0.5, 0.5], 0.05);
    assert.deepEqual(springs, [[0.5, 0.5]]);
    springs = toggleSpring(springs, [0.51, 0.5], 0.05);
    assert.deepEqual(springs, [], 'clicking near a spring removes it');
    for (let i = 0; i < MAX_SPRINGS + 2; i++) {
        springs = toggleSpring(springs, [i / 10, 0.1], 0.05);
    }
    assert.equal(springs.length, MAX_SPRINGS);
    assert.deepEqual(springs.at(-1), [(MAX_SPRINGS + 1) / 10, 0.1], 'the oldest one makes room');
});

test('world and uv coordinates round-trip', () => {
    assert.deepEqual(worldToUv(0, 0), [0.5, 0.5]);
    assert.deepEqual(worldToUv(-1, 1), [0, 0], 'front-left corner');
    const [x, z] = uvToWorld(...worldToUv(0.3, -0.7));
    assert.ok(Math.abs(x - 0.3) < 1e-12 && Math.abs(z + 0.7) < 1e-12);
});

test('water clock: the speed sets how often the water runs, never the time step', () => {
    const runFor = (speed, steps) => {
        let credit = 0;
        let total = 0;
        for (let i = 0; i < steps; i++) {
            const result = waterRuns(credit, speed);
            credit = result.credit;
            total += result.runs;
            assert.ok(credit >= 0 && credit < 1);
        }

        return total;
    };
    assert.equal(runFor(1, 100), 100);
    assert.equal(runFor(0.25, 100), 25);
    assert.equal(runFor(3, 100), 300);
    assert.equal(runFor(1.5, 100), 150);
    assert.equal(runFor(10, 10), 30, 'clamped to the maximum');
    assert.equal(runFor(0, 100), 25, 'clamped to the minimum');
});

test('the hammer is a tool and the four sides are named', () => {
    assert.equal(toolForKey('0').id, 'hammer');
    assert.deepEqual(SIDES.map((s) => s.id), ['left', 'right', 'front', 'back']);
    assert.ok(WATER_SPEED.min < WATER_SPEED.initial && WATER_SPEED.initial < WATER_SPEED.max);
});

test('water is conserved at real speed: it only evaporates while time is accelerated, in the dry', async () => {
    const { evaporation } = await import('../../assets/lib/sand-physics.js');
    assert.equal(PHYSICS.evaporation, undefined);
    assert.equal(PHYSICS.infiltration, undefined);
    assert.ok(PHYSICS.rain > 0);
    assert.equal(evaporation(1, 1, 1, false), 0, 'real time');
    assert.equal(evaporation(0, 1, 1, false), 0, 'pause');
    assert.equal(evaporation(20, 1, 1, true), 0, 'in the rain');
    assert.ok(evaporation(20, 1, 1, false) > evaporation(20, 1, 0, false), 'more in the sun than at night');
    assert.ok(evaporation(20, 1, 0, false) > 0, 'a little at night too');
});

test('materials: rock is harder to dig than clay, clay resists water, lava sets into rock', () => {
    assert.ok(PHYSICS.digRock < PHYSICS.digClay && PHYSICS.digClay < 1);
    assert.ok(PHYSICS.clayErosion > 0 && PHYSICS.clayErosion < 1);
    const secondsToSet = (1 - PHYSICS.lavaFreezing) / PHYSICS.lavaCooling;
    assert.ok(secondsToSet > 20 && secondsToSet < 90, `${secondsToSet} s in the air`);
    assert.ok((1 - PHYSICS.lavaFreezing) / (PHYSICS.lavaCooling + PHYSICS.lavaQuench) < 0.5, 'almost at once under water');
});

test('every painting tool has a brush mode and a rate', () => {
    for (const id of ['dig', 'raise', 'clay', 'rock', 'water', 'lava', 'sponge']) {
        assert.ok(tool(id).mode > 0 && tool(id).rate > 0, id);
    }
    assert.equal(tool('lava').mode, 9, 'mode shared with the lava brush shader');
    assert.equal(tool('seeds').mode, 10, 'mode shared with the plants brush shader');
    assert.equal(tool('fire').mode, 11, 'mode shared with the fire brush shader');
    assert.equal(new Set(TOOLS.map((t) => t.mode).filter((m) => m > 0)).size, 10, 'no two tools share a mode');
    assert.equal(toolForKey('g').id, 'seeds');
    assert.equal(toolForKey('f').id, 'fire');
    assert.equal(toolForKey('o').id, 'objects');
});

test('objects fill free slots first, then replace the oldest', () => {
    let slots = Array(MAX_OBJECTS).fill(null);
    for (let i = 0; i < MAX_OBJECTS; i++) {
        const placed = placeObject(slots, 'duck', i);
        assert.equal(placed.index, i);
        slots = placed.slots;
    }
    slots[5] = null;
    assert.equal(placeObject(slots, 'boat', 100).index, 5, 'a freed slot is reused');
    slots[5] = { type: 'leaf', born: 200 };
    const { index, slots: next } = placeObject(slots, 'ball', 300);
    assert.equal(index, 0, 'when full, the oldest object makes room');
    assert.deepEqual(next[0], { type: 'ball', born: 300 });
    assert.equal(slots[0].type, 'duck', 'the original list is left untouched');
});

test('object types have a name and a size', () => {
    assert.equal(new Set(OBJECT_TYPES.map((t) => t.id)).size, OBJECT_TYPES.length);
    for (const type of OBJECT_TYPES) {
        assert.ok(type.label && type.radius > 0 && type.radius < 0.1, type.id);
    }
});

test('ocean: real swell scaled to the surfer, Froude time scaling', async () => {
    const { OCEAN, oceanWaves } = await import('../../assets/lib/sand-physics.js');
    const { amplitude, period } = oceanWaves(1.75, 9);
    assert.ok(Math.abs(amplitude * 2 - 0.05) < 1e-9, 'a swell as tall as the surfer is as tall as his model');
    assert.ok(Math.abs(period - 9 * Math.sqrt(OCEAN.metre)) < 1e-9);
    assert.equal(oceanWaves(20, 15).amplitude, OCEAN.maxAmplitude, 'storm swells are capped');
    assert.ok(oceanWaves(0, 0).period >= 0.3);
});

test('ocean: Open-Meteo response parsing and compass', async () => {
    const { compass, parseMarine } = await import('../../assets/lib/sand-physics.js');
    const swell = parseMarine({ current: { time: '2026-10-05T18:45', wave_height: 0.86, swell_wave_height: 0.84, swell_wave_period: 8.55, swell_wave_direction: 313, sea_surface_temperature: 21.3 } });
    assert.deepEqual(swell, { height: 0.84, period: 8.55, direction: 313, waves: 0.86, temperature: 21.3, time: '2026-10-05T18:45' });
    assert.equal(parseMarine({ current: { swell_wave_height: null, swell_wave_period: null } }), null, 'inland: no sea');
    assert.equal(parseMarine({ error: true, reason: 'x' }), null);
    assert.equal(compass(313), 'NO');
    assert.equal(compass(0), 'N');
    assert.equal(compass(-90), 'O');
    assert.equal(compass(181), 'S');
});

test('ocean: two swell trains beat into sets', async () => {
    const { oceanWaves, oceanWaveTrain } = await import('../../assets/lib/sand-physics.js');
    const [a, b] = oceanWaveTrain(1.5, 10);
    const { amplitude, omega } = oceanWaves(1.5, 10);
    const sum = a.amplitude + b.amplitude;
    assert.ok(sum > amplitude && sum < amplitude * 1.3, 'the biggest waves of a set are a little above the average');
    const wavesPerSet = a.omega / (b.omega - a.omega);
    assert.ok(wavesPerSet > 8 && wavesPerSet < 15, `${wavesPerSet} waves per set`);
    assert.ok(Math.abs(a.omega - omega) < 1e-9);
    assert.ok(a.kx > 0 && b.kx < 0, 'the two trains come in at slightly different angles');
});

test('time: the physics follows the speed up to its cap, life follows it all the way', async () => {
    const { physicsSteps, TIME, timeRates } = await import('../../assets/lib/sand-physics.js');
    assert.equal(physicsSteps(1 / 60, 0), 0, 'paused: nothing flows');
    assert.equal(physicsSteps(1 / 60, 1), substepsFor(1 / 60), 'real time as before');
    assert.ok(Math.abs(physicsSteps(1 / 60, 4) - 4 * substepsFor(1 / 60)) <= 1, 'x4 is four times the steps (to one step)');
    assert.ok(physicsSteps(1, 4) <= PHYSICS.maxSubsteps * 4, 'a frozen tab still cannot snowball');
    assert.deepEqual(timeRates(100), { physics: TIME.physicsCap, life: 100 });
    assert.deepEqual(timeRates(1), { physics: 1, life: 1 });
    assert.deepEqual(timeRates(0), { physics: 0, life: 0 });
    assert.deepEqual(timeRates(20, 2), { physics: 2, life: 20 }, 'a slow machine lowers the physics only');
    assert.ok(TIME.speeds.includes(0) && TIME.speeds.includes(TIME.initial));
});

test('time: a slow machine lowers the physics speed, never below real time', async () => {
    const { nextPhysicsCap, TIME } = await import('../../assets/lib/sand-physics.js');
    let cap = TIME.physicsCap;
    for (let i = 0; i < 100; i++) {
        cap = nextPhysicsCap(cap, 0.05);
    }
    assert.equal(cap, 1);
    for (let i = 0; i < 1000; i++) {
        cap = nextPhysicsCap(cap, 1 / 60);
    }
    assert.equal(cap, TIME.physicsCap, 'it recovers on fast frames');
    assert.equal(nextPhysicsCap(2, 0.025), 2, 'in between, it holds');
});

test('time: clock and light of the day', async () => {
    const { clockLabel, clockOf, sunAt, TIME } = await import('../../assets/lib/sand-physics.js');
    const at = (hour, day = 0) => (day + hour / 24) * TIME.dayLength;
    assert.equal(clockLabel(at(10)), 'Jour 1 · 10:00');
    assert.equal(clockLabel(at(14.5, 1)), 'Jour 2 · 14:30');
    assert.deepEqual(clockOf(at(23.99)), { day: 1, hour: 23, minute: 59 });

    const start = sunAt(at(TIME.startHour));
    assert.equal(start.daylight, 1);
    assert.deepEqual(start.tint, [1, 1, 1], 'the start looks like the tank before the cycle');
    const before = [0.55, 0.75, 0.35].map((c, _, all) => c / Math.hypot(...all));
    const cos = start.direction.reduce((sum, c, i) => sum + c * before[i], 0);
    assert.ok(cos > 0.999, 'and the sun is where it was');

    assert.ok(sunAt(at(12)).direction[1] > sunAt(at(8)).direction[1], 'higher at noon');
    assert.equal(sunAt(at(0)).daylight, 0, 'night');
    assert.ok(sunAt(at(0)).tint[2] > sunAt(at(0)).tint[0], 'bluish moonlight');
    assert.ok(sunAt(at(0)).direction[1] > 0, 'the moon lights from above');
    assert.ok(sunAt(at(6.05)).daylight < 0.05 && sunAt(at(17.95)).daylight < 0.05, 'dawn and dusk start dark');
    assert.ok(sunAt(at(7)).tint[2] < sunAt(at(7)).tint[0], 'low sun: warm light');
    assert.ok(Math.max(...sunAt(at(5.99)).tint) < 0.01 && Math.max(...sunAt(at(6.01)).tint) < 0.01, 'no jump when the moon hands over to the sun');
});

test('life: grass outgrows trees, roots hold steeper than wet sand', async () => {
    const { LIFE } = await import('../../assets/lib/sand-physics.js');
    assert.ok(LIFE.grassGrowth > LIFE.treeGrowth && LIFE.grassGrowth > LIFE.mossGrowth);
    assert.ok(LIFE.rootTalus > PHYSICS.talusWet);
    assert.ok(LIFE.rootErosion > 0 && LIFE.rootErosion < 1);
    const reach = Math.sqrt(LIFE.moistureSpread / LIFE.moistureLoss / 4);
    assert.ok(reach > 8 && reach < 40, `damp ground about ${reach.toFixed(0)} cells from the water`);
});
