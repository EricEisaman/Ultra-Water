import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';

// One-off procedural textures, baked at startup (tileable, mipmapped, R8-ish in RGBA8).

const FOAM = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 outColor;
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
// tileable voronoi: cell ids wrap at period
vec2 voronoi(vec2 p, float period) {
  vec2 i = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y);
    vec2 o = hash22(mod(i + g, period));
    float d = length(g + o - f);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return vec2(f1, f2);
}
void main() {
  vec2 a = voronoi(vUv * 9.0, 9.0);
  vec2 b = voronoi(vUv * 23.0 + 0.5, 23.0);
  vec2 c = voronoi(vUv * 61.0, 61.0);
  float lace = 1.0 - smoothstep(0.0, 0.22, a.y - a.x);
  float fine = 1.0 - smoothstep(0.0, 0.16, b.y - b.x);
  float bubbles = smoothstep(0.55, 0.15, c.x);
  float v = lace * 0.55 + fine * 0.3 + bubbles * 0.25 + (1.0 - a.x) * 0.25;
  outColor = vec4(vec3(clamp(v * 0.85, 0.0, 1.0)), 1.0);
}`;

// Dave Hoskins / joltz0r tileable caustic, frozen at one time; animated at use by
// min-blending two scrolled copies.
const CAUSTIC = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 outColor;
#define TAU 6.28318530718
void main() {
  float time = 13.7;
  vec2 p = mod(vUv * TAU, TAU) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 5; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 5.0;
  c = 1.17 - pow(c, 1.4);
  float v = pow(abs(c), 8.0);
  outColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}`;

function bake(renderer, frag, size) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: true, depthBuffer: false, anisotropy: renderer.capabilities.getMaxAnisotropy(),
  });
  const mat = rawPass(frag);
  new FullscreenQuad(mat).render(renderer, rt);
  mat.dispose();
  renderer.setRenderTarget(null);
  return rt.texture;
}

export function bakeWaterTextures(renderer) {
  return { foam: bake(renderer, FOAM, 512), caustics: bake(renderer, CAUSTIC, 512) };
}
