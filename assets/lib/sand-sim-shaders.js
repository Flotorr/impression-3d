// GLSL for the simulation passes. Every pass draws a full-screen quad into one N × N float texture.
//
// Each column of the tank is a stack: rock at the bottom, then clay, then sand, with lava and water on top.
//
//   terrain   r: sand height   g: wetness (0–1)   b: clay height   a: rock height
//   lava      r: depth         g: temperature (1 molten → 0 cold)   b: steam (contact with water, for the render)
//   water     r: depth         g, b: velocity along u and v (world units / s)   a: suspended sediment
//   flux      water outflow towards the left, right, down and up neighbours (virtual pipes)
//   lavaFlux  the same for lava
//   slide     sand leaving towards the 8 neighbours (avalanches): cardinal and diagonal shares, two textures
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

// Needs uTerrain and uLava.
const GROUND = /* glsl */ `
float solidAt(vec2 uv) { vec4 t = texture2D(uTerrain, uv); return t.r + t.b + t.a; }
float groundAt(vec2 uv) { return solidAt(uv) + texture2D(uLava, uv).r; }
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

/** Initial dunes with a hollow, over a bed of rock that breaks the surface here and there. */
export const initTerrainShader = /* glsl */ `
${COMMON}
${NOISE}
uniform vec2 uSeed;
uniform vec2 uBasin;
void main() {
    vec2 p = vUv * 2.6 + uSeed;
    float dunes = 0.13 + 0.07 * fbm(p);
    // Wind ripples, stretched along one direction like real dunes
    dunes += 0.018 * sin(vUv.x * 30.0 + 4.0 * fbm(p * 1.7)) * smoothstep(-0.2, 0.4, fbm(p * 0.7));
    float hollow = smoothstep(0.3, 0.0, length(vUv - uBasin));
    float surface = max(0.02, dunes - 0.11 * hollow);
    float rock = 0.025 + 0.16 * smoothstep(0.15, 0.55, fbm(p * 0.8 + 31.0)) * (1.0 - hollow);
    gl_FragColor = vec4(max(0.0, surface - rock), 0.0, 0.0, rock);
}
`;

/** Initial water: a lake filling the hollow up to `uLevel`. */
export const initWaterShader = /* glsl */ `
${COMMON}
uniform sampler2D uTerrain;
uniform vec2 uBasin;
uniform float uLevel;
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float lake = step(length(vUv - uBasin), 0.32);
    gl_FragColor = vec4(max(0.0, uLevel - (t.r + t.b + t.a)) * lake, 0.0, 0.0, 0.0);
}
`;

// Brush modes: 1 dig, 2 sand, 3 push, 4 water, 6 sponge, 7 rock, 8 clay, 9 lava.
const BRUSH_UNIFORMS = /* glsl */ `
uniform int uMode;
uniform vec2 uBrush;
uniform float uRadius;
uniform float uAmount;
`;

export const brushTerrainShader = /* glsl */ `
${COMMON}
${BRUSH_UNIFORMS}
uniform sampler2D uTerrain;
uniform vec2 uDrag;
uniform float uMaxSand;
uniform float uDigClay;
uniform float uDigRock;
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float f = falloff(vUv, uBrush, uRadius);
    float amount = uAmount * f;
    float room = max(0.0, uMaxSand - (t.r + t.b + t.a));
    if (uMode == 1) {
        // The shovel takes the sand first, then bites slowly into the clay, and barely into the rock.
        float sand = min(t.r, amount);
        t.r -= sand;
        amount -= sand;
        float clay = min(t.b, amount * uDigClay);
        t.b -= clay;
        amount -= clay / uDigClay;
        t.a = max(0.0, t.a - amount * uDigRock);
    } else if (uMode == 2) {
        t.r += min(room, amount);
    } else if (uMode == 3) {
        // Bulldozer: each cell takes the sand that was behind it along the gesture.
        t.r = bilinear(uTerrain, vUv - uDrag * f).r;
    } else if (uMode == 7 || uMode == 8) {
        // Rock and clay go on top: the loose layers under the brush are turned into the new material.
        float turned = t.r * min(1.0, f * 20.0 * uAmount);
        t.r -= turned;
        float added = turned + min(room, amount);
        if (uMode == 7) {
            float clay = t.b * min(1.0, f * 20.0 * uAmount);
            t.b -= clay;
            t.a += added + clay;
        } else {
            t.b += added;
        }
    }
    gl_FragColor = t;
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
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
    vec4 w = texture2D(uWater, vUv);
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
// Wave maker along the back edge (v = 1): amplitude, angular frequency, still-water level, on/off.
uniform vec4 uWaves;
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
        float surface = uWaves.z + uWaves.x * sin(uWaves.y * uWaveTime);
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
uniform float uErosion; // 0 = off
${GROUND}
// Material the water picks up this step (> 0) or lets settle as sand (< 0). Sand goes first, then clay,
// which resists (uClayErosion); rock and lava never erode. clayPart is the share taken from the clay.
float exchange(out float clayPart) {
    vec4 w = texture2D(uWater, vUv);
    vec4 t = texture2D(uTerrain, vUv);
    clayPart = 0.0;
    if (texture2D(uLava, vUv).r > 0.0005) return 0.0;
    vec2 grad = vec2(groundAt(R()) - groundAt(L()), groundAt(U()) - groundAt(D())) / (2.0 * uCell);
    float sinTilt = length(grad) / sqrt(1.0 + dot(grad, grad));
    float depthFactor = clamp(w.r / 0.01, 0.0, 1.0);
    float capacity = uCapacity * max(sinTilt, 0.05) * length(w.gb) * depthFactor;
    if (w.a >= capacity) {
        return -min(w.a, uDeposit * (w.a - capacity) * uDt) * uErosion;
    }
    float wanted = uDissolve * (capacity - w.a) * uDt * uErosion;
    float sand = min(t.r, wanted);
    clayPart = min(t.b, (wanted - sand) * uClayErosion);
    return sand + clayPart;
}
`;

export const erosionTerrainShader = /* glsl */ `
${COMMON}
${EROSION}
uniform float uDrying;
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float d = texture2D(uWater, vUv).r;
    float clayPart;
    float moved = exchange(clayPart);
    t.b -= clayPart;
    t.r -= moved - clayPart; // deposits (moved < 0) settle as sand
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
    float clayPart;
    w.a += exchange(clayPart);
    gl_FragColor = w;
}
`;

// Avalanches look at the 8 neighbours (diagonals at √2 the distance), so piles settle into round cones
// rather than square pyramids. Only sand slides; it compares the full ground heights (rock, clay, lava
// included). The pass runs twice on the same input: uDiagonal 0 writes the shares sent left, right, down
// and up; uDiagonal 1 those sent down-left, down-right, up-left and up-right.
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
${GROUND}
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    float d = texture2D(uWater, vUv).r;
    float h = groundAt(vUv);
    float repose = (d > 0.0015 ? uTalusUnder : mix(uTalusDry, uTalusWet, t.g)) * uCell;
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
    // Sand buried under lava stays put.
    float loose = texture2D(uLava, vUv).r > 0.0005 ? 0.0 : t.r;
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
float solid(vec2 uv) { vec4 t = texture2D(uTerrain, uv); return t.r + t.b + t.a; }
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
void main() {
    vec4 t = texture2D(uTerrain, vUv);
    vec4 lava = texture2D(uLava, vUv);
    // The new rock is on top: the sand and clay it covered are fused into it (the stack keeps rock at the bottom).
    if (solidifies(lava)) {
        t.a += lava.r + t.r + t.b;
        t.r = 0.0;
        t.b = 0.0;
    }
    gl_FragColor = t;
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
    float sand = 0.03 + (uLevel + 0.06) * shore + 0.006 * fbm(vUv * 6.0) + 0.004 * sin(vUv.x * 40.0 + fbm(vUv * 3.0) * 3.0) * shore;
    gl_FragColor = vec4(sand, 0.0, 0.0, 0.0);
}
`;