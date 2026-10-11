import * as THREE from 'three';
import { uvToWorld, worldToUv } from './sand-physics.js';

// Falling meteorites, seen from the sky to the ground, and what flies at the impact. The crater itself is dug by
// the simulation (SandSimulation.impact); this is only what is seen: the glowing rock, its trail of fire and
// smoke, the burning debris thrown out of the crater.

const FALL = 0.9; // seconds from the sky to the ground
const FROM = new THREE.Vector3(0.6, 1, -0.45).normalize(); // they come in from high up behind, on the right
const DISTANCE = 3.4;
const PARTICLES = 1500;
const GRAVITY = 3; // world units / s²: slower than real, so the debris can be followed
const FIRE = 0;
const SMOKE = 1;
const DEBRIS = 2;

const particleShader = {
    vertexShader: /* glsl */ `
uniform float uFocal;
attribute vec4 aColour;
attribute float aSize;
varying vec4 vColour;
void main() {
    vColour = aColour;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aColour.a > 0.0 ? uFocal * aSize / -mv.z : 0.0;
    gl_Position = projectionMatrix * mv;
}
`,
    fragmentShader: /* glsl */ `
varying vec4 vColour;
void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5 || vColour.a <= 0.0) discard;
    gl_FragColor = vec4(pow(vColour.rgb, vec3(2.2)), vColour.a * smoothstep(0.5, 0.15, r));
    #include <colorspace_fragment>
}
`,
};

/** A lumpy rock, the same for every meteorite (scaled to its size). */
function rockGeometry() {
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const position = geometry.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i);
        const bump = 0.8 + 0.25 * Math.sin(v.x * 5.1 + v.y * 3.7) * Math.cos(v.z * 4.3 - v.x * 2.1);
        v.multiplyScalar(bump);
        position.setXYZ(i, v.x, v.y, v.z);
    }
    geometry.computeVertexNormals();

    return geometry;
}

export class Meteors {
    /**
     * `groundAt(uv)`: ground height there (from the simulation's height map). `onImpact(uv, meteor)` is called
     * when a rock reaches the ground.
     */
    constructor(scene, { groundAt, onImpact }) {
        this.scene = scene;
        this.groundAt = groundAt;
        this.onImpact = onImpact;
        this.flying = [];
        this.rock = rockGeometry();
        this.rockMaterial = new THREE.MeshStandardMaterial({
            color: '#2e2520',
            emissive: '#ff5a14',
            emissiveIntensity: 1.8,
            roughness: 0.9,
            flatShading: true,
        });

        // Particles live on the CPU (a few hundred at a time) and are copied to the GPU each frame.
        this.position = new Float32Array(PARTICLES * 3);
        this.velocity = new Float32Array(PARTICLES * 3);
        this.colour = new Float32Array(PARTICLES * 4);
        this.size = new Float32Array(PARTICLES);
        this.age = new Float32Array(PARTICLES);
        this.life = new Float32Array(PARTICLES); // 0 = free slot
        this.kind = new Uint8Array(PARTICLES);
        this.base = new Float32Array(PARTICLES); // size at birth
        this.next = 0;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('aColour', new THREE.BufferAttribute(this.colour, 4).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
        this.points = new THREE.Points(geometry, new THREE.ShaderMaterial({
            ...particleShader,
            uniforms: { uFocal: { value: 1000 } },
            transparent: true,
            depthWrite: false,
        }));
        this.points.frustumCulled = false;
        this.points.renderOrder = 7;
        scene.add(this.points);
        this.alive = 0;
    }

    setFocal(focal) {
        this.points.material.uniforms.uFocal.value = focal;
    }

    /** Sends a meteorite (one of METEOR_SIZES) at `uv`. */
    launch(uv, meteor) {
        const [x, z] = uvToWorld(uv[0], uv[1]);
        const end = new THREE.Vector3(x, this.groundAt(uv), z);
        const start = end.clone().addScaledVector(FROM, DISTANCE);
        const mesh = new THREE.Mesh(this.rock, this.rockMaterial);
        mesh.scale.setScalar(meteor.size);
        mesh.position.copy(start);
        this.scene.add(mesh);
        this.flying.push({ uv, meteor, start, end, mesh, age: 0, spin: new THREE.Vector3(Math.random(), Math.random(), Math.random()) });
    }

    emit(kind, x, y, z, vx, vy, vz, size, life) {
        const i = this.next;
        this.next = (this.next + 1) % PARTICLES;
        this.position.set([x, y, z], i * 3);
        this.velocity.set([vx, vy, vz], i * 3);
        this.kind[i] = kind;
        this.base[i] = size;
        this.age[i] = 0;
        this.life[i] = life;
    }

    update(dt) {
        for (const rock of [...this.flying]) {
            rock.age += dt;
            const t = Math.min(1, rock.age / FALL);
            rock.mesh.position.lerpVectors(rock.start, rock.end, t * t); // it speeds up on the way down
            rock.mesh.rotation.x += rock.spin.x * dt * 6;
            rock.mesh.rotation.y += rock.spin.y * dt * 6;
            // Trail: fire right behind the rock, smoke further back.
            const { x, y, z } = rock.mesh.position;
            const s = rock.meteor.size;
            for (let k = 0; k < 6; k++) {
                const jitter = () => (Math.random() - 0.5) * s;
                this.emit(FIRE, x + jitter(), y + jitter(), z + jitter(), 0, 0, 0, s * (1.6 + Math.random()), 0.35 + Math.random() * 0.2);
            }
            this.emit(SMOKE, x, y, z, (Math.random() - 0.5) * 0.05, 0.05, (Math.random() - 0.5) * 0.05, s * 2, 1.4 + Math.random());
            if (t >= 1) {
                this.scene.remove(rock.mesh);
                this.flying.splice(this.flying.indexOf(rock), 1);
                this.burst(rock);
                this.onImpact(rock.uv, rock.meteor);
            }
        }
        this.updateParticles(dt);
    }

    /** Burning debris thrown out of the crater, and a cloud of dust. */
    burst({ end, meteor }) {
        const count = Math.round(40 + meteor.radius * 1600);
        const reach = Math.sqrt(meteor.radius) * 4;
        for (let k = 0; k < count; k++) {
            const angle = Math.random() * Math.PI * 2;
            const out = reach * (0.3 + Math.random() * 0.7);
            this.emit(DEBRIS, end.x, end.y + 0.01, end.z, Math.cos(angle) * out, reach * (0.8 + Math.random()), Math.sin(angle) * out,
                0.006 + Math.random() * 0.01 + meteor.size * 0.1, 2.5 + Math.random());
        }
        for (let k = 0; k < count / 2; k++) {
            const angle = Math.random() * Math.PI * 2;
            const out = reach * 0.25 * Math.random();
            this.emit(SMOKE, end.x, end.y + 0.02, end.z, Math.cos(angle) * out, 0.15 + Math.random() * 0.3, Math.sin(angle) * out,
                meteor.size * (2 + 3 * Math.random()), 2 + Math.random() * 1.5);
        }
    }

    updateParticles(dt) {
        let alive = 0;
        for (let i = 0; i < PARTICLES; i++) {
            if (this.life[i] <= 0) {
                this.colour[i * 4 + 3] = 0;
                continue;
            }
            this.age[i] += dt;
            const f = this.age[i] / this.life[i];
            if (f >= 1) {
                this.life[i] = 0;
                this.colour[i * 4 + 3] = 0;
                continue;
            }
            alive++;
            const p = i * 3;
            const kind = this.kind[i];
            if (kind === DEBRIS) {
                this.velocity[p + 1] -= GRAVITY * dt;
            } else if (kind === SMOKE) {
                this.velocity[p + 1] += 0.1 * dt; // rises
            }
            this.position[p] += this.velocity[p] * dt;
            this.position[p + 1] += this.velocity[p + 1] * dt;
            this.position[p + 2] += this.velocity[p + 2] * dt;
            if (kind === DEBRIS) {
                // Stops where it falls: on the sand inside the tank, on the base or the table outside.
                const [x, , z] = [this.position[p], 0, this.position[p + 2]];
                const inside = Math.abs(x) < 1 && Math.abs(z) < 1;
                const ground = inside ? this.groundAt(worldToUv(x, z)) : Math.abs(x) < 1.07 && Math.abs(z) < 1.07 ? 0 : -0.1;
                if (this.position[p + 1] < ground) {
                    this.position[p + 1] = ground;
                    this.velocity.fill(0, p, p + 3);
                }
            }
            const c = i * 4;
            let rgb;
            let alpha;
            if (kind === FIRE) {
                rgb = f < 0.3 ? [1, 0.95, 0.7] : [1, 0.55 - 0.3 * f, 0.15];
                alpha = 0.9 * (1 - f);
                this.size[i] = this.base[i] * (1 - 0.5 * f);
            } else if (kind === SMOKE) {
                rgb = [0.32, 0.3, 0.29];
                alpha = 0.45 * Math.sin(Math.PI * f);
                this.size[i] = this.base[i] * (1 + 2 * f);
            } else {
                const glow = Math.max(0, 1 - f * 2.5); // red hot, then a dark stone
                rgb = [0.25 + 0.75 * glow, 0.2 + 0.35 * glow * glow, 0.17];
                alpha = Math.min(1, (1 - f) * 4);
                this.size[i] = this.base[i];
            }
            this.colour.set([rgb[0], rgb[1], rgb[2], alpha], c);
        }
        this.alive = alive;
        const { attributes } = this.points.geometry;
        if (alive > 0 || this.wasAlive) {
            attributes.position.needsUpdate = true;
            attributes.aColour.needsUpdate = true;
            attributes.aSize.needsUpdate = true;
        }
        this.wasAlive = alive > 0;
    }

    clear() {
        for (const rock of this.flying) {
            this.scene.remove(rock.mesh);
        }
        this.flying = [];
        this.life.fill(0);
    }

    dispose() {
        this.clear();
        this.rock.dispose();
        this.rockMaterial.dispose();
    }
}
