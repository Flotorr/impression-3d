import * as THREE from 'three';
import { MAX_SPRINGS, PHYSICS, substepsFor, WATER_SPEED, waterRuns } from './sand-physics.js';
import {
    brushLavaShader,
    brushTerrainShader,
    beachShader,
    brushWaterShader,
    clearLayersShader,
    erosionTerrainShader,
    erosionWaterShader,
    fillWaterShader,
    fluxShader,
    initTerrainShader,
    initWaterShader,
    lavaFluxShader,
    lavaShader,
    lavaSolidifyShader,
    lavaSolidifyTerrainShader,
    QUAD_VERTEX,
    slideApplyShader,
    slideOutShader,
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

const SAMPLERS = ['uTerrain', 'uLava', 'uWater', 'uFlux', 'uLavaFlux', 'uSlide', 'uSlideDiagonal'];
// Brush modes understood by the shaders (see TOOLS in sand-physics.js).
const TERRAIN_MODES = new Set([1, 2, 3, 7, 8]);
const LAVA_MODE = 9;

/**
 * Sand, clay, rock, lava and water simulation on the GPU. One frame = brush passes, then a few substeps of:
 * sand avalanches → lava flow, cooling and hardening → water flux → water depth and velocity → erosion and wetness.
 * The water passes run on their own credit (see waterRuns) so their speed can be tuned.
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
            uErosion: { value: 1 },
        };
        this.erosionSwitch = erosion.uErosion;
        const freezing = { uFreezing: { value: PHYSICS.lavaFreezing } };
        const waterDt = { uDt: { value: PHYSICS.dt / PHYSICS.waterSteps } };

        this.passes = {
            initTerrain: pass(initTerrainShader, { uSeed: { value: new THREE.Vector2() }, uBasin: { value: new THREE.Vector2() } }),
            initWater: pass(initWaterShader, { uBasin: { value: new THREE.Vector2() }, uLevel: { value: 0 } }),
            brushTerrain: pass(brushTerrainShader, {
                ...this.brush,
                uDrag: { value: new THREE.Vector2() },
                uMaxSand: { value: PHYSICS.maxSand },
                uDigClay: { value: PHYSICS.digClay },
                uDigRock: { value: PHYSICS.digRock },
            }),
            brushWater: pass(brushWaterShader, {
                ...this.brush,
                uSprings: { value: Array.from({ length: MAX_SPRINGS }, () => new THREE.Vector2()) },
                uSpringCount: { value: 0 },
                uSpringRate: { value: PHYSICS.springRate },
                uRain: { value: 0 },
                uFrameDt: { value: 0 },
                uTime: { value: 0 },
            }),
            brushLava: pass(brushLavaShader, this.brush),
            slideOut: pass(slideOutShader, {
                uTalusDry: { value: PHYSICS.talusDry },
                uTalusWet: { value: PHYSICS.talusWet },
                uTalusUnder: { value: PHYSICS.talusUnder },
                uSlideRate: { value: PHYSICS.slideRate },
                uDiagonal: { value: 0 },
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
            // The water passes use their own, shorter time step (see PHYSICS.waterSteps).
            flux: pass(fluxShader, { ...waterDt, uGravity: { value: PHYSICS.gravity }, uDamping: { value: PHYSICS.fluxDamping } }),
            water: pass(waterShader, {
                ...waterDt,
                uMaxSpeed: { value: PHYSICS.maxSpeed },
                uWorld: { value: PHYSICS.world },
                uWaves: { value: new THREE.Vector4(0, 0, 0, 0) },
                uWaveTime: { value: 0 },
            }),
            beach: pass(beachShader, { uLevel: { value: 0 } }),
            erosionWater: pass(erosionWaterShader, { ...erosion, ...waterDt }),
            erosionTerrain: pass(erosionTerrainShader, { ...erosion, ...waterDt, uDrying: { value: PHYSICS.drying } }),
            clearLayers: pass(clearLayersShader, { uKeep: { value: new THREE.Vector4(1, 1, 1, 1) } }),
            fillWater: pass(fillWaterShader, { uLevel: { value: 0 } }),
        };

        this.readBuffer = this.dataType === THREE.FloatType ? new Float32Array(4) : new Uint16Array(4);
    }

    /** Renders `material` into `target.write` with the given input textures, then swaps. */
    run(material, target, inputs = {}) {
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

    /** New dunes over a rocky bed, with a lake in a hollow. */
    reset(random = Math.random) {
        const basin = new THREE.Vector2(0.3 + random() * 0.4, 0.3 + random() * 0.4);
        const { initTerrain, initWater } = this.passes;
        initTerrain.uniforms.uSeed.value.set(random() * 100, random() * 100);
        initTerrain.uniforms.uBasin.value.copy(basin);
        this.run(initTerrain, this.terrain);
        initWater.uniforms.uBasin.value.copy(basin);
        initWater.uniforms.uLevel.value = 0.1;
        this.run(initWater, this.water, { uTerrain: this.terrain.texture });
        for (const target of [this.lava, this.flux, this.lavaFlux, this.slide, this.slideDiagonal]) {
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
        this.passes.brushTerrain.uniforms.uDrag.value.set(drag[0], drag[1]);
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

    /** Removes the sand only. */
    clearSand() {
        this.passes.clearLayers.uniforms.uKeep.value.set(0, 1, 1, 1);
        this.run(this.passes.clearLayers, this.terrain, { uTerrain: this.terrain.texture });
        this.clear(this.slide);
        this.clear(this.slideDiagonal);
        this.renderer.setRenderTarget(null);
    }

    clearLava() {
        this.clear(this.lava);
        this.clear(this.lavaFlux);
        this.renderer.setRenderTarget(null);
    }

    /** An empty tank: no sand, clay, rock, lava or water. */
    clearAll() {
        for (const target of [this.terrain, this.lava, this.water, this.flux, this.lavaFlux, this.slide, this.slideDiagonal]) {
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

    /** Swell pushed in from the back edge; `null` stops it. */
    setWaves(waves, level) {
        const value = this.passes.water.uniforms.uWaves.value;
        if (waves) {
            value.set(waves.amplitude, waves.omega, level, 1);
        } else {
            value.w = 0;
        }
    }

    drain() {
        this.clear(this.water);
        this.clear(this.flux);
        this.renderer.setRenderTarget(null);
    }

    step(frameDt) {
        const { passes } = this;
        const dt = Math.min(frameDt, 0.1);
        this.time += dt;

        const mode = this.brush.uMode.value;
        if (TERRAIN_MODES.has(mode)) {
            this.run(passes.brushTerrain, this.terrain, { uTerrain: this.terrain.texture });
        }
        if (mode === LAVA_MODE) {
            this.run(passes.brushLava, this.lava, { uLava: this.lava.texture });
        }
        passes.brushWater.uniforms.uRain.value = this.rain ? PHYSICS.rain : 0;
        passes.brushWater.uniforms.uFrameDt.value = dt;
        passes.brushWater.uniforms.uTime.value = this.time;
        this.run(passes.brushWater, this.water, { uWater: this.water.texture });
        this.erosionSwitch.value = this.erosion ? 1 : 0;

        for (let i = substepsFor(dt); i > 0; i--) {
            this.stepSand();
            this.stepLava();
            const { runs, credit } = waterRuns(this.waterCredit, this.waterSpeed);
            this.waterCredit = credit;
            for (let run = 0; run < runs * PHYSICS.waterSteps; run++) {
                this.stepWater();
            }
        }
        this.renderer.setRenderTarget(null);
    }

    /** Avalanches: the shares sent to the 8 neighbours, then the exchange. */
    stepSand() {
        const { passes } = this;
        const inputs = { uTerrain: this.terrain.texture, uLava: this.lava.texture, uWater: this.water.texture };
        passes.slideOut.uniforms.uDiagonal.value = 0;
        this.run(passes.slideOut, this.slide, inputs);
        passes.slideOut.uniforms.uDiagonal.value = 1;
        this.run(passes.slideOut, this.slideDiagonal, inputs);
        this.run(passes.slideApply, this.terrain, {
            uTerrain: this.terrain.texture,
            uSlide: this.slide.texture,
            uSlideDiagonal: this.slideDiagonal.texture,
        });
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
        this.run(passes.lavaSolidifyTerrain, this.terrain, { uTerrain: this.terrain.texture, uLava: lava });
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
        const inputs = { uTerrain: this.terrain.texture, uLava: this.lava.texture, uWater: this.water.texture };
        this.run(passes.erosionWater, this.water, inputs);
        this.run(passes.erosionTerrain, this.terrain, inputs);
    }

    /** Water depth along one edge (side order of SIDES), read back from the GPU; index = position along the edge. */
    edgeDepths(side) {
        const n = this.size;
        const [x, y, width, height] = [[0, 0, 1, n], [n - 1, 0, 1, n], [0, 0, n, 1], [0, n - 1, n, 1]][side];
        const buffer = this.dataType === THREE.FloatType ? new Float32Array(n * 4) : new Uint16Array(n * 4);
        this.renderer.readRenderTargetPixels(this.water.read, x, y, width, height, buffer);

        return Array.from({ length: n }, (_, i) => this.decode(buffer[i * 4]));
    }

    decode(value) {
        return this.dataType === THREE.FloatType ? value : THREE.DataUtils.fromHalfFloat(value);
    }

    /** Ground height (rock + clay + sand + lava) and water depth at `uv`, read back from the GPU (for picking). */
    sample(uv) {
        const x = Math.min(this.size - 1, Math.max(0, Math.floor(uv[0] * this.size)));
        const y = Math.min(this.size - 1, Math.max(0, Math.floor(uv[1] * this.size)));
        const read = (target) => {
            this.renderer.readRenderTargetPixels(target.read, x, y, 1, 1, this.readBuffer);

            return Array.from(this.readBuffer, (value) => this.decode(value));
        };
        const [sand, , clay, rock] = read(this.terrain);
        const [lava] = read(this.lava);
        const [water] = read(this.water);

        return { ground: sand + clay + rock + lava, water };
    }

    dispose() {
        for (const target of [this.terrain, this.lava, this.water, this.flux, this.lavaFlux, this.slide, this.slideDiagonal]) {
            target.dispose();
        }
        for (const material of Object.values(this.passes)) {
            material.dispose();
        }
        this.quad.geometry.dispose();
    }
}
