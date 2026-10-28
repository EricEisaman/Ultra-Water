import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildTerrain } from './terrainGeometry.js';
import { islandHeight } from './islandHeight.js';
import { fbm } from './noise.js';

// Island + shore rocks on MeshStandardMaterial, patched with: biome colouring,
// wet sand sheen, sunlight absorption under water and procedural caustics.
const VERT_PARS = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNrm;
`;

const FRAG_PARS = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNrm;
uniform sampler2D uCaustics;
uniform samplerCube uSkyCube;
uniform vec3 uAbsorption;
uniform vec3 uSunDirT;
uniform float uTimeT;
uniform float uCausticStrength;
uniform float uFogDensity;
float th(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float tn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(th(i), th(i + vec2(1, 0)), u.x), mix(th(i + vec2(0, 1)), th(i + 1.0), u.x), u.y); }
`;

const ALBEDO = /* glsl */`
  float hgt = vWPos.y;
  float flat_ = clamp(vWNrm.y, 0.0, 1.0);
  float n1 = tn(vWPos.xz * 0.08), n2 = tn(vWPos.xz * 0.6), n3 = tn(vWPos.xz * 0.013);
  vec3 sand = mix(vec3(0.80, 0.71, 0.53), vec3(0.72, 0.62, 0.45), n1) * (0.92 + 0.16 * n2);
  vec3 seabed = mix(vec3(0.78, 0.72, 0.56), vec3(0.62, 0.58, 0.44), n1 * n3);
  vec3 grass = mix(vec3(0.20, 0.30, 0.10), vec3(0.33, 0.37, 0.15), n1) * (0.85 + 0.3 * n2);
  vec3 rock = mix(vec3(0.33, 0.31, 0.29), vec3(0.45, 0.41, 0.36), n2) * (0.8 + 0.4 * n3);
#ifdef ROCK
  vec3 albedo = rock * mix(0.9, 1.15, n1);
#else
  float sandLine = 2.4 + 1.6 * n3 + 0.8 * n1;
  vec3 albedo = hgt < 0.0 ? seabed : sand;
  albedo = mix(albedo, grass, smoothstep(sandLine, sandLine + 1.5, hgt) * smoothstep(0.62, 0.8, flat_));
  albedo = mix(albedo, rock, smoothstep(0.78, 0.62, flat_) * smoothstep(-6.0, 1.0, hgt));
  albedo = mix(albedo, rock * 1.1, smoothstep(38.0, 52.0, hgt + n1 * 8.0));
#endif
  // wet band above the waterline
  float wet = 1.0 - smoothstep(0.35, 1.3 + 0.5 * n1, hgt);
  albedo *= mix(1.0, 0.58, wet);
  diffuseColor.rgb = albedo;
`;

// sand ripples + grain bump in world space, faded out before they alias
const RIPPLES = /* glsl */`
#ifndef ROCK
  {
    vec2 fw = fwidth(vWPos.xz);
    float px = max(fw.x, fw.y);
    float sandMask = (1.0 - smoothstep(sandLine - 0.5, sandLine + 0.5, hgt)) * smoothstep(0.85, 0.95, flat_);
    sandMask *= mix(1.0, 0.25, smoothstep(-0.3, 0.6, hgt)); // dry sand: faint wind ripples only
    vec2 g = vec2(0.0);
    // long wave-formed ripples (~1.6 m) and short ones (~0.3 m), bent by noise
    vec2 d1 = normalize(vec2(0.8, 0.6) + (vec2(tn(vWPos.xz * 0.02), tn(vWPos.xz * 0.02 + 5.0)) - 0.5));
    float w1 = 3.9, p1 = dot(vWPos.xz, d1) * w1 + tn(vWPos.xz * 0.11) * 5.0;
    g += d1 * w1 * cos(p1) * 0.025 * (1.0 - smoothstep(0.15, 0.5, px));
    float w2 = 21.0, p2 = dot(vWPos.xz, vec2(-d1.y, d1.x) * 0.3 + d1) * w2 + tn(vWPos.xz * 0.5) * 4.0;
    g += d1 * w2 * cos(p2) * 0.0025 * (1.0 - smoothstep(0.03, 0.09, px));
    vec3 nW = normalize(vWNrm - vec3(g.x, 0.0, g.y) * sandMask);
    normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  }
#endif
`;

const UNDERWATER = /* glsl */`
  float wdepth = max(-vWPos.y, 0.0);
  // sun and sky light reaching the bed through the water column
  float sunPath = wdepth / max(uSunDirT.y, 0.15);
  diffuseColor.rgb *= exp(-uAbsorption * (sunPath * 0.6 + wdepth * 0.4));
`;

const ROUGH = /* glsl */`
  roughnessFactor = mix(roughnessFactor, 0.32, wet * step(0.0, hgt));
`;

const CAUSTICS = /* glsl */`
  if (wdepth > 0.0) {
    vec3 rs = refract(-uSunDirT, vec3(0.0, 1.0, 0.0), 0.75);
    vec2 base = vWPos.xz + rs.xz / rs.y * wdepth;   // where this light entered the surface
    float c1 = texture(uCaustics, base * 0.19 + uTimeT * vec2(0.021, 0.013)).r;
    float c2 = texture(uCaustics, base * 0.23 + vec2(0.37, 0.71) - uTimeT * vec2(0.017, 0.023)).r;
    float c = min(c1, c2) * 2.5;
    float fade = smoothstep(0.0, 0.5, wdepth) * exp(-wdepth * 0.11);
    reflectedLight.directDiffuse *= 1.0 + c * fade * uCausticStrength;
  }
`;

const FOG = /* glsl */`
  vec3 fdir = normalize(vWPos - cameraPosition);
  float fogAmt = 1.0 - exp(-length(vWPos - cameraPosition) * uFogDensity);
  outgoingLight = mix(outgoingLight, textureLod(uSkyCube, vec3(fdir.x, max(fdir.y, 0.0), fdir.z), 3.0).rgb, fogAmt);
`;

// mode: 'terrain' | 'rock' | 'prop' (props keep their own colours, just get the
// underwater light falloff, caustics and fog)
function patch(material, uniforms, mode) {
  const ground = mode !== 'prop';
  if (mode === 'rock') material.defines = { ...material.defines, ROCK: '' };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 wp = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  wp = instanceMatrix * wp;
#endif
  vWPos = (modelMatrix * wp).xyz;
  vec3 wn = objectNormal;
#ifdef USE_INSTANCING
  wn = mat3(instanceMatrix) * wn;
#endif
  vWNrm = normalize(mat3(modelMatrix) * wn);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + (ground ? ALBEDO : '') + UNDERWATER)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + (ground ? ROUGH : ''))
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + (ground ? RIPPLES : ''))
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + CAUSTICS)
      .replace('#include <opaque_fragment>', FOG + '#include <opaque_fragment>');
  };
  material.customProgramCacheKey = () => 'gelatin-' + mode;
}

function rockGeometry() {
  let g = new THREE.IcosahedronGeometry(1, 4);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = fbm(v.x * 1.4 + 3, v.z * 1.4 + v.y * 0.7, 5, 21);
    const facet = Math.abs(fbm(v.x * 3.1, v.y * 3.1 + v.z, 3, 5));
    v.multiplyScalar(1 + 0.38 * n - 0.12 * facet);
    if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.4;   // flattish base
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function placeRocks(count, rand) {
  const out = [];
  for (let i = 0; i < count * 6 && out.length < count; i++) {
    const a = rand() * Math.PI * 2;
    // walk outwards to the coast along this bearing, then jitter around it
    let r = 150;
    while (r < 700 && islandHeight(Math.cos(a) * r, Math.sin(a) * r) > 0) r += 4;
    r += (rand() - 0.6) * 40;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = islandHeight(x, z);
    if (h < -5 || h > 6) continue;
    const s = 1.5 + Math.pow(rand(), 2.2) * 9;
    out.push({ x, z, y: h - s * 0.15, s });
    // small satellites
    for (let k = 0; k < 3 && out.length < count; k++) {
      const ox = x + (rand() - 0.5) * s * 4, oz = z + (rand() - 0.5) * s * 4;
      const ss = s * (0.25 + rand() * 0.35);
      out.push({ x: ox, z: oz, y: islandHeight(ox, oz) - ss * 0.2, s: ss });
    }
  }
  return out;
}

export function createTerrain({ sky, caustics, absorption, reflectionLayer = 1 }) {
  const uniforms = {
    uCaustics: { value: caustics },
    uSkyCube: { value: sky.cube },
    uAbsorption: { value: absorption },
    uSunDirT: { value: sky.sunDir },
    uTimeT: { value: 0 },
    uCausticStrength: { value: 3.0 },
    uFogDensity: { value: 1 / 18000 },
  };

  const { geometry } = buildTerrain(384);
  const groundMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, envMapIntensity: 0.9 });
  patch(groundMat, uniforms, 'terrain');
  const ground = new THREE.Mesh(geometry, groundMat);
  ground.castShadow = ground.receiveShadow = true;

  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const spots = placeRocks(90, rand);
  const rockMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: 0.9 });
  patch(rockMat, uniforms, 'rock');
  const rocks = new THREE.InstancedMesh(rockGeometry(), rockMat, spots.length);
  const m = new THREE.Matrix4(), qt = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3();
  spots.forEach((s, i) => {
    e.set(rand() * 0.6, rand() * Math.PI * 2, rand() * 0.6);
    sc.set(s.s * (0.8 + rand() * 0.6), s.s * (0.5 + rand() * 0.5), s.s * (0.8 + rand() * 0.6));
    m.compose(new THREE.Vector3(s.x, s.y, s.z), qt.setFromEuler(e), sc);
    rocks.setMatrixAt(i, m);
  });
  rocks.computeBoundingSphere();
  rocks.castShadow = rocks.receiveShadow = true;

  const group = new THREE.Group();
  group.add(ground, rocks);
  for (const o of [ground, rocks]) o.layers.enable(reflectionLayer);
  return { group, uniforms, patchProp: (m) => patch(m, uniforms, 'prop') };
}
