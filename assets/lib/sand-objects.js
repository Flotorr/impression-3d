import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAX_OBJECTS, OBJECT_TYPES, PHYSICS, placeObject } from './sand-physics.js';
import { PingPong } from './sand-sim.js';

// State of every object lives in a 3·MAX × 1 float texture, updated on the GPU:
//   texel i            (u, v, du/dt, dv/dt): position and velocity in simulation uv
//   texel MAX + i      (heading, spin, active, radius in uv)
//   texel 2·MAX + i    (height, vertical speed, outside, 0): once out of the tank through a broken pane,
//                      the object falls under gravity onto the wooden base or the table
// so objects follow the water without reading it back to the CPU.

const LANDED = 0.012; // height kept above the ground outside the tank (about the models' lift)

const STATE = /* glsl */ `
uniform sampler2D uObjects;
uniform float uMax;
vec4 objectTexel(float k) { return texture2D(uObjects, vec2((k + 0.5) / (3.0 * uMax), 0.5)); }
vec4 objectState(float i) { return objectTexel(i); }
vec4 objectInfo(float i) { return objectTexel(uMax + i); }
vec4 objectFall(float i) { return objectTexel(2.0 * uMax + i); }
`;

const SURFACE = /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uWater;
float groundAt(vec2 uv) { vec4 t = texture2D(uTerrain, uv); return t.r + t.b + t.a + texture2D(uLava, uv).r; }
float surfaceAt(vec2 uv) { return groundAt(uv) + texture2D(uWater, uv).r; }
`;

const updateShader = /* glsl */ `
${STATE}
${SURFACE}
uniform vec2 uTexel;
uniform float uCell;
uniform float uWorld;
uniform float uDt;
uniform vec4 uBroken;   // left, right, front (v = 0), back (v = 1)
uniform float uFloor;
uniform float uBase;    // half width of the wooden base, world units
uniform float uSpawn;   // slot to (re)initialise this frame, or -1
uniform vec4 uSpawnState;
uniform vec4 uSpawnInfo;
varying vec2 vUv;
const float LANDED = ${LANDED};
void main() {
    float index = floor(vUv.x * 3.0 * uMax);
    float channel = floor(index / uMax); // 0 state, 1 info, 2 fall
    float i = index - channel * uMax;
    if (abs(i - uSpawn) < 0.5) {
        gl_FragColor = channel < 0.5 ? uSpawnState : channel < 1.5 ? uSpawnInfo : vec4(0.0);
        return;
    }
    vec4 state = objectState(i);
    vec4 info = objectInfo(i);
    vec4 fall = objectFall(i);
    if (info.z < 0.5) {
        gl_FragColor = channel < 0.5 ? state : channel < 1.5 ? info : fall;
        return;
    }
    vec2 p = state.xy;
    vec2 v = state.zw;
    bool outside = fall.z > 0.5;
    float buoyancy = 0.0;

    if (!outside) {
        vec4 water = texture2D(uWater, p);
        buoyancy = smoothstep(0.002, 0.008, water.r);
        // Afloat, the object is carried by the current and slides down the slope of the surface;
        // aground, friction stops it.
        vec2 slope = vec2(surfaceAt(p + vec2(uTexel.x, 0.0)) - surfaceAt(p - vec2(uTexel.x, 0.0)),
                          surfaceAt(p + vec2(0.0, uTexel.y)) - surfaceAt(p - vec2(0.0, uTexel.y))) / (2.0 * uCell);
        vec2 current = water.gb / uWorld;
        vec2 afloat = mix(v, current, 1.0 - exp(-uDt * 3.0)) - slope * 0.4 * uDt;
        v = mix(v * exp(-uDt * 8.0), afloat, buoyancy);
    } else {
        // Out of the tank: free fall, then friction once on the base or the table.
        fall.y -= 9.81 * uDt;
        fall.x += fall.y * uDt;
        vec2 world = vec2((p.x - 0.5) * uWorld, (0.5 - p.y) * uWorld);
        bool onBase = abs(world.x) < uBase && abs(world.y) < uBase;
        float ground = (onBase ? 0.0 : uFloor) + LANDED;
        bool landed = fall.x <= ground;
        if (landed) {
            fall.x = ground;
            fall.y = 0.0;
        }
        v *= exp(-uDt * (landed ? 5.0 : 0.1));
    }

    // Objects push each other apart (those still in the tank and those outside are kept apart by the glass).
    for (int j = 0; j < ${MAX_OBJECTS}; j++) {
        float fj = float(j);
        if (abs(fj - i) < 0.5) continue;
        vec4 other = objectInfo(fj);
        if (other.z < 0.5 || (objectFall(fj).z > 0.5) != outside) continue;
        vec2 delta = p - objectState(fj).xy;
        float dist = length(delta);
        float overlap = info.w + other.w - dist;
        if (overlap > 0.0 && dist > 1e-6) {
            vec2 away = delta / dist;
            p += away * overlap * 0.5;
            v += away * overlap * 3.0;
        }
    }
    p += v * uDt;

    if (!outside) {
        // The glass walls: a broken pane lets the object through, and it starts to fall from the water's surface.
        float r = info.w;
        bool leaves = (p.x < 0.0 && uBroken.x > 0.5) || (p.x > 1.0 && uBroken.y > 0.5)
                   || (p.y < 0.0 && uBroken.z > 0.5) || (p.y > 1.0 && uBroken.w > 0.5);
        if (leaves) {
            fall = vec4(surfaceAt(clamp(p, 0.0, 1.0)), 0.0, 1.0, 0.0);
            v *= 1.2;
        } else {
            if (p.x < r && uBroken.x < 0.5) { p.x = r; v.x = abs(v.x) * 0.3; }
            if (p.x > 1.0 - r && uBroken.y < 0.5) { p.x = 1.0 - r; v.x = -abs(v.x) * 0.3; }
            if (p.y < r && uBroken.z < 0.5) { p.y = r; v.y = abs(v.y) * 0.3; }
            if (p.y > 1.0 - r && uBroken.w < 0.5) { p.y = 1.0 - r; v.y = -abs(v.y) * 0.3; }
        }
    } else {
        // Outside, the glass (or the edge of the tank) keeps it from coming back in.
        if (p.x > 0.0 && p.x < 1.0 && p.y > 0.0 && p.y < 1.0) {
            vec2 toEdge = vec2(p.x < 0.5 ? -p.x : 1.0 - p.x, p.y < 0.5 ? -p.y : 1.0 - p.y);
            if (abs(toEdge.x) < abs(toEdge.y)) {
                p.x += toEdge.x + sign(toEdge.x) * 0.002;
                v.x = 0.0;
            } else {
                p.y += toEdge.y + sign(toEdge.y) * 0.002;
                v.y = 0.0;
            }
        }
        p = clamp(p, -0.7, 1.7); // stays on the visible part of the table
    }

    if (channel > 1.5) {
        gl_FragColor = fall;
    } else if (channel > 0.5) {
        // Turning: a slow spin that dies out, and a pull towards the direction of travel while afloat.
        float speed = length(v);
        float heading = info.x + info.y * uDt;
        if (speed > 0.01 && buoyancy > 0.5) {
            float target = atan(v.y, v.x);
            float diff = mod(target - heading + 3.14159265, 6.2831853) - 3.14159265;
            heading += diff * min(1.0, uDt * 1.2);
        }
        gl_FragColor = vec4(heading, info.y * exp(-uDt * 0.5), info.z, info.w);
    } else {
        gl_FragColor = vec4(p, v);
    }
}
`;

// Vertex code injected into MeshStandardMaterial: place each instance on the water (or the ground), tilted
// with the surface, turned to its heading, bobbing a little; outside the tank, at its falling height, level.
// Inactive slots collapse to nothing.
const PLACE_PARS = /* glsl */ `
${STATE}
${SURFACE}
uniform vec2 uTexel;
uniform float uCell;
uniform float uWorld;
uniform float uTime;
uniform float uLift; // height of the waterline above the bottom of the model, when it rests on the ground
attribute float aObject;
`;

const PLACE_NORMAL = /* glsl */ `
vec4 objState = objectState(aObject);
vec4 objInfo = objectInfo(aObject);
vec4 objFall = objectFall(aObject);
bool objOutside = objFall.z > 0.5;
vec2 objUv = objState.xy;
float objDepth = texture2D(uWater, objUv).r;
float objFloat = objOutside ? 0.0 : smoothstep(0.002, 0.008, objDepth);
vec2 objSlope = vec2(surfaceAt(objUv + vec2(uTexel.x, 0.0)) - surfaceAt(objUv - vec2(uTexel.x, 0.0)),
                     surfaceAt(objUv + vec2(0.0, uTexel.y)) - surfaceAt(objUv - vec2(0.0, uTexel.y))) / (2.0 * uCell);
vec3 objUp = objOutside ? vec3(0.0, 1.0, 0.0) : normalize(vec3(-objSlope.x, 1.0, objSlope.y));
vec3 objForward0 = vec3(cos(objInfo.x), 0.0, -sin(objInfo.x)); // uv.y runs towards -z
vec3 objForward = normalize(objForward0 - objUp * dot(objForward0, objUp));
mat3 objBasis = mat3(objForward, objUp, cross(objForward, objUp));
float objHeight = objOutside
    ? objFall.x - ${LANDED} + uLift
    : surfaceAt(objUv) + (1.0 - objFloat) * uLift + objFloat * 0.002 * sin(uTime * 2.3 + aObject * 1.7);
vec3 objOffset = vec3((objUv.x - 0.5) * uWorld, objHeight, (0.5 - objUv.y) * uWorld);
float objAlive = step(0.5, objInfo.z);
vec3 objectNormal = objBasis * normal;
`;

const PLACE_POSITION = /* glsl */ `
vec3 transformed = objAlive > 0.5 ? objBasis * position + objOffset : vec3(0.0, -50.0, 0.0);
`;
/** Paints a geometry with one colour (vertex colours), non-indexed so the parts can be merged. */
function paint(geometry, colour) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const c = new THREE.Color(colour);
    const colours = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < colours.length; i += 3) {
        colours.set([c.r, c.g, c.b], i);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    g.deleteAttribute('uv');

    return g;
}

const part = (geometry, colour, [x, y, z] = [0, 0, 0], [rx, ry, rz] = [0, 0, 0], [sx, sy, sz] = [1, 1, 1]) => {
    geometry.scale(sx, sy, sz);
    geometry.rotateX(rx);
    geometry.rotateY(ry);
    geometry.rotateZ(rz);
    geometry.translate(x, y, z);

    return paint(geometry, colour);
};

// Models are built facing +x, with the waterline at y = 0. `lift` raises them onto their base on dry ground.
// The surfer is to scale for "Océan en direct": 1.75 m tall (OCEAN.metre world units per metre), on a 2 m board.
const M = 0.05 / 1.75;
const MODELS = {
    surfer: {
        lift: 0.003,
        parts: () => [
            part(new THREE.SphereGeometry(1, 24, 10), '#f7f7f2', [0, 0.0015, 0], [0, 0, 0], [1.0 * M, 0.06 * M, 0.27 * M]),
            part(new THREE.BoxGeometry(2 * M * 0.98, 0.002, 0.03 * M), '#2a9df4', [0, 0.0035, 0]),
            part(new THREE.CylinderGeometry(0.06 * M, 0.06 * M, 0.85 * M, 8), '#1d1d1f', [-0.22 * M, 0.003 + 0.42 * M, 0], [0, 0, 0.18]),
            part(new THREE.CylinderGeometry(0.06 * M, 0.06 * M, 0.85 * M, 8), '#1d1d1f', [0.22 * M, 0.003 + 0.42 * M, 0], [0, 0, -0.18]),
            part(new THREE.CylinderGeometry(0.13 * M, 0.11 * M, 0.6 * M, 10), '#1d1d1f', [0, 0.003 + 1.12 * M, 0]),
            part(new THREE.SphereGeometry(0.11 * M, 14, 10), '#e0ac69', [0, 0.003 + 1.6 * M, 0]),
            part(new THREE.CylinderGeometry(0.045 * M, 0.045 * M, 1.5 * M, 8), '#1d1d1f', [0, 0.003 + 1.33 * M, 0], [0, 0, Math.PI / 2 - 0.15]),
        ],
    },
    duck: {
        lift: 0.016,
        parts: () => [
            part(new THREE.SphereGeometry(0.024, 20, 14), '#ffd23f', [0, 0.004, 0], [0, 0, 0], [1.3, 0.8, 1]),
            part(new THREE.SphereGeometry(0.013, 16, 12), '#ffd23f', [0.022, 0.03, 0]),
            part(new THREE.ConeGeometry(0.006, 0.014, 10), '#f28c28', [0.037, 0.028, 0], [0, 0, -Math.PI / 2]),
            part(new THREE.SphereGeometry(0.0025, 8, 6), '#1a1a1a', [0.03, 0.035, 0.008]),
            part(new THREE.SphereGeometry(0.0025, 8, 6), '#1a1a1a', [0.03, 0.035, -0.008]),
            part(new THREE.ConeGeometry(0.008, 0.018, 8), '#ffc61a', [-0.031, 0.012, 0], [0, 0, Math.PI / 2.5]),
        ],
    },
    boat: {
        lift: 0.008,
        parts: () => {
            const hull = new THREE.Shape([
                new THREE.Vector2(-0.045, 0.012), new THREE.Vector2(-0.03, -0.008),
                new THREE.Vector2(0.03, -0.008), new THREE.Vector2(0.045, 0.012),
            ]);
            const hullGeometry = new THREE.ExtrudeGeometry(hull, { depth: 0.03, bevelEnabled: false });
            const sail = new THREE.Shape([new THREE.Vector2(-0.025, 0.012), new THREE.Vector2(0.025, 0.012), new THREE.Vector2(0, 0.05)]);
            const sailGeometry = new THREE.ExtrudeGeometry(sail, { depth: 0.002, bevelEnabled: false });

            return [
                part(hullGeometry, '#f4f1ea', [0, 0, -0.015]),
                part(sailGeometry, '#e9e4d8', [0, 0, -0.001]),
            ];
        },
    },
    leaf: {
        lift: 0.002,
        parts: () => [
            part(new THREE.SphereGeometry(0.02, 18, 8), '#5c9e3a', [0, 0.001, 0], [0, 0, 0], [1.6, 0.1, 0.8]),
            part(new THREE.CylinderGeometry(0.0015, 0.0015, 0.02, 6), '#3f6e26', [-0.04, 0.002, 0], [0, 0, Math.PI / 2]),
        ],
    },
    log: {
        lift: 0.011,
        parts: () => [
            part(new THREE.CylinderGeometry(0.012, 0.012, 0.09, 16), '#7a4f2c', [0, 0.003, 0], [0, 0, Math.PI / 2]),
            part(new THREE.CylinderGeometry(0.0105, 0.0105, 0.0905, 16, 1, true), '#c9a06a', [0, 0.003, 0], [0, 0, Math.PI / 2]),
        ],
    },
    ball: {
        lift: 0.012,
        parts: () => [
            part(new THREE.SphereGeometry(0.022, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2), '#e63946', [0, 0.01, 0]),
            part(new THREE.SphereGeometry(0.022, 24, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), '#f1faee', [0, 0.01, 0]),
        ],
    },
};

/** The objects: GPU state, one instanced mesh per type, placement and removal. */
export class FloatingObjects {
    constructor(sim, scene, shared, { floor, base }) {
        this.sim = sim;
        this.slots = Array(MAX_OBJECTS).fill(null);
        this.state = new PingPong(MAX_OBJECTS * 3, {
            type: sim.dataType,
            format: THREE.RGBAFormat,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            depthBuffer: false,
        }, 1);
        sim.clear(this.state);

        this.uniforms = {
            uObjects: { value: this.state.texture },
            uMax: { value: MAX_OBJECTS },
            uTerrain: shared.uTerrain,
            uLava: shared.uLava,
            uWater: shared.uWater,
            uTexel: shared.uTexel,
            uCell: shared.uCell,
            uTime: shared.uTime,
            uWorld: { value: PHYSICS.world },
        };
        this.update = new THREE.ShaderMaterial({
            vertexShader: /* glsl */ 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: updateShader,
            uniforms: {
                ...this.uniforms,
                uDt: { value: 0 },
                uBroken: { value: sim.broken },
                uFloor: { value: floor },
                uBase: { value: base },
                uSpawn: { value: -1 },
                uSpawnState: { value: new THREE.Vector4() },
                uSpawnInfo: { value: new THREE.Vector4() },
            },
            depthTest: false,
            depthWrite: false,
        });

        this.meshes = Object.fromEntries(OBJECT_TYPES.map(({ id }) => {
            const model = MODELS[id];
            const geometry = mergeGeometries(model.parts());
            geometry.setAttribute('aObject', new THREE.InstancedBufferAttribute(new Float32Array(MAX_OBJECTS), 1));
            const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
            material.onBeforeCompile = (shader) => {
                Object.assign(shader.uniforms, this.uniforms, { uLift: { value: model.lift } });
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>', `#include <common>\n${PLACE_PARS}`)
                    .replace('#include <beginnormal_vertex>', PLACE_NORMAL)
                    .replace('#include <begin_vertex>', PLACE_POSITION);
            };
            const mesh = new THREE.InstancedMesh(geometry, material, MAX_OBJECTS);
            mesh.count = 0;
            mesh.frustumCulled = false;
            scene.add(mesh);

            return [id, mesh];
        }));
        this.pending = null;
        this.clock = 0;
    }

    /** Drops an object of `type` at `uv`. */
    add(type, uv) {
        const { index, slots } = placeObject(this.slots, type, this.clock);
        this.slots = slots;
        const radius = OBJECT_TYPES.find((t) => t.id === type).radius / PHYSICS.world;
        this.pending = {
            index,
            state: new THREE.Vector4(uv[0], uv[1], 0, 0),
            info: new THREE.Vector4(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 2, 1, radius),
        };
        this.rebuildInstances();
    }

    clear() {
        this.slots = Array(MAX_OBJECTS).fill(null);
        this.sim.clear(this.state);
        this.sim.renderer.setRenderTarget(null);
        this.rebuildInstances();
    }

    get count() {
        return this.slots.filter(Boolean).length;
    }

    /** Each type's mesh draws the slots holding that type. */
    rebuildInstances() {
        for (const [type, mesh] of Object.entries(this.meshes)) {
            const attribute = mesh.geometry.attributes.aObject;
            let n = 0;
            this.slots.forEach((slot, index) => {
                if (slot?.type === type) {
                    attribute.array[n++] = index;
                }
            });
            attribute.needsUpdate = true;
            mesh.count = n;
        }
    }

    step(dt) {
        this.clock += dt;
        const { uniforms } = this.update;
        uniforms.uDt.value = Math.min(dt, 0.05);
        uniforms.uSpawn.value = this.pending ? this.pending.index : -1;
        if (this.pending) {
            uniforms.uSpawnState.value.copy(this.pending.state);
            uniforms.uSpawnInfo.value.copy(this.pending.info);
            this.pending = null;
        }
        this.sim.run(this.update, this.state, { uObjects: this.state.texture });
        this.uniforms.uObjects.value = this.state.texture;
        this.sim.renderer.setRenderTarget(null);
    }

    dispose() {
        this.state.dispose();
        this.update.dispose();
        for (const mesh of Object.values(this.meshes)) {
            mesh.geometry.dispose();
            mesh.material.dispose();
            mesh.dispose();
        }
    }
}
