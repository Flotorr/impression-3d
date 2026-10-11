import * as THREE from 'three';
import { impactWave, LIFE, MAX_SPRINGS, PHYSICS, physicsSteps, RIM, WATER_SPEED, waterRuns, WORLDS } from './sand-physics.js';
import {
    brushEarthShader,
    brushFireShader,
    brushLavaShader,
    brushPlantsShader,
    brushTerrainShader,
    beachShader,
    brushWaterShader,
    clearLayersShader,
    craterEarthShader,
    craterLavaShader,
    craterPlantsShader,
    craterSoilShader,
    craterTerrainShader,
    craterWaterShader,
    erosionEarthShader,
    erosionTerrainShader,
    erosionWaterShader,
    fillWaterShader,
    fluxShader,
    heightsShader,
    initEarthShader,
    initPlantsShader,
    initSoilShader,
    initTerrainShader,
    initWaterShader,
    lavaFluxShader,
    lavaShader,
    lavaSolidifyEarthShader,
    lavaSolidifyShader,
    lavaSolidifyTerrainShader,
    plantsShader,
    QUAD_VERTEX,
    slideApplyShader,
    slideOutShader,
    soilShader,
    waterShader,
} from './sand-sim-shaders.js';

/** Two render targets swapped after each write, so a pass can read the previous state while writing the next. */
export class PingPong {
    constructor(width, options, height = width) {
        this.read = new THREE.WebGLRenderTarget(width, height, options);
        this.write = new THREE.WebGLRenderTarget(width, height, options);
    }

    swap() {
        [this.read, this.write] = [this.write, this.read];
    }

    get texture() {
        return this.read.texture;
    }

    dispose() {
        this.read.dispose();
        this.write.dispose();
    }
}

const SAMPLERS = ['uTerrain', 'uEarth', 'uLava', 'uWater', 'uFlux', 'uLavaFlux', 'uSlide', 'uSlideDiagonal', 'uPlants', 'uSoil'];
// Brush modes understood by the shaders (see TOOLS in sand-physics.js).
const TERRAIN_MODES = new Set([1, 2, 3, 7, 8, 12]);
// Modes that change the earth: digging, adding earth, and rock or clay, which turn the earth under them.
const EARTH_MODES = new Set([1, 7, 8, 12]);
const LAVA_MODE = 9;
const HEIGHT_MAP = 128; // side of the height map read back by the CPU
const SEEDS_MODE = 10;
const FIRE_MODE = 11;
// Sowing changes the plants, and so does every tool that digs or covers the ground.
const PLANT_MODES = new Set([...TERRAIN_MODES, SEEDS_MODE]);

/**
 * Sand, earth, clay, rock, lava and water simulation on the GPU. One frame = brush passes, then a few substeps of:
 * sand and earth avalanches → lava flow, cooling and hardening → water flux → water depth and velocity → erosion and wetness.
 * The water passes run on their own credit (see waterRuns) so their speed can be tuned.
 * Plants, soil moisture and fire (stepLife) run once per frame on the clock of life, which can go much faster.
 */
export class SandSimulation {
    constructor(renderer, { size = PHYSICS.size } = {}) {
        this.renderer = renderer;
        this.size = size;
        const float = renderer.extensions.has('EXT_color_buffer_float');
        const linear = !float || renderer.extensions.has('OES_texture_float_linear');
        this.dataType = float ? THREE.FloatType : THREE.HalfFloatType;
        const options = {
            type: this.dataType,
            format: THREE.RGBAFormat,
            minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
            magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
            wrapS: THREE.ClampToEdgeWrapping,
            wrapT: THREE.ClampToEdgeWrapping,
            depthBuffer: false,
        };
        this.terrain = new PingPong(size, options);
        this.lava = new PingPong(size, options);
        this.water = new PingPong(size, options);
        this.flux = new PingPong(size, options);
        this.lavaFlux = new PingPong(size, options);
        this.slide = new PingPong(size, options);
        this.slideDiagonal = new PingPong(size, options);
        this.earth = new PingPong(size, options);
        this.earthSlide = new PingPong(size, options);
        this.earthSlideDiagonal = new PingPong(size, options);
        this.plants = new PingPong(size, options);
        this.soil = new PingPong(size, options);

        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
        this.quadScene = new THREE.Scene();
        this.quadScene.add(this.quad);

        const common = {
            uTexel: { value: new THREE.Vector2(1 / size, 1 / size) },
            uCell: { value: PHYSICS.world / size },
            uDt: { value: PHYSICS.dt },
            uBroken: { value: new THREE.Vector4(0, 0, 0, 0) }, // explicit: a bare Vector4() has w = 1, i.e. the back pane broken
        };
        this.broken = common.uBroken.value;
        this.waterSpeed = WATER_SPEED.initial;
        this.waterCredit = 0;
        this.brush = {
            uMode: { value: 0 },
            uBrush: { value: new THREE.Vector2(-1, -1) },
            uRadius: { value: 0.08 },
            uAmount: { value: 0 },
        };
        this.springs = [];
        this.rain = false;
        this.evaporate = 0; // water depth evaporated by the next step (see evaporation() in sand-physics.js)
        this.erosion = true;
        this.time = 0;

        const pass = (fragmentShader, uniforms = {}) => new THREE.ShaderMaterial({
            vertexShader: QUAD_VERTEX,
            fragmentShader,
            uniforms: {
                ...common,
                ...Object.fromEntries(SAMPLERS.map((name) => [name, { value: null }])),
                ...uniforms,
            },
            depthTest: false,
            depthWrite: false,
        });
        const erosion = {
            uCapacity: { value: PHYSICS.erosionCapacity },
            uDissolve: { value: PHYSICS.erosionDissolve },
            uDeposit: { value: PHYSICS.erosionDeposit },
            uClayErosion: { value: PHYSICS.clayErosion },
            uEarthErosion: { value: PHYSICS.earthErosion },
            uErosion: { value: 1 },
            uRootErosion: { value: LIFE.rootErosion },
        };
        this.erosionSwitch = erosion.uErosion;
        const freezing = { uFreezing: { value: PHYSICS.lavaFreezing } };
        // Clock of life, shared by the soil and plants passes.
        this.life = {
            uLifeDt: { value: 0 },
            uLifeTime: { value: 0 },
            uDaylight: { value: 1 },
        };
        const waterDt = { uDt: { value: PHYSICS.dt / PHYSICS.waterSteps } };
        // Live ocean, shared by the flux (breaking) and water (wave maker) passes.
        const waves = { uWaves: { value: new THREE.Vector4(0, 0, 0, 0) }, uWaves2: { value: new THREE.Vector4(0, 0, 0, 0) } };

        // A new world: the same seed, lake and kind for every layer.
        const world = { uSeed: { value: new THREE.Vector2() }, uBasin: { value: new THREE.Vector2() }, uKind: { value: 0 } };
        this.world = world;
        // The terrain and earth brushes run the same code on the same inputs (see BRUSH_STACK).
        const stack = {
            ...this.brush,
            uDrag: { value: new THREE.Vector2() },
            uMaxSand: { value: PHYSICS.maxSand },
            uDigClay: { value: PHYSICS.digClay },
            uDigRock: { value: PHYSICS.digRock },
            uDigEarth: { value: PHYSICS.digEarth },
        };
        this.drag = stack.uDrag.value;
        // Meteorite, shared by the crater passes.
        this.impactUniforms = {
            uImpact: { value: new THREE.Vector2() },
            uImpactRadius: { value: 0.1 },
            uImpactDepth: { value: 0.05 },
            uRim: { value: RIM },
            uMaxSand: { value: PHYSICS.maxSand },
            uImpactLava: { value: 0 },
            uWave: { value: 0 },
            uFireRadius: { value: 2 },
        };
        const impact = this.impactUniforms;

        this.passes = {
            initTerrain: pass(initTerrainShader, world),
            initEarth: pass(initEarthShader, world),
            initWater: pass(initWaterShader, { uBasin: world.uBasin, uLevel: { value: 0 } }),
            brushTerrain: pass(brushTerrainShader, stack),
            brushEarth: pass(brushEarthShader, stack),
            brushWater: pass(brushWaterShader, {
                ...this.brush,
                uSprings: { value: Array.from({ length: MAX_SPRINGS }, () => new THREE.Vector2()) },
                uSpringCount: { value: 0 },
                uSpringRate: { value: PHYSICS.springRate },
                uRain: { value: 0 },
                uFrameDt: { value: 0 },
                uTime: { value: 0 },
                uEvaporate: { value: 0 },
            }),
            brushLava: pass(brushLavaShader, this.brush),
            brushPlants: pass(brushPlantsShader, this.brush),
            brushFire: pass(brushFireShader, this.brush),
            initPlants: pass(initPlantsShader, world),
            initSoil: pass(initSoilShader, world),
            craterTerrain: pass(craterTerrainShader, impact),
            craterEarth: pass(craterEarthShader, impact),
            craterLava: pass(craterLavaShader, impact),
            craterWater: pass(craterWaterShader, impact),
            craterPlants: pass(craterPlantsShader, impact),
            craterSoil: pass(craterSoilShader, impact),
            soil: pass(soilShader, {
                ...this.life,
                uMoistureSpread: { value: LIFE.moistureSpread },
                uMoistureLoss: { value: LIFE.moistureLoss },
                uFireSpread: { value: LIFE.fireSpread },
            }),
            plants: pass(plantsShader, {
                ...this.life,
                uGrassGrowth: { value: LIFE.grassGrowth },
                uGrassDecay: { value: LIFE.grassDecay },
                uDrown: { value: LIFE.drown },
                uMossGrowth: { value: LIFE.mossGrowth },
                uTreeGrowth: { value: LIFE.treeGrowth },
                uBurn: { value: LIFE.burn },
                uAshFade: { value: LIFE.ashFade },
                uEarthFertility: { value: LIFE.earthFertility },
            }),
            slideOut: pass(slideOutShader, {
                uTalusDry: { value: PHYSICS.talusDry },
                uTalusWet: { value: PHYSICS.talusWet },
                uTalusUnder: { value: PHYSICS.talusUnder },
                uSlideRate: { value: PHYSICS.slideRate },
                uDiagonal: { value: 0 },
                uTalusRoots: { value: LIFE.rootTalus },
                uMaterial: { value: 0 },
                uTalusEarth: { value: new THREE.Vector3(PHYSICS.talusEarth, PHYSICS.talusEarthWet, PHYSICS.talusEarthUnder) },
            }),
            slideApply: pass(slideApplyShader),
            lavaFlux: pass(lavaFluxShader, {
                uGravity: { value: PHYSICS.gravity },
                uLavaFluidity: { value: PHYSICS.lavaFluidity },
                uLavaDamping: { value: PHYSICS.lavaDamping },
            }),
            lava: pass(lavaShader, { uCooling: { value: PHYSICS.lavaCooling }, uQuench: { value: PHYSICS.lavaQuench } }),
            lavaSolidifyTerrain: pass(lavaSolidifyTerrainShader, freezing),
            lavaSolidify: pass(lavaSolidifyShader, freezing),
            lavaSolidifyEarth: pass(lavaSolidifyEarthShader, freezing),
            // The water passes use their own, shorter time step (see PHYSICS.waterSteps).
            flux: pass(fluxShader, {
                ...waterDt,
                ...waves,
                uGravity: { value: PHYSICS.gravity },
                uDamping: { value: PHYSICS.fluxDamping },
                uBreakLoss: { value: PHYSICS.breakLoss },
            }),
            water: pass(waterShader, {
                ...waterDt,
                ...waves,
                uMaxSpeed: { value: PHYSICS.maxSpeed },
                uWorld: { value: PHYSICS.world },
                uWaveTime: { value: 0 },
            }),
            beach: pass(beachShader, { uLevel: { value: 0 } }),
            erosionWater: pass(erosionWaterShader, { ...erosion, ...waterDt }),
            erosionTerrain: pass(erosionTerrainShader, { ...erosion, ...waterDt, uDrying: { value: PHYSICS.drying } }),
            erosionEarth: pass(erosionEarthShader, { ...erosion, ...waterDt }),
            clearLayers: pass(clearLayersShader, { uKeep: { value: new THREE.Vector4(1, 1, 1, 1) } }),
            fillWater: pass(fillWaterShader, { uLevel: { value: 0 } }),
            heights: pass(heightsShader),
        };

        this.heights = new THREE.WebGLRenderTarget(HEIGHT_MAP, HEIGHT_MAP, options);
        this.heightMap = null;
        this.readingHeights = false;
        this.lavaActive = false;
        this.lavaPoured = 0; // pours so far: a map read before the last pour cannot turn the lava passes off
        this.earthActive = false; // the same for the earth passes
        this.earthAdded = 0;
    }

    /**
     * Renders `material` into `target.write` with the given input textures, then swaps. The earth is part of the
     * height of the ground almost everywhere: it is bound unless `inputs` gives another one (an earlier state).
     */
    run(material, target, inputs = {}) {
        if (material.uniforms.uEarth) {
            material.uniforms.uEarth.value = this.earth.texture;
        }
        for (const [name, texture] of Object.entries(inputs)) {
            material.uniforms[name].value = texture;
        }
        this.quad.material = material;
        this.renderer.setRenderTarget(target.write);
        this.renderer.render(this.quadScene, this.camera);
        target.swap();
    }

    clear(target) {
        const color = this.renderer.getClearColor(new THREE.Color());
        const alpha = this.renderer.getClearAlpha();
        this.renderer.setClearColor(0x000000, 0);
        for (const rt of [target.read, target.write]) {
            this.renderer.setRenderTarget(rt);
            this.renderer.clear(true, false, false);
        }
        this.renderer.setClearColor(color, alpha);
    }

    /** A new world of the kind `world` (id from WORLDS), with a lake in a hollow, meadows and a few groves. */
    reset(random = Math.random, world = 'dunes') {
        const { passes } = this;
        const kind = WORLDS.find(({ id }) => id === world)?.kind ?? 0;
        this.world.uKind.value = kind;
        this.world.uSeed.value.set(random() * 100, random() * 100);
        this.world.uBasin.value.set(0.3 + random() * 0.4, 0.3 + random() * 0.4);
        this.run(passes.initTerrain, this.terrain);
        this.run(passes.initEarth, this.earth);
        passes.initWater.uniforms.uLevel.value = 0.1;
        this.run(passes.initWater, this.water, { uTerrain: this.terrain.texture });
        this.run(passes.initPlants, this.plants, { uTerrain: this.terrain.texture, uWater: this.water.texture });
        this.run(passes.initSoil, this.soil);
        this.earthActive = kind > 0;
        this.earthAdded++;
        for (const target of [this.lava, this.flux, this.lavaFlux, this.slide, this.slideDiagonal, this.earthSlide, this.earthSlideDiagonal]) {
            this.clear(target);
        }
        this.renderer.setRenderTarget(null);
    }

    /**
     * `mode` 0 = idle (see TOOLS for the others); `uv` brush centre; `amount` per frame; `drag` uv delta for the push tool.
     */
    setBrush({ mode = 0, uv = [-1, -1], radius = 0.08, amount = 0, drag = [0, 0] }) {
        this.brush.uMode.value = mode;
        this.brush.uBrush.value.set(uv[0], uv[1]);
        this.brush.uRadius.value = radius;
        this.brush.uAmount.value = amount;
        this.drag.set(drag[0], drag[1]);
    }

    setSprings(springs) {
        this.springs = springs.slice(0, MAX_SPRINGS);
        const { uniforms } = this.passes.brushWater;
        this.springs.forEach(([u, v], i) => uniforms.uSprings.value[i].set(u, v));
        uniforms.uSpringCount.value = this.springs.length;
    }

    /** `sides` [left, right, front, back]: true where the glass is broken. */
    setBroken(sides) {
        this.broken.set(...sides.map((side) => (side ? 1 : 0)));
    }

    /** Removes the sand only, with the grass and the trees that grew on it (the moss on the rock stays). */
    clearSand() {
        const { uKeep } = this.passes.clearLayers.uniforms;
        uKeep.value.set(0, 1, 1, 1);
        this.run(this.passes.clearLayers, this.terrain, { uTerrain: this.terrain.texture });
        uKeep.value.set(0, 1, 0, 0);
        this.run(this.passes.clearLayers, this.plants, { uTerrain: this.plants.texture });
        this.clear(this.slide);
        this.clear(this.slideDiagonal);
        this.renderer.setRenderTarget(null);
    }

    /** Removes the earth only, with what grew on it. */
    clearEarth() {
        this.clear(this.earth);
        this.clear(this.earthSlide);
        this.clear(this.earthSlideDiagonal);
        this.renderer.setRenderTarget(null);
    }

    /** Removes every plant, the ash and the fires; the ground stays as damp as it was. */
    clearPlants() {
        this.clear(this.plants);
        this.passes.clearLayers.uniforms.uKeep.value.set(1, 0, 0, 0);
        this.run(this.passes.clearLayers, this.soil, { uTerrain: this.soil.texture });
        this.renderer.setRenderTarget(null);
    }

    clearLava() {
        this.clear(this.lava);
        this.clear(this.lavaFlux);
        this.renderer.setRenderTarget(null);
    }

    /** An empty tank: no sand, clay, rock, lava, water or plants. */
    clearAll() {
        for (const target of this.targets()) {
            this.clear(target);
        }
        this.renderer.setRenderTarget(null);
    }

    /** Raises the water everywhere to \`level\` (world height), without lowering it where it is already higher. */
    fill(level = PHYSICS.fillLevel) {
        this.passes.fillWater.uniforms.uLevel.value = level;
        this.run(this.passes.fillWater, this.water, {
            uTerrain: this.terrain.texture,
            uLava: this.lava.texture,
            uWater: this.water.texture,
        });
        this.renderer.setRenderTarget(null);
    }

    /** A beach with still water up to `level`, ready for the swell. */
    makeBeach(level) {
        this.clearAll();
        this.passes.beach.uniforms.uLevel.value = level;
        this.run(this.passes.beach, this.terrain);
        this.fill(level);
    }

    /** Swell pushed in from the back edge, as the two trains of oceanWaveTrain(); `null` stops it. */
    setWaves(trains, level) {
        const { uWaves, uWaves2 } = this.passes.water.uniforms;
        if (!trains) {
            uWaves.value.w = 0;
            return;
        }
        const [a, b] = trains;
        uWaves.value.set(a.amplitude, a.omega, level, 1);
        uWaves2.value.set(b.amplitude, b.omega, a.kx, b.kx);
    }

    drain() {
        this.clear(this.water);
        this.clear(this.flux);
        this.renderer.setRenderTarget(null);
    }

    /**
     * One frame: the brush, at the pace of the hand whatever the speed, then the physics, run `speed` times
     * faster than real time. Paused (0), the brush still shapes the ground but nothing flows.
     */
    step(frameDt, speed = 1) {
        const { passes } = this;
        const dt = Math.min(frameDt, 0.1);
        const physicsDt = dt * speed;
        this.time += physicsDt;

        const mode = this.brush.uMode.value;
        if (PLANT_MODES.has(mode)) {
            // Before the terrain changes: the plants of the top layer go with it.
            this.run(passes.brushPlants, this.plants, { uPlants: this.plants.texture, uTerrain: this.terrain.texture });
        }
        // The terrain and the earth change together: both brushes read the state from before either.
        const terrain = this.terrain.texture;
        const earth = this.earth.texture;
        if (EARTH_MODES.has(mode)) {
            this.run(passes.brushEarth, this.earth, { uTerrain: terrain, uEarth: earth });
            this.earthActive = true;
            this.earthAdded++;
        }
        if (TERRAIN_MODES.has(mode)) {
            this.run(passes.brushTerrain, this.terrain, { uTerrain: terrain, uEarth: earth });
        }
        if (mode === LAVA_MODE) {
            this.run(passes.brushLava, this.lava, { uLava: this.lava.texture });
            this.lavaActive = true;
            this.lavaPoured++;
        }
        if (mode === FIRE_MODE) {
            this.run(passes.brushFire, this.soil, { uSoil: this.soil.texture });
        }
        passes.brushWater.uniforms.uRain.value = this.rain ? PHYSICS.rain : 0;
        passes.brushWater.uniforms.uFrameDt.value = physicsDt;
        passes.brushWater.uniforms.uTime.value = this.time;
        passes.brushWater.uniforms.uEvaporate.value = this.evaporate;
        this.run(passes.brushWater, this.water, { uWater: this.water.texture });
        this.erosionSwitch.value = this.erosion ? 1 : 0;

        for (let i = physicsSteps(dt, speed); i > 0; i--) {
            this.stepSand();
            if (this.lavaActive) {
                this.stepLava(); // 4 passes saved while there is no lava
            }
            const { runs, credit } = waterRuns(this.waterCredit, this.waterSpeed);
            this.waterCredit = credit;
            for (let run = 0; run < runs * PHYSICS.waterSteps; run++) {
                this.stepWater();
            }
        }
        this.renderer.setRenderTarget(null);
    }

    /**
     * Plants, soil moisture and fire, for `lifeDt` seconds of tank time; `daylight` is 0 at night, 1 in full sun.
     * Both passes read the same state, so the fuel that burns is the fuel that was there.
     */
    stepLife(lifeDt, daylight) {
        if (!(lifeDt > 0)) {
            return;
        }
        const { life, passes } = this;
        life.uLifeDt.value = Math.min(lifeDt, 3);
        life.uLifeTime.value += lifeDt;
        life.uDaylight.value = daylight;
        const inputs = {
            uTerrain: this.terrain.texture,
            uLava: this.lava.texture,
            uWater: this.water.texture,
            uPlants: this.plants.texture,
            uSoil: this.soil.texture,
        };
        this.run(passes.soil, this.soil, inputs);
        this.run(passes.plants, this.plants, inputs);
        this.renderer.setRenderTarget(null);
    }

    /**
     * Avalanches: the shares sent to the 8 neighbours, then the exchange; for the sand, then for the earth (only
     * while there is earth). Every share is computed from the same state.
     */
    stepSand() {
        const { passes } = this;
        const { uDiagonal, uMaterial } = passes.slideOut.uniforms;
        const inputs = {
            uTerrain: this.terrain.texture,
            uEarth: this.earth.texture,
            uLava: this.lava.texture,
            uWater: this.water.texture,
            uPlants: this.plants.texture,
        };
        const shares = (material, cardinal, diagonal) => {
            uMaterial.value = material;
            uDiagonal.value = 0;
            this.run(passes.slideOut, cardinal, inputs);
            uDiagonal.value = 1;
            this.run(passes.slideOut, diagonal, inputs);
        };
        shares(0, this.slide, this.slideDiagonal);
        if (this.earthActive) {
            shares(1, this.earthSlide, this.earthSlideDiagonal);
        }
        // slideApply moves the .r channel of the texture it is given: sand in the terrain, or the earth.
        this.run(passes.slideApply, this.terrain, {
            uTerrain: this.terrain.texture,
            uSlide: this.slide.texture,
            uSlideDiagonal: this.slideDiagonal.texture,
        });
        if (this.earthActive) {
            this.run(passes.slideApply, this.earth, {
                uTerrain: this.earth.texture,
                uSlide: this.earthSlide.texture,
                uSlideDiagonal: this.earthSlideDiagonal.texture,
            });
        }
    }

    /** Lava flow and cooling, then cold lava turns into rock (both passes read the same lava). */
    stepLava() {
        const { passes } = this;
        this.run(passes.lavaFlux, this.lavaFlux, {
            uTerrain: this.terrain.texture,
            uLava: this.lava.texture,
            uLavaFlux: this.lavaFlux.texture,
        });
        this.run(passes.lava, this.lava, { uLava: this.lava.texture, uLavaFlux: this.lavaFlux.texture, uWater: this.water.texture });
        const lava = this.lava.texture;
        const earth = this.earth.texture;
        this.run(passes.lavaSolidifyTerrain, this.terrain, { uTerrain: this.terrain.texture, uEarth: earth, uLava: lava });
        if (this.earthActive) {
            this.run(passes.lavaSolidifyEarth, this.earth, { uEarth: earth, uLava: lava });
        }
        this.run(passes.lavaSolidify, this.lava, { uLava: lava });
    }

    /** Water flux, depth and velocity, then erosion and wetness: one step of the water clock. */
    stepWater() {
        const { passes } = this;
        this.run(passes.flux, this.flux, {
            uTerrain: this.terrain.texture,
            uLava: this.lava.texture,
            uWater: this.water.texture,
            uFlux: this.flux.texture,
        });
        passes.water.uniforms.uWaveTime.value = this.time;
        this.run(passes.water, this.water, {
            uTerrain: this.terrain.texture,
            uLava: this.lava.texture,
            uWater: this.water.texture,
            uFlux: this.flux.texture,
        });

        // Both erosion passes read the same terrain and water, so they agree on how much material moved.
        const inputs = {
            uTerrain: this.terrain.texture,
            uEarth: this.earth.texture,
            uLava: this.lava.texture,
            uWater: this.water.texture,
            uPlants: this.plants.texture,
        };
        if (this.erosion && this.earthActive) {
            this.run(passes.erosionEarth, this.earth, inputs);
        }
        if (this.erosion) {
            this.run(passes.erosionWater, this.water, inputs); // the terrain pass still runs: it also wets and dries the sand
        }
        this.run(passes.erosionTerrain, this.terrain, inputs);
    }

    /**
     * Starts reading the height map back (see heightsShader), unless a read is still on its way. The GPU writes it
     * into a buffer and the CPU picks it up a frame or two later: nothing waits, unlike readRenderTargetPixels.
     */
    refreshHeights() {
        if (this.readingHeights) {
            return;
        }
        this.readingHeights = true;
        const poured = this.lavaPoured;
        const added = this.earthAdded;
        const { uniforms } = this.passes.heights;
        uniforms.uTerrain.value = this.terrain.texture;
        uniforms.uEarth.value = this.earth.texture;
        uniforms.uLava.value = this.lava.texture;
        uniforms.uWater.value = this.water.texture;
        this.quad.material = this.passes.heights;
        this.renderer.setRenderTarget(this.heights);
        this.renderer.render(this.quadScene, this.camera);
        this.renderer.setRenderTarget(null);
        const n = HEIGHT_MAP;
        const buffer = this.dataType === THREE.FloatType ? new Float32Array(n * n * 4) : new Uint16Array(n * n * 4);
        this.renderer.readRenderTargetPixelsAsync(this.heights, 0, 0, n, n, buffer)
            .then(() => {
                const map = buffer instanceof Float32Array ? buffer : Float32Array.from(buffer, (v) => THREE.DataUtils.fromHalfFloat(v));
                this.heightMap = map;
                // The lava and earth passes only run while there is some (or while some is being added).
                let lava = false;
                let earth = false;
                for (let i = 0; i < map.length && !(lava && earth); i += 4) {
                    lava ||= map[i + 2] > 0;
                    earth ||= map[i + 3] > 0;
                }
                this.lavaActive = lava || this.lavaPoured !== poured;
                this.earthActive = earth || this.earthAdded !== added;
            })
            .catch(() => {})
            .finally(() => {
                this.readingHeights = false;
            });
    }

    /** Value `channel` (0 ground, 1 water, 2 lava) of the height map at texel (x, y). */
    mapAt(x, y, channel) {
        const n = HEIGHT_MAP;

        return this.heightMap[(Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))) * 4 + channel];
    }

    /** Water depth along one edge (side order of SIDES), from the height map; index = position along the edge. */
    edgeDepths(side) {
        if (!this.heightMap) {
            return [];
        }
        const n = HEIGHT_MAP;
        const at = [(i) => [0, i], (i) => [n - 1, i], (i) => [i, 0], (i) => [i, n - 1]][side];

        return Array.from({ length: n }, (_, i) => this.mapAt(...at(i), 1));
    }

    /** Ground height (rock + clay + sand + lava) and water depth at `uv`, from the height map (for picking). */
    sample(uv) {
        if (!this.heightMap) {
            return { ground: 0.12, water: 0 };
        }
        const x = Math.floor(uv[0] * HEIGHT_MAP);
        const y = Math.floor(uv[1] * HEIGHT_MAP);

        return { ground: this.mapAt(x, y, 0), water: this.mapAt(x, y, 1) };
    }

    /**
     * A meteorite strikes at `uv` (see METEOR_SIZES): a crater with a rim, molten rock at the bottom, the water
     * of the crater blown out into a ring wave, the plants destroyed and set on fire around it. Every pass reads
     * the state from before the impact.
     */
    impact(uv, meteor) {
        const { passes } = this;
        const u = this.impactUniforms;
        u.uImpact.value.set(uv[0], uv[1]);
        u.uImpactRadius.value = meteor.radius;
        u.uImpactDepth.value = meteor.depth;
        u.uImpactLava.value = meteor.lava;
        u.uFireRadius.value = meteor.fire;
        u.uWave.value = impactWave(this.waterIn(uv, meteor.radius * 1.15), meteor.radius);
        const inputs = {
            uTerrain: this.terrain.texture,
            uEarth: this.earth.texture,
            uLava: this.lava.texture,
            uWater: this.water.texture,
            uPlants: this.plants.texture,
            uSoil: this.soil.texture,
        };
        this.run(passes.craterTerrain, this.terrain, inputs);
        this.run(passes.craterEarth, this.earth, inputs);
        this.run(passes.craterLava, this.lava, inputs);
        this.run(passes.craterWater, this.water, inputs);
        this.run(passes.craterPlants, this.plants, inputs);
        this.run(passes.craterSoil, this.soil, inputs);
        this.clear(this.flux); // the old currents would carry on through the crater
        this.lavaActive = true;
        this.lavaPoured++;
        this.renderer.setRenderTarget(null);
    }

    /** Volume of water (world units³) within `radius` (uv) of `uv`, from the height map. */
    waterIn(uv, radius) {
        if (!this.heightMap) {
            return 0;
        }
        const n = HEIGHT_MAP;
        const cell = (PHYSICS.world / n) ** 2;
        let volume = 0;
        const reach = Math.ceil(radius * n);
        const [cx, cy] = [Math.floor(uv[0] * n), Math.floor(uv[1] * n)];
        for (let y = cy - reach; y <= cy + reach; y++) {
            for (let x = cx - reach; x <= cx + reach; x++) {
                if (x >= 0 && y >= 0 && x < n && y < n && Math.hypot((x + 0.5) / n - uv[0], (y + 0.5) / n - uv[1]) < radius) {
                    volume += this.mapAt(x, y, 1) * cell;
                }
            }
        }

        return volume;
    }

    targets() {
        return [
            this.terrain, this.earth, this.lava, this.water, this.flux, this.lavaFlux, this.slide, this.slideDiagonal,
            this.earthSlide, this.earthSlideDiagonal, this.plants, this.soil,
        ];
    }

    dispose() {
        this.heights.dispose();
        for (const target of this.targets()) {
            target.dispose();
        }
        for (const material of Object.values(this.passes)) {
            material.dispose();
        }
        this.quad.geometry.dispose();
    }
}
