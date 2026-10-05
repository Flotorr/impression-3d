import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAX_SPRINGS, OCEAN, oceanWaves, oceanWaveTrain, PHYSICS, toggleSpring, tool as toolById, worldToUv } from './sand-physics.js';
import { createRain, createSteam, createWaterfall, FLOOR, GlassTank, WALL_HEIGHT } from './sand-effects.js';
import { sectionShader, shadowShader, terrainShader, waterSurfaceShader } from './sand-render-shaders.js';
import { FloatingObjects } from './sand-objects.js';
import { SandSimulation } from './sand-sim.js';

const PUDDLE_EVERY = 10; // frames between two readbacks of the water leaving through broken panes

/**
 * The sandbox: glass tank, sand, water and the GPU simulation behind them.
 * Left button / one finger uses the current tool; right button / two fingers turn the camera; wheel / pinch zooms.
 * The hammer breaks a pane: the simulation then lets water and sand out on that side.
 * The wheel zooms towards the point under the cursor.
 * The constructor throws when WebGL 2 or float render targets are unavailable.
 */
export class SandScene {
    /** `tools: false` (wave tank): no tools, the left button and one finger turn the camera. */
    constructor(container, { reducedMotion = false, tools = true } = {}) {
        this.container = container;
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
        if (!this.renderer.capabilities.isWebGL2) {
            throw new Error('WebGL 2 is required');
        }
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.05;
        this.renderer.domElement.classList.add('stage-gl');
        container.appendChild(this.renderer.domElement);

        this.sim = new SandSimulation(this.renderer);
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
        this.camera.position.set(0.2, 2.35, 3.15);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        Object.assign(this.controls, {
            enableDamping: true,
            dampingFactor: 0.08,
            enablePan: false,
            minDistance: 1.3,
            maxDistance: 6,
            maxPolarAngle: 1.38,
            rotateSpeed: 0.6,
            autoRotate: false,
            zoomToCursor: true,
            maxTargetRadius: 1.3, // zooming towards the cursor moves the target: keep it over the tank
        });
        this.controls.target.set(0, 0.08, 0);
        // With tools, the left button and a single finger belong to them.
        this.tools = tools;
        this.controls.mouseButtons = { LEFT: tools ? null : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
        this.controls.touches = { ONE: tools ? null : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };

        this.sun = new THREE.Vector3(0.55, 0.75, 0.35).normalize();
        this.shared = {
            uTerrain: { value: this.sim.terrain.texture },
            uLava: { value: this.sim.lava.texture },
            uWater: { value: this.sim.water.texture },
            uTexel: { value: new THREE.Vector2(1 / this.sim.size, 1 / this.sim.size) },
            uCell: { value: PHYSICS.world / this.sim.size },
            uSun: { value: this.sun },
            uTime: { value: 0 },
            uGloom: { value: 0 },
            uSwell: { value: new THREE.Vector2(0, 0) },
        };
        this.buildSandbox();
        this.objects = new FloatingObjects(this.sim, this.scene, this.shared, { floor: FLOOR, base: PHYSICS.world / 2 + 0.07 });
        this.objectType = 'duck';

        this.tool = 'dig';
        this.brushRadius = 0.08; // uv units
        this.strength = 0.6;
        this.springs = [];
        this.pointer = null; // { x, y } in CSS pixels, while over the canvas
        this.painting = false;
        this.touches = new Set();
        this.lastUv = null;
        this.raining = false;
        this.frameCount = 0;
        this.sinceReadback = 0;
        this.raycaster = new THREE.Raycaster();
        this.reducedMotion = reducedMotion;
        if (tools) {
            this.bindPointer();
        }

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(container);
        this.resize();

        this.sim.reset();
        this.frame = null;
        this.last = 0;
        this.tick = this.tick.bind(this);
    }

    buildSandbox() {
        const n = this.sim.size;
        const plane = new THREE.PlaneGeometry(PHYSICS.world, PHYSICS.world, n - 1, n - 1);

        this.terrainUniforms = {
            ...this.shared,
            uBrush: { value: new THREE.Vector2(-1, -1) },
            uRadius: { value: 0.08 },
            uBrushVisible: { value: 0 },
            uBrushColour: { value: new THREE.Color('#ffffff') },
            uSprings: { value: Array.from({ length: MAX_SPRINGS }, () => new THREE.Vector2()) },
            uSpringCount: { value: 0 },
        };
        this.terrain = new THREE.Mesh(plane, new THREE.ShaderMaterial({ ...terrainShader, uniforms: this.terrainUniforms }));
        this.terrain.rotation.x = -Math.PI / 2;
        this.scene.add(this.terrain);

        this.water = new THREE.Mesh(plane, new THREE.ShaderMaterial({
            ...waterSurfaceShader,
            uniforms: this.shared,
            transparent: true,
            depthWrite: false,
        }));
        this.water.rotation.x = -Math.PI / 2;
        this.water.renderOrder = 2;
        this.scene.add(this.water);

        const section = this.sectionGeometry(n);
        this.sandSection = new THREE.Mesh(section, new THREE.ShaderMaterial({
            ...sectionShader,
            uniforms: { ...this.shared, uLayer: { value: 0 } },
            side: THREE.DoubleSide,
        }));
        this.waterSection = new THREE.Mesh(section, new THREE.ShaderMaterial({
            ...sectionShader,
            uniforms: { ...this.shared, uLayer: { value: 1 } },
            side: THREE.DoubleSide,
            transparent: true,
            depthWrite: false,
        }));
        this.waterSection.renderOrder = 1;
        this.scene.add(this.sandSection, this.waterSection);

        // Glass panes, rain, waterfalls, then a wooden base, a thin metal rim and a soft shadow.
        const half = PHYSICS.world / 2;
        this.tank = new GlassTank(this.scene);
        this.rainDrops = createRain(this.shared);
        this.waterfall = createWaterfall(this.shared, this.sim.broken);
        this.steam = createSteam(this.shared);
        this.scene.add(this.rainDrops, this.waterfall, this.steam);

        this.scene.add(new THREE.HemisphereLight('#dfe9f5', '#8a6b4a', 1.2));
        const sunLight = new THREE.DirectionalLight('#fff3dd', 2.2);
        sunLight.position.copy(this.sun).multiplyScalar(5);
        this.scene.add(sunLight);

        const base = new THREE.Mesh(
            new THREE.BoxGeometry(PHYSICS.world + 0.14, 0.1, PHYSICS.world + 0.14),
            new THREE.MeshStandardMaterial({ color: '#5a3d28', roughness: 0.75 }),
        );
        base.position.y = -0.052; // 2 mm under the bottom of the tank, so the two never fight for the same pixels
        this.scene.add(base);
        const rimMaterial = new THREE.MeshStandardMaterial({ color: '#e4e8ee', metalness: 0.25, roughness: 0.35 });
        for (const [x, z, w, d] of [[0, half, PHYSICS.world + 0.03, 0.03], [0, -half, PHYSICS.world + 0.03, 0.03], [half, 0, 0.03, PHYSICS.world + 0.03], [-half, 0, 0.03, PHYSICS.world + 0.03]]) {
            const rim = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), rimMaterial);
            rim.position.set(x, WALL_HEIGHT, z);
            this.scene.add(rim);
        }
        const shadow = new THREE.Mesh(
            new THREE.PlaneGeometry(PHYSICS.world * 1.9, PHYSICS.world * 1.9),
            new THREE.ShaderMaterial({ ...shadowShader, transparent: true, depthWrite: false }),
        );
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = FLOOR - 0.004;
        this.scene.add(shadow);
    }

    /** Four strips just inside the glass; each column samples the terrain at the matching edge. */
    sectionGeometry(n) {
        const half = PHYSICS.world / 2 - 0.002;
        const positions = [];
        const edgeUvs = [];
        const tops = [];
        const indices = [];
        const sides = [
            (t) => [[-half + t * 2 * half, half], [t, 0]], // front, z = +1
            (t) => [[half - t * 2 * half, -half], [1 - t, 1]], // back
            (t) => [[-half, -half + t * 2 * half], [0, 1 - t]], // left
            (t) => [[half, half - t * 2 * half], [1, t]], // right
        ];
        for (const side of sides) {
            const start = positions.length / 3;
            for (let i = 0; i < n; i++) {
                const [[x, z], [u, v]] = side(i / (n - 1));
                const uv = [Math.min(u, 1 - 0.5 / n), Math.min(v, 1 - 0.5 / n)].map((c) => Math.max(c, 0.5 / n));
                for (const top of [0, 1]) {
                    positions.push(x, 0, z);
                    edgeUvs.push(...uv);
                    tops.push(top);
                }
                if (i < n - 1) {
                    const a = start + i * 2;
                    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
                }
            }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('aEdgeUv', new THREE.Float32BufferAttribute(edgeUvs, 2));
        geometry.setAttribute('aTop', new THREE.Float32BufferAttribute(tops, 1));
        geometry.setIndex(indices);
        // Heights are set in the shader: the bounding sphere must cover the whole tank.
        geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.2, 0), 1.6);

        return geometry;
    }

    // --- Interaction -----------------------------------------------------------

    bindPointer() {
        const canvas = this.renderer.domElement;
        canvas.style.touchAction = 'none';
        this.onPointerDown = (event) => {
            if (event.pointerType === 'touch') {
                this.touches.add(event.pointerId);
                if (this.touches.size > 1) {
                    this.painting = false; // two fingers: the camera takes over
                    return;
                }
            } else if (event.button !== 0) {
                return;
            }
            this.pointer = this.localPoint(event);
            this.lastUv = null;
            if (this.tool === 'hammer') {
                const hit = this.pickPane();
                if (hit && this.tank.break(hit.side, hit.point)) {
                    this.sim.setBroken(this.tank.broken);
                    this.onPanesChange?.(this.tank.broken);
                }

                return;
            }
            if (this.tool === 'objects') {
                const uv = this.pick();
                if (uv) {
                    this.objects.add(this.objectType, uv);
                    this.onObjectsChange?.(this.objects.count);
                }

                return;
            }
            if (this.tool === 'spring') {
                const uv = this.pick();
                if (uv) {
                    this.setSprings(toggleSpring(this.springs, uv, 0.05));
                    this.onSpringsChange?.(this.springs);
                }

                return;
            }
            this.painting = true;
            canvas.setPointerCapture(event.pointerId);
        };
        this.onPointerMove = (event) => {
            if (event.pointerType === 'touch' && this.touches.size > 1) {
                return;
            }
            this.pointer = this.localPoint(event);
        };
        this.onPointerUp = (event) => {
            this.touches.delete(event.pointerId);
            this.painting = false;
            if (event.pointerType === 'touch') {
                this.pointer = null;
            }
        };
        this.onPointerLeave = () => {
            if (!this.painting) {
                this.pointer = null;
            }
        };
        canvas.addEventListener('pointerdown', this.onPointerDown);
        canvas.addEventListener('pointermove', this.onPointerMove);
        canvas.addEventListener('pointerup', this.onPointerUp);
        canvas.addEventListener('pointercancel', this.onPointerUp);
        canvas.addEventListener('pointerleave', this.onPointerLeave);
    }

    localPoint(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();

        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    /**
     * Simulation uv under the pointer. The terrain is displaced on the GPU, so the ray is intersected
     * with a horizontal plane at the height read back under the previous guess (two rounds are enough).
     */
    pick() {
        if (!this.pointer) {
            return null;
        }
        const ndc = new THREE.Vector2(
            (this.pointer.x / this.container.clientWidth) * 2 - 1,
            -(this.pointer.y / this.container.clientHeight) * 2 + 1,
        );
        this.raycaster.setFromCamera(ndc, this.camera);
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.12);
        const hit = new THREE.Vector3();
        let uv = null;
        for (let round = 0; round < 2; round++) {
            if (!this.raycaster.ray.intersectPlane(plane, hit)) {
                return null;
            }
            uv = worldToUv(hit.x, hit.z);
            if (uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) {
                return null;
            }
            const { ground, water } = this.sim.sample(uv);
            const onWater = this.tool === 'water' || this.tool === 'sponge' || this.tool === 'objects';
            const target = onWater ? ground + water : ground;
            plane.constant = -target;
        }

        return uv;
    }

    /** Glass pane under the pointer, if any. */
    pickPane() {
        if (!this.pointer) {
            return null;
        }
        const ndc = new THREE.Vector2(
            (this.pointer.x / this.container.clientWidth) * 2 - 1,
            -(this.pointer.y / this.container.clientHeight) * 2 + 1,
        );
        this.raycaster.setFromCamera(ndc, this.camera);

        return this.tank.pick(this.raycaster);
    }

    repairPanes() {
        this.tank.repair();
        this.sim.setBroken(this.tank.broken);
        this.onPanesChange?.(this.tank.broken);
    }

    /** "Océan en direct": a beach, the real swell (`{ height, period }` in metres and seconds) and a surfer for scale. */
    startOcean(swell) {
        this.repairPanes();
        this.setSprings([]);
        this.sim.makeBeach(OCEAN.level);
        this.updateOcean(swell);
        this.objects.clear();
        this.objects.add('surfer', [0.5, 0.62]);
        this.onObjectsChange?.(this.objects.count);
        this.onSpringsChange?.([]);
    }

    /** New readings for the swell already shown. */
    updateOcean(swell) {
        const waves = oceanWaves(swell.height, swell.period);
        this.sim.setWaves(oceanWaveTrain(swell.height, swell.period), OCEAN.level);
        this.shared.uSwell.value.set(OCEAN.level, Math.max(waves.amplitude, 0.002));
    }

    stopOcean() {
        this.sim.setWaves(null);
        this.shared.uSwell.value.set(0, 0);
    }

    clearObjects() {
        this.objects.clear();
        this.onObjectsChange?.(0);
    }

    setRain(raining) {
        this.raining = raining;
        this.sim.rain = raining;
    }

    setTool(tool) {
        this.tool = tool;
        this.painting = false;
    }

    setSprings(springs) {
        this.springs = springs;
        this.sim.setSprings(springs);
        springs.forEach(([u, v], i) => this.terrainUniforms.uSprings.value[i].set(u, v));
        this.terrainUniforms.uSpringCount.value = springs.length;
    }

    setBrushColour(css) {
        this.terrainUniforms.uBrushColour.value.set(css);
    }

    /** Applies the current tool for this frame. */
    updateBrush(dt) {
        const aiming = this.tool !== 'hammer';
        const uv = this.pointer && aiming ? this.pick() : null;
        this.tank.hover(this.tool === 'hammer' ? this.pickPane() : null);
        const visible = uv && this.tool !== 'spring' && this.tool !== 'objects';
        this.terrainUniforms.uBrushVisible.value = visible ? 1 : 0;
        if (uv) {
            this.terrainUniforms.uBrush.value.set(uv[0], uv[1]);
            this.terrainUniforms.uRadius.value = this.brushRadius;
        }
        if (!this.painting || !uv) {
            this.sim.setBrush({ mode: 0 });
            this.lastUv = uv;
            return;
        }
        const { mode, rate } = toolById(this.tool);
        const drag = this.tool === 'push' && this.lastUv ? [uv[0] - this.lastUv[0], uv[1] - this.lastUv[1]] : [0, 0];
        this.sim.setBrush({
            mode,
            uv,
            radius: this.brushRadius,
            amount: rate * this.strength * dt,
            drag,
        });
        this.lastUv = uv;
    }

    // --- Loop ----------------------------------------------------------------------

    tick(now) {
        this.frame = requestAnimationFrame(this.tick);
        const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 1 / 60;
        this.last = now;

        this.updateBrush(dt);
        this.sim.step(dt);
        this.objects.step(dt);
        this.tank.updateShards(dt);
        this.updatePuddles(dt);
        // The sky clouds over and clears up gradually.
        const k = 1 - Math.exp(-dt * 1.5);
        const target = this.raining ? 1 : 0;
        this.shared.uGloom.value += (target - this.shared.uGloom.value) * k;
        this.rainDrops.material.uniforms.uRain.value += (target - this.rainDrops.material.uniforms.uRain.value) * k * 2;
        this.shared.uTerrain.value = this.sim.terrain.texture;
        this.shared.uLava.value = this.sim.lava.texture;
        this.shared.uWater.value = this.sim.water.texture;
        this.shared.uTime.value += this.reducedMotion ? dt * 0.3 : dt;
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    /** Water leaving through broken panes, estimated from the edge depths, feeds the puddles on the table. */
    updatePuddles(dt) {
        this.sinceReadback += dt;
        if (++this.frameCount % PUDDLE_EVERY !== 0) {
            this.tank.updatePuddles(dt, []);
            return;
        }
        const cell = PHYSICS.world / this.sim.size;
        const flows = this.tank.broken.map((broken, side) => {
            if (!broken) {
                return null;
            }
            let volume = 0;
            let weighted = 0;
            this.sim.edgeDepths(side).forEach((depth, i, all) => {
                const rate = depth > 0.0015 ? depth * Math.sqrt(PHYSICS.gravity * depth) * cell : 0; // depth × speed × width
                volume += rate;
                weighted += rate * (i + 0.5) / all.length;
            });

            return { volume: volume * this.sinceReadback * this.sim.waterSpeed, centre: volume > 0 ? weighted / volume : 0.5 };
        });
        this.tank.updatePuddles(dt, flows);
        this.sinceReadback = 0;
    }

    setRunning(running) {
        if (running && this.frame === null) {
            this.last = 0;
            this.frame = requestAnimationFrame(this.tick);
        } else if (!running && this.frame !== null) {
            cancelAnimationFrame(this.frame);
            this.frame = null;
        }
    }

    resize() {
        const width = Math.max(1, this.container.clientWidth);
        const height = Math.max(1, this.container.clientHeight);
        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        const portrait = width < height;
        this.camera.fov = portrait ? 50 : 38;
        this.camera.updateProjectionMatrix();
        const focal = (height * this.renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
        this.waterfall.material.uniforms.uFocal.value = focal;
        this.steam.material.uniforms.uFocal.value = focal;
        // Frame the whole tank, at start and when the orientation flips (not on every resize, not to undo a zoom).
        if (this.portrait !== portrait) {
            this.portrait = portrait;
            const halfWidth = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect);
            const distance = Math.max(3.9, 1.35 / Math.tan(halfWidth));
            const direction = this.camera.position.clone().sub(this.controls.target).normalize();
            this.camera.position.copy(this.controls.target).addScaledVector(direction, distance);
            this.controls.maxDistance = Math.max(6, distance * 1.4);
        }
    }

    capture() {
        this.renderer.render(this.scene, this.camera);

        return this.renderer.domElement.toDataURL('image/png');
    }

    dispose() {
        this.setRunning(false);
        this.resizeObserver.disconnect();
        const canvas = this.renderer.domElement;
        if (this.tools) {
            canvas.removeEventListener('pointerdown', this.onPointerDown);
            canvas.removeEventListener('pointermove', this.onPointerMove);
            canvas.removeEventListener('pointerup', this.onPointerUp);
            canvas.removeEventListener('pointercancel', this.onPointerUp);
            canvas.removeEventListener('pointerleave', this.onPointerLeave);
        }
        this.controls.dispose();
        this.tank.dispose();
        this.objects.dispose();
        this.scene.traverse((object) => {
            object.geometry?.dispose();
            object.material?.dispose();
        });
        this.sim.dispose();
        this.renderer.dispose();
        canvas.remove();
    }
}
