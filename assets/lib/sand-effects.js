import * as THREE from 'three';
import { PHYSICS } from './sand-physics.js';
import { glassShader, puddleShader, rainShader, steamShader, waterfallShader } from './sand-render-shaders.js';

export const WALL_HEIGHT = 0.48;
export const FLOOR = -0.1; // the table the tank stands on
const HALF = PHYSICS.world / 2;
const BASE = HALF + 0.07; // the wooden base sticks out a little beyond the glass
const SHARDS_PER_PANE = 90;

// Same order as SIDES and the simulation: left (x = -1), right (x = +1), front (z = +1), back (z = -1).
const PANES = [
    { centre: new THREE.Vector3(-HALF, 0, 0), rotation: Math.PI / 2, outward: new THREE.Vector3(-1, 0, 0) },
    { centre: new THREE.Vector3(HALF, 0, 0), rotation: -Math.PI / 2, outward: new THREE.Vector3(1, 0, 0) },
    { centre: new THREE.Vector3(0, 0, HALF), rotation: 0, outward: new THREE.Vector3(0, 0, 1) },
    { centre: new THREE.Vector3(0, 0, -HALF), rotation: Math.PI, outward: new THREE.Vector3(0, 0, -1) },
];

/** Tangent along a pane, pointing the way its edge uv increases (see waterfallShader). */
function along(side) {
    return side < 2 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(1, 0, 0);
}

/**
 * The four glass panes: hover highlight for the hammer, breaking into falling shards,
 * and the puddles that grow on the table where the water lands.
 */
export class GlassTank {
    constructor(scene) {
        this.scene = scene;
        this.broken = [false, false, false, false];
        this.panes = PANES.map((pane, side) => {
            const mesh = new THREE.Mesh(
                new THREE.PlaneGeometry(PHYSICS.world + 0.01, WALL_HEIGHT),
                new THREE.ShaderMaterial({
                    ...glassShader,
                    uniforms: {
                        uHover: { value: 0 },
                        uHit: { value: new THREE.Vector2() },
                        uSize: { value: new THREE.Vector2(PHYSICS.world + 0.01, WALL_HEIGHT) },
                    },
                    transparent: true,
                    depthWrite: false,
                    side: THREE.DoubleSide,
                }),
            );
            mesh.position.copy(pane.centre).setY(WALL_HEIGHT / 2);
            mesh.rotation.y = pane.rotation;
            mesh.renderOrder = 3;
            mesh.userData.side = side;
            scene.add(mesh);

            return mesh;
        });

        this.shardGeometry = new THREE.BufferGeometry();
        this.shardGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.6, 0, -0.5, -0.4, 0, 0.55, -0.3, 0], 3));
        this.shardGeometry.computeVertexNormals();
        this.shardMaterial = new THREE.MeshStandardMaterial({
            color: '#e8f6ff',
            transparent: true,
            opacity: 0.55,
            roughness: 0.05,
            metalness: 0.1,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        this.shards = [];

        this.puddles = PANES.map((_, side) => {
            const mesh = new THREE.Mesh(
                new THREE.CircleGeometry(1, 48),
                new THREE.ShaderMaterial({ ...puddleShader, uniforms: { uSeed: { value: side * 2.3 } }, transparent: true, depthWrite: false }),
            );
            mesh.rotation.x = -Math.PI / 2;
            mesh.visible = false;
            scene.add(mesh);

            return { mesh, volume: 0, centre: 0.5 };
        });
        this.dummy = new THREE.Object3D();
    }

    /** Pane under the ray, ignoring broken ones. */
    pick(raycaster) {
        const hit = raycaster.intersectObjects(this.panes.filter((pane) => pane.visible), false)[0];

        return hit ? { side: hit.object.userData.side, point: hit.point } : null;
    }

    /** Shows cracks on the pane under the hammer, around `point` (world). */
    hover(hit) {
        this.panes.forEach((pane, i) => {
            const { uniforms } = pane.material;
            uniforms.uHover.value = hit?.side === i ? 1 : 0;
            if (hit?.side === i) {
                const local = pane.worldToLocal(hit.point.clone());
                uniforms.uHit.value.set(local.x + uniforms.uSize.value.x / 2, local.y + uniforms.uSize.value.y / 2);
            }
        });
    }

    /** Breaks a pane; returns false if it was already broken. */
    break(side, point) {
        if (this.broken[side]) {
            return false;
        }
        this.broken[side] = true;
        this.panes[side].visible = false;
        this.spawnShards(side, point ?? PANES[side].centre.clone().setY(WALL_HEIGHT / 2));

        return true;
    }

    repair() {
        this.broken = [false, false, false, false];
        for (const pane of this.panes) {
            pane.visible = true;
        }
        for (const { mesh } of this.shards) {
            this.scene.remove(mesh);
            mesh.dispose();
        }
        this.shards = [];
        for (const puddle of this.puddles) {
            puddle.volume = 0;
            puddle.mesh.visible = false;
        }
    }

    spawnShards(side, point) {
        const { outward } = PANES[side];
        const tangent = along(side);
        const mesh = new THREE.InstancedMesh(this.shardGeometry, this.shardMaterial, SHARDS_PER_PANE);
        mesh.frustumCulled = false;
        const impact = point.clone().sub(PANES[side].centre).dot(tangent);
        const items = Array.from({ length: SHARDS_PER_PANE }, () => {
            // Most shards come from around the impact, the rest from the whole pane.
            const near = Math.random() < 0.6;
            const offset = near ? impact + (Math.random() - 0.5) * 0.7 : (Math.random() - 0.5) * PHYSICS.world;
            const position = PANES[side].centre.clone().addScaledVector(tangent, THREE.MathUtils.clamp(offset, -HALF, HALF));
            position.y = near ? THREE.MathUtils.clamp(point.y + (Math.random() - 0.5) * 0.3, 0.02, WALL_HEIGHT) : Math.random() * WALL_HEIGHT;

            return {
                position,
                velocity: outward.clone().multiplyScalar(0.3 + Math.random() * 1.1)
                    .addScaledVector(tangent, (Math.random() - 0.5) * 0.8)
                    .add(new THREE.Vector3(0, Math.random() * 0.9, 0)),
                rotation: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
                spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(14),
                scale: 0.015 + Math.random() ** 2 * 0.07,
                resting: false,
            };
        });
        this.scene.add(mesh);
        this.shards.push({ mesh, items });
        this.updateShards(0);
    }

    updateShards(dt) {
        for (const { mesh, items } of this.shards) {
            items.forEach((shard, i) => {
                if (!shard.resting && dt > 0) {
                    shard.velocity.y -= 9.81 * dt;
                    shard.position.addScaledVector(shard.velocity, dt);
                    shard.rotation.x += shard.spin.x * dt;
                    shard.rotation.y += shard.spin.y * dt;
                    shard.rotation.z += shard.spin.z * dt;
                    const onBase = Math.abs(shard.position.x) < BASE && Math.abs(shard.position.z) < BASE;
                    const ground = onBase ? 0.002 : FLOOR + 0.002;
                    if (shard.position.y < ground) {
                        shard.position.y = ground;
                        shard.velocity.multiplyScalar(0.3);
                        shard.velocity.y = Math.abs(shard.velocity.y) * 0.25;
                        shard.spin.multiplyScalar(0.4);
                        if (shard.velocity.lengthSq() < 0.01) {
                            shard.resting = true;
                            shard.rotation.x = Math.PI / 2; // lie flat
                        }
                    }
                }
                this.dummy.position.copy(shard.position);
                this.dummy.rotation.copy(shard.rotation);
                this.dummy.scale.setScalar(shard.scale);
                this.dummy.updateMatrix();
                mesh.setMatrixAt(i, this.dummy.matrix);
            });
            mesh.instanceMatrix.needsUpdate = true;
        }
    }

    /**
     * `flows[side]` = { volume, centre }: water that left through that side since the last call
     * (world units³) and where along the edge it mostly left (0–1).
     */
    updatePuddles(dt, flows) {
        this.puddles.forEach((puddle, side) => {
            const flow = flows[side];
            if (flow && flow.volume > 0) {
                puddle.volume += flow.volume;
                puddle.centre = THREE.MathUtils.lerp(puddle.centre, flow.centre, 0.2);
            }
            const radius = Math.min(1.3, Math.sqrt(puddle.volume / (Math.PI * 0.004)));
            puddle.mesh.visible = radius > 0.02;
            if (!puddle.mesh.visible) {
                return;
            }
            const { outward } = PANES[side];
            const edge = PANES[side].centre.clone().addScaledVector(along(side), (puddle.centre - 0.5) * PHYSICS.world);
            puddle.mesh.position.copy(edge).addScaledVector(outward, BASE - HALF + radius * 0.7 + 0.05).setY(FLOOR + 0.001);
            puddle.mesh.scale.setScalar(radius);
        });
    }

    dispose() {
        this.repair();
        for (const pane of this.panes) {
            pane.geometry.dispose();
            pane.material.dispose();
        }
        for (const { mesh } of this.puddles) {
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        this.shardGeometry.dispose();
        this.shardMaterial.dispose();
    }
}

/** Raindrops falling from the sky (line segments animated in the vertex shader). */
export function createRain(shared, count = 2600) {
    const seeds = new Float32Array(count * 6);
    const ends = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
        const seed = [Math.random(), Math.random(), Math.random()];
        seeds.set(seed, i * 6);
        seeds.set(seed, i * 6 + 3);
        ends[i * 2 + 1] = 1;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 6), 3));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 3));
    geometry.setAttribute('aEnd', new THREE.Float32BufferAttribute(ends, 1));
    const uniforms = { ...shared, uRain: { value: 0 }, uWorld: { value: PHYSICS.world } };
    const rain = new THREE.LineSegments(geometry, new THREE.ShaderMaterial({ ...rainShader, uniforms, transparent: true, depthWrite: false }));
    rain.frustumCulled = false;
    rain.renderOrder = 4;

    return rain;
}

/** Water pouring out of broken panes (points animated in the vertex shader). */
export function createWaterfall(shared, broken, perSide = 1500) {
    const count = perSide * 4;
    const seeds = new Float32Array(count * 3);
    const sides = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        seeds.set([Math.random(), Math.random(), Math.random()], i * 3);
        sides[i] = Math.floor(i / perSide);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 3));
    geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
    const uniforms = {
        ...shared,
        uBroken: { value: broken },
        uWorld: { value: PHYSICS.world },
        uFocal: { value: 1000 },
        uFloor: { value: FLOOR },
    };
    const waterfall = new THREE.Points(geometry, new THREE.ShaderMaterial({ ...waterfallShader, uniforms, transparent: true, depthWrite: false }));
    waterfall.frustumCulled = false;
    waterfall.renderOrder = 4;

    return waterfall;
}

/** Steam rising where lava meets water (points animated in the vertex shader). */
export function createSteam(shared, count = 6000) {
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) {
        seeds[i] = Math.random();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 3));
    const uniforms = { ...shared, uWorld: { value: PHYSICS.world }, uFocal: { value: 1000 } };
    const steam = new THREE.Points(geometry, new THREE.ShaderMaterial({ ...steamShader, uniforms, transparent: true, depthWrite: false }));
    steam.frustumCulled = false;
    steam.renderOrder = 5;

    return steam;
}
