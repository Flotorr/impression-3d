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

test('water is conserved: nothing makes it vanish by itself', () => {
    assert.equal(PHYSICS.evaporation, undefined);
    assert.equal(PHYSICS.infiltration, undefined);
    assert.ok(PHYSICS.rain > 0);
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
    assert.equal(new Set(TOOLS.map((t) => t.mode).filter((m) => m > 0)).size, 8, 'no two tools share a mode');
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
