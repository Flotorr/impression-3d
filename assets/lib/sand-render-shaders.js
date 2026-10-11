// GLSL for drawing the sandbox. Heights come from the simulation textures (see sand-sim-shaders.js):
// terrain r sand, g wetness, b clay, a rock; lava r depth, g temperature, b steam; water r depth.
// Colours are written in sRGB then linearised; three.js applies tone mapping and the output transfer.

const OUTPUT = /* glsl */ `
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;

// Ground height (uTerrain and uLava declared by the caller; declares uEarth).
const GROUND = /* glsl */ `
uniform sampler2D uEarth;
float groundAt(vec2 uv) { vec4 t = texture2D(uTerrain, uv); return t.r + t.b + t.a + texture2D(uEarth, uv).r + texture2D(uLava, uv).r; }
`;

const SHARED = /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uWater;
uniform vec2 uTexel;
uniform float uCell;
uniform vec3 uSun;
uniform float uTime;
uniform float uGloom; // 0 sunny, 1 overcast (rain)
uniform vec2 uSwell;  // live ocean: still-water level and swell amplitude (0 when off)
uniform sampler2D uPlants; // grass, moss, trees, ash
uniform sampler2D uSoil;   // moisture, fire
uniform vec3 uSunTint;     // colour and strength of the light along uSun: the sun by day, the moon at night
uniform float uDaylight;   // 0 at night, 1 by day
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
${GROUND}
float surfaceAt(vec2 uv) { return groundAt(uv) + texture2D(uWater, uv).r; }
float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
}
// Average of 9 taps around uv: material boundaries drawn from it follow smooth lines, not grid cells.
vec4 soft(sampler2D tex, vec2 uv) {
    vec2 o = uTexel * 1.6;
    vec2 d = uTexel * 1.13;
    return 0.2 * texture2D(tex, uv)
         + 0.1 * (texture2D(tex, uv + vec2(o.x, 0.0)) + texture2D(tex, uv - vec2(o.x, 0.0))
                + texture2D(tex, uv + vec2(0.0, o.y)) + texture2D(tex, uv - vec2(0.0, o.y))
                + texture2D(tex, uv + d) + texture2D(tex, uv - d)
                + texture2D(tex, uv + vec2(d.x, -d.y)) + texture2D(tex, uv + vec2(-d.x, d.y)));
}
// Light of the sky, dark blue at night.
vec3 ambientTint() { return mix(vec3(0.16, 0.2, 0.34), vec3(1.0), uDaylight); }
float ambientLevel() { return mix(0.22, 1.0, uDaylight); }
vec3 skyColour(vec3 dir) {
    vec3 clear = mix(lin(vec3(0.86, 0.9, 0.95)), lin(vec3(0.42, 0.62, 0.86)), clamp(dir.y * 1.4, 0.0, 1.0));
    return mix(clear, lin(vec3(0.6, 0.63, 0.67)), uGloom * 0.8) * ambientTint();
}
vec3 sunlight() { return mix(1.0, 0.35, uGloom) * uSunTint; }

// Glowing lava: yellow-orange when molten. As it cools, a black crust closes over it and the glow
// shrinks to a network of cracks that dims from orange to dark red.
vec3 lavaGlow(vec2 p, float temperature, float time) {
    float n = valueNoise(p * 18.0 + time * 0.05) * 0.65 + valueNoise(p * 47.0) * 0.35;
    float ridge = 1.0 - abs(2.0 * n - 1.0); // bright along the noise ridges: the cracks
    float threshold = mix(0.95, -0.1, smoothstep(0.2, 0.95, temperature));
    float open = smoothstep(threshold, threshold + 0.08, ridge);
    vec3 hot = mix(lin(vec3(0.55, 0.06, 0.02)), lin(vec3(1.0, 0.45, 0.08)), smoothstep(0.3, 0.8, temperature));
    hot = mix(hot, lin(vec3(1.0, 0.72, 0.25)), smoothstep(0.85, 1.0, temperature));
    // Slow swirls on the molten surface
    float swirl = valueNoise(p * 7.0 + vec2(time * 0.15, -time * 0.1)) * 0.6 + valueNoise(p * 19.0 - time * 0.2) * 0.4;
    return hot * open * (0.1 + 1.3 * temperature * temperature) * (0.7 + 0.6 * swirl);
}
// Rain on the water: each cell of a grid gets a drop at its own moment; its ring spreads and fades.
vec2 rainRipples(vec2 p, float t) {
    vec2 cell = floor(p);
    vec2 slope = vec2(0.0);
    for (int i = -1; i <= 1; i++) {
        for (int j = -1; j <= 1; j++) {
            vec2 c = cell + vec2(float(i), float(j));
            vec2 centre = c + vec2(hash(c + 3.1), hash(c + 7.7));
            float phase = fract(t * 1.1 + hash(c));
            vec2 dv = p - centre;
            float dist = length(dv) + 1e-4;
            float ring = sin((dist - phase * 0.9) * 30.0) * smoothstep(0.1, 0.0, abs(dist - phase * 0.9)) * (1.0 - phase);
            slope += dv / dist * ring;
        }
    }
    return slope;
}
`;

export const terrainShader = {
    vertexShader: /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uLava;
varying vec2 vUv;
varying vec3 vWorld;
${GROUND}
void main() {
    vUv = uv;
    vec3 p = position;
    p.z = groundAt(uv); // the plane is rotated: object z is world height
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
}
`,
    fragmentShader: /* glsl */ `
${SHARED}
uniform vec2 uBrush;
uniform float uRadius;
uniform float uBrushVisible;
uniform vec3 uBrushColour;
uniform vec2 uSprings[4];
uniform int uSpringCount;
varying vec2 vUv;
varying vec3 vWorld;

// Light focused by the waves on the bottom: two drifting layers of folded sine waves.
float caustics(vec2 p, float t) {
    float c = 0.0;
    for (int i = 0; i < 2; i++) {
        vec2 q = p * (1.0 + float(i) * 0.7) + vec2(sin(p.y * 1.7 + t * 0.8), cos(p.x * 1.3 - t * 0.6)) * 0.8;
        float w = sin(q.x * 3.1 + t) + sin(q.y * 3.7 - t * 1.2) + sin((q.x + q.y) * 2.3 + t * 0.7);
        c += pow(1.0 - abs(w) / 3.0, 12.0);
    }
    return c;
}

void main() {
    vec4 t = texture2D(uTerrain, vUv);
    vec4 lava = texture2D(uLava, vUv);
    float depth = texture2D(uWater, vUv).r;
    float h = groundAt(vUv);
    float hx = (groundAt(vUv + vec2(uTexel.x, 0.0)) - groundAt(vUv - vec2(uTexel.x, 0.0))) / (2.0 * uCell);
    float hy = (groundAt(vUv + vec2(0.0, uTexel.y)) - groundAt(vUv - vec2(0.0, uTexel.y))) / (2.0 * uCell);
    vec3 n = normalize(vec3(-hx, 1.0, hy)); // uv.y runs towards -z
    vec3 V = normalize(cameraPosition - vWorld);

    // The visible material is the top of the stack: a thin layer lets the one below show through.
    float grain = hash(floor(vUv * 2048.0));
    vec3 sand = mix(vec3(0.76, 0.6, 0.41), vec3(0.94, 0.84, 0.66), smoothstep(0.0, 0.3, h)) * (0.9 + 0.2 * grain);
    // Height is folded into the texture coordinates so steep faces are not stretched into streaks.
    vec2 q = vWorld.xz + vec2(vWorld.y, -vWorld.y) * 0.8;
    float clayGrain = valueNoise(q * 80.0);
    vec3 clay = mix(vec3(0.58, 0.29, 0.19), vec3(0.72, 0.4, 0.27), clayGrain);
    float rockNoise = valueNoise(q * 30.0) * 0.6 + valueNoise(q * 110.0) * 0.4;
    vec3 rock = mix(vec3(0.3, 0.29, 0.29), vec3(0.55, 0.53, 0.5), rockNoise) * (0.85 + 0.3 * grain * grain);
    vec4 layers = soft(uTerrain, vUv);
    float edgeNoise = (valueNoise(q * 60.0) - 0.5) * 0.003; // irregular edges between materials
    float earthLayer = soft(uEarth, vUv).r;
    // Earth: dark brown soil with crumbs and a few pebbles.
    float crumbs = valueNoise(q * 150.0) * 0.6 + valueNoise(q * 45.0) * 0.4;
    vec3 earth = mix(vec3(0.33, 0.23, 0.15), vec3(0.47, 0.35, 0.23), crumbs);
    earth = mix(earth, vec3(0.55, 0.52, 0.48), step(0.985, hash(floor(q * 260.0))) * 0.7);
    float clayCover = smoothstep(0.0005, 0.005, layers.b + edgeNoise);
    float earthCover = smoothstep(0.0005, 0.005, earthLayer + edgeNoise);
    float sandCover = smoothstep(0.0005, 0.005, layers.r + edgeNoise);
    vec3 surface = mix(rock, clay, clayCover);
    surface = mix(surface, earth, earthCover);
    surface = mix(surface, sand, sandCover);
    // The bare bottom of the tank (everything removed): a light, even floor.
    surface = mix(vec3(0.72, 0.74, 0.76), surface, smoothstep(0.0005, 0.004, layers.r + layers.b + layers.a + earthLayer));
    float looseCover = max(max(sandCover, clayCover), earthCover);

    // Plants over the ground: tufted grass on sand and clay, yellowing as the soil dries and darker under the
    // trees; moss on rock; ash where it burned.
    vec4 plants = soft(uPlants, vUv);
    float moisture = texture2D(uSoil, vUv).r;
    float tufts = valueNoise(q * 140.0) * 0.6 + valueNoise(q * 420.0) * 0.4;
    float grassCover = smoothstep(0.08, 0.45, plants.r * (0.7 + 0.6 * tufts) + edgeNoise * 20.0);
    float thirst = 1.0 - smoothstep(0.08, 0.35, moisture);
    vec3 grass = mix(vec3(0.46, 0.53, 0.27), vec3(0.32, 0.42, 0.2), smoothstep(0.5, 1.0, plants.r));
    grass = mix(grass, vec3(0.26, 0.31, 0.16), smoothstep(0.2, 0.7, plants.b) * 0.5);
    grass = mix(grass, vec3(0.66, 0.6, 0.36), thirst * 0.85) * (0.84 + 0.32 * tufts);
    float mossCover = smoothstep(0.1, 0.5, plants.g * (0.6 + 0.8 * valueNoise(q * 70.0)));
    vec3 moss = vec3(0.36, 0.42, 0.24) * (0.8 + 0.4 * rockNoise);
    float ashCover = smoothstep(0.05, 0.4, plants.a * (0.7 + 0.6 * tufts));
    surface = mix(surface, moss, mossCover);
    surface = mix(surface, grass, grassCover);
    surface = mix(surface, mix(vec3(0.25, 0.24, 0.22), vec3(0.44, 0.42, 0.38), tufts), ashCover * 0.9);
    float bare = (1.0 - grassCover) * (1.0 - ashCover);

    vec3 albedo = lin(surface) * mix(1.0, mix(0.75, 0.42, looseCover), t.g * bare); // damp ground is darker

    // Ambient occlusion from the local hollow
    float around = 0.25 * (groundAt(vUv + vec2(uTexel.x * 4.0, 0.0)) + groundAt(vUv - vec2(uTexel.x * 4.0, 0.0))
                         + groundAt(vUv + vec2(0.0, uTexel.y * 4.0)) + groundAt(vUv - vec2(0.0, uTexel.y * 4.0)));
    float ao = clamp(1.0 - (around - h) * 30.0, 0.55, 1.0);

    float diffuse = max(dot(n, uSun), 0.0);
    vec3 light = lin(vec3(1.0, 0.95, 0.86)) * diffuse * 1.15 * sunlight() + skyColour(n) * 0.45;
    vec3 colour = albedo * light * ao;
    vec3 R = reflect(-uSun, n);
    vec3 glint = uSunTint * pow(max(dot(R, V), 0.0), 40.0);
    colour += t.g * bare * glint * 0.25;                                                                  // sheen of wet ground
    colour += (1.0 - t.g) * sandCover * bare * step(0.996, grain) * uSunTint * pow(max(dot(R, V), 0.0), 6.0) * 0.8; // glints of dry sand

    // Lava on top: cooled crust is dark rock, the cracks glow (the glow ignores the sunlight).
    // Its edge is drawn from the depth averaged with the neighbours and slightly perturbed, so it follows a
    // smooth, irregular line instead of the cells of the simulation grid.
    float lavaCover = smoothstep(0.0008, 0.004, soft(uLava, vUv).r + edgeNoise * 0.5);
    vec3 crust = lin(vec3(0.12, 0.1, 0.1)) * light;
    colour = mix(colour, crust + lavaGlow(q, lava.g, uTime), lavaCover);

    // Fire: flickering flames over what burns, the ground blackened behind them (the flames ignore the light).
    float fire = soft(uSoil, vUv).g;
    if (fire > 0.002) {
        float flicker = valueNoise(q * 40.0 + vec2(0.0, -uTime * 6.0)) * 0.6 + valueNoise(q * 95.0 - uTime * 9.0) * 0.4;
        vec3 flame = mix(lin(vec3(0.9, 0.25, 0.04)), lin(vec3(1.0, 0.75, 0.3)), flicker);
        colour = mix(colour, colour * 0.35, smoothstep(0.0, 0.5, fire));
        colour += flame * smoothstep(0.0, 0.6, fire) * (0.4 + 1.6 * flicker * flicker) * 1.4;
    }

    if (depth > 0.0006) {
        float under = exp(-depth * 22.0);
        colour += lin(vec3(0.75, 0.92, 1.0)) * caustics(vWorld.xz * 9.0, uTime * 1.3) * diffuse * under * 0.35;
    }

    // Springs
    for (int i = 0; i < 4; i++) {
        if (i >= uSpringCount) break;
        float r = length(vUv - uSprings[i]) / 0.03;
        float ring = smoothstep(0.75, 0.9, r) * smoothstep(1.15, 1.0, r);
        colour = mix(colour, lin(vec3(0.3, 0.75, 1.0)), ring * (0.6 + 0.4 * sin(uTime * 4.0)));
    }

    // Brush outline
    float r = length(vUv - uBrush) / uRadius;
    float outline = smoothstep(0.9, 0.96, r) * smoothstep(1.06, 1.0, r);
    colour = mix(colour, lin(uBrushColour), outline * uBrushVisible * 0.85);

    gl_FragColor = vec4(colour, 1.0);
    ${OUTPUT}
}
`,
};

export const waterSurfaceShader = {
    vertexShader: /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uWater;
varying vec2 vUv;
varying vec3 vWorld;
${GROUND}
void main() {
    vUv = uv;
    float d = texture2D(uWater, uv).r;
    vec3 p = position;
    p.z = groundAt(uv) + d - (d < 0.0006 ? 0.004 : 0.0); // dry cells tuck the surface under the ground
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
}
`,
    fragmentShader: /* glsl */ `
${SHARED}
varying vec2 vUv;
varying vec3 vWorld;
void main() {
    vec4 w = texture2D(uWater, vUv);
    float d = w.r;
    if (d < 0.0006) discard;
    float sx = (surfaceAt(vUv + vec2(uTexel.x, 0.0)) - surfaceAt(vUv - vec2(uTexel.x, 0.0))) / (2.0 * uCell);
    float sy = (surfaceAt(vUv + vec2(0.0, uTexel.y)) - surfaceAt(vUv - vec2(0.0, uTexel.y))) / (2.0 * uCell);
    // Small ripples on top of the simulated surface: the slope of two drifting layers of noise
    // (irregular, so a large calm surface does not show a grid).
    vec2 rp = vWorld.xz * 40.0;
    float e = 0.15;
    float r0 = valueNoise(rp + uTime * vec2(0.9, 0.6)) + 0.5 * valueNoise(rp * 2.3 - uTime * vec2(0.7, 1.1));
    float rx = valueNoise(rp + vec2(e, 0.0) + uTime * vec2(0.9, 0.6)) + 0.5 * valueNoise((rp + vec2(e, 0.0)) * 2.3 - uTime * vec2(0.7, 1.1));
    float rz = valueNoise(rp + vec2(0.0, e) + uTime * vec2(0.9, 0.6)) + 0.5 * valueNoise((rp + vec2(0.0, e)) * 2.3 - uTime * vec2(0.7, 1.1));
    vec2 ripple = vec2(rx - r0, rz - r0) / e * 0.012;
    ripple += rainRipples(vWorld.xz * 16.0, uTime) * 0.3 * uGloom;
    vec3 n = normalize(vec3(-sx + ripple.x, 1.0, sy + ripple.y));
    vec3 V = normalize(cameraPosition - vWorld);

    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
    vec3 R = reflect(-V, n);
    vec3 reflection = skyColour(R) + lin(vec3(1.0, 0.95, 0.85)) * pow(max(dot(R, uSun), 0.0), 300.0) * 6.0 * sunlight();

    vec3 transmittance = exp(-d * vec3(38.0, 11.0, 7.0)); // red is absorbed first
    vec3 body = mix(lin(vec3(0.03, 0.2, 0.28)), lin(vec3(0.35, 0.7, 0.72)), transmittance.g);
    body *= (0.55 + 0.45 * max(dot(n, uSun), 0.0)) * mix(1.0, 0.75, uGloom) * ambientTint();

    float speed = length(w.gb);
    // Foam and boiling use smooth drifting noise (a per-pixel hash would look like pixels).
    float churn = valueNoise(vWorld.xz * 70.0 + uTime * vec2(1.7, -1.1)) * 0.6 + valueNoise(vWorld.xz * 160.0 - uTime * 2.3) * 0.4;
    float foam = smoothstep(0.45, 1.2, speed) * (0.45 + 0.55 * churn)
               + smoothstep(0.003, 0.0008, d) * step(0.08, speed) * 0.4;
    // Boiling where the water touches lava: clusters of bubbles
    foam += texture2D(uLava, vUv).b * smoothstep(0.35, 0.75, churn);

    vec3 colour = mix(body, reflection, fresnel);
    // Live ocean: crests lighter, troughs darker, so a long, gentle swell can still be read from above.
    if (uSwell.y > 0.0) {
        float eta = groundAt(vUv) + d - uSwell.x;
        float crest = clamp(eta / uSwell.y, -1.0, 1.0);
        colour *= 1.0 + 0.35 * crest;
        colour = mix(colour, lin(vec3(0.75, 0.9, 0.9)), smoothstep(0.6, 1.0, crest) * 0.25);
        // Whitewater where the crest is too high for the depth (same rule as the breaking in the simulation),
        // and foam streaks on the steep fronts of the waves.
        float stillDepth = max(uSwell.x - groundAt(vUv), 0.003);
        float breaking = smoothstep(0.3, 0.6, eta / stillDepth);
        float steep = smoothstep(0.25, 0.6, length(vec2(sx, sy))) * step(0.0, eta);
        float streaks = smoothstep(0.45, 0.8, valueNoise(vWorld.xz * vec2(90.0, 35.0) + uTime * vec2(0.3, -0.8)));
        foam += breaking * (0.55 + 0.45 * churn) + steep * streaks * 0.6;
    }
    colour = mix(colour, vec3(0.92) * ambientLevel(), clamp(foam, 0.0, 1.0) * 0.75);
    float alpha = clamp(1.0 - transmittance.g * 0.85 + fresnel * 0.6 + foam, 0.12, 0.96);
    alpha *= smoothstep(0.0006, 0.0025, d); // soft shoreline
    gl_FragColor = vec4(colour, alpha);
    ${OUTPUT}
}
`,
};

/**
 * Cross-section seen through the glass. Each vertex knows the terrain uv of its column (aEdgeUv)
 * and whether it is at the bottom or the top of the strip (aTop).
 * uLayer 0 = the ground (rock, clay, sand, lava) from the floor up, 1 = water from the ground to the surface.
 */
export const sectionShader = {
    vertexShader: /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uLava;
uniform sampler2D uWater;
uniform float uLayer;
attribute vec2 aEdgeUv;
attribute float aTop;
varying vec2 vEdgeUv;
varying float vHeight;
varying float vTopHeight;
varying vec3 vWorld;
${GROUND}
void main() {
    vEdgeUv = aEdgeUv;
    float b = groundAt(aEdgeUv);
    float d = texture2D(uWater, aEdgeUv).r;
    float bottom = uLayer < 0.5 ? 0.0 : b;
    float top = uLayer < 0.5 ? b : b + (d < 0.0006 ? 0.0 : d);
    vec3 p = position;
    p.y = aTop > 0.5 ? top : bottom;
    vHeight = p.y;
    vTopHeight = top;
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
}
`,
    fragmentShader: /* glsl */ `
${SHARED}
uniform float uLayer;
varying vec2 vEdgeUv;
varying float vHeight;
varying float vTopHeight;
varying vec3 vWorld;
void main() {
    if (uLayer > 0.5) {
        float depthBelowSurface = vTopHeight - vHeight;
        vec3 water = mix(lin(vec3(0.3, 0.68, 0.75)), lin(vec3(0.03, 0.18, 0.27)), clamp(depthBelowSurface * 14.0, 0.0, 1.0));
        water *= ambientTint();
        gl_FragColor = vec4(water, 0.55 + 0.3 * clamp(depthBelowSurface * 20.0, 0.0, 1.0));
        ${OUTPUT}
        return;
    }
    // Which layer is at this height: rock at the bottom, then clay, earth, sand and lava.
    vec4 t = texture2D(uTerrain, vEdgeUv);
    vec4 lava = texture2D(uLava, vEdgeUv);
    float rockTop = t.a;
    float clayTop = rockTop + t.b;
    float earthTop = clayTop + texture2D(uEarth, vEdgeUv).r;
    float sandTop = earthTop + t.r;
    float grain = hash(floor(vec2(vWorld.x + vWorld.z, vHeight) * 900.0));
    vec3 colour;
    if (vHeight > sandTop + 0.0005 && lava.r > 0.0003) {
        colour = lin(vec3(0.12, 0.1, 0.1)) * 0.6 + lavaGlow(vec2(vWorld.x + vWorld.z, vHeight * 3.0), lava.g, uTime);
    } else if (vHeight > earthTop) {
        // Sand strata: thin layers, damp near the surface when wet.
        float layers = 0.88 + 0.12 * sin(vHeight * 170.0 + sin(vWorld.x * 9.0 + vWorld.z * 7.0) * 2.0);
        vec3 sand = mix(vec3(0.62, 0.48, 0.32), vec3(0.86, 0.73, 0.53), smoothstep(0.0, 0.25, vHeight)) * layers * (0.9 + 0.2 * grain);
        float damp = t.g * smoothstep(0.06, 0.0, sandTop - vHeight);
        colour = lin(sand) * mix(1.0, 0.5, damp) * 0.85;
    } else if (vHeight > clayTop) {
        // Earth: brown, darker and finer near the top (humus), with pebbles and a few roots.
        vec2 p = vec2(vWorld.x + vWorld.z, vHeight);
        vec3 earth = mix(vec3(0.38, 0.27, 0.17), vec3(0.27, 0.18, 0.11), smoothstep(0.03, 0.0, earthTop - vHeight));
        earth *= 0.85 + 0.3 * valueNoise(p * 160.0);
        earth = mix(earth, vec3(0.52, 0.5, 0.46), step(0.97, hash(floor(p * 420.0))) * 0.8);
        float roots = smoothstep(0.92, 1.0, sin(p.x * 140.0 + sin(p.y * 90.0) * 3.0)) * smoothstep(0.04, 0.0, earthTop - vHeight);
        earth = mix(earth, vec3(0.6, 0.48, 0.34), roots * 0.5);
        float damp = t.g * smoothstep(0.06, 0.0, earthTop - vHeight);
        colour = lin(earth) * mix(1.0, 0.6, damp) * 0.85;
    } else if (vHeight > rockTop) {
        vec3 clay = mix(vec3(0.5, 0.25, 0.16), vec3(0.64, 0.34, 0.22), valueNoise(vec2(vWorld.x + vWorld.z, vHeight) * 120.0));
        colour = lin(clay) * 0.85;
    } else {
        float strata = valueNoise(vec2((vWorld.x + vWorld.z) * 8.0, vHeight * 90.0));
        vec3 rock = mix(vec3(0.26, 0.25, 0.25), vec3(0.46, 0.44, 0.42), strata) * (0.85 + 0.3 * grain);
        colour = lin(rock) * 0.85;
    }
    // A thin green line of turf at the top of a planted column.
    float turf = smoothstep(0.2, 0.6, texture2D(uPlants, vEdgeUv).r) * step(vTopHeight - 0.004, vHeight) * step(lava.r, 0.0003);
    colour = mix(colour, lin(vec3(0.24, 0.42, 0.15)) * 0.85, turf);
    colour *= ambientTint();
    if (vHeight > sandTop + 0.0005 && lava.r > 0.0003) {
        colour += lavaGlow(vec2(vWorld.x + vWorld.z, vHeight * 3.0), lava.g, uTime) * (1.0 - ambientTint()); // the glow stays at night
    }
    gl_FragColor = vec4(colour, 1.0);
    ${OUTPUT}
}
`,
};

export const glassShader = {
    vertexShader: /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
}
`,
    fragmentShader: /* glsl */ `
uniform float uHover; // the hammer is over this pane
uniform vec2 uHit;    // where, in world units from the pane's bottom-left corner
uniform vec2 uSize;   // pane width and height
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
    vec3 V = normalize(cameraPosition - vWorld);
    float facing = abs(dot(normalize(vNormalW), V));
    float fresnel = pow(1.0 - facing, 4.0);
    // A soft diagonal reflection streak
    float streak = smoothstep(0.08, 0.0, abs(fract((vWorld.x + vWorld.z) * 0.6 + vWorld.y) - 0.5) - 0.38) * 0.15;
    // Under the hammer: cracks radiating from the point of impact, wobbly and of uneven length,
    // with a couple of broken rings close to the centre.
    vec2 q = vUv * uSize - uHit;
    float r = length(q);
    float angle = atan(q.y, q.x);
    float wobble = angle + 0.08 * sin(r * 40.0 + angle * 3.0);
    float rays = smoothstep(0.93, 1.0, cos(wobble * 7.0)) * smoothstep(0.38 + 0.15 * sin(angle * 5.0), 0.0, r);
    float rings = smoothstep(0.9, 1.0, cos(r * 60.0 + 2.0 * sin(angle * 4.0))) * smoothstep(0.14, 0.03, r);
    float web = rays + rings * 0.7 + smoothstep(0.012, 0.0, r);
    vec3 colour = mix(vec3(0.92, 0.97, 1.0), vec3(1.0, 0.55, 0.35), uHover * 0.6);
    gl_FragColor = vec4(mix(colour, vec3(1.0), web * uHover), 0.05 + fresnel * 0.35 + streak + uHover * (0.1 + web * 0.75));
    ${OUTPUT}
}
`,
};

/** Soft round shadow under the box. */
export const shadowShader = {
    vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
    fragmentShader: /* glsl */ `
varying vec2 vUv;
void main() {
    vec2 p = abs(vUv - 0.5) * 2.0;
    float box = max(p.x, p.y);
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.22 * smoothstep(1.0, 0.55, box));
}
`,
};

/**
 * Raindrops: short streaks falling from the sky, slanted by a light wind. Each drop stops where it meets
 * the sand or the water (read from the simulation), then starts again from the top.
 */
export const rainShader = {
    vertexShader: /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
uniform sampler2D uLava;
uniform sampler2D uWater;
uniform float uTime;
uniform float uRain;
uniform float uWorld;
attribute vec3 aSeed; // x, z, phase
attribute float aEnd; // 0 bottom of the streak, 1 top
varying float vAlpha;
void main() {
    const float TOP = 3.2;
    const float FALL = 3.5;
    float y = TOP - mod(uTime * 5.0 + aSeed.z * FALL, FALL);
    float x = (aSeed.x - 0.5) * 2.8 + (TOP - y) * 0.08;
    float z = (aSeed.y - 0.5) * 2.8;
    vec2 uv = vec2(x / uWorld + 0.5, 0.5 - z / uWorld);
    float ground = -0.1;
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
        vec4 t = texture2D(uTerrain, uv);
        ground = t.r + t.b + t.a + texture2D(uEarth, uv).r + texture2D(uLava, uv).r + texture2D(uWater, uv).r;
    } else if (abs(x) < 1.07 && abs(z) < 1.07) {
        ground = 0.0; // the wooden base
    }
    vAlpha = uRain * step(ground, y) * 0.5;
    vec3 p = vec3(x + aEnd * 0.006, y + aEnd * 0.08, z);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`,
    fragmentShader: /* glsl */ `
varying float vAlpha;
void main() {
    if (vAlpha <= 0.0) discard;
    gl_FragColor = vec4(pow(vec3(0.82, 0.88, 0.96), vec3(2.2)), vAlpha);
    #include <colorspace_fragment>
}
`,
};

/**
 * Water pouring through a broken pane: particles leave the edge of the tank with the depth found there,
 * follow a parabola and vanish on the floor. A side whose glass is intact, or a dry edge, shows nothing.
 */
export const waterfallShader = {
    vertexShader: /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
uniform sampler2D uLava;
uniform sampler2D uWater;
uniform vec4 uBroken;
uniform float uTime;
uniform float uWorld;
uniform float uFocal;
uniform float uFloor;
attribute vec3 aSeed; // position along the edge, phase, spread
attribute float aSide; // 0 left, 1 right, 2 front, 3 back
varying float vAlpha;
void main() {
    float inset = 0.6 / 256.0;
    float t = aSeed.x;
    vec2 uv;
    vec3 outward;
    float broken;
    if (aSide < 0.5) { uv = vec2(inset, t); outward = vec3(-1.0, 0.0, 0.0); broken = uBroken.x; }
    else if (aSide < 1.5) { uv = vec2(1.0 - inset, t); outward = vec3(1.0, 0.0, 0.0); broken = uBroken.y; }
    else if (aSide < 2.5) { uv = vec2(t, inset); outward = vec3(0.0, 0.0, 1.0); broken = uBroken.z; }
    else { uv = vec2(t, 1.0 - inset); outward = vec3(0.0, 0.0, -1.0); broken = uBroken.w; }

    vec4 column = texture2D(uTerrain, uv);
    float b = column.r + column.b + column.a + texture2D(uEarth, uv).r + texture2D(uLava, uv).r;
    float d = texture2D(uWater, uv).r;
    const float LIFE = 0.8;
    float age = fract(uTime / LIFE + aSeed.y) * LIFE;
    vec3 start = vec3((uv.x - 0.5) * uWorld, b + aSeed.z * d, (0.5 - uv.y) * uWorld) + outward * 0.01;
    float speed = 0.15 + sqrt(9.81 * d) * 1.4;
    vec3 side = cross(outward, vec3(0.0, 1.0, 0.0));
    vec3 p = start + outward * speed * age + side * (aSeed.z - 0.5) * 0.05 * age;
    p.y -= 0.5 * 9.81 * age * age;

    float visible = broken * step(0.0015, d) * step(uFloor, p.y);
    vAlpha = visible * clamp(d * 80.0, 0.25, 0.9);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_PointSize = visible * uFocal * (0.01 + 0.008 * aSeed.z) / -mv.z;
    gl_Position = projectionMatrix * mv;
}
`,
    fragmentShader: /* glsl */ `
varying float vAlpha;
void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5 || vAlpha <= 0.0) discard;
    gl_FragColor = vec4(pow(vec3(0.62, 0.84, 0.92), vec3(2.2)), vAlpha * smoothstep(0.5, 0.2, r));
    #include <colorspace_fragment>
}
`,
};

/** Puddle on the floor where the water lands, with a ragged rim. */
export const puddleShader = {
    vertexShader: /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
}
`,
    fragmentShader: /* glsl */ `
uniform float uSeed;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float angle = atan(p.y, p.x);
    float rim = 0.85 + 0.08 * sin(angle * 5.0 + uSeed) + 0.05 * sin(angle * 11.0 + uSeed * 2.0);
    float r = length(p) / rim;
    if (r > 1.0) discard;
    vec3 V = normalize(cameraPosition - vWorld);
    float fresnel = 0.04 + 0.9 * pow(1.0 - V.y, 4.0);
    vec3 colour = mix(pow(vec3(0.35, 0.5, 0.58), vec3(2.2)), pow(vec3(0.85, 0.9, 0.95), vec3(2.2)), fresnel);
    gl_FragColor = vec4(colour, (0.35 + 0.4 * fresnel) * smoothstep(1.0, 0.85, r));
    #include <colorspace_fragment>
}
`,
};

/**
 * Steam where lava meets water. Each particle draws a random spot of the tank at every cycle and only shows
 * if that spot is boiling (lava.b), then rises, swells and fades.
 */
export const steamShader = {
    vertexShader: /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
uniform sampler2D uLava;
uniform sampler2D uWater;
uniform float uTime;
uniform float uWorld;
uniform float uFocal;
attribute vec3 aSeed;
varying float vAlpha;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
    const float LIFE = 1.6;
    float cycle = floor(uTime / LIFE + aSeed.z);
    float age = fract(uTime / LIFE + aSeed.z);
    vec2 uv = vec2(hash(aSeed.xy + cycle), hash(aSeed.yx + cycle * 1.7));
    vec4 t = texture2D(uTerrain, uv);
    float top = t.r + t.b + t.a + texture2D(uEarth, uv).r + texture2D(uLava, uv).r + texture2D(uWater, uv).r;
    float boiling = texture2D(uLava, uv).b;
    vec3 p = vec3((uv.x - 0.5) * uWorld, top + age * 0.35, (0.5 - uv.y) * uWorld);
    p.xz += vec2(sin(age * 5.0 + aSeed.x * 20.0), cos(age * 4.0 + aSeed.y * 20.0)) * 0.03 * age;
    vAlpha = step(0.3, boiling) * sin(age * 3.14159) * 0.45;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_PointSize = vAlpha > 0.0 ? uFocal * (0.02 + 0.05 * age) / -mv.z : 0.0;
    gl_Position = projectionMatrix * mv;
}
`,
    fragmentShader: /* glsl */ `
varying float vAlpha;
void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5 || vAlpha <= 0.0) discard;
    gl_FragColor = vec4(vec3(0.93), vAlpha * smoothstep(0.5, 0.0, r));
    #include <colorspace_fragment>
}
`,
};

/**
 * Smoke over the fires, like the steam: each particle draws a random spot at every cycle and only shows if it
 * burns there (soil.g); it leaves as an ember, turns into grey smoke, drifts with a light wind and fades.
 */
export const smokeShader = {
    vertexShader: /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
uniform sampler2D uLava;
uniform sampler2D uSoil;
uniform float uTime;
uniform float uWorld;
uniform float uFocal;
attribute vec3 aSeed;
varying float vAlpha;
varying float vAge;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
    const float LIFE = 2.4;
    float cycle = floor(uTime / LIFE + aSeed.z);
    float age = fract(uTime / LIFE + aSeed.z);
    vec2 uv = vec2(hash(aSeed.xy + cycle * 1.3), hash(aSeed.yx + cycle * 2.1));
    vec4 t = texture2D(uTerrain, uv);
    float top = t.r + t.b + t.a + texture2D(uEarth, uv).r + texture2D(uLava, uv).r;
    vec3 p = vec3((uv.x - 0.5) * uWorld, top + age * 0.55, (0.5 - uv.y) * uWorld);
    p.xz += vec2(sin(age * 3.0 + aSeed.x * 20.0), cos(age * 2.5 + aSeed.y * 20.0)) * 0.04 * age + vec2(0.08, 0.03) * age;
    vAlpha = step(0.2, texture2D(uSoil, uv).g) * sin(age * 3.14159) * 0.55;
    vAge = age;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_PointSize = vAlpha > 0.0 ? uFocal * (0.025 + 0.09 * age) / -mv.z : 0.0;
    gl_Position = projectionMatrix * mv;
}
`,
    fragmentShader: /* glsl */ `
varying float vAlpha;
varying float vAge;
void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5 || vAlpha <= 0.0) discard;
    vec3 colour = mix(vec3(1.0, 0.55, 0.2), vec3(0.3, 0.29, 0.28), smoothstep(0.0, 0.2, vAge));
    gl_FragColor = vec4(pow(colour, vec3(2.2)), vAlpha * smoothstep(0.5, 0.0, r));
    #include <colorspace_fragment>
}
`,
};

/**
 * Trees, drawn in 3D out of the "trees" layer of the plants: every slot of a fixed grid holds a tree that
 * appears once the wood there passes its own threshold, then grows with it. Slots below their threshold are
 * pushed out of view. Low-poly facets (normals from the screen-space derivatives), a little sway in the wind;
 * they dry up with the soil, glow while they burn and stay charred on the ash.
 */
export const treeShader = {
    vertexShader: /* glsl */ `
uniform sampler2D uTerrain;
uniform sampler2D uEarth;
uniform sampler2D uLava;
uniform sampler2D uPlants;
uniform sampler2D uSoil;
uniform float uTime;
uniform float uWorld;
attribute vec4 aSlot; // uv, threshold, size (random)
attribute float aPart; // 0 trunk, 1 crown
varying vec3 vWorld;
varying float vPart;
varying vec4 vLife; // colour variation, fire, ash, soil moisture
void main() {
    vec4 plants = texture2D(uPlants, aSlot.xy);
    float threshold = 0.12 + 0.6 * aSlot.z;
    float size = clamp((plants.b - threshold) / (1.0 - threshold) * 1.6, 0.0, 1.0) * (0.7 + 0.6 * aSlot.w);
    if (size < 0.05) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }
    vec4 t = texture2D(uTerrain, aSlot.xy);
    float ground = t.r + t.b + t.a + texture2D(uEarth, aSlot.xy).r + texture2D(uLava, aSlot.xy).r;
    float angle = fract(aSlot.z * 91.7 + aSlot.w * 13.1) * 6.2832;
    vec3 p = position * size;
    p.xz = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p.xz;
    p.x += sin(uTime * 1.3 + aSlot.x * 40.0) * 0.03 * p.y * aPart;
    vec3 world = vec3((aSlot.x - 0.5) * uWorld, ground - 0.002, (0.5 - aSlot.y) * uWorld) + p;
    vec4 soil = texture2D(uSoil, aSlot.xy);
    vWorld = world;
    vPart = aPart;
    vLife = vec4(fract(aSlot.w * 7.3), soil.g, plants.a, soil.r);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`,
    fragmentShader: /* glsl */ `
${SHARED}
varying vec3 vWorld;
varying float vPart;
varying vec4 vLife;
void main() {
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (dot(n, V) < 0.0) n = -n;
    vec3 leaves = mix(vec3(0.2, 0.32, 0.15), vec3(0.36, 0.45, 0.2), vLife.x);
    leaves = mix(leaves, vec3(0.56, 0.46, 0.2), (1.0 - smoothstep(0.08, 0.35, vLife.w)) * 0.8);
    vec3 albedo = lin(mix(vec3(0.36, 0.25, 0.16), leaves, vPart));
    albedo = mix(albedo, lin(vec3(0.08, 0.07, 0.06)), smoothstep(0.1, 0.6, vLife.z)); // charred
    float diffuse = max(dot(n, uSun), 0.0) * 0.8 + 0.2;
    vec3 colour = albedo * (lin(vec3(1.0, 0.95, 0.86)) * diffuse * 1.1 * sunlight() + skyColour(n) * 0.5);
    float flicker = valueNoise(vWorld.xz * 60.0 + vWorld.y * 80.0 - uTime * 8.0);
    colour += lin(vec3(1.0, 0.45, 0.1)) * smoothstep(0.1, 0.6, vLife.y) * (0.6 + 1.4 * flicker) * vPart;
    gl_FragColor = vec4(colour, 1.0);
    ${OUTPUT}
}
`,
};
