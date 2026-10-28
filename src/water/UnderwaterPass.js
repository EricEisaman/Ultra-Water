import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';
import { WATER_GLSL } from './OceanSurface.js';

// Fullscreen pass over the finished HDR frame when the camera is at or below the
// surface. Per pixel it finds whether the lens (near-plane point) is under the exact
// rendered surface, so a wave washing over the camera splits the screen with a
// meniscus line. Underwater pixels get the camera->hit water column: Beer-Lambert
// extinction towards an in-scatter colour that matches the surface underside, and
// single-scattered sun shafts raymarched through the same caustic pattern the seabed
// uses (projected along the refracted sun).
const FRAG = /* glsl */`
precision highp float;
precision highp int;
${WATER_GLSL}
uniform sampler2D tColor;
uniform highp sampler2D tDepth;
uniform sampler2D uCaustics;
uniform samplerCube uSkyCube;
uniform float uSkyMaxLod;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uAbsorption;
uniform vec3 uScatterColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec4 uUnder;   // scattering coefficient (1/m), shaft strength, shaft range (m), meniscus darkening
uniform float uFull;   // 1: camera deep enough that the whole near plane is submerged
uniform float uFrame;  // frame index mod 64, rotates the shaft jitter
in vec2 vUv;
out vec4 outColor;

vec3 viewPos(vec2 uv, float ndcZ) {
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, ndcZ, 1.0);
  return v.xyz / v.w;
}

// shafts are blurry anyway: one scrolling sample of the seabed caustic pattern
float caustic(vec2 base, float lod) {
  return textureLod(uCaustics, base * 0.19 + uTime * vec2(0.021, 0.013), lod).r * 1.6;
}

float isFront(float a) { return step(0.25, a) * step(a, 0.75); }

void main() {
  vec3 nearW = (uCamWorld * vec4(viewPos(vUv, -1.0), 1.0)).xyz;
  float d = uFull > 0.5 ? 10.0 : waterAt(nearW.xz, vec3(0.0)).y - nearW.y;   // lens depth

  // where the pixel sees the water surface, its facing decides (alpha from the water
  // pass: 0 underside, 0.5 top, 1 no water). That keeps the split consistent with the
  // mesh even where its coarse fan around the lens disagrees with the exact height.
  vec4 src = texture(tColor, vUv);
  bool under = src.a < 0.25 || (src.a > 0.75 && d > 0.0);

  // meniscus: a dark line where the top of the surface meets its underside on screen
  float meniscus = 1.0;
  if (uFull < 0.5) {
    vec2 px = 2.0 / vec2(textureSize(tColor, 0));
    float f = 0.0, b = 0.0;
    for (int i = 0; i < 4; i++) {
      vec2 o = vec2(i == 0 ? px.x : i == 1 ? -px.x : 0.0, i == 2 ? px.y : i == 3 ? -px.y : 0.0);
      float a = texture(tColor, vUv + o).a;
      f += isFront(a);
      b += step(a, 0.25);
    }
    // only near the lens: far front/back boundaries are folded crests, not the waterline
    meniscus -= uUnder.w * max(isFront(src.a) * min(b, 1.0), step(src.a, 0.25) * min(f, 1.0))
              * smoothstep(0.35, 0.1, abs(d));
  }
  if (!under) {
    outColor = vec4(src.rgb * meniscus, 1.0);
    return;
  }
  d = max(d, 0.0);

  // slight refractive wobble of the whole image
  vec2 uv = vUv + vec2(sin(vUv.y * 37.0 + uTime * 1.9), cos(vUv.x * 29.0 + uTime * 1.6)) * 0.0012;
  vec3 col = texture(tColor, uv).rgb;
  float z = texture(tDepth, uv).r;
  vec3 hitV = viewPos(uv, z * 2.0 - 1.0);
  float dist = z > 0.999999 ? 1e5 : length(hitV);
  vec3 dir = normalize(mat3(uCamWorld) * hitV);
  vec3 camPos = uCamWorld[3].xyz;

  vec3 sigT = uAbsorption + uUnder.x;
  // in-scatter: the surface underside's deep-water colour, darker with depth and
  // brighter looking up towards the light
  vec3 ambient = textureLod(uSkyCube, vec3(0.0, 1.0, 0.0), uSkyMaxLod).rgb;
  vec3 fogCol = uScatterColor * (ambient + uSunColor * max(uSunDir.y, 0.0))
              * exp(-uAbsorption * d * 0.5) * mix(0.55, 1.35, dir.y * 0.5 + 0.5);
  vec3 T = exp(-sigT * dist);
  col = col * T + fogCol * (1.0 - T);

  // sun shafts: single scattering of the refracted sun, modulated by caustics
  if (uUnder.y > 0.0 && uSunDir.y > 0.0) {
    vec3 rs = refract(-uSunDir, vec3(0.0, 1.0, 0.0), 0.75);
    float range = min(dist, uUnder.z);
    const int STEPS = 8;
    float stepL = range / float(STEPS);
    // interleaved gradient noise, shifted by the golden ratio each frame: at high frame
    // rates the per-pixel grain averages out instead of showing a fixed pattern
    float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrame * 0.618034);
    float mu = dot(dir, -rs);
    const float g = 0.7;
    float phase = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5)) + 0.04;
    // prefilter along the ray: mip from how far one step moves through the pattern, so
    // rays sweeping across the caustics average to smooth haze and rays looking along
    // the light keep sharp shafts (8 samples can't resolve the pattern otherwise)
    vec2 dbase = dir.xz - rs.xz / rs.y * dir.y;
    float lodRay = log2(max(length(dbase) * stepL * 0.19 * float(textureSize(uCaustics, 0).x), 1.0));
    vec3 acc = vec3(0.0);
    for (int i = 0; i < STEPS; i++) {
      float s = (float(i) + jit) * stepL;
      vec3 p = camPos + dir * s;
      float pd = -p.y;
      if (pd <= 0.0) continue;
      float c = caustic(p.xz + rs.xz / rs.y * pd, max(lodRay, 1.5 + log2(1.0 + pd * 0.6)));
      acc += c * exp(-sigT * (s + pd / -rs.y)) * smoothstep(0.0, 0.6, pd);
    }
    col += uSunColor * acc * (uUnder.x * phase * stepL * uUnder.y);
  }

  outColor = vec4(col * meniscus, 1.0);
}`;

export class UnderwaterPass {
  constructor(surface, camera, caustics) {
    this.params = { scattering: 0.03, shafts: 4, shaftRange: 40, meniscus: 0.5 };
    this.uniforms = {
      ...surface.uniforms,
      tColor: { value: null }, tDepth: { value: null }, uCaustics: { value: caustics },
      uInvProj: { value: camera.projectionMatrixInverse }, uCamWorld: { value: camera.matrixWorld },
      uUnder: { value: new THREE.Vector4() }, uFull: { value: 0 }, uFrame: { value: 0 },
    };
    this.quad = new FullscreenQuad(rawPass(FRAG, this.uniforms));
    this.target = null;
  }

  setSize(w, h) {
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
  }

  // src: the HDR target after the water pass (colour + depth). Returns the new colour.
  render(renderer, src, full) {
    const u = this.uniforms, p = this.params;
    u.tColor.value = src.texture;
    u.tDepth.value = src.depthTexture;
    u.uUnder.value.set(p.scattering, p.shafts, p.shaftRange, p.meniscus);
    u.uFull.value = full ? 1 : 0;
    u.uFrame.value = (u.uFrame.value + 1) % 64;
    this.quad.render(renderer, this.target);
    return this.target.texture;
  }
}
