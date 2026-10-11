// GLSL for the simulation passes. Every pass draws a full-screen quad into one N × N float texture.
//
// Each column of the tank is a stack: rock at the bottom, then clay, earth and sand, with lava and water on top.
// A brush that adds a material turns the loose layers above its place in the stack into it (rock turns the
// clay, earth and sand under the brush into rock), so the order always holds.
//
//   terrain   r: sand height   g: wetness (0–1)   b: clay height   a: rock height
//   earth     r: earth height (its own texture: the terrain one is full)
//   lava      r: depth         g: temperature (1 molten → 0 cold)   b: steam (contact with water, for the render)
//   water     r: depth         g, b: velocity along u and v (world units / s)   a: suspended sediment
//   flux      water outflow towards the left, right, down and up neighbours (virtual pipes)
//   lavaFlux  the same for lava
//   slide     sand leaving towards the 8 neighbours (avalanches): cardinal and diagonal shares, two textures
//   plants    r: grass   g: moss   b: trees (maturity of the wood: the 3D trees grow out of it)   a: ash   (0–1)
//   soil      r: moisture of the ground (spreads from the water)   g: fire (0–1)
//
// Plants and fire run on the clock of life (see TIME in sand-physics.js), which the accelerator speeds up
// without touching the physics time step.
//
// References: Mei, Decaudin & Hu, "Fast Hydraulic Erosion Simulation and Visualization on GPU" (2007),
// for the pipe model and the erosion / deposition step.

export const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMMON = /* glsl */ `
uniform vec2 uTexel;
uniform float uCell;
uniform float uDt;
varying vec2 vUv;

vec2 L() { return vUv - vec2(uTexel.x, 0.0); }
vec2 R() { return vUv + vec2(uTexel.x, 0.0); }
vec2 D() { return vUv - vec2(0.0, uTexel.y); }
vec2 U() { return vUv + vec2(0.0, uTexel.y); }

// 1 where the neighbour exists, 0 against the glass walls.
vec4 openSides() {
    return vec4(
        vUv.x > uTexel.x ? 1.0 : 0.0,
        vUv.x < 1.0 - uTexel.x ? 1.0 : 0.0,
        vUv.y > uTexel.y ? 1.0 : 0.0,
        vUv.y < 1.0 - uTexel.y ? 1.0 : 0.0
    );
}

// Sides whose glass is broken (1) open onto the outside: the floor of the room, below the tank.
uniform vec4 uBroken;
const float OUTSIDE = -0.12;
vec4 toOutside() { return (1.0 - openSides()) * uBroken; }

// Bilinear read that works whatever the texture filtering (float textures may not filter linearly).
vec4 bilinear(sampler2D tex, vec2 uv) {
    vec2 st = clamp(uv, 0.5 * uTexel, 1.0 - 0.5 * uTexel) / uTexel - 0.5;
    vec2 i = floor(st);
    vec2 f = st - i;
    vec2 base = (i + 0.5) * uTexel;
    vec4 a = texture2D(tex, base);
    vec4 b = texture2D(tex, base + vec2(uTexel.x, 0.0));
    vec4 c = texture2D(tex, base + vec2(0.0, uTexel.y));
    vec4 d = texture2D(tex, base + uTexel);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Smooth bump: 1 at the centre, 0 at the edge of the brush.
float falloff(vec2 uv, vec2 centre, float radius) {
    float r = length(uv - centre) / radius;
    return r >= 1.0 ? 0.0 : (1.0 - r * r) * (1.0 - r * r);
}
`;

// Needs uTerrain and uLava; declares uEarth.
const GROUND = /* glsl */ `
uniform sampler2D uEarth;
float solidAt(vec2 uv) { vec4 t = texture2D(uTerrain, uv); return t.r + t.b + t.a + texture2D(uEarth, uv).r; }
float groundAt(vec2 uv) { return solidAt(uv) + texture2D(uLava, uv).r; }
`;

// Needs uPlants. How much the roots of the grass and the trees hold the sand of a cell (0–1).
const ROOTS = /* glsl */ `
float rootsAt(vec2 uv) { vec4 p = texture2D(uPlants, uv); return clamp(p.r * 0.6 + p.b, 0.0, 1.0); }
`;

const HASH = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

const NOISE = /* glsl */ `
// 2D simplex noise, Ashima Arts / Stefan Gustavson (MIT), https://github.com/stegu/webgl-noise
vec3 permute(vec3 x) { return mod(((x * 34.0) + 10.0) * x, 289.0); }
float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}
float fbm(vec2 p) {
    float sum = 0.0, amp = 0.5;
    for (int i = 0; i < 5; i++) { sum += amp * snoise(p); p = p * 2.03 + 17.1; amp *= 0.5; }
    return sum;
}
`;

export { NOISE };

// A new world, column by column: vec4(sand, earth, clay, rock). uKind (see WORLDS): 0 dunes of sand over a bed
// of rock that breaks the surface here and there; 1 rolling hills of earth, the rock rarely showing;
// 2 the same hills with patches of sand blown over them. Always a hollow with a lake.
const WORLD = /* glsl */ `
uniform vec2 uSeed;
uniform vec2 uBasin;
uniform int uKind;
vec4 worldColumn(vec2 uv) {
    vec2 p = uv * 2.6 + uSeed;
    float hollow = smoothstep(0.3, 0.0, length(uv - uBasin));
    if (uKind == 0) {
        float dunes = 0.13 + 0.07 * fbm(p);
        // Wind ripples, stretched along one direction like real dunes
        dunes += 0.018 * sin(uv.x * 30.0 + 4.0 * fbm(p * 1.7)) * smoothstep(-0.2, 0.4, fbm(p * 0.7));
        float surface = max(0.02, dunes - 0.11 * hollow);
        float rock = 0.025 + 0.16 * smoothstep(0.15, 0.55, fbm(p * 0.8 + 31.0)) * (1.0 - hollow);
        return vec4(max(0.0, surface - rock), 0.0, 0.0, rock);
    }
    float hills = 0.14 + 0.08 * fbm(p * 0.7) + 0.012 * fbm(p * 4.0);
    float surface = max(0.03, hills - 0.12 * hollow);
    float rock = min(surface, 0.02 + 0.2 * smoothstep(0.35, 0.7, fbm(p * 0.8 + 31.0)) * (1.0 - hollow));
    float sand = 0.0;
    if (uKind == 2) {
        float drifts = smoothstep(0.0, 0.35, fbm(p * 1.3 + 57.0)) * (1.0 - 0.7 * hollow);
        sand = min(surface - rock, drifts * (0.015 + 0.012 * sin(uv.x * 34.0 + 4.0 * fbm(p * 1.7))));
    }
    return vec4(max(0.0, sand), max(0.0, surface - rock - sand), 0.0, rock);
}
`;

export const initTerrainShader = /* glsl */ `
${COMMON}
${NOISE}
${WORLD}
void main() {
    vec4 c = worldColumn(vUv);
    gl_FragColor = vec4(c.x, 0.0, c.z, c.w);
}
`;

export const initEarthShader = /* glsl */ `
${COMMON}
${NOISE}
${WORLD}
void main() {
    gl_FragColor = vec4(worldColumn(vUv).y, 0.0, 0.0, 0.0);
}
`;

/** Initial water: a lake filling the hollow up to `uLevel`. */
export const initWaterShader = /* glsl */ `
${COMMON}
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
uniform vec2 uBasin;
uniform float uLevel;
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float lake = step(length(vUv - uBasin), 0.32);
    gl_FragColor = vec4(max(0.0, uLevel - (t.r + t.b + t.a + texture2D(uEarth, vUv).r)) * lake, 0.0, 0.0, 0.0);
}
`;

// Brush modes: 1 dig, 2 sand, 3 push, 4 water, 6 sponge, 7 rock, 8 clay, 9 lava, 10 seeds, 11 fire, 12 earth.
const BRUSH_UNIFORMS = /* glsl */ `
uniform int uMode;
uniform vec2 uBrush;
uniform float uRadius;
uniform float uAmount;
`;

// The terrain brush changes the terrain and the earth together: both passes run this same function on the same
// inputs, and each keeps its own part of the result.
const BRUSH_STACK = /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
uniform vec2 uDrag;
uniform float uMaxSand;
uniform float uDigClay;
uniform float uDigRock;
uniform float uDigEarth;
void applyBrush(inout vec4 t, inout float e) {
    float f = falloff(vUv, uBrush, uRadius);
    float amount = uAmount * f;
    float room = max(0.0, uMaxSand - (t.r + t.b + t.a + e));
    if (uMode == 1) {
        // The shovel takes the sand first, then the earth, bites slowly into the clay, and barely into the rock.
        float sand = min(t.r, amount);
        t.r -= sand;
        amount -= sand;
        float earth = min(e, amount * uDigEarth);
        e -= earth;
        amount -= earth / uDigEarth;
        float clay = min(t.b, amount * uDigClay);
        t.b -= clay;
        amount -= clay / uDigClay;
        t.a = max(0.0, t.a - amount * uDigRock);
    } else if (uMode == 2) {
        t.r += min(room, amount);
    } else if (uMode == 3) {
        // Bulldozer: each cell takes the sand that was behind it along the gesture.
        t.r = bilinear(uTerrain, vUv - uDrag * f).r;
    } else if (uMode == 7 || uMode == 8 || uMode == 12) {
        // Rock, clay and earth go on top: the loose layers above their place in the stack, under the brush,
        // are turned into the new material.
        float k = min(1.0, f * 20.0 * uAmount);
        float turned = t.r * k;
        t.r -= turned;
        float added = turned + min(room, amount);
        if (uMode == 12) {
            e += added;
        } else {
            float earth = e * k;
            e -= earth;
            added += earth;
            if (uMode == 7) {
                float clay = t.b * k;
                t.b -= clay;
                t.a += added + clay;
            } else {
                t.b += added;
            }
        }
    }
}
`;

export const brushTerrainShader = /* glsl */ `
${COMMON}
${BRUSH_UNIFORMS}
${BRUSH_STACK}
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float e = texture2D(uEarth, vUv).r;
    applyBrush(t, e);
    gl_FragColor = t;
}
`;

export const brushEarthShader = /* glsl */ `
${COMMON}
${BRUSH_UNIFORMS}
${BRUSH_STACK}
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float e = texture2D(uEarth, vUv).r;
    applyBrush(t, e);
    gl_FragColor = vec4(e, 0.0, 0.0, 0.0);
}
`;

export const brushWaterShader = /* glsl */ `
${COMMON}
${BRUSH_UNIFORMS}
uniform sampler2D uWater;
uniform vec2 uSprings[4];
uniform int uSpringCount;
uniform float uSpringRate;
uniform float uRain;
uniform float uFrameDt;
uniform float uTime;
uniform float uEvaporate; // depth lost this frame (only while time is accelerated)
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
    vec4 w = texture2D(uWater, vUv);
    w.r = max(0.0, w.r - uEvaporate);
    float f = falloff(vUv, uBrush, uRadius);
    if (uMode == 4) {
        w.r += uAmount * f;
    } else if (uMode == 6) {
        w.r *= 1.0 - clamp(uAmount * 12.0 * f, 0.0, 1.0);
    }
    for (int i = 0; i < 4; i++) {
        if (i >= uSpringCount) break;
        w.r += uSpringRate * uFrameDt * falloff(vUv, uSprings[i], 0.035);
    }
    // Rain: spread over the whole tank with a slight variation (the drops themselves are drawn by the particles).
    w.r += uRain * uFrameDt * (0.75 + 0.5 * hash(floor(vUv * 64.0) + floor(uTime * 3.0)));
    gl_FragColor = w;
}
`;

export const brushLavaShader = /* glsl */ `
${COMMON}
${BRUSH_UNIFORMS}
uniform sampler2D uLava;
void main() {
    vec4 l = texture2D(uLava, vUv);
    float added = uMode == 9 ? uAmount * falloff(vUv, uBrush, uRadius) : 0.0;
    // Fresh lava is molten: the mix heats up in proportion to what was poured.
    l.g = (l.r * l.g + added) / max(l.r + added, 1e-6);
    l.r += added;
    gl_FragColor = l;
}
`;

export const fluxShader = /* glsl */ `
${COMMON}
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uWater;
uniform sampler2D uFlux;
uniform float uGravity;
uniform float uDamping;
uniform vec4 uWaves;     // live ocean (see waterShader): z still-water level, w on/off
uniform float uBreakLoss;
${GROUND}
float surface(vec2 uv) { return groundAt(uv) + texture2D(uWater, uv).r; }
void main() {
    float d = texture2D(uWater, vUv).r;
    float h = groundAt(vUv) + d;
    vec4 outside = toOutside();
    vec4 neighbours = mix(vec4(surface(L()), surface(R()), surface(D()), surface(U())), vec4(OUTSIDE), outside);
    vec4 dh = h - neighbours;
    // Pipe of section cell² and length cell: the flow grows by dt · g · cell · Δh.
    // Through a broken pane the water pours out and leaves the simulation.
    vec4 f = max(vec4(0.0), texture2D(uFlux, vUv) * uDamping + uDt * uGravity * uCell * dh) * (openSides() + outside);
    // Breaking: a crest higher than about half the still depth topples and loses its energy in whitewater.
    if (uWaves.w > 0.5) {
        float stillDepth = max(uWaves.z - groundAt(vUv), 0.003);
        f *= 1.0 - uBreakLoss * smoothstep(0.42, 0.65, (h - uWaves.z) / stillDepth);
    }
    float total = f.r + f.g + f.b + f.a;
    float available = d * uCell * uCell / uDt;
    if (total > available) {
        f *= available / total; // never take more water than the cell holds
    }
    gl_FragColor = f;
}
`;

export const waterShader = /* glsl */ `
${COMMON}
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uWater;
uniform sampler2D uFlux;
uniform float uMaxSpeed;
uniform float uWorld;
// Wave maker along the back edge (v = 1). uWaves: amplitude, angular frequency, still-water level, on/off
// of the first train; uWaves2: amplitude and angular frequency of the second, wavenumbers along the edge of both.
uniform vec4 uWaves;
uniform vec4 uWaves2;
uniform float uWaveTime;
${GROUND}
void main() {
    vec4 w = texture2D(uWater, vUv);
    vec4 f = texture2D(uFlux, vUv);
    vec4 open = openSides();
    float inL = texture2D(uFlux, L()).g * open.x; // the left neighbour's flow to the right
    float inR = texture2D(uFlux, R()).r * open.y;
    float inD = texture2D(uFlux, D()).a * open.z;
    float inU = texture2D(uFlux, U()).b * open.w;
    float outflow = f.r + f.g + f.b + f.a;
    float d = max(0.0, w.r + uDt * (inL + inR + inD + inU - outflow) / (uCell * uCell));

    float meanDepth = max(0.5 * (w.r + d), 0.0005);
    vec2 v = vec2((inL - f.r) + (f.g - inR), (inD - f.b) + (f.a - inU)) * 0.5 / (uCell * meanDepth);
    float speed = length(v);
    if (speed > uMaxSpeed) v *= uMaxSpeed / speed;
    if (d < 0.0002) v = vec2(0.0);

    // The last rows at the back follow the swell: like the paddle of a wave tank, they push the waves in.
    if (uWaves.w > 0.5 && vUv.y > 1.0 - 2.0 * uTexel.y) {
        float x = (vUv.x - 0.5) * uWorld;
        float surface = uWaves.z + uWaves.x * sin(uWaves.y * uWaveTime - uWaves2.z * x)
                      + uWaves2.x * sin(uWaves2.y * uWaveTime - uWaves2.w * x + 1.7);
        d = max(0.0, surface - groundAt(vUv));
    }

    // Sediment travels with the water (semi-Lagrangian back-trace).
    float sediment = bilinear(uWater, vUv - v * uDt / uWorld).a;
    gl_FragColor = vec4(d, v, sediment);
}
`;

const EROSION = /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uWater;
uniform float uCapacity;
uniform float uDissolve;
uniform float uDeposit;
uniform float uClayErosion;
uniform float uEarthErosion;
uniform float uErosion; // 0 = off
uniform sampler2D uPlants;
uniform float uRootErosion;
${GROUND}
${ROOTS}
// Material the water picks up this step (> 0) or lets settle as sand (< 0). Sand goes first, then earth and
// clay, which resist (uEarthErosion, uClayErosion); rock and lava never erode. earthPart and clayPart are the
// shares taken from the earth and the clay.
float exchange(out float earthPart, out float clayPart) {
    vec4 w = texture2D(uWater, vUv);
    vec4 t = texture2D(uTerrain, vUv);
    earthPart = 0.0;
    clayPart = 0.0;
    if (texture2D(uLava, vUv).r > 0.0005) return 0.0;
    vec2 grad = vec2(groundAt(R()) - groundAt(L()), groundAt(U()) - groundAt(D())) / (2.0 * uCell);
    float sinTilt = length(grad) / sqrt(1.0 + dot(grad, grad));
    float depthFactor = clamp(w.r / 0.01, 0.0, 1.0);
    // Roots hold the ground against the current.
    float capacity = uCapacity * max(sinTilt, 0.05) * length(w.gb) * depthFactor * (1.0 - uRootErosion * rootsAt(vUv));
    if (w.a >= capacity) {
        return -min(w.a, uDeposit * (w.a - capacity) * uDt) * uErosion;
    }
    float wanted = uDissolve * (capacity - w.a) * uDt * uErosion;
    float sand = min(t.r, wanted);
    float left = wanted - sand;
    earthPart = min(texture2D(uEarth, vUv).r, left * uEarthErosion);
    left -= earthPart / uEarthErosion;
    clayPart = min(t.b, left * uClayErosion);
    return sand + earthPart + clayPart;
}
`;

export const erosionTerrainShader = /* glsl */ `
${COMMON}
${EROSION}
uniform float uDrying;
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float d = texture2D(uWater, vUv).r;
    float earthPart, clayPart;
    float moved = exchange(earthPart, clayPart);
    t.b -= clayPart;
    t.r -= moved - earthPart - clayPart; // deposits (moved < 0) settle as sand
    // Sand under water is soaked; a film of water (rain) soaks it gradually; it dries slowly once the water has gone.
    t.g = d > 0.0015 ? 1.0 : d > 0.0001 ? min(1.0, t.g + 1.5 * uDt) : max(0.0, t.g - uDrying * uDt);
    gl_FragColor = t;
}
`;

export const erosionWaterShader = /* glsl */ `
${COMMON}
${EROSION}
void main() {
    vec4 w = texture2D(uWater, vUv);
    float earthPart, clayPart;
    w.a += exchange(earthPart, clayPart);
    gl_FragColor = w;
}
`;

export const erosionEarthShader = /* glsl */ `
${COMMON}
${EROSION}
void main() {
    float earthPart, clayPart;
    exchange(earthPart, clayPart);
    gl_FragColor = vec4(texture2D(uEarth, vUv).r - earthPart, 0.0, 0.0, 0.0);
}
`;

// Avalanches look at the 8 neighbours (diagonals at √2 the distance), so piles settle into round cones
// rather than square pyramids. Only sand slides; it compares the full ground heights (rock, clay, lava
// included). The pass runs twice on the same input: uDiagonal 0 writes the shares sent left, right, down
// and up; uDiagonal 1 those sent down-left, down-right, up-left and up-right.
// uMaterial 0 moves the sand; 1 the earth, at its own angles of repose, where no sand covers it.
export const slideOutShader = /* glsl */ `
${COMMON}
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uWater;
uniform float uTalusDry;
uniform float uTalusWet;
uniform float uTalusUnder;
uniform float uSlideRate;
uniform float uDiagonal;
uniform sampler2D uPlants;
uniform float uTalusRoots;
uniform float uMaterial;
uniform vec3 uTalusEarth; // dry, wet, under water
${GROUND}
${ROOTS}
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float d = texture2D(uWater, vUv).r;
    float h = groundAt(vUv);
    bool earth = uMaterial > 0.5;
    float repose = earth
        ? (d > 0.0015 ? uTalusEarth.z : mix(uTalusEarth.x, uTalusEarth.y, t.g))
        : (d > 0.0015 ? uTalusUnder : mix(uTalusDry, uTalusWet, t.g));
    // Grass and trees hold their slope: a planted bank stands steeper.
    repose = mix(repose, max(repose, uTalusRoots), rootsAt(vUv)) * uCell;
    vec4 open = openSides();
    vec2 tx = vec2(uTexel.x, 0.0);
    vec2 ty = vec2(0.0, uTexel.y);
    vec4 cardinal = vec4(groundAt(L()), groundAt(R()), groundAt(D()), groundAt(U()));
    vec4 diagonal = vec4(groundAt(vUv - tx - ty), groundAt(vUv + tx - ty), groundAt(vUv - tx + ty), groundAt(vUv + tx + ty));
    vec4 openDiagonal = vec4(open.x * open.z, open.y * open.z, open.x * open.w, open.y * open.w);
    // Through a broken pane the sand runs out onto the floor (height 0) until it reaches its angle of repose.
    vec4 outside = toOutside();
    cardinal = mix(cardinal, vec4(0.0), outside);
    vec4 excessC = max((h - cardinal) * (open + outside) - repose, 0.0);
    vec4 excessD = max((h - diagonal) * openDiagonal - repose * 1.41421356, 0.0);
    float sum = dot(excessC, vec4(1.0)) + dot(excessD, vec4(1.0));
    float steepest = max(max(max(excessC.x, excessC.y), max(excessC.z, excessC.w)),
                         max(max(excessD.x, excessD.y), max(excessD.z, excessD.w)));
    // Moving half the steepest excess, shared by steepness, keeps the scheme stable and the mass exact.
    // Sand buried under lava stays put; so does earth under sand.
    float loose = texture2D(uLava, vUv).r > 0.0005 ? 0.0 : !earth ? t.r : t.r < 0.0005 ? texture2D(uEarth, vUv).r : 0.0;
    float moved = min(loose, 0.5 * steepest * uSlideRate);
    vec4 share = uDiagonal > 0.5 ? excessD : excessC;
    gl_FragColor = sum > 0.0 ? share / sum * moved : vec4(0.0);
}
`;

export const slideApplyShader = /* glsl */ `
${COMMON}
uniform sampler2D uTerrain;
uniform sampler2D uSlide;
uniform sampler2D uSlideDiagonal;
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    vec4 open = openSides();
    vec2 tx = vec2(uTexel.x, 0.0);
    vec2 ty = vec2(0.0, uTexel.y);
    float incoming = texture2D(uSlide, L()).g * open.x + texture2D(uSlide, R()).r * open.y
                   + texture2D(uSlide, D()).a * open.z + texture2D(uSlide, U()).b * open.w
                   // from the down-left neighbour its up-right share, and so on
                   + texture2D(uSlideDiagonal, vUv - tx - ty).a * open.x * open.z
                   + texture2D(uSlideDiagonal, vUv + tx - ty).b * open.y * open.z
                   + texture2D(uSlideDiagonal, vUv - tx + ty).g * open.x * open.w
                   + texture2D(uSlideDiagonal, vUv + tx + ty).r * open.y * open.w;
    vec4 a = texture2D(uSlide, vUv);
    vec4 b = texture2D(uSlideDiagonal, vUv);
    t.r += incoming - dot(a, vec4(1.0)) - dot(b, vec4(1.0));
    gl_FragColor = t;
}
`;

// Lava: the same pipe model as water, but viscous (strong damping, a flow that stiffens as it cools)
// and it carries its temperature with it. It cools slowly in the air and almost at once under water.
export const lavaFluxShader = /* glsl */ `
${COMMON}
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uLavaFlux;
uniform float uGravity;
uniform float uLavaFluidity;
uniform float uLavaDamping;
uniform sampler2D uEarth;
float solid(vec2 uv) { vec4 t = texture2D(uTerrain, uv); return t.r + t.b + t.a + texture2D(uEarth, uv).r; }
float surface(vec2 uv) { return solid(uv) + texture2D(uLava, uv).r; }
void main() {
    vec4 lava = texture2D(uLava, vUv);
    float h = solid(vUv) + lava.r;
    vec4 outside = toOutside();
    vec4 neighbours = mix(vec4(surface(L()), surface(R()), surface(D()), surface(U())), vec4(OUTSIDE), outside);
    float fluidity = uLavaFluidity * lava.g * lava.g;
    vec4 f = max(vec4(0.0), texture2D(uLavaFlux, vUv) * uLavaDamping + uDt * uGravity * fluidity * uCell * (h - neighbours))
           * (openSides() + outside);
    float total = f.r + f.g + f.b + f.a;
    float available = lava.r * uCell * uCell / uDt;
    if (total > available) {
        f *= available / total;
    }
    gl_FragColor = f;
}
`;

export const lavaShader = /* glsl */ `
${COMMON}
uniform sampler2D uLava;
uniform sampler2D uLavaFlux;
uniform sampler2D uWater;
uniform float uCooling;
uniform float uQuench;
void main() {
    vec4 lava = texture2D(uLava, vUv);
    vec4 f = texture2D(uLavaFlux, vUv);
    vec4 open = openSides();
    float k = uDt / (uCell * uCell);
    vec4 incoming = vec4(texture2D(uLavaFlux, L()).g * open.x, texture2D(uLavaFlux, R()).r * open.y,
                         texture2D(uLavaFlux, D()).a * open.z, texture2D(uLavaFlux, U()).b * open.w) * k;
    vec4 heat = vec4(texture2D(uLava, L()).g, texture2D(uLava, R()).g, texture2D(uLava, D()).g, texture2D(uLava, U()).g);
    float stay = max(0.0, lava.r - (f.r + f.g + f.b + f.a) * k);
    float depth = stay + dot(incoming, vec4(1.0));
    // Heat is carried with the lava: the new temperature is the mix of what stayed and what came in.
    float temperature = depth > 1e-6 ? (stay * lava.g + dot(incoming, heat)) / depth : 0.0;
    float water = texture2D(uWater, vUv).r;
    bool quenched = water > 0.001;
    temperature = max(0.0, temperature - uDt * (uCooling + (quenched ? uQuench : 0.0)));
    float steam = quenched && depth > 0.0005 ? 1.0 : lava.b * (1.0 - 2.0 * uDt);
    gl_FragColor = vec4(depth, temperature, steam, 0.0);
}
`;

// Cold lava (or a film too thin to flow) becomes rock. Both passes read the same lava, so they agree.
const SOLIDIFY = /* glsl */ `
uniform sampler2D uLava;
uniform float uFreezing;
// Only the faintest films set at once: the thin edge of a flow must keep flowing, or it leaves isolated specks.
bool solidifies(vec4 lava) { return lava.r > 0.0 && (lava.g < uFreezing || lava.r < 0.00005); }
`;

export const lavaSolidifyTerrainShader = /* glsl */ `
${COMMON}
${SOLIDIFY}
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    vec4 lava = texture2D(uLava, vUv);
    // The new rock is on top: the sand, earth and clay it covered are fused into it (the stack keeps rock at the bottom).
    if (solidifies(lava)) {
        t.a += lava.r + t.r + t.b + texture2D(uEarth, vUv).r;
        t.r = 0.0;
        t.b = 0.0;
    }
    gl_FragColor = t;
}
`;

export const lavaSolidifyEarthShader = /* glsl */ `
${COMMON}
${SOLIDIFY}
uniform sampler2D uEarth;
void main() {
    vec4 e = texture2D(uEarth, vUv);
    gl_FragColor = solidifies(texture2D(uLava, vUv)) ? vec4(0.0) : e;
}
`;

export const lavaSolidifyShader = /* glsl */ `
${COMMON}
${SOLIDIFY}
void main() {
    vec4 lava = texture2D(uLava, vUv);
    gl_FragColor = solidifies(lava) ? vec4(0.0, 0.0, lava.b, 0.0) : lava;
}
`;

// Buttons of the panel: remove one material everywhere, or fill the tank with water up to a level.
export const clearLayersShader = /* glsl */ `
${COMMON}
uniform sampler2D uTerrain;
uniform vec4 uKeep; // sand, wetness, clay, rock: 1 keeps, 0 removes
void main() {
    gl_FragColor = texture2D(uTerrain, vUv) * uKeep;
}
`;

export const fillWaterShader = /* glsl */ `
${COMMON}
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uWater;
uniform float uLevel;
${GROUND}
void main() {
    vec4 w = texture2D(uWater, vUv);
    float depth = max(w.r, uLevel - groundAt(vUv));
    gl_FragColor = vec4(depth, depth > w.r ? vec2(0.0) : w.gb, w.a);
}
`;

/** "Océan en direct": a beach. Deep sand-free water at the back, a sand slope up to a dry beach at the front. */
export const beachShader = /* glsl */ `
${COMMON}
${NOISE}
uniform float uLevel;
void main() {
    // v = 1 is the back (open sea), v = 0 the front (the beach, near the camera)
    float shore = smoothstep(0.78, 0.05, vUv.y);
    // A sandbar offshore, wavy along the beach: the waves break a first time on it, then reform.
    float barLine = 0.5 + 0.04 * sin(vUv.x * 7.0 + 1.3) + 0.02 * fbm(vUv * 3.0);
    float bar = 0.02 * exp(-pow((vUv.y - barLine) / 0.05, 2.0)); // its top stays just under the still water
    float sand = 0.03 + (uLevel + 0.06) * shore + bar + 0.006 * fbm(vUv * 6.0) + 0.004 * sin(vUv.x * 40.0 + fbm(vUv * 3.0) * 3.0) * shore;
    gl_FragColor = vec4(sand, 0.0, 0.0, 0.0);
}
`;
// --- Life: plants, soil moisture and fire ---------------------------------------------------------------

/** Meadows and moss around the lake of a new world (over most of the land of earth), with a few groves; none on the water. */
export const initPlantsShader = /* glsl */ `
${COMMON}
${NOISE}
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
uniform sampler2D uWater;
uniform vec2 uSeed;
uniform vec2 uBasin;
uniform int uKind;
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float e = texture2D(uEarth, vUv).r;
    float dry = step(texture2D(uWater, vUv).r, 0.0005);
    float near = uKind == 0 ? smoothstep(0.55, 0.3, length(vUv - uBasin)) : smoothstep(0.95, 0.4, length(vUv - uBasin));
    float patches = smoothstep(-0.15, 0.3, fbm(vUv * 5.0 + uSeed * 0.37));
    float cover = dry * near * patches;
    bool soil = t.r + t.b + e > 0.002;
    float grass = soil ? cover * (t.r < 0.002 && e > 0.002 ? 1.0 : 0.9) : 0.0;
    float moss = soil ? 0.0 : cover * 0.7;
    float trees = grass > 0.6 ? smoothstep(0.1, 0.5, fbm(vUv * 9.0 + uSeed.yx)) : 0.0;
    gl_FragColor = vec4(grass, moss, trees, 0.0);
}
`;

/** Damp ground around the lake of a new world, as after a rain (earth keeps its water further from the lake). */
export const initSoilShader = /* glsl */ `
${COMMON}
uniform vec2 uBasin;
uniform int uKind;
void main() {
    float reach = uKind == 0 ? 0.55 : 0.9;
    gl_FragColor = vec4(smoothstep(reach, 0.2, length(vUv - uBasin)), 0.0, 0.0, 0.0);
}
`;

export const brushPlantsShader = /* glsl */ `
${COMMON}
${BRUSH_UNIFORMS}
uniform sampler2D uPlants;
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
void main() {
    vec4 p = texture2D(uPlants, vUv);
    vec4 t = texture2D(uTerrain, vUv);
    float f = falloff(vUv, uBrush, uRadius);
    if (uMode == 10) {
        // Seeds: grass on sand, earth and clay, moss on bare rock. They only take where the ground is damp.
        float sown = uAmount * f;
        if (t.r + t.b + texture2D(uEarth, vUv).r > 0.002) {
            p.r = min(1.0, p.r + sown);
        } else if (t.a > 0.002) {
            p.g = min(1.0, p.g + sown);
        }
    } else {
        // Digging, pushing or covering the ground takes the plants (and the ash) with the top layer.
        p *= 1.0 - (uMode == 3 ? f * 0.3 : min(1.0, f * 40.0 * uAmount));
    }
    gl_FragColor = p;
}
`;

export const brushFireShader = /* glsl */ `
${COMMON}
${BRUSH_UNIFORMS}
uniform sampler2D uSoil;
void main() {
    vec4 s = texture2D(uSoil, vUv);
    s.g = max(s.g, step(0.15, falloff(vUv, uBrush, uRadius)));
    gl_FragColor = s;
}
`;

const LIFE_UNIFORMS = /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uWater;
uniform sampler2D uPlants;
uniform sampler2D uSoil;
uniform sampler2D uEarth;
uniform float uLifeDt;    // tank time elapsed this frame
uniform float uLifeTime;  // tank time
uniform float uDaylight;  // 0 at night, 1 in full sun
`;

/**
 * Soil moisture and fire. Moisture spreads from cell to cell (a wall keeps it in), is lost slowly to the air
 * and is saturated under water or wet sand. Fire catches from a burning neighbour or from hot lava, grows while
 * there is fuel (grass, trees, a little moss) and dies out without it; damp ground, water and rain stop it.
 */
export const soilShader = /* glsl */ `
${COMMON}
${HASH}
${LIFE_UNIFORMS}
uniform float uMoistureSpread;
uniform float uMoistureLoss;
uniform float uFireSpread;
float lavaHeat(vec2 uv) { vec4 l = texture2D(uLava, uv); return l.r > 0.0005 ? l.g : 0.0; }
void main() {
    vec4 s = texture2D(uSoil, vUv);
    vec4 p = texture2D(uPlants, vUv);
    vec4 t = texture2D(uTerrain, vUv);
    float d = texture2D(uWater, vUv).r;
    float dt = uLifeDt;
    vec4 open = openSides();
    vec4 sl = texture2D(uSoil, L());
    vec4 sr = texture2D(uSoil, R());
    vec4 sd = texture2D(uSoil, D());
    vec4 su = texture2D(uSoil, U());

    vec4 around = mix(vec4(s.r), vec4(sl.r, sr.r, sd.r, su.r), open);
    float moisture = s.r + min(1.0, uMoistureSpread * dt) * (dot(around, vec4(0.25)) - s.r);
    moisture *= exp(-uMoistureLoss * dt * (0.4 + 0.6 * uDaylight));
    moisture = max(moisture, d > 0.0015 ? 1.0 : t.g);

    float fire = s.g;
    float fuel = p.r + 2.0 * p.b + 0.3 * p.g;
    vec4 flames = vec4(sl.g, sr.g, sd.g, su.g) * open;
    float spark = max(max(flames.x, flames.y), max(flames.z, flames.w));
    float heat = max(lavaHeat(vUv), max(max(lavaHeat(L()), lavaHeat(R())), max(lavaHeat(D()), lavaHeat(U()))));
    spark = max(spark, step(0.3, heat));
    if (fire > 0.01) {
        fire = fuel > 0.02 ? min(1.0, fire + 2.0 * dt) : fire - 1.5 * dt;
    } else {
        // An irregular front: each cell catches at its own pace, redrawn four times per second of tank time.
        float pace = 0.4 + 1.2 * hash(floor(vUv / uTexel) + floor(uLifeTime * 4.0));
        float catching = uFireSpread * pace * smoothstep(0.03, 0.2, fuel) * (1.0 - smoothstep(0.6, 0.98, moisture));
        fire = min(1.0, catching * dt) * spark;
    }
    if (d > 0.0015) {
        fire = 0.0;
    }
    fire -= dt * 2.0 * smoothstep(0.6, 1.0, t.g); // soaked by the rain
    gl_FragColor = vec4(clamp(moisture, 0.0, 1.0), clamp(fire, 0.0, 1.0), 0.0, 0.0);
}
`;

/**
 * Plants. Grass grows by day on damp sand or clay, from its own roots and from the seeds of its neighbours,
 * faster on ash; it dries up without water and rots under it. Moss covers damp bare rock, in the shade too.
 * Trees grow slowly out of old meadows. Fire burns them all into ash; lava swallows everything.
 */
export const plantsShader = /* glsl */ `
${COMMON}
${LIFE_UNIFORMS}
uniform float uGrassGrowth;
uniform float uGrassDecay;
uniform float uDrown;
uniform float uMossGrowth;
uniform float uTreeGrowth;
uniform float uBurn;
uniform float uAshFade;
uniform float uEarthFertility;
void main() {
    vec4 p = texture2D(uPlants, vUv);
    float e = texture2D(uEarth, vUv).r;
    vec4 s = texture2D(uSoil, vUv);
    vec4 t = texture2D(uTerrain, vUv);
    float d = texture2D(uWater, vUv).r;
    float dt = uLifeDt;
    if (texture2D(uLava, vUv).r > 0.0005) {
        gl_FragColor = vec4(0.0);
        return;
    }
    vec4 open = openSides();
    vec4 n = (texture2D(uPlants, L()) * open.x + texture2D(uPlants, R()) * open.y
            + texture2D(uPlants, D()) * open.z + texture2D(uPlants, U()) * open.w) * 0.25;
    bool soil = t.r + t.b + e > 0.002;
    bool rock = !soil && t.a > 0.002;
    float fertility = t.r < 0.002 && e > 0.002 ? uEarthFertility : 1.0; // bare earth
    float wet = smoothstep(0.1, 0.35, s.r);
    float dry = 1.0 - smoothstep(0.04, 0.15, s.r);
    float drowned = smoothstep(0.003, 0.008, d);
    float sun = uDaylight;
    float burn = uBurn * s.g * dt;

    float grass = p.r;
    if (soil) {
        float vigour = wet * sun * (1.0 - drowned) * (1.0 + 2.0 * p.a) * fertility;
        grass += uGrassGrowth * dt * vigour * (grass + 0.3 * n.r + 0.02 * p.a) * (1.0 - grass);
    } else {
        grass = 0.0;
    }
    grass -= dt * (uGrassDecay * dry * (0.3 + 0.7 * sun) + uDrown * drowned);
    float burntGrass = clamp(burn, 0.0, max(grass, 0.0));
    grass -= burntGrass;

    float moss = p.g;
    if (rock) {
        moss += uMossGrowth * dt * wet * (0.5 + 0.5 * sun) * (moss + 0.3 * n.g + 0.01) * (1.0 - moss);
    } else {
        moss -= dt * 0.5; // buried under sand or clay
    }
    moss -= dt * uGrassDecay * 0.3 * dry + burn * 0.3;

    float trees = p.b;
    if (soil) {
        float meadow = smoothstep(0.5, 0.85, grass);
        // 0.01: a few seeds carried by the wind and the birds
        trees += uTreeGrowth * dt * wet * sun * meadow * (trees + 0.05 * n.b + 0.01) * (1.0 - trees);
    } else {
        trees = 0.0;
    }
    trees -= dt * (uGrassDecay * 0.5 * dry + uDrown * 0.3 * smoothstep(0.01, 0.03, d)); // trees survive shallow floods
    float burntTrees = clamp(burn * 0.35, 0.0, max(trees, 0.0));
    trees -= burntTrees;

    float ash = p.a + (burntGrass + 2.0 * burntTrees) * 1.5 - dt * (uAshFade + 0.1 * drowned);
    gl_FragColor = clamp(vec4(grass, moss, trees, ash), 0.0, 1.0);
}
`;

/**
 * Small map of the tank read back by the CPU (asynchronously, so the GPU never waits): ground height, water depth,
 * lava and earth depths, each texel the average of a block of cells. Used to aim the tools, for the puddles under
 * broken panes, to size the wave of a meteorite and to skip the lava and earth passes while there is none.
 */
export const heightsShader = /* glsl */ `
${COMMON}
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uWater;
${GROUND}
void main() {
    gl_FragColor = vec4(groundAt(vUv), texture2D(uWater, vUv).r, texture2D(uLava, vUv).r, texture2D(uEarth, vUv).r);
}
`;

// --- Meteorite --------------------------------------------------------------------------------------------

// Impact of a meteorite, run once. Every crater pass reads the same state and keeps its own part.
const CRATER = /* glsl */ `
uniform vec2 uImpact;         // uv
uniform float uImpactRadius;  // uv
uniform float uImpactDepth;   // world units
uniform float uRim;           // height of the rim, in depths
uniform float uMaxSand;
uniform float uImpactLava;    // depth of molten rock left at the bottom
uniform float uWave;          // depth added to the ring of water (see impactWave())
uniform float uFireRadius;    // in crater radii
float craterR() { return length(vUv - uImpact) / uImpactRadius; }
// craterProfile() of sand-physics.js, with a ragged rim.
float craterChange() {
    float r = craterR();
    vec2 dir = vUv - uImpact;
    float angle = atan(dir.y, dir.x);
    float ragged = 0.7 + 0.3 * sin(angle * 7.0 + uImpact.x * 41.0) + 0.2 * sin(angle * 13.0 - uImpact.y * 29.0);
    float bowl = r < 1.0 ? -uImpactDepth * (1.0 - r * r) : 0.0;
    return bowl + uRim * uImpactDepth * exp(-pow((r - 1.0) / 0.3, 2.0)) * ragged;
}
// The bowl is blown out from the top of the stack down; the rim is the ground pushed up, so its top layer rises.
void crater(inout vec4 t, inout float e) {
    float change = craterChange();
    if (change < 0.0) {
        float dig = -change;
        float sand = min(t.r, dig);
        t.r -= sand;
        dig -= sand;
        float earth = min(e, dig);
        e -= earth;
        dig -= earth;
        float clay = min(t.b, dig);
        t.b -= clay;
        dig -= clay;
        t.a = max(0.0, t.a - dig);
    } else {
        float up = min(max(0.0, uMaxSand - (t.r + t.b + t.a + e)), change);
        if (t.r > 0.0005) t.r += up;
        else if (e > 0.0005) e += up;
        else if (t.b > 0.0005) t.b += up;
        else t.a += up;
    }
    if (craterR() < 1.0) {
        t.g = 0.0; // dried by the heat
    }
}
`;

export const craterTerrainShader = /* glsl */ `
${COMMON}
${CRATER}
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float e = texture2D(uEarth, vUv).r;
    crater(t, e);
    gl_FragColor = t;
}
`;

export const craterEarthShader = /* glsl */ `
${COMMON}
${CRATER}
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float e = texture2D(uEarth, vUv).r;
    crater(t, e);
    gl_FragColor = vec4(e, 0.0, 0.0, 0.0);
}
`;

/** Molten rock at the bottom of the crater. */
export const craterLavaShader = /* glsl */ `
${COMMON}
${CRATER}
uniform sampler2D uLava;
void main() {
    vec4 l = texture2D(uLava, vUv);
    float r = craterR() / 0.65;
    float added = r < 1.0 ? uImpactLava * (1.0 - r * r) : 0.0;
    l.g = (l.r * l.g + added) / max(l.r + added, 1e-6);
    l.r += added;
    gl_FragColor = l;
}
`;

/** The water of the crater is blown out into a ring around it, which runs off as a wave. */
export const craterWaterShader = /* glsl */ `
${COMMON}
${CRATER}
uniform sampler2D uWater;
void main() {
    vec4 w = texture2D(uWater, vUv);
    float r = craterR();
    if (r < 1.15) {
        w = vec4(0.0);
    } else {
        w.r += uWave * smoothstep(1.15, 1.35, r) * smoothstep(2.1, 1.8, r);
    }
    gl_FragColor = w;
}
`;

/** Nothing is left alive in the crater; around it, burnt ground. */
export const craterPlantsShader = /* glsl */ `
${COMMON}
${CRATER}
uniform sampler2D uPlants;
void main() {
    vec4 p = texture2D(uPlants, vUv);
    float r = craterR();
    if (r < 1.15) {
        p = vec4(0.0);
    } else if (r < 1.6) {
        p = vec4(p.r * 0.3, p.g * 0.3, p.b, max(p.a, 0.6));
    }
    gl_FragColor = p;
}
`;

/** The blast sets fire to what can burn around the crater, and dries the ground it digs. */
export const craterSoilShader = /* glsl */ `
${COMMON}
${CRATER}
uniform sampler2D uSoil;
void main() {
    vec4 s = texture2D(uSoil, vUv);
    float r = craterR();
    if (r < uFireRadius) {
        s.g = 1.0; // dies out at once where there is nothing to burn
    }
    if (r < 1.0) {
        s.r = 0.0;
    }
    gl_FragColor = s;
}
`;
