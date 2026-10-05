// Physical constants and tool definitions shared by the GPU simulation and the interface.
// The box is 2 × 2 world units; heights are in the same units.
// Water is conserved: it only leaves through the sponge or a broken pane.

const deg = (d) => Math.tan((d * Math.PI) / 180);

export const PHYSICS = {
    size: 256, // simulation grid, cells per side
    world: 2, // box width in world units
    gravity: 9.81,
    dt: 0.004, // simulation step, seconds
    // Water runs twice per step with half the time step: in 2D, the pipe model stays stable while
    // sqrt(2 · g · depth) · dt is below the cell size, and the tank must hold water up to the brim.
    waterSteps: 2,
    maxSubsteps: 8,
    fluxDamping: 0.9993, // pipe flow kept from one step to the next: waves keep ~70 % of their energy per second
    maxSpeed: 1.5, // water speed cap, world units per second (keeps the scheme stable)
    // Angle of repose: dry sand slides past ~32°, damp sand holds ~50°, underwater it slumps at ~25°.
    talusDry: deg(32),
    talusWet: deg(50),
    talusUnder: deg(25),
    slideRate: 0.5,
    maxSand: 0.42, // the glass walls are a little higher
    // "Remplir d'eau": about 60 % of the height of the glass.
    fillLevel: 0.3,
    drying: 0.04, // wetness lost per second once the water has gone
    // Erosion: capacity = kc · slope · speed; dissolve and deposit rates.
    erosionCapacity: 0.02,
    erosionDissolve: 0.6,
    erosionDeposit: 0.9,
    rain: 0.003, // depth per second: the dunes are only a few hundredths high, so this is already a downpour
    springRate: 0.08, // depth per second at the centre of a spring
    // Clay holds any shape and resists water; the shovel bites into clay and rock more slowly than into sand.
    clayErosion: 0.15,
    digClay: 0.5,
    digRock: 0.12,
    // Lava: a viscous flow that stiffens as it cools (fluidity × temperature²), cools slowly in the air,
    // almost at once under water (quench), and turns into rock below the freezing temperature.
    lavaFluidity: 2.5,
    lavaDamping: 0.96,
    lavaCooling: 0.02, // temperature lost per second in the air: about 40 s before it sets
    lavaQuench: 4,
    lavaFreezing: 0.15,
};

export const MAX_SPRINGS = 4;

// `mode` is the brush mode understood by the brush shaders; `rate` the height (or depth) per second at the
// centre of the brush at full strength.
export const TOOLS = [
    { id: 'dig', label: 'Creuser', key: '1', mode: 1, rate: 0.35, hint: 'Retire du sable, plus lentement de l’argile et de la roche' },
    { id: 'raise', label: 'Sable', key: '2', mode: 2, rate: 0.35, hint: 'Ajoute du sable, qui s’éboule' },
    { id: 'clay', label: 'Argile', key: '3', mode: 8, rate: 0.3, hint: 'Ajoute de l’argile : elle garde sa forme et résiste à l’eau' },
    { id: 'rock', label: 'Roche', key: '4', mode: 7, rate: 0.3, hint: 'Ajoute de la roche : rien ne la déplace' },
    { id: 'push', label: 'Pousser', key: '5', mode: 3, rate: 0, hint: 'Déplace le sable dans le sens du geste' },
    { id: 'water', label: 'Eau', key: '6', mode: 4, rate: 0.45, hint: "Verse de l'eau" },
    { id: 'lava', label: 'Lave', key: '7', mode: 9, rate: 0.3, hint: 'Verse de la lave : elle coule, refroidit et durcit en roche' },
    { id: 'objects', label: 'Objets', key: 'o', mode: 0, rate: 0, hint: 'Pose un objet qui flotte et suit le courant' },
    { id: 'spring', label: 'Source', key: '8', mode: 0, rate: 0, hint: 'Pose ou retire une source qui coule en continu' },
    { id: 'sponge', label: 'Éponge', key: '9', mode: 6, rate: 1, hint: "Absorbe l'eau" },
    { id: 'hammer', label: 'Marteau', key: '0', mode: 0, rate: 0, hint: "Casse une vitre : l'eau et le sable se déversent" },
];

export function tool(id) {
    return TOOLS.find((t) => t.id === id);
}
// Glass walls, in the order of the simulation's sides: u = 0, u = 1, v = 0, v = 1.
export const SIDES = [
    { id: 'left', label: 'gauche' },
    { id: 'right', label: 'droite' },
    { id: 'front', label: 'avant' },
    { id: 'back', label: 'arrière' },
];

// Water speed multiplier offered by the slider.
export const WATER_SPEED = { min: 0.25, max: 3, initial: 1 };

/**
 * Water runs on its own clock: each simulation step adds `speed` to a credit, and every whole unit of credit
 * runs the water passes once. Below 1 the water skips steps, above 1 it runs several times per step;
 * the time step itself never changes, so the scheme stays stable at any speed.
 */
export function waterRuns(credit, speed) {
    const total = credit + Math.min(WATER_SPEED.max, Math.max(WATER_SPEED.min, speed));
    const runs = Math.floor(total);

    return { runs, credit: total - runs };
}

export function toolForKey(key) {
    return TOOLS.find((tool) => tool.key === key) ?? null;
}

/** Simulation steps for a rendered frame: enough to keep up with real time, capped so a slow frame cannot snowball. */
export function substepsFor(frameDt, { dt, maxSubsteps } = PHYSICS) {
    if (!(frameDt > 0)) {
        return 1;
    }

    return Math.min(maxSubsteps, Math.max(1, Math.round(frameDt / dt)));
}

/** Height difference two neighbouring cells may keep before sand slides, for a given state of the sand. */
export function talusHeight({ wetness, underwater }, cell = PHYSICS.world / PHYSICS.size) {
    const tan = underwater ? PHYSICS.talusUnder : PHYSICS.talusDry + (PHYSICS.talusWet - PHYSICS.talusDry) * wetness;

    return tan * cell;
}

/** Adds a spring at `uv`, or removes the one already there (within `radius`). Returns a new list. */
export function toggleSpring(springs, uv, radius) {
    const index = springs.findIndex(([x, y]) => Math.hypot(x - uv[0], y - uv[1]) < radius);
    if (index !== -1) {
        return springs.filter((_, i) => i !== index);
    }
    if (springs.length >= MAX_SPRINGS) {
        return [...springs.slice(1), uv];
    }

    return [...springs, uv];
}

/** World (x, z) on the box floor to simulation uv, and back. */
export function worldToUv(x, z) {
    return [(x / PHYSICS.world) + 0.5, 0.5 - (z / PHYSICS.world)];
}

export function uvToWorld(u, v) {
    return [(u - 0.5) * PHYSICS.world, (0.5 - v) * PHYSICS.world];
}

// Floating objects. \`radius\` (world units) is used for the collisions between objects.
export const MAX_OBJECTS = 48;
export const OBJECT_TYPES = [
    { id: 'duck', label: 'Canard', radius: 0.035 },
    { id: 'boat', label: 'Bateau en papier', radius: 0.045 },
    { id: 'leaf', label: 'Feuille', radius: 0.028 },
    { id: 'log', label: 'Bûche', radius: 0.045 },
    { id: 'ball', label: 'Ballon', radius: 0.025 },
    { id: 'surfer', label: 'Surfeur (1,75 m)', radius: 0.03 },
];

/**
 * Slot for a new object of \`type\`: the first free one, or the oldest when all are taken.
 * \`slots\` holds, per slot, { type, born } or null. Returns the slot index and the new list.
 */
export function placeObject(slots, type, born) {
    let index = slots.findIndex((slot) => slot === null);
    if (index === -1) {
        index = slots.reduce((oldest, slot, i) => (slot.born < slots[oldest].born ? i : oldest), 0);
    }
    const next = [...slots];
    next[index] = { type, born };

    return { index, slots: next };
}
// Live ocean: the tank becomes a beach and the real swell of a town (Open-Meteo) comes in from the back.
// Scale: the surfer is 1.75 m tall; lengths are scaled by OCEAN.metre and times by its square root
// (Froude similitude, as in wave-tank models), so heights, lengths and speeds keep their proportions.
export const OCEAN = {
    surferHeight: 1.75, // metres
    metre: 0.05 / 1.75, // world units per metre: the surfer model is 0.05 tall
    level: 0.14, // still-water level over the beach
    maxAmplitude: 0.06, // a storm swell is capped so the waves stay inside the glass
    refreshMinutes: 15,
};

/** Swell in the tank for a real swell of `height` m (crest to trough) and `period` s. */
export function oceanWaves(height, period) {
    const amplitude = Math.min(OCEAN.maxAmplitude, (height / 2) * OCEAN.metre);
    const scaledPeriod = Math.max(0.3, period * Math.sqrt(OCEAN.metre));

    return { amplitude, period: scaledPeriod, omega: (2 * Math.PI) / scaledPeriod };
}

/** The `current` block of an Open-Meteo marine response, or null when there is no sea there. */
export function parseMarine(response) {
    const current = response?.current;
    if (!current || typeof current.swell_wave_height !== 'number' || typeof current.swell_wave_period !== 'number') {
        return null;
    }

    return {
        height: current.swell_wave_height,
        period: current.swell_wave_period,
        direction: current.swell_wave_direction ?? null,
        waves: current.wave_height ?? null,
        temperature: current.sea_surface_temperature ?? null,
        time: current.time ?? null,
    };
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

/** "NO" for 313°: where the swell comes from, in French. */
export function compass(degrees) {
    return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
}
