// Physical constants and tool definitions shared by the GPU simulation and the interface.
// The box is 2 × 2 world units; heights are in the same units.
// Water is conserved: it only leaves through the sponge or a broken pane, and evaporates only while time is
// accelerated (see TIME and evaporation()).

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
    breakLoss: 0.012, // flow lost per water step where a wave breaks (live ocean)
    maxSpeed: 1.5, // water speed cap, world units per second (keeps the scheme stable)
    // Angle of repose: dry sand slides past ~32°, damp sand holds ~50°, underwater it slumps at ~25°.
    talusDry: deg(32),
    talusWet: deg(50),
    talusUnder: deg(25),
    // Earth (soil) holds better than sand: ~40° dry, ~55° damp, ~30° under water. The water wears it away half as fast.
    talusEarth: deg(40),
    talusEarthWet: deg(55),
    talusEarthUnder: deg(30),
    earthErosion: 0.5,
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
    digEarth: 0.8,
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
    { id: 'earth', label: 'Terre', key: 't', mode: 12, rate: 0.3, hint: "Ajoute de la terre : elle tient mieux que le sable et l'herbe y pousse mieux" },
    { id: 'clay', label: 'Argile', key: '3', mode: 8, rate: 0.3, hint: 'Ajoute de l’argile : elle garde sa forme et résiste à l’eau' },
    { id: 'rock', label: 'Roche', key: '4', mode: 7, rate: 0.3, hint: 'Ajoute de la roche : rien ne la déplace' },
    { id: 'push', label: 'Pousser', key: '5', mode: 3, rate: 0, hint: 'Déplace le sable dans le sens du geste' },
    { id: 'water', label: 'Eau', key: '6', mode: 4, rate: 0.45, hint: "Verse de l'eau" },
    { id: 'lava', label: 'Lave', key: '7', mode: 9, rate: 0.3, hint: 'Verse de la lave : elle coule, refroidit et durcit en roche' },
    { id: 'seeds', label: 'Graines', key: 'g', mode: 10, rate: 1.5, hint: "Sème de l'herbe (de la mousse sur la roche) : elle pousse là où le sol est humide" },
    { id: 'fire', label: 'Feu', key: 'f', mode: 11, rate: 0, hint: "Allume un feu : il gagne l'herbe et les arbres, l'eau l'arrête" },
    { id: 'objects', label: 'Objets', key: 'o', mode: 0, rate: 0, hint: 'Pose un objet qui flotte et suit le courant' },
    { id: 'spring', label: 'Source', key: '8', mode: 0, rate: 0, hint: 'Pose ou retire une source qui coule en continu' },
    { id: 'sponge', label: 'Éponge', key: '9', mode: 6, rate: 1, hint: "Absorbe l'eau" },
    { id: 'hammer', label: 'Marteau', key: '0', mode: 0, rate: 0, hint: "Casse une vitre : l'eau et le sable se déversent" },
    { id: 'meteor', label: 'Météorite', key: 'm', mode: 0, rate: 0, hint: 'Fait tomber une météorite : cratère, lave, vague et incendie' },
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

/**
 * Simulation steps for a frame when the physics runs `speed` times faster than real time (0 = paused).
 * The cap grows with the speed, so ×4 really is four times more steps, while a frozen tab still cannot snowball.
 */
export function physicsSteps(frameDt, speed, { dt, maxSubsteps } = PHYSICS) {
    if (!(speed > 0)) {
        return 0;
    }

    return substepsFor(frameDt * speed, { dt, maxSubsteps: maxSubsteps * Math.ceil(speed) });
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

/**
 * The swell as two trains: their periods differ by 9 %, so they beat into sets of bigger waves every ~11 waves,
 * and they arrive at slightly different angles. Each train: amplitude, angular frequency and wavenumber along
 * the back edge (kx, from the angle and the shallow-water wave speed at the back of the tank).
 */
export function oceanWaveTrain(height, period, backDepth = OCEAN.level - 0.03) {
    const { amplitude, omega } = oceanWaves(height, period);
    const speed = Math.sqrt(PHYSICS.gravity * backDepth);
    const train = (share, frequency, degrees) => ({
        amplitude: amplitude * share,
        omega: omega * frequency,
        kx: ((omega * frequency) / speed) * Math.sin((degrees * Math.PI) / 180),
    });

    return [train(0.72, 1, 10), train(0.42, 1.09, -6)];
}

// Time accelerator. Life and weather (plants, fire, day and night, evaporation) follow the chosen speed:
// they only multiply rates, so ×100 costs nothing. The physics (sand, water, lava) needs more steps per frame
// to go faster: it follows the speed up to `physicsCap`, lowered on machines that cannot keep up.
export const TIME = {
    speeds: [0, 1, 5, 20, 100], // 0 = pause
    initial: 1,
    physicsCap: 4,
    dayLength: 600, // seconds of tank time per day: 10 minutes at ×1, 6 seconds at ×100
    startHour: 10,
};

// Vegetation and fire. Rates are per second of tank time.
export const LIFE = {
    grassGrowth: 1 / 40, // a seed becomes a meadow in a few minutes of sunlight
    grassDecay: 1 / 300, // without water a meadow dries up within a day
    drown: 1 / 30, // under water, grass rots in about half a minute
    mossGrowth: 1 / 120,
    treeGrowth: 1 / 200, // trees take two or three days to grow out of a meadow
    moistureSpread: 3, // soil moisture spreads from the water through the ground (capillarity)...
    moistureLoss: 0.004, // ... and is lost slowly, faster in the sun: damp soil reaches ~25 cells from the water
    fireSpread: 6,
    burn: 0.6, // fuel burnt per second by a full fire
    ashFade: 1 / 300, // gone in half a day
    rootTalus: deg(62), // roots hold sand on steeper slopes...
    rootErosion: 0.8, // ... and against the current (share of the erosion they prevent)
    earthFertility: 1.6, // grass grows this much faster on earth than on sand
    evaporation: 0.00005, // depth per second in full sun, only while time is accelerated
};

/** Speeds of the physics and of life for a chosen speed of time. */
export function timeRates(speed, physicsCap = TIME.physicsCap) {
    return { physics: Math.min(speed, physicsCap), life: speed };
}

/**
 * Physics speed the machine can afford: lowered quickly when frames get slow, raised slowly when they are fast.
 * Never below real time, never above TIME.physicsCap.
 */
export function nextPhysicsCap(cap, frameDt) {
    if (frameDt > 0.03) {
        return Math.max(1, cap - 0.25);
    }
    if (frameDt < 0.02) {
        return Math.min(TIME.physicsCap, cap + 0.02);
    }

    return cap;
}

const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));

    return t * t * (3 - 2 * t);
};

/** Tank time (seconds since day 1, 00:00) to day, hour and minute. */
export function clockOf(seconds, dayLength = TIME.dayLength) {
    const total = Math.floor((seconds / dayLength) * 24 * 60 + 1e-6); // minutes since day 1, 00:00 (no 14:29.9999)
    const minutes = total % (24 * 60);

    return { day: Math.floor(total / (24 * 60)) + 1, hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

/** "Jour 2 · 14:05" */
export function clockLabel(seconds) {
    const { day, hour, minute } = clockOf(seconds);

    return `Jour ${day} · ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Light of the tank at a tank time. The sun rises at 6:00 on the +x side and sets at 18:00 on the -x side;
 * at night a dim, bluish moon lights the tank from the other side, so shapes stay readable.
 * Returns the direction of the light, `daylight` (0 at night, 1 in full sun: plants only grow by day) and the
 * colour of the light, intensity included (white at 10:00, the look the tank had before the cycle).
 */
export function sunAt(seconds, dayLength = TIME.dayLength) {
    const hour = ((((seconds / dayLength) % 1) + 1) % 1) * 24;
    const angle = (Math.PI * (hour - 6)) / 12;
    // Tilted so that at 10:00 the sun is exactly where the tank always had it, (0.55, 0.75, 0.35).
    const sun = [Math.cos(angle), 0.787 * Math.sin(angle), 0.318];
    const length = Math.hypot(...sun);
    const elevation = sun[1] / length;
    const daylight = smoothstep(0, 0.2, elevation);
    if (elevation >= 0) {
        const warmth = smoothstep(0.05, 0.5, elevation); // low sun: orange light
        const tint = [1, 0.62 + 0.38 * warmth, 0.38 + 0.62 * warmth].map((c) => c * daylight);

        return { direction: sun.map((c) => c / length), daylight, tint, hour };
    }
    const moon = [-sun[0], -sun[1], sun[2]].map((c) => c / length);
    const glow = 0.35 * smoothstep(0, 0.15, -elevation);

    return { direction: moon, daylight: 0, tint: [0.32 * glow, 0.4 * glow, 0.62 * glow], hour };
}

/** Water depth lost this frame: only while time is accelerated, never in the rain, mostly in the sun. */
export function evaporation(speed, lifeDt, daylight, raining) {
    if (speed <= 1 || raining) {
        return 0;
    }

    return LIFE.evaporation * lifeDt * (0.15 + 0.85 * daylight);
}

// Kinds of world offered by "Nouveau monde". `kind` is the index understood by the init shaders.
export const WORLDS = [
    { id: 'dunes', kind: 0, label: 'Dunes', hint: 'Sable et roche autour d’un lac' },
    { id: 'earth', kind: 1, label: 'Terre', hint: 'Collines de terre et prairies' },
    { id: 'earth-sand', kind: 2, label: 'Terre et sable', hint: 'De la terre, du sable par-dessus' },
];

/**
 * Meteorites. `radius` (uv) and `depth` (world units) of the crater; `lava`: depth of molten rock left at the
 * bottom; `fire`: radius of the blaze, in crater radii; `size`: radius of the falling rock; `shake` of the camera.
 * The biggest one blows out the panes it lands near.
 */
export const METEOR_SIZES = [
    { id: 'small', label: 'Petite', radius: 0.04, depth: 0.035, lava: 0.008, fire: 1.4, size: 0.014, shake: 0.008, breaksGlass: false },
    { id: 'medium', label: 'Moyenne', radius: 0.085, depth: 0.08, lava: 0.02, fire: 1.9, size: 0.028, shake: 0.02, breaksGlass: false },
    { id: 'huge', label: 'Énorme', radius: 0.17, depth: 0.15, lava: 0.04, fire: 2.4, size: 0.055, shake: 0.05, breaksGlass: true },
];

export const RIM = 0.2; // height of the rim, in crater depths: most of the dug material is blown away

/**
 * Change of ground height at `r` crater radii from the impact: a bowl down to -depth at the centre, a rim at the
 * edge. Same formula as craterShader.
 */
export function craterProfile(r, depth) {
    const bowl = r < 1 ? -depth * (1 - r * r) : 0;

    return bowl + RIM * depth * Math.exp(-(((r - 1) / 0.3) ** 2));
}

/**
 * Depth added to the ring of water around the crater (1.2 to 2 crater radii) for a `volume` of water pushed out
 * of it; half of it boils away.
 */
export function impactWave(volume, radius, world = PHYSICS.world) {
    const r = radius * world;
    const ring = Math.PI * ((2 * r) ** 2 - (1.2 * r) ** 2);

    return ring > 0 ? (0.5 * volume) / ring : 0;
}

/** Sides (order of SIDES) whose pane the shock of a meteorite at `uv` blows out. */
export function panesHit(uv, meteor) {
    if (!meteor.breaksGlass) {
        return [];
    }
    const reach = meteor.radius * 2 + 0.08;
    const distances = [uv[0], 1 - uv[0], uv[1], 1 - uv[1]];

    return distances.flatMap((distance, side) => (distance < reach ? [side] : []));
}
