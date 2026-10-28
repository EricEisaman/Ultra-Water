import * as THREE from 'three';

const LEVELS = 6;

const VERT = /* glsl */`
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const HEAD = /* glsl */`
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
`;

// 13-tap dual-filter downsample (CoD AW). With PREFILTER: clamp + soft knee per tap, Karis-weighted groups.
const DOWN = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel; // source texel size
#ifdef PREFILTER
uniform vec4 uCurve; // threshold-knee, 2*knee, 0.25/knee, threshold
uniform float uClamp;
#endif

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 tap(vec2 o) {
  vec3 c = texture(tSrc, vUv + o * uTexel).rgb;
#ifdef PREFILTER
  c = max(c, 0.0); // negatives (and NaN on most GPUs) -> 0
  float l = max(luma(c), 1e-4);
  c *= min(1.0, uClamp / l);
  l = min(l, uClamp);
  float q = clamp(l - uCurve.x, 0.0, uCurve.y);
  c *= max(uCurve.z * q * q, l - uCurve.w) / l;
#endif
  return c;
}

void main() {
  vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0, 0.0)), f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0)), l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));
  vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25;
  vec3 g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25;
  vec3 g4 = (j + k + l + m) * 0.25;
#ifdef PREFILTER
  float w0 = 0.125 / (1.0 + luma(g0)), w1 = 0.125 / (1.0 + luma(g1));
  float w2 = 0.125 / (1.0 + luma(g2)), w3 = 0.125 / (1.0 + luma(g3));
  float w4 = 0.5 / (1.0 + luma(g4));
  vec3 r = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
#else
  vec3 r = g4 * 0.5 + (g0 + g1 + g2 + g3) * 0.125;
#endif
  fragColor = vec4(r, 1.0);
}`;

// 9-tap tent upsample; blended additively onto the finer level.
const UP = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel; // source (coarser) texel size
void main() {
  vec4 d = uTexel.xyxy * vec4(1.0, 1.0, -1.0, 0.0);
  vec3 s = texture(tSrc, vUv - d.xy).rgb + texture(tSrc, vUv - d.wy).rgb * 2.0 + texture(tSrc, vUv - d.zy).rgb
    + texture(tSrc, vUv + d.zw).rgb * 2.0 + texture(tSrc, vUv).rgb * 4.0 + texture(tSrc, vUv + d.xw).rgb * 2.0
    + texture(tSrc, vUv + d.zy).rgb + texture(tSrc, vUv + d.wy).rgb * 2.0 + texture(tSrc, vUv + d.xy).rgb;
  fragColor = vec4(s * (1.0 / 16.0), 1.0);
}`;

// Same math as three's AgXToneMapping chunk (Filament/Blender AgX, iolite contrast approx).
const COMP = /* glsl */`
uniform sampler2D tHdr;
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uBloom;
uniform vec2 uLook; // AgX look: power (contrast), saturation

const mat3 SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const mat3 REC2020_TO_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 AGX_INSET = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const mat3 AGX_OUTSET = mat3(
  vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const float AGX_MIN_EV = -12.47393;
const float AGX_MAX_EV = 4.026069;

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agx(vec3 c) {
  c = AGX_INSET * (SRGB_TO_REC2020 * c);
  c = clamp((log2(max(c, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
  c = agxContrast(c);
  // AgX "punchy"-style look in the encoded domain
  c = pow(max(c, 0.0), vec3(uLook.x));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = l + uLook.y * (c - l);
  c = AGX_OUTSET * c;
  return clamp(REC2020_TO_SRGB * pow(max(c, 0.0), vec3(2.2)), 0.0, 1.0);
}

void main() {
  vec3 c = (texture(tHdr, vUv).rgb + texture(tBloom, vUv).rgb * uBloom) * uExposure;
  vec2 d = (vUv - 0.5) * 1.41421356; // |d|^2 = 1 at corners
  c = agx(c) * (1.0 - 0.08 * dot(d, d));
  fragColor = vec4(mix(pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308)))), 1.0);
}`;

const mk = (frag, uniforms, defines = {}, extra = {}) => new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: HEAD + frag,
  uniforms, defines, depthTest: false, depthWrite: false, ...extra,
});

export class PostFX {
  params = { exposure: 1.0, bloomStrength: 0.06, bloomThreshold: 1.0, bloomClamp: 64.0, contrast: 1.12, saturation: 1.3 };

  constructor(renderer) {
    this.renderer = renderer;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.mesh = new THREE.Mesh(this.geometry);
    this.mesh.frustumCulled = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const src = () => ({ tSrc: { value: null }, uTexel: { value: null } });
    this.matPre = mk(DOWN, { ...src(), uCurve: { value: new THREE.Vector4() }, uClamp: { value: 64 } }, { PREFILTER: 1 });
    this.matDown = mk(DOWN, src());
    this.matUp = mk(UP, src(), {}, {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.matComp = mk(COMP, {
      tHdr: { value: null }, tBloom: { value: null }, uExposure: { value: 1 }, uBloom: { value: 0 }, uLook: { value: new THREE.Vector2(1, 1) },
    });

    // levels[i] is 1/2^(i+1) of the input; texel[0] is the HDR input, texel[i+1] is levels[i]
    this.levels = [];
    this.texel = [new THREE.Vector2()];
    for (let i = 0; i < LEVELS; i++) {
      this.levels.push(new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      }));
      this.texel.push(new THREE.Vector2());
    }
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.setSize(size.x, size.y);
  }

  setSize(width, height) {
    let w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
    this.texel[0].set(1 / w, 1 / h);
    for (let i = 0; i < LEVELS; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this.levels[i].setSize(w, h);
      this.texel[i + 1].set(1 / w, 1 / h);
    }
  }

  _pass(mat, target) {
    this.mesh.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.mesh, this.camera);
  }

  _blit(mat, src, texel, target) {
    mat.uniforms.tSrc.value = src;
    mat.uniforms.uTexel.value = texel;
    this._pass(mat, target);
  }

  render(hdrTexture) {
    const r = this.renderer, p = this.params, L = this.levels, T = this.texel;
    const prevTarget = r.getRenderTarget(), prevClear = r.autoClear, prevReset = r.info.autoReset;
    r.autoClear = false;
    r.info.autoReset = false; // keep scene stats; our passes would otherwise wipe them

    const th = p.bloomThreshold, knee = Math.max(th * 0.5, 1e-4);
    const pre = this.matPre.uniforms;
    pre.uCurve.value.set(th - knee, 2 * knee, 0.25 / knee, th);
    pre.uClamp.value = p.bloomClamp;

    this._blit(this.matPre, hdrTexture, T[0], L[0]);
    for (let i = 1; i < LEVELS; i++) this._blit(this.matDown, L[i - 1].texture, T[i], L[i]);
    for (let i = LEVELS - 2; i >= 0; i--) this._blit(this.matUp, L[i + 1].texture, T[i + 2], L[i]);

    const u = this.matComp.uniforms;
    u.tHdr.value = hdrTexture;
    u.tBloom.value = L[0].texture;
    u.uExposure.value = p.exposure;
    u.uLook.value.set(p.contrast, p.saturation);
    u.uBloom.value = p.bloomStrength;
    this._pass(this.matComp, null);

    r.setRenderTarget(prevTarget);
    r.autoClear = prevClear;
    r.info.autoReset = prevReset;
  }

  dispose() {
    for (const rt of this.levels) rt.dispose();
    for (const m of [this.matPre, this.matDown, this.matUp, this.matComp]) m.dispose();
    this.geometry.dispose();
  }
}
