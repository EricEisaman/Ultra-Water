import * as THREE from 'three';
import { N } from './OceanSim.js';

// Camera-centred polar grid. Ring radii grow geometrically so cells stay square and
// screen density stays ~constant. Displacement is band-limited to the local vertex
// spacing (textureLod), which is what kills swimming - no clipmap snapping needed.
const ANGULAR = 384;
const HIGH_CAMERA = 60;  // m: above this a half-density grid is used (waves there are sub-pixel)
const INNER = 1;        // m, scaled by camera height
const OUTER = 3000;     // m, then one flat skirt
const SKIRT = 60000;

function buildGrid(ANGULAR) {
  const q = 1 + (2 * Math.PI) / ANGULAR;
  const radii = [];
  // a few coarser-ratio rings inside INNER so the surface right at the lens isn't one
  // flat fan when the camera sits on the waterline
  for (let r = INNER / 16; r < INNER * 0.99; r *= 1.12) radii.push(r);
  for (let r = INNER; r < OUTER; r *= q) radii.push(r);
  radii.push(SKIRT);
  const verts = new Float32Array((1 + radii.length * ANGULAR) * 3);
  let v = 3; // vertex 0 = centre
  for (const r of radii) {
    for (let a = 0; a < ANGULAR; a++) {
      const t = (a / ANGULAR) * Math.PI * 2;
      verts[v++] = Math.cos(t) * r; verts[v++] = 0; verts[v++] = Math.sin(t) * r;
    }
  }
  const idx = [];
  for (let a = 0; a < ANGULAR; a++) idx.push(0, 1 + ((a + 1) % ANGULAR), 1 + a);
  for (let ring = 0; ring < radii.length - 1; ring++) {
    const i0 = 1 + ring * ANGULAR, i1 = i0 + ANGULAR;
    for (let a = 0; a < ANGULAR; a++) {
      const b = (a + 1) % ANGULAR;
      idx.push(i0 + a, i0 + b, i1 + a, i0 + b, i1 + b, i1 + a);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  return geo;
}

// Shared by the surface, the CPU height queries and the underwater pass, so every
// consumer sees exactly the same surface.
export const WATER_GLSL = /* glsl */`
#define N_TEX ${N.toFixed(1)}
#define PI 3.14159265359
uniform sampler2D uDisp0, uDisp1, uDisp2;
uniform sampler2D uSlope0, uSlope1, uSlope2;
uniform vec3 uLength;
uniform sampler2D uShore;
uniform float uShoreExtent;
uniform float uTime;
uniform vec4 uShoreWave;   // amplitude, wavelength, speed, steepness
uniform vec2 uWaveDamp;    // depth where long swell fully exists, chop strength in shallows
uniform vec2 uSwellDir;    // propagation direction of the swell (xz)

vec4 shoreSample(vec2 xz) {
  vec2 uv = xz / uShoreExtent + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(-60.0, 1e4, 0.0, 0.0);
  return textureLod(uShore, uv, 0.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + 1.0), u.x), u.y);
}

// FFT cascade weights by water depth: long swell is replaced by shore waves in the
// shallows, chop survives almost to the beach.
vec3 cascadeDamp(float depth) {
  float swell = smoothstep(2.0, uWaveDamp.x, depth);
  float chop = smoothstep(-0.4, 2.0, depth) * mix(uWaveDamp.y, 1.0, smoothstep(0.0, 10.0, depth));
  return vec3(swell, chop, chop);
}

// Travelling breakers driven by the coast SDF: phase = k*sdf + wt, so fronts run up the
// distance gradient towards the beach. Gerstner push along -grad(sdf), Green's-law
// shoaling, breaking limit A <= 0.42*depth.
struct Shore { vec3 disp; vec2 slope; float foam; vec2 foamUV; };
Shore shoreWaves(vec2 xz, vec4 sh) {
  Shore o = Shore(vec3(0.0), vec2(0.0), 0.0, vec2(0.0));
  float depth = -sh.x, sdf = sh.y;
  float gl = length(sh.zw);
  float env = smoothstep(180.0, 70.0, sdf) * smoothstep(0.35, 0.8, gl) * smoothstep(-0.9, 0.5, depth);
  if (env <= 0.0 || uShoreWave.x <= 0.0) return o;
  vec2 dir = -sh.zw / gl;
  // coasts facing the swell get the big sets, lee shores only small ones
  env *= mix(0.25, 1.0, smoothstep(-0.3, 0.7, dot(dir, uSwellDir)));
  float shoal = pow(clamp(max(depth, 0.6) / 14.0, 0.04, 1.0), -0.25);
  float amax = 0.42 * max(depth, 0.0) + 0.14;
  float noisePhase = vnoise(xz * 0.0042) * 9.0 + vnoise(xz * 0.011 + 7.0) * 2.5;
  float group = 0.45 + 0.55 * vnoise(xz * 0.004 + vec2(uTime * 0.021, -uTime * 0.017));
  for (int i = 0; i < 2; i++) {
    float lambda = uShoreWave.y * (i == 0 ? 1.0 : 0.61);
    float k = 2.0 * PI / lambda;
    float w = sqrt(9.81 * k) * uShoreWave.z;
    float a = min(uShoreWave.x * (i == 0 ? 1.0 : 0.45) * env * shoal * group, amax * (i == 0 ? 1.0 : 0.5));
    float ph = k * sdf + w * uTime + noisePhase * (i == 0 ? 1.0 : 1.37) + float(i) * 2.1;
    float c = 0.5 + 0.5 * cos(ph);
    float s = sin(ph);
    const float P = 1.6;           // narrower crests, flatter troughs
    float cp = pow(c, P - 1.0);
    float qak = min(0.85, uShoreWave.w * a * k * 8.0);
    o.disp.y += a * (2.0 * cp * c - 0.78);
    o.disp.xz += dir * (qak / k) * s;
    o.slope += dir * (a * k * P * cp * s / (1.0 - qak * cos(ph)));
    // whitewater: on the crest and trailing behind it once the wave is near breaking
    float breaking = smoothstep(0.18, 0.4, a / max(depth, 0.05));
    float psi = mod(ph + PI, 2.0 * PI) - PI;
    float f = breaking * smoothstep(-0.45, 0.0, psi) * exp(-max(psi, 0.0) * 0.8);
    o.foam += f;
    // foam texture rides with the bore: -psi/k is the coordinate in the frame moving at
    // phase speed; each wave cycle gets its own random offset (the wrap sits where foam ~ 0)
    if (i == 0) {
      float cycle = floor((ph + PI) / (2.0 * PI));
      o.foamUV = vec2(dot(xz, vec2(-dir.y, dir.x)), -psi / k) + vec2(hash12(vec2(cycle, 3.7)), hash12(vec2(cycle, 9.1))) * 50.0;
    }
  }
  return o;
}

// Full surface displacement at an undisplaced xz; lod per cascade (0 = finest).
vec3 waterDisplacement(vec2 xz, vec3 lod) {
  vec4 sh = shoreSample(xz);
  vec3 damp = cascadeDamp(-sh.x);
  vec3 d = textureLod(uDisp0, xz / uLength.x, max(lod.x, 0.0)).xyz * damp.x
         + textureLod(uDisp1, xz / uLength.y, max(lod.y, 0.0)).xyz * damp.y
         + textureLod(uDisp2, xz / uLength.z, max(lod.z, 0.0)).xyz * damp.z;
  return d + shoreWaves(xz, sh).disp;
}

// Surface at world xz: invert the choppy horizontal displacement by fixed-point
// iteration, then read the height there. Returns the displacement; .y is the height.
vec3 waterAt(vec2 q, vec3 lod) {
  vec2 p = q;
  vec3 d = vec3(0.0);
  for (int i = 0; i < 4; i++) { d = waterDisplacement(p, lod); p = q - d.xz; }
  return waterDisplacement(p, lod);
}
`;

const VERT = WATER_GLSL + /* glsl */`
uniform float uGridScale;
uniform float uCellStep;
out vec3 vWorld;
out vec2 vXZ;

void main() {
  vec2 local = position.xz;
  float r = length(local);
  float scale = r > ${(OUTER * 2).toFixed(1)} ? 1.0 : uGridScale;
  vec2 xz = cameraPosition.xz + local * scale;
  float cell = max(r, ${INNER.toFixed(1)}) * uCellStep * scale;

  // +1 LOD bias: box-filtered mips still leak a little past Nyquist
  vec3 d = waterDisplacement(xz, log2(cell * N_TEX / uLength) + 1.0);

  vXZ = xz;
  vWorld = vec3(xz.x + d.x, d.y, xz.y + d.z);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`;

const FRAG = WATER_GLSL + /* glsl */`
precision highp sampler2DShadow;
uniform vec2 uResolution;
uniform vec2 uNearFar;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform sampler2D uReflection;
uniform mat4 uReflMatrix;
uniform samplerCube uSkyCube;
uniform float uSkyMaxLod;
uniform sampler2D uFoamTex;
uniform sampler2DShadow uShadowMap;
uniform mat4 uShadowMatrix;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAbsorption;
uniform vec3 uScatterColor;
uniform vec4 uSSS;          // peak strength, view strength, shadow strength, -
uniform vec4 uFoam;         // bias, scale, shore band (m), brightness
uniform vec4 uOptics;       // base roughness, refraction strength, reflection distortion, fog density
uniform vec3 uCamForward;
uniform int uDebug;
uniform float uGlint;
uniform float uCamSide;     // -1 camera above the surface, 1 below, 0 straddling it
in vec3 vWorld;
in vec2 vXZ;
out vec4 fragColor;

float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
}

float sunShadow(vec3 p) {
  vec4 sc = uShadowMatrix * vec4(p, 1.0);
  if (sc.x <= 0.0 || sc.y <= 0.0 || sc.x >= 1.0 || sc.y >= 1.0 || sc.z >= 1.0) return 1.0;
  // one hardware 2x2 PCF tap: texels are ~0.44 m, soft enough on moving water
  return texture(uShadowMap, vec3(sc.xy, sc.z - 0.0015));
}

vec3 skyLod(vec3 dir, float lod) {
  dir.y = max(dir.y, 0.0);
  return textureLod(uSkyCube, dir, lod).rgb;
}

void main() {
  // folded crests flip triangles; drop faces that can't face the camera's side
  if (gl_FrontFacing ? uCamSide > 0.5 : uCamSide < -0.5) discard;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 uv = gl_FragCoord.xy / uResolution;

  // --- surface: slopes + slope variance from the three cascades -----------------
  vec4 sh = shoreSample(vXZ);
  float depthBelow = -sh.x;
  vec3 damp = cascadeDamp(depthBelow);
  vec4 s0 = texture(uSlope0, vXZ / uLength.x) * damp.x;
  vec4 s1 = texture(uSlope1, vXZ / uLength.y) * damp.y;
  vec4 s2 = texture(uSlope2, vXZ / uLength.z) * damp.z;
  Shore shore = shoreWaves(vXZ, sh);
  vec2 slope = s0.xy + s1.xy + s2.xy + shore.slope;
  // damp scales the moments linearly; good enough for a roughness estimate
  vec2 variance = max(s0.zw - s0.xy * s0.xy, 0.0) + max(s1.zw - s1.xy * s1.xy, 0.0) + max(s2.zw - s2.xy * s2.xy, 0.0);
  vec3 Nrm = normalize(vec3(-slope.x, 1.0, -slope.y));

  // geometric specular AA (Kaplanyan): normal change across the pixel adds variance
  vec3 dndx = dFdx(Nrm), dndy = dFdy(Nrm);
  float geoVar = min(0.25 * (dot(dndx, dndx) + dot(dndy, dndy)), 0.18);
  float alpha2 = uOptics.x * uOptics.x + variance.x + variance.y + geoVar;
  float alpha = sqrt(alpha2);

  float NoV = max(dot(Nrm, V), 1e-4);
  float NoL = dot(Nrm, uSunDir);
  float shadow = sunShadow(vWorld);

  // --- foam -------------------------------------------------------------------
  float t0 = texture(uDisp0, vXZ / uLength.x).w, t1 = texture(uDisp1, vXZ / uLength.y).w, t2 = texture(uDisp2, vXZ / uLength.z).w;
  float jac = mix(1.0, t0, damp.x) + mix(1.0, t1, damp.y) + mix(1.0, t2, damp.z) - 2.0;
  float foam = clamp((uFoam.x - jac) * uFoam.y, 0.0, 1.0);

  // --- seen from below: Snell's window + total internal reflection ---------------
  // (the camera->surface water column is fogged later by the underwater pass)
  if (!gl_FrontFacing) {
    vec3 Nu = -Nrm;
    vec3 Tdir = refract(-V, Nu, 1.33);
    vec3 ambientU = skyLod(vec3(0.0, 1.0, 0.0), uSkyMaxLod);
    vec3 below = uScatterColor * (ambientU + uSunColor * max(uSunDir.y, 0.0));
    vec3 colU = below;
    if (dot(Tdir, Tdir) > 0.0) {
      float cosT = max(dot(Tdir, Nrm), 0.0);
      float Fu = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
      // sky through the window is the refracted direction (the 180-degree sky squeezed
      // into the ~97-degree cone); anything opaque above water comes from the frame
      vec2 wuv = uv + Nrm.xz * 0.04;
      vec3 above = textureLod(uSceneDepth, wuv, 0.0).r > 0.999999 ? skyLod(Tdir, 0.0) : textureLod(uSceneColor, wuv, 0.0).rgb;
      // sun seen through the window, smeared by the ripples
      float sunLobe = pow(max(dot(Tdir, uSunDir), 0.0), 600.0) * 40.0;
      colU = mix(above + uSunColor * sunLobe * shadow, below, Fu);
    }
    colU *= 1.0 - 0.55 * max(foam, clamp(shore.foam, 0.0, 1.0));
    // alpha tags what the pixel sees for the underwater pass: 0 underside, 0.5 top
    fragColor = vec4(colU, 0.0);
    return;
  }

  // --- refraction + absorption -------------------------------------------------
  float waterDepth = linearDepth(gl_FragCoord.z);
  float sceneDepth = linearDepth(textureLod(uSceneDepth, uv, 0.0).r);
  float viewCos = max(dot(-V, uCamForward), 0.05);
  float thick = max(sceneDepth - waterDepth, 0.0) / viewCos;
  vec2 ruv = uv + Nrm.xz * uOptics.y * clamp(thick * 0.25, 0.0, 1.0) / max(waterDepth * 0.02, 1.0);
  float rDepth = linearDepth(textureLod(uSceneDepth, ruv, 0.0).r);
  if (rDepth < waterDepth) { ruv = uv; rDepth = sceneDepth; }
  else thick = max(rDepth - waterDepth, 0.0) / viewCos;
  vec3 refracted = textureLod(uSceneColor, ruv, 0.0).rgb;
  vec3 T = exp(-uAbsorption * thick);

  // shoreline contact foam where the water gets thin
  float contact = 1.0 - smoothstep(0.0, uFoam.z, thick * viewCos);
  foam = max(foam, contact * 0.9);
  float shoreFoam = clamp(shore.foam, 0.0, 1.0);

  // --- lighting ------------------------------------------------------------------
  vec3 ambient = skyLod(vec3(0.0, 1.0, 0.0), uSkyMaxLod);
  vec3 sun = uSunColor * shadow;
  // in-scatter of the water column (sun + sky), then Atlas-style SSS on crests
  vec3 inscatter = uScatterColor * (ambient + uSunColor * (0.3 + 0.7 * shadow) * max(uSunDir.y, 0.0));
  float h = max(vWorld.y, 0.0);
  float k1 = uSSS.x * h * pow(clamp(dot(uSunDir, -V), 0.0, 1.0), 4.0) * pow(0.5 - 0.5 * NoL, 3.0);
  float k2 = uSSS.y * pow(NoV, 2.0);
  vec3 sss = (k1 + k2) * uScatterColor * sun + uSSS.z * max(NoL, 0.0) * uScatterColor * sun;
  vec3 body = refracted * T + (inscatter + sss) * (1.0 - T);

  // Fresnel with roughness-aware F90 (Lagarde) so the rough far field doesn't go white
  const float F0 = 0.02;
  float F90 = max(1.0 - 0.7 * sqrt(alpha), F0);
  float F = F0 + (F90 - F0) * pow(1.0 - NoV, 5.0);

  // --- reflection: half-res planar (terrain) over the sky cube -----------------------
  vec3 R = reflect(-V, Nrm);
  R.y = abs(R.y);
  float lod = clamp(log2(alpha * 650.0), 0.0, uSkyMaxLod);
  vec3 refl = skyLod(R, lod);
  vec4 pc = uReflMatrix * vec4(vXZ.x, 0.0, vXZ.y, 1.0);
  vec2 puv = pc.xy / pc.w + Nrm.xz * uOptics.z / max(1.0, waterDepth * 0.01);
  vec4 planar = texture(uReflection, puv);
  refl = mix(refl, planar.rgb, planar.a);

  // --- sun specular: GGX, alpha floored so the sun acts as a small area light ---------
  float aS = max(alpha, 0.015);
  float aS2 = aS * aS;
  vec3 H = normalize(uSunDir + V);
  float NoH = max(dot(Nrm, H), 0.0);
  float nl = max(NoL, 0.0);
  float dd = NoH * NoH * (aS2 - 1.0) + 1.0;
  float D = aS2 / (PI * dd * dd);
  float vis = 0.5 / (nl * sqrt(NoV * NoV * (1.0 - aS2) + aS2) + NoV * sqrt(nl * nl * (1.0 - aS2) + aS2) + 1e-5);
  float Fs = F0 + (1.0 - F0) * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  vec3 spec = sun * (PI * D * vis * Fs * nl);

  // stochastic glitter: where facets are sub-pixel the averaged lobe is broken into
  // sparse twinkling sparkles. Mean of mask is 1, so energy is preserved.
  if (uGlint > 0.0) {
    vec2 fw = fwidth(vXZ);
    float lf = log2(max(max(fw.x, fw.y), 1e-3)) + 1.0;
    float l0 = floor(lf);
    float m = 0.0;
    for (int j = 0; j < 2; j++) {
      float l = l0 + float(j);
      vec2 cell = floor(vXZ / exp2(l));
      float hr = hash12(cell + l * 17.17);
      float h = hash12(cell * 1.31 + floor(uTime * 5.0 + hr * 7.0) * 3.7);
      m += (j == 0 ? 1.0 - (lf - l0) : lf - l0) * step(0.82, h) / 0.18;
    }
    // only the bright glitter path sparkles; dim sheen stays smooth instead of grainy
    float bright = smoothstep(1.5, 12.0, dot(spec, vec3(0.2126, 0.7152, 0.0722)));
    spec *= mix(1.0, m, uGlint * bright * smoothstep(15.0, 120.0, dist));
  }

  vec3 col = mix(body, refl, F) + spec;

  // --- foam surface: eroded by age via the pattern threshold, kills specular ----------
  // erosion: dense foam is nearly solid, ageing foam thins out to the lace network
  // (texture taps only where there is foam; most of the ocean has none)
  float cover = 0.0, pat = 0.0;
  if (foam > 0.0) {
    pat = texture(uFoamTex, vXZ * 0.11).r * 0.65 + texture(uFoamTex, vXZ * 0.031 + 0.37).r * 0.35;
    cover = smoothstep(1.05 - foam, 1.3 - foam, pat) * sqrt(foam);
  }
  if (shoreFoam > 0.0) {
    float sPattern = texture(uFoamTex, shore.foamUV * 0.09).r * 0.7 + texture(uFoamTex, shore.foamUV * 0.023 + 0.5).r * 0.3;
    float sCover = smoothstep(1.0 - shoreFoam, 1.25 - shoreFoam, sPattern) * sqrt(shoreFoam);
    if (sCover >= cover) pat = sPattern;
    cover = max(cover, sCover);
  }
  if (cover > 0.0) {
    // thin foam lets the water colour through and looks bluish; thick foam is bright
    vec3 foamAlbedo = mix(vec3(0.62, 0.78, 0.82), vec3(0.95), smoothstep(0.3, 0.9, pat));
    vec3 foamCol = uFoam.w * foamAlbedo * (sun * (0.35 + 0.65 * max(NoL, 0.0)) + ambient * 1.1);
    col = mix(col, foamCol, cover);
  }

  // --- aerial perspective into the horizon sky ---------------------------------------
  float fog = 1.0 - exp(-dist * uOptics.w);
  col = mix(col, skyLod(-V, 3.0), fog);

  if (uDebug == 1) col = Nrm * 0.5 + 0.5;
  else if (uDebug == 2) col = spec;
  else if (uDebug == 3) col = vec3(foam, cover, shoreFoam);
  else if (uDebug == 4) col = vec3(alpha * 5.0, sqrt(geoVar) * 5.0, sqrt(variance.x + variance.y) * 5.0);
  else if (uDebug == 5) col = vec3(F);
  else if (uDebug == 6) col = body;
  else if (uDebug == 7) col = refl;
  fragColor = vec4(col, 0.5);
}`;

export class OceanSurface {
  constructor(sim, shore, sky) {
    this.sim = sim;
    const L = new THREE.Vector3(...sim.lengths);
    this.uniforms = {
      uDisp0: { value: null }, uDisp1: { value: null }, uDisp2: { value: null },
      uSlope0: { value: null }, uSlope1: { value: null }, uSlope2: { value: null },
      uLength: { value: L },
      uShore: { value: shore.texture }, uShoreExtent: { value: shore.extent },
      uTime: { value: 0 },
      uShoreWave: { value: new THREE.Vector4(0.55, 30, 1.0, 1.0) },
      uWaveDamp: { value: new THREE.Vector2(26, 0.55) },
      uSwellDir: { value: new THREE.Vector2(1, 0) },
      uGridScale: { value: 1 },
      uCellStep: { value: (2 * Math.PI) / ANGULAR },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNearFar: { value: new THREE.Vector2(0.5, 80000) },
      uSceneColor: { value: null },
      uSceneDepth: { value: null },
      uReflection: { value: null },
      uReflMatrix: { value: new THREE.Matrix4() },
      uSkyCube: { value: sky.cube },
      uSkyMaxLod: { value: Math.log2(sky.cubeSize) },
      uFoamTex: { value: null },
      uShadowMap: { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uSunDir: { value: sky.sunDir },
      uSunColor: { value: sky.sunColor },
      uAbsorption: { value: new THREE.Vector3(0.42, 0.075, 0.048) },
      uScatterColor: { value: new THREE.Color(0.0, 0.05, 0.08) },
      uSSS: { value: new THREE.Vector4(1.6, 0.06, 0.05, 0) },
      uFoam: { value: new THREE.Vector4(0.05, 1.3, 0.35, 0.85) },
      uOptics: { value: new THREE.Vector4(0.02, 0.06, 0.04, 1 / 18000) },
      uCamForward: { value: new THREE.Vector3() },
      uDebug: { value: 0 },
      uGlint: { value: 0.6 },
      uCamSide: { value: -1 },
    };
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.DoubleSide,
    });
    this.grids = [buildGrid(ANGULAR), buildGrid(ANGULAR / 2)];
    this.mesh = new THREE.Mesh(this.grids[0], this.material);
    this.mesh.frustumCulled = false;
  }

  update(camera, time) {
    const u = this.uniforms, s = this.sim;
    u.uDisp0.value = s.displacement[0]; u.uDisp1.value = s.displacement[1]; u.uDisp2.value = s.displacement[2];
    u.uSlope0.value = s.slope[0]; u.uSlope1.value = s.slope[1]; u.uSlope2.value = s.slope[2];
    u.uTime.value = time;
    const a = THREE.MathUtils.degToRad(s.params.swellDirection);
    u.uSwellDir.value.set(-Math.cos(a), -Math.sin(a));
    u.uGridScale.value = Math.max(1, Math.abs(camera.position.y) / 2);
    const coarse = Math.abs(camera.position.y) > HIGH_CAMERA ? 1 : 0;
    this.mesh.geometry = this.grids[coarse];
    u.uCellStep.value = (2 * Math.PI) / (ANGULAR >> coarse);
    u.uNearFar.value.set(camera.near, camera.far);
    camera.getWorldDirection(u.uCamForward.value);
  }
}
